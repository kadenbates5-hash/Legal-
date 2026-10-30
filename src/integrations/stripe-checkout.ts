import { createHmac, timingSafeEqual } from "node:crypto";
import type { CheckoutProvider, CheckoutSessionRequest, CheckoutSessionResult } from "./checkout-provider.js";

const STRIPE_API_BASE = "https://api.stripe.com/v1";

/** Stripe's REST API is form-encoded, with PHP-style bracket notation for nested/array params — there is no JSON request body. */
function toFormParams(input: Record<string, unknown>, prefix = ""): string[] {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      value.forEach((item, i) => parts.push(...toFormParams({ [i]: item }, fullKey)));
    } else if (typeof value === "object") {
      parts.push(...toFormParams(value as Record<string, unknown>, fullKey));
    } else {
      parts.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts;
}

/**
 * Hand-rolled over `fetch` — no `stripe` SDK — same dependency-light
 * style as every other integration in this directory (Twilio, Google
 * Calendar, Anthropic, SMTP). Stripe's REST API needs nothing more than
 * Bearer auth and form encoding, so pulling in the SDK for one endpoint
 * would be the kind of dependency this project has deliberately avoided
 * elsewhere (`pg`/`pdf-parse`/`pdf-lib` are the three justified
 * exceptions, each wrapping something not reasonable to reimplement —
 * a REST call is not that).
 */
export class StripeCheckoutProvider implements CheckoutProvider {
  readonly name = "stripe";
  #secretKey: string;

  constructor(params: { secretKey: string }) {
    this.#secretKey = params.secretKey;
  }

  async createSession(request: CheckoutSessionRequest): Promise<CheckoutSessionResult> {
    const currency = request.currency ?? "usd";
    const body = toFormParams({
      mode: "payment",
      success_url: request.successUrl,
      cancel_url: request.cancelUrl,
      metadata: request.metadata,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency,
            unit_amount: request.amountCents,
            product_data: { name: request.description },
          },
        },
      ],
    }).join("&");

    const res = await fetch(`${STRIPE_API_BASE}/checkout/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Stripe checkout session creation failed (${res.status}): ${text.slice(0, 500)}`);
    }
    const data = (await res.json()) as { id: string; url: string | null };
    if (!data.url) throw new Error("Stripe did not return a checkout URL");
    return { id: data.id, url: data.url };
  }
}

/**
 * Stripe's webhook signing scheme: the `Stripe-Signature` header carries
 * `t=<unix timestamp>,v1=<hex hmac>[,v1=<hex hmac>...]` (more than one
 * `v1` appears during a secret rotation window — any match is accepted).
 * The signed payload is `${timestamp}.${rawBody}`, HMAC-SHA256 with the
 * webhook's signing secret. Fails closed on a missing header, an
 * unparseable one, every `v1` mismatching, or a timestamp outside
 * `toleranceSeconds` (replay protection) — same "fail closed on a
 * missing/wrong signature" posture as `twilio-voice.ts`'s
 * `verifyTwilioSignature`.
 */
export function verifyStripeSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
  toleranceSeconds = 300,
): boolean {
  if (!header) return false;
  const parts = new Map<string, string[]>();
  for (const segment of header.split(",")) {
    const eq = segment.indexOf("=");
    if (eq === -1) continue;
    const key = segment.slice(0, eq).trim();
    const value = segment.slice(eq + 1).trim();
    const existing = parts.get(key) ?? [];
    existing.push(value);
    parts.set(key, existing);
  }
  const timestamp = parts.get("t")?.[0];
  const signatures = parts.get("v1") ?? [];
  if (!timestamp || signatures.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSeconds) return false;

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  return signatures.some((sig) => {
    const sigBuf = Buffer.from(sig, "hex");
    return sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf);
  });
}

export interface StripeCheckoutCompletedEvent {
  sessionId: string;
  /** Absent only if Stripe's payload shape ever changes unexpectedly — callers should treat that as "nothing to reconcile against" rather than guessing a reference. */
  paymentIntentId: string | undefined;
  amountTotalCents: number;
  matterId: string;
  invoiceId: string;
}

/**
 * Parses a `checkout.session.completed` webhook body into the one shape
 * `InvoicingService.recordCheckoutPayment` needs — `undefined` for any
 * other event type, or a `checkout.session.completed` event missing the
 * `matterId`/`invoiceId` metadata this app always sets when it creates
 * the session (see `InvoicingService.createCheckoutSession`). Exported
 * standalone so the parsing rules are unit-testable without a live
 * Stripe webhook, same reasoning as `google-calendar.ts`'s
 * `parseDeadlineEvent()`.
 */
export function parseCheckoutSessionCompletedEvent(rawBody: string): StripeCheckoutCompletedEvent | undefined {
  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return undefined;
  }
  if (typeof event !== "object" || event === null) return undefined;
  const e = event as { type?: unknown; data?: { object?: unknown } };
  if (e.type !== "checkout.session.completed") return undefined;
  const session = e.data?.object as
    | { id?: unknown; payment_intent?: unknown; amount_total?: unknown; metadata?: { matterId?: unknown; invoiceId?: unknown } }
    | undefined;
  if (!session || typeof session.id !== "string") return undefined;
  const matterId = session.metadata?.matterId;
  const invoiceId = session.metadata?.invoiceId;
  if (typeof matterId !== "string" || typeof invoiceId !== "string") return undefined;
  if (typeof session.amount_total !== "number") return undefined;
  return {
    sessionId: session.id,
    paymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : undefined,
    amountTotalCents: session.amount_total,
    matterId,
    invoiceId,
  };
}
