import { describe, expect, it } from "vitest";
import { ESignatureStore, EsignatureError } from "../src/core/esignature.js";

function create(store: ESignatureStore, signerCount = 1) {
  return store.create({
    matterId: "m1",
    title: "Engagement Letter",
    sourceKind: "document" as const,
    sourceId: "doc_1",
    documentHash: "deadbeef",
    pdfContent: Buffer.from("fake pdf bytes").toString("base64"),
    createdBy: "a1",
    signers: Array.from({ length: signerCount }, (_, i) => ({ name: `Signer ${i + 1}`, email: `signer${i + 1}@example.com` })),
  });
}

describe("ESignatureStore", () => {
  it("creates an envelope with one token per signer, and the tokens aren't the signer ids", () => {
    const store = new ESignatureStore();
    const { envelope, tokens } = create(store, 2);
    expect(envelope.status).toBe("sent");
    expect(envelope.signers).toHaveLength(2);
    for (const signer of envelope.signers) {
      expect(tokens[signer.id]).toBeDefined();
      expect(tokens[signer.id]).not.toBe(signer.id);
      expect(signer.tokenHash).not.toBe(tokens[signer.id]); // never stored in the clear
    }
  });

  it("refuses to create an envelope with no signers", () => {
    const store = new ESignatureStore();
    expect(() =>
      store.create({
        matterId: "m1",
        title: "x",
        sourceKind: "document",
        sourceId: "doc_1",
        documentHash: "h",
        pdfContent: "",
        createdBy: "a1",
        signers: [],
      }),
    ).toThrow(EsignatureError);
  });

  it("resolves a signer by their real token, not by a guessed or empty one", () => {
    const store = new ESignatureStore();
    const { envelope, tokens } = create(store);
    const token = tokens[envelope.signers[0]!.id]!;
    const found = store.findSignerByToken(token);
    expect(found?.envelope.id).toBe(envelope.id);
    expect(found?.signer.id).toBe(envelope.signers[0]!.id);
    expect(store.findSignerByToken("not-a-real-token")).toBeUndefined();
    expect(store.findSignerByToken("")).toBeUndefined();
  });

  it("completes the envelope only once every signer has signed", () => {
    const store = new ESignatureStore();
    const { envelope, tokens } = create(store, 2);
    const [s1, s2] = envelope.signers;
    const afterFirst = store.recordSignature(envelope.id, s1!.id, { signatureText: "Jane Doe" });
    expect(afterFirst.status).toBe("sent");
    expect(afterFirst.signers.find((s) => s.id === s1!.id)?.status).toBe("signed");

    const afterSecond = store.recordSignature(envelope.id, s2!.id, { signatureText: "John Roe" });
    expect(afterSecond.status).toBe("completed");
    expect(afterSecond.completedAt).toBeDefined();
    expect(afterSecond.signers.every((s) => s.status === "signed")).toBe(true);

    // A signed token can't be used again.
    expect(() => store.recordSignature(envelope.id, s1!.id, { signatureText: "Jane Doe" })).toThrow(EsignatureError);
    // And it no longer resolves at all — the envelope is no longer "sent".
    expect(store.findSignerByToken(tokens[s1!.id]!)).toBeUndefined();
  });

  it("declining moves the whole envelope to declined, not just that signer", () => {
    const store = new ESignatureStore();
    const { envelope } = create(store, 2);
    const [s1] = envelope.signers;
    const updated = store.declineBySigner(envelope.id, s1!.id, "won't sign this version");
    expect(updated.status).toBe("declined");
    expect(updated.signers.find((s) => s.id === s1!.id)?.status).toBe("declined");
    expect(updated.signers.find((s) => s.id === s1!.id)?.declineReason).toBe("won't sign this version");
  });

  it("attaches the final document only once completed", () => {
    const store = new ESignatureStore();
    const { envelope } = create(store, 1);
    expect(() => store.setFinalDocument(envelope.id, "final")).toThrow(EsignatureError);
    store.recordSignature(envelope.id, envelope.signers[0]!.id, { signatureText: "Jane Doe" });
    const updated = store.setFinalDocument(envelope.id, "final-bytes");
    expect(updated.finalPdfContent).toBe("final-bytes");
  });

  it("voids only a still-pending envelope, never a completed one", () => {
    const store = new ESignatureStore();
    const { envelope: pending } = create(store, 1);
    const voided = store.void(pending.id, "a1", "client withdrew the request");
    expect(voided.status).toBe("voided");
    expect(voided.voidReason).toBe("client withdrew the request");

    const { envelope: toComplete } = create(store, 1);
    store.recordSignature(toComplete.id, toComplete.signers[0]!.id, { signatureText: "Jane Doe" });
    expect(() => store.void(toComplete.id, "a1", "too late")).toThrow(EsignatureError);
  });

  it("rejects an expired token", () => {
    const store = new ESignatureStore();
    const { envelope, tokens } = create(store);
    const signer = envelope.signers[0]!;
    // Reach into the snapshot to backdate the expiry, the same way other
    // time-boxed-secret tests in this project simulate elapsed time.
    const snapshot = store.toSnapshot();
    snapshot[0]!.signers[0]!.tokenExpiresAt = new Date(Date.now() - 1000).toISOString();
    const expiredStore = ESignatureStore.fromSnapshot(snapshot);
    expect(expiredStore.findSignerByToken(tokens[signer.id]!)).toBeUndefined();
  });

  it("round-trips through toSnapshot/fromSnapshot, including signer status", () => {
    const store = new ESignatureStore();
    const { envelope } = create(store, 2);
    store.recordSignature(envelope.id, envelope.signers[0]!.id, { signatureText: "Jane Doe", ipAddress: "127.0.0.1" });
    const snapshot = store.toSnapshot();

    const reloaded = ESignatureStore.fromSnapshot(snapshot);
    const reloadedEnvelope = reloaded.get(envelope.id);
    expect(reloadedEnvelope?.signers.find((s) => s.id === envelope.signers[0]!.id)?.status).toBe("signed");
    expect(reloadedEnvelope?.signers.find((s) => s.id === envelope.signers[0]!.id)?.ipAddress).toBe("127.0.0.1");

    // New ids after reload keep incrementing rather than colliding with what's already there.
    const { envelope: fresh } = create(reloaded, 1);
    expect(fresh.id).not.toBe(envelope.id);
    expect(reloaded.get(fresh.id)).toBeDefined();
  });

  it("lists envelopes by matter", () => {
    const store = new ESignatureStore();
    create(store, 1);
    const other = store.create({
      matterId: "m2",
      title: "Other matter",
      sourceKind: "document",
      sourceId: "doc_2",
      documentHash: "h2",
      pdfContent: "",
      createdBy: "a1",
      signers: [{ name: "X", email: "x@example.com" }],
    });
    expect(store.listByMatter("m1")).toHaveLength(1);
    expect(store.listByMatter("m2")).toHaveLength(1);
    expect(store.listByMatter("m2")[0]!.id).toBe(other.envelope.id);
  });
});
