import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  StripeCheckoutProvider,
  verifyStripeSignature,
  parseCheckoutSessionCompletedEvent,
} from "../src/integrations/stripe-checkout.js";

function signHeader(body: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

describe("StripeCheckoutProvider.createSession", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("posts form-encoded params with Bearer auth, and returns the session id/url", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: string | undefined;
    let capturedAuth: string | undefined;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = init?.body as string;
      capturedAuth = (init?.headers as Record<string, string>)?.["Authorization"];
      return new Response(JSON.stringify({ id: "cs_test_123", url: "https://checkout.stripe.com/pay/cs_test_123" }), { status: 200 });
    }) as unknown as typeof fetch;

    const provider = new StripeCheckoutProvider({ secretKey: "sk_test_abc" });
    const result = await provider.createSession({
      amountCents: 12_345,
      description: "Invoice INV-1",
      successUrl: "https://docket.example.com/?invoicePaid=1",
      cancelUrl: "https://docket.example.com/?cancelled=1",
      metadata: { matterId: "m1", invoiceId: "inv_1" },
    });

    expect(result).toEqual({ id: "cs_test_123", url: "https://checkout.stripe.com/pay/cs_test_123" });
    expect(capturedUrl).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(capturedAuth).toBe("Bearer sk_test_abc");
    expect(capturedBody).toContain("mode=payment");
    expect(capturedBody).toContain(encodeURIComponent("line_items[0][price_data][unit_amount]") + "=12345");
    expect(capturedBody).toContain(encodeURIComponent("metadata[matterId]") + "=m1");
    expect(capturedBody).toContain(encodeURIComponent("metadata[invoiceId]") + "=inv_1");
  });

  it("throws with the response body on a non-OK response", async () => {
    global.fetch = vi.fn(async () => new Response("card declined", { status: 402 })) as unknown as typeof fetch;
    const provider = new StripeCheckoutProvider({ secretKey: "sk_test_abc" });
    await expect(
      provider.createSession({ amountCents: 100, description: "x", successUrl: "https://x", cancelUrl: "https://y", metadata: {} }),
    ).rejects.toThrow(/402/);
  });

  it("throws if Stripe returns no checkout URL", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ id: "cs_1", url: null }), { status: 200 })) as unknown as typeof fetch;
    const provider = new StripeCheckoutProvider({ secretKey: "sk_test_abc" });
    await expect(
      provider.createSession({ amountCents: 100, description: "x", successUrl: "https://x", cancelUrl: "https://y", metadata: {} }),
    ).rejects.toThrow(/did not return a checkout URL/);
  });
});

describe("verifyStripeSignature", () => {
  const secret = "whsec_test_secret";
  const body = JSON.stringify({ type: "checkout.session.completed" });

  it("accepts a correctly signed header", () => {
    expect(verifyStripeSignature(body, signHeader(body, secret), secret)).toBe(true);
  });

  it("rejects a missing header", () => {
    expect(verifyStripeSignature(body, undefined, secret)).toBe(false);
  });

  it("rejects a wrong secret", () => {
    expect(verifyStripeSignature(body, signHeader(body, "wrong_secret"), secret)).toBe(false);
  });

  it("rejects a tampered body", () => {
    const header = signHeader(body, secret);
    expect(verifyStripeSignature(body + "tampered", header, secret)).toBe(false);
  });

  it("rejects a timestamp outside tolerance (replay protection)", () => {
    const oldTimestamp = Math.floor(Date.now() / 1000) - 10_000;
    expect(verifyStripeSignature(body, signHeader(body, secret, oldTimestamp), secret)).toBe(false);
  });

  it("accepts when at least one of multiple v1 signatures matches (secret rotation)", () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const goodSig = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
    const header = `t=${timestamp},v1=deadbeef,v1=${goodSig}`;
    expect(verifyStripeSignature(body, header, secret)).toBe(true);
  });

  it("rejects an unparseable header", () => {
    expect(verifyStripeSignature(body, "garbage", secret)).toBe(false);
  });
});

describe("parseCheckoutSessionCompletedEvent", () => {
  it("parses a well-formed checkout.session.completed event", () => {
    const raw = JSON.stringify({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_1",
          payment_intent: "pi_test_1",
          amount_total: 5000,
          metadata: { matterId: "m1", invoiceId: "inv_1" },
        },
      },
    });
    expect(parseCheckoutSessionCompletedEvent(raw)).toEqual({
      sessionId: "cs_test_1",
      paymentIntentId: "pi_test_1",
      amountTotalCents: 5000,
      matterId: "m1",
      invoiceId: "inv_1",
    });
  });

  it("returns undefined for a different event type", () => {
    const raw = JSON.stringify({ type: "payment_intent.succeeded", data: { object: {} } });
    expect(parseCheckoutSessionCompletedEvent(raw)).toBeUndefined();
  });

  it("returns undefined when metadata is missing matterId/invoiceId", () => {
    const raw = JSON.stringify({
      type: "checkout.session.completed",
      data: { object: { id: "cs_1", amount_total: 100, metadata: {} } },
    });
    expect(parseCheckoutSessionCompletedEvent(raw)).toBeUndefined();
  });

  it("returns undefined for invalid JSON", () => {
    expect(parseCheckoutSessionCompletedEvent("not json")).toBeUndefined();
  });

  it("tolerates a missing payment_intent, leaving it undefined", () => {
    const raw = JSON.stringify({
      type: "checkout.session.completed",
      data: { object: { id: "cs_1", amount_total: 100, metadata: { matterId: "m1", invoiceId: "inv_1" } } },
    });
    expect(parseCheckoutSessionCompletedEvent(raw)?.paymentIntentId).toBeUndefined();
  });
});
