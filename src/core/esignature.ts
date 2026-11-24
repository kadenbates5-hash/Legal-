import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { bearerTokenDigest, looksLikeBearerToken, sameDigest } from "./token-hash.js";

/**
 * Electronic signature envelopes — getting an already-attorney-approved
 * document (an engagement letter, a settlement, a stipulation) actually
 * signed, closing a gap nothing else in this system fills: drafting,
 * review, and billing all exist, but there was no way to get a signature
 * on the result.
 *
 * **The non-negotiable rule (§1) still applies here, not just at
 * drafting.** A `WorkProduct` can only be sent for signature once it is
 * `released` — never `draft`/`pending_review`/`approved` — so this can
 * never become a second path around the attorney checkpoint. A staff-
 * uploaded `CaseDocument` (e.g. a template engagement letter) has no such
 * gate, since it was never agent-drafted content in the first place; see
 * `ESignatureService.send()` for where that check actually lives (it
 * belongs with the source lookup, not in this store, the same split
 * `WorkProductStore`/`DocumentStore` already draw between "no access
 * control lives here" and the review-ui service that adds it).
 *
 * **What makes a signature worth anything here:** the exact bytes a
 * signer is shown are hashed and frozen (`documentHash`/`pdfContent`) at
 * send time — not a live reference to a document that could change out
 * from under a signature already collected — and every signer's token is
 * a single-use, hashed, time-boxed bearer secret, the same shape as
 * `core/auth.ts`'s `PasswordResetRequest`: whoever holds it can sign with
 * no other proof of identity, so it's never stored in the clear.
 */
export type EnvelopeStatus = "sent" | "completed" | "voided" | "declined";
export type SignerStatus = "pending" | "signed" | "declined";

export interface Signer {
  id: string;
  name: string;
  email: string;
  status: SignerStatus;
  signedAt?: string;
  /** What the signer actually typed at the moment of signing — may differ in capitalization/punctuation from the invited `name`, and is what the certificate of completion records as the signature itself. */
  signatureText?: string;
  declinedAt?: string;
  declineReason?: string;
  ipAddress?: string;
  userAgent?: string;
  tokenHash: string;
  tokenSalt: string;
  tokenExpiresAt: string;
}

export interface SignatureEnvelope {
  id: string;
  matterId: string;
  title: string;
  sourceKind: "document" | "work_product";
  sourceId: string;
  /** SHA-256 hex of `pdfContent`'s decoded bytes — what every signer is provably shown. */
  documentHash: string;
  /** Base64 PDF bytes exactly as sent — frozen at send time, never the live source. */
  pdfContent: string;
  signers: Signer[];
  status: EnvelopeStatus;
  createdBy: string;
  createdAt: string;
  completedAt?: string;
  voidedAt?: string;
  voidedBy?: string;
  voidReason?: string;
  /** Base64 of the certificate-stamped, fully-executed PDF — set only once every signer has signed. */
  finalPdfContent?: string;
}

export type SignatureEnvelopeSnapshot = SignatureEnvelope[];

const TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days — long enough that a signer who doesn't open the email same-day isn't already locked out.
const SCRYPT_KEYLEN = 64;

function hashToken(token: string, salt: string): string {
  return scryptSync(token, salt, SCRYPT_KEYLEN).toString("hex");
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * A signer's link token, stored as a SHA-256 digest (see `token-hash.ts`
 * for why not scrypt). An empty `tokenSalt` marks this scheme; a salted
 * record is one issued before it, still checked the old way until its 14
 * days run out.
 */
function issueToken(now: number): { tokenHash: string; tokenSalt: string; tokenExpiresAt: string; plaintext: string } {
  const plaintext = randomBytes(24).toString("hex");
  return {
    plaintext,
    tokenHash: bearerTokenDigest(plaintext),
    tokenSalt: "",
    tokenExpiresAt: new Date(now + TOKEN_TTL_MS).toISOString(),
  };
}

export class EsignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EsignatureError";
  }
}

export class ESignatureStore {
  #byId = new Map<string, SignatureEnvelope>();
  #nextEnvelopeId = 1;
  #nextSignerId = 1;

  /** Returns the new envelope plus each signer's one-time plaintext token (shown/emailed exactly once — only the hash is ever stored). */
  create(params: {
    matterId: string;
    title: string;
    sourceKind: "document" | "work_product";
    sourceId: string;
    documentHash: string;
    pdfContent: string;
    createdBy: string;
    signers: { name: string; email: string }[];
  }): { envelope: SignatureEnvelope; tokens: Record<string, string> } {
    if (params.signers.length === 0) {
      throw new EsignatureError("a signature request needs at least one signer");
    }
    const now = Date.now();
    const tokens: Record<string, string> = {};
    const signers: Signer[] = params.signers.map((s) => {
      const id = `signer_${this.#nextSignerId++}`;
      const issued = issueToken(now);
      tokens[id] = issued.plaintext;
      return {
        id,
        name: s.name,
        email: s.email,
        status: "pending",
        tokenHash: issued.tokenHash,
        tokenSalt: issued.tokenSalt,
        tokenExpiresAt: issued.tokenExpiresAt,
      };
    });
    const envelope: SignatureEnvelope = {
      id: `env_${this.#nextEnvelopeId++}`,
      matterId: params.matterId,
      title: params.title,
      sourceKind: params.sourceKind,
      sourceId: params.sourceId,
      documentHash: params.documentHash,
      pdfContent: params.pdfContent,
      signers,
      status: "sent",
      createdBy: params.createdBy,
      createdAt: new Date(now).toISOString(),
    };
    this.#byId.set(envelope.id, envelope);
    return { envelope, tokens };
  }

  get(id: string): SignatureEnvelope | undefined {
    return this.#byId.get(id);
  }

  listByMatter(matterId: string): SignatureEnvelope[] {
    return this.listAll().filter((e) => e.matterId === matterId);
  }

  listAll(): SignatureEnvelope[] {
    return [...this.#byId.values()];
  }

  /**
   * Resolves a bearer token from a signing link to the envelope/signer it
   * belongs to — `undefined` for an unknown, expired, or already-used
   * token, or one whose envelope is no longer `"sent"` (voided, or every
   * signer already resolved). Scans every pending signer rather than
   * indexing by token, since the token is exactly the secret that must
   * never be usable as a lookup key in storage.
   */
  findSignerByToken(token: string): { envelope: SignatureEnvelope; signer: Signer } | undefined {
    if (!looksLikeBearerToken(token)) return undefined;
    const now = Date.now();
    const digest = bearerTokenDigest(token);
    for (const envelope of this.#byId.values()) {
      if (envelope.status !== "sent") continue;
      for (const signer of envelope.signers) {
        if (signer.status !== "pending") continue;
        if (Date.parse(signer.tokenExpiresAt) < now) continue;
        const matches = signer.tokenSalt
          ? timingSafeStringEqual(hashToken(token, signer.tokenSalt), signer.tokenHash) // issued before SHA-256
          : sameDigest(digest, signer.tokenHash);
        if (matches) return { envelope, signer };
      }
    }
    return undefined;
  }

  /**
   * Records one signer's signature. Returns the updated envelope — now
   * `"completed"` if this was the last pending signer, still `"sent"`
   * otherwise. Does **not** build the final certificate-stamped PDF
   * (that needs `pdf-lib`, which belongs in the integration layer — see
   * `esignature-pdf.ts` — not here); call `setFinalDocument()` once the
   * caller has generated it.
   */
  recordSignature(
    envelopeId: string,
    signerId: string,
    params: { signatureText: string; ipAddress?: string; userAgent?: string },
  ): SignatureEnvelope {
    const envelope = this.#requireSendable(envelopeId);
    const signer = this.#requireSigner(envelope, signerId);
    const now = new Date().toISOString();
    const updatedSigner: Signer = {
      ...signer,
      status: "signed",
      signedAt: now,
      signatureText: params.signatureText,
      ...(params.ipAddress ? { ipAddress: params.ipAddress } : {}),
      ...(params.userAgent ? { userAgent: params.userAgent } : {}),
    };
    const signers = envelope.signers.map((s) => (s.id === signerId ? updatedSigner : s));
    const allSigned = signers.every((s) => s.status === "signed");
    const updated: SignatureEnvelope = {
      ...envelope,
      signers,
      ...(allSigned ? { status: "completed", completedAt: now } : {}),
    };
    this.#byId.set(envelope.id, updated);
    return updated;
  }

  /** A signer refusing to sign. Moves the whole envelope to `"declined"` — a document missing a required signature can't be partially executed. */
  declineBySigner(envelopeId: string, signerId: string, reason: string): SignatureEnvelope {
    const envelope = this.#requireSendable(envelopeId);
    const signer = this.#requireSigner(envelope, signerId);
    const now = new Date().toISOString();
    const signers = envelope.signers.map((s) =>
      s.id === signerId ? { ...s, status: "declined" as const, declinedAt: now, declineReason: reason } : s,
    );
    const updated: SignatureEnvelope = { ...envelope, signers, status: "declined" };
    this.#byId.set(envelope.id, updated);
    return updated;
  }

  /** Attaches the certificate-stamped final PDF once every signer has signed — a separate step because building it is async (pdf-lib). */
  setFinalDocument(envelopeId: string, finalPdfContent: string): SignatureEnvelope {
    const envelope = this.#byId.get(envelopeId);
    if (!envelope) throw new EsignatureError(`no signature envelope '${envelopeId}'`);
    if (envelope.status !== "completed") {
      throw new EsignatureError(`cannot attach a final document to envelope '${envelopeId}' in status '${envelope.status}'`);
    }
    const updated: SignatureEnvelope = { ...envelope, finalPdfContent };
    this.#byId.set(envelopeId, updated);
    return updated;
  }

  /** Only a still-pending (`"sent"`) envelope can be voided — a completed signature can't be un-signed, the same "void, don't edit" reasoning as a sent invoice. */
  void(envelopeId: string, by: string, reason: string): SignatureEnvelope {
    const envelope = this.#byId.get(envelopeId);
    if (!envelope) throw new EsignatureError(`no signature envelope '${envelopeId}'`);
    if (envelope.status !== "sent") {
      throw new EsignatureError(`cannot void envelope '${envelopeId}' in status '${envelope.status}' — only a pending request can be withdrawn`);
    }
    const updated: SignatureEnvelope = {
      ...envelope,
      status: "voided",
      voidedAt: new Date().toISOString(),
      voidedBy: by,
      voidReason: reason,
    };
    this.#byId.set(envelopeId, updated);
    return updated;
  }

  #requireSendable(envelopeId: string): SignatureEnvelope {
    const envelope = this.#byId.get(envelopeId);
    if (!envelope) throw new EsignatureError(`no signature envelope '${envelopeId}'`);
    if (envelope.status !== "sent") {
      throw new EsignatureError(`envelope '${envelopeId}' is no longer open for signing (status '${envelope.status}')`);
    }
    return envelope;
  }

  #requireSigner(envelope: SignatureEnvelope, signerId: string): Signer {
    const signer = envelope.signers.find((s) => s.id === signerId);
    if (!signer) throw new EsignatureError(`no signer '${signerId}' on envelope '${envelope.id}'`);
    if (signer.status !== "pending") {
      throw new EsignatureError(`signer '${signerId}' has already ${signer.status === "signed" ? "signed" : "declined"}`);
    }
    return signer;
  }

  toSnapshot(): SignatureEnvelopeSnapshot {
    return this.listAll().map((e) => ({ ...e, signers: e.signers.map((s) => ({ ...s })) }));
  }

  static fromSnapshot(snapshot: SignatureEnvelopeSnapshot): ESignatureStore {
    const store = new ESignatureStore();
    let maxEnvelope = 0;
    let maxSigner = 0;
    for (const envelope of snapshot) {
      store.#byId.set(envelope.id, { ...envelope, signers: envelope.signers.map((s) => ({ ...s })) });
      const envNum = Number(envelope.id.replace(/^env_/, ""));
      if (Number.isFinite(envNum) && envNum > maxEnvelope) maxEnvelope = envNum;
      for (const signer of envelope.signers) {
        const sigNum = Number(signer.id.replace(/^signer_/, ""));
        if (Number.isFinite(sigNum) && sigNum > maxSigner) maxSigner = sigNum;
      }
    }
    store.#nextEnvelopeId = maxEnvelope + 1;
    store.#nextSignerId = maxSigner + 1;
    return store;
  }
}
