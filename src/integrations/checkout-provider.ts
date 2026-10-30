/**
 * Vendor-agnostic seam for a *hosted* checkout flow — deliberately
 * separate from `PaymentProcessor` in `payment-processor.ts`. That
 * interface models a direct `charge(token)` call, staff-initiated, for
 * a card already tokenized client-side (e.g. over the phone with a
 * terminal, or Stripe Elements embedded in the app itself). A hosted
 * checkout is a different shape entirely: the browser is redirected to
 * the vendor's own page, the vendor collects the card, and the result
 * comes back asynchronously (a redirect plus a webhook) rather than as
 * the return value of one call — trying to force that into `charge()`
 * would mean pretending an async, redirect-driven flow is synchronous.
 *
 * Same "card data must never reach this server" property as
 * `payment-processor.ts` already requires, taken further: with a hosted
 * checkout, card data never reaches this server even transiently as a
 * token — it goes straight from the browser to the vendor's own page.
 */
export interface CheckoutSessionRequest {
  amountCents: number;
  /** ISO 4217, lowercase (Stripe's convention) — defaults to "usd". */
  currency?: string;
  /** Shown on the vendor's hosted page as the line item description. */
  description: string;
  /** Where the browser lands after a successful payment. */
  successUrl: string;
  /** Where the browser lands if the payer backs out. */
  cancelUrl: string;
  /**
   * Structured data the vendor echoes back verbatim on the webhook —
   * never parsed from the free-text description, same "trust structured
   * fields, not free text" reasoning as `google-calendar.ts`'s
   * `extendedProperties.private`.
   */
  metadata: Record<string, string>;
}

export interface CheckoutSessionResult {
  id: string;
  /** The vendor's own hosted page — redirect the browser here. */
  url: string;
}

export interface CheckoutProvider {
  readonly name: string;
  createSession(request: CheckoutSessionRequest): Promise<CheckoutSessionResult>;
}
