import { afterEach, describe, expect, it } from "vitest";
import { randomBytes, scryptSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { ESignatureStore } from "../src/core/esignature.js";
import { AuthService, AuthError, MAX_LIVE_PASSWORD_RESETS_PER_ACCOUNT } from "../src/core/auth.js";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import type { EmailMessage, EmailResult, EmailSender } from "../src/integrations/email-sender.js";

/*
 * Signing links and reset links are checked on routes anyone can reach
 * without signing in. Each check used to cost one scrypt per *stored*
 * link, so 30 signatures out for signing made every request to
 * /api/sign/<anything> block the server for ~1.5 s. And sign-in, reset
 * requests and the reset email all answered faster for usernames that
 * don't exist, which lists the firm's accounts to anyone with a stopwatch.
 */

function sendEnvelope(store: ESignatureStore, i: number) {
  return store.create({
    matterId: `m${i}`,
    title: "Engagement Letter",
    sourceKind: "document",
    sourceId: `doc_${i}`,
    documentHash: "deadbeef",
    pdfContent: Buffer.from("pdf").toString("base64"),
    createdBy: "a1",
    signers: [{ name: `Signer ${i}`, email: `s${i}@example.com` }],
  });
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function timeOf(fn: () => void): number {
  const start = performance.now();
  try {
    fn();
  } catch {
    /* only the time matters here */
  }
  return performance.now() - start;
}

describe("signing links", () => {
  it("are found in one hash, however many are outstanding", () => {
    const store = new ESignatureStore();
    const issued = Array.from({ length: 200 }, (_, i) => sendEnvelope(store, i));
    const last = issued[issued.length - 1]!;
    const lastToken = last.tokens[last.envelope.signers[0]!.id]!;

    const miss = timeOf(() => store.findSignerByToken(randomBytes(24).toString("hex")));
    const hit = timeOf(() => store.findSignerByToken(lastToken));
    // scrypt took ~50 ms per stored link; 200 of them would be ~10 s.
    expect(miss).toBeLessThan(100);
    expect(hit).toBeLessThan(100);
    expect(store.findSignerByToken(lastToken)?.envelope.id).toBe(last.envelope.id);
  });

  it("aren't stored as the token, or as anything a salt is needed to check", () => {
    const store = new ESignatureStore();
    const { envelope, tokens } = sendEnvelope(store, 1);
    const signer = envelope.signers[0]!;
    expect(signer.tokenHash).not.toContain(tokens[signer.id]!);
    expect(signer.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(signer.tokenSalt).toBe("");
  });

  it("turn away anything that isn't shaped like a link token, before hashing", () => {
    const store = new ESignatureStore();
    const { envelope, tokens } = sendEnvelope(store, 1);
    const token = tokens[envelope.signers[0]!.id]!;
    expect(store.findSignerByToken(token.toUpperCase())).toBeUndefined();
    expect(store.findSignerByToken(`${token}0`)).toBeUndefined();
    expect(store.findSignerByToken("x".repeat(100_000))).toBeUndefined();
    expect(store.findSignerByToken(token)).toBeDefined();
  });

  it("issued before the change still open until they expire", () => {
    const store = new ESignatureStore();
    sendEnvelope(store, 1);
    const snapshot = store.toSnapshot();
    const legacyToken = randomBytes(24).toString("hex");
    const salt = randomBytes(16).toString("hex");
    snapshot[0]!.signers[0] = {
      ...snapshot[0]!.signers[0]!,
      tokenSalt: salt,
      tokenHash: scryptSync(legacyToken, salt, 64).toString("hex"),
    };
    const restored = ESignatureStore.fromSnapshot(snapshot);
    expect(restored.findSignerByToken(legacyToken)?.envelope.id).toBe(snapshot[0]!.id);
    expect(restored.findSignerByToken(randomBytes(24).toString("hex"))).toBeUndefined();
  });
});

describe("password reset links", () => {
  it("are capped per account, so nobody can fill an inbox with them", () => {
    const auth = new AuthService();
    auth.createUser({ username: "alice", password: "old-password", role: "attorney" });
    const issued = Array.from({ length: MAX_LIVE_PASSWORD_RESETS_PER_ACCOUNT }, () => auth.requestPasswordReset("alice"));
    expect(issued.every(Boolean)).toBe(true);
    expect(auth.requestPasswordReset("alice")).toBeUndefined();
    expect(auth.toSnapshot().passwordResetRequests).toHaveLength(MAX_LIVE_PASSWORD_RESETS_PER_ACCOUNT);

    // Every issued link still works; using one frees a place.
    auth.resetPasswordWithToken(issued[0]!.token, "brand-new-password");
    expect(auth.requestPasswordReset("alice")).toBeDefined();
  });

  it("are checked in one hash, and garbage isn't hashed at all", () => {
    const auth = new AuthService();
    for (let i = 0; i < 20; i++) {
      auth.createUser({ username: `user${i}`, password: "old-password", role: "attorney" });
      for (let j = 0; j < 3; j++) auth.requestPasswordReset(`user${i}`);
    }
    expect(auth.toSnapshot().passwordResetRequests).toHaveLength(60);
    const elapsed = timeOf(() => auth.resetPasswordWithToken(randomBytes(24).toString("hex"), "brand-new-password"));
    expect(elapsed).toBeLessThan(100); // was ~50 ms × 60 links
    expect(() => auth.resetPasswordWithToken("nope", "brand-new-password")).toThrow(/invalid or has expired/);
  });

  it("issued before the change still redeem", () => {
    const auth = new AuthService();
    const alice = auth.createUser({ username: "alice", password: "old-password", role: "attorney" });
    const legacyToken = randomBytes(24).toString("hex");
    const salt = randomBytes(16).toString("hex");
    const snapshot = auth.toSnapshot();
    snapshot.passwordResetRequests = [
      {
        userId: alice.id,
        hash: scryptSync(legacyToken, salt, 64).toString("hex"),
        salt,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ];
    const restored = AuthService.fromSnapshot(snapshot);
    expect(restored.resetPasswordWithToken(legacyToken, "brand-new-password").id).toBe(alice.id);
    expect(() => restored.login("alice", "brand-new-password", false)).not.toThrow();
  });
});

describe("signing in", () => {
  it("takes as long for a username that doesn't exist as for a wrong password", () => {
    const auth = new AuthService();
    auth.createUser({ username: "alice", password: "correct-horse", role: "attorney" });
    const bob = auth.createUser({ username: "bob", password: "correct-horse", role: "attorney" });
    auth.setDisabled(bob.id, true);

    const wrongPassword: number[] = [];
    const noSuchUser: number[] = [];
    const disabled: number[] = [];
    for (let i = 0; i < 5; i++) {
      wrongPassword.push(timeOf(() => auth.login("alice", "wrong-password", false)));
      noSuchUser.push(timeOf(() => auth.login("nobody-here", "wrong-password", false)));
      disabled.push(timeOf(() => auth.login("bob", "correct-horse", false)));
    }
    // Before: ~0 ms against ~50 ms. A generous bound, so a busy machine can't flake it.
    expect(median(noSuchUser)).toBeGreaterThan(median(wrongPassword) * 0.4);
    expect(median(disabled)).toBeGreaterThan(median(wrongPassword) * 0.4);
    expect(() => auth.login("nobody-here", "wrong-password", false)).toThrow(AuthError);
    expect(() => auth.login("bob", "correct-horse", false)).toThrow("invalid username or password");
  });
});

describe("POST /api/forgot-password", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it("answers without waiting for the mail server, so a real account doesn't answer later", async () => {
    const sent: EmailMessage[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const slowMail: EmailSender = {
      name: "slow",
      canSend: true,
      fromAddress: "firm@example.com",
      async send(message: EmailMessage): Promise<EmailResult> {
        await held; // a mail server that takes its time
        sent.push(message);
        return { messageId: "m1" };
      },
    };
    const auth = new AuthService();
    auth.createUser({ username: "alice", password: "old-password", role: "attorney", email: "alice@example.com" });
    server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, {
      passwordReset: { email: slowMail, baseUrl: "https://docket.example.com" },
    });
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const res = await Promise.race([
      fetch(`${base}/api/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "alice" }),
      }),
      new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), 2_000)),
    ]);
    expect(res).not.toBe("timed out");
    expect((res as Response).status).toBe(200);
    expect(sent).toHaveLength(0); // the reply came first

    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("/reset-password.html?token=");
  });

  it("keeps answering the same way when the mail server fails", async () => {
    const failingMail: EmailSender = {
      name: "broken",
      canSend: true,
      fromAddress: "firm@example.com",
      async send(): Promise<EmailResult> {
        throw new Error("connection refused");
      },
    };
    const auth = new AuthService();
    auth.createUser({ username: "alice", password: "old-password", role: "attorney", email: "alice@example.com" });
    server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, {
      passwordReset: { email: failingMail, baseUrl: "https://docket.example.com" },
    });
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const ask = async (username: string) =>
      (
        await fetch(`${base}/api/forgot-password`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username }),
        })
      ).json();
    expect(await ask("alice")).toEqual(await ask("nobody"));
    // And the server is still up after the failed send.
    expect((await fetch(`${base}/api/me`)).status).toBe(401);
  });
});
