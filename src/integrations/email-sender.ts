/**
 * Outbound email, behind a vendor-agnostic interface — the same pattern
 * as `SpeechToText`, `PaymentProcessor` and `ClaudeClient` elsewhere in
 * this directory. Nothing above this file knows whether mail leaves via
 * the firm's own SMTP server, a transactional API, or not at all.
 *
 * **What a firm should know before pointing this at a real mailbox.**
 * An invoice is a client communication, so it carries the same
 * confidentiality weight as anything else in this system: the subject
 * line alone names the matter, and the body itemises what was worked on.
 * §5's vendor due-diligence questions therefore apply in full to whoever
 * carries it — retention, whether the provider trains on message
 * content, storage jurisdiction, and subpoena exposure. Using the firm's
 * existing mail server (see `smtp-email.ts`) is usually the least
 * surprising answer, because it puts invoices on exactly the same
 * footing as every other email the firm already sends.
 */
export interface EmailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface EmailMessage {
  to: string;
  subject: string;
  /** Always required. A text/plain alternative is what makes mail readable everywhere. */
  text: string;
  /** Optional richer alternative, sent as a multipart/alternative sibling of `text`. */
  html?: string;
  replyTo?: string;
  /**
   * Files travelling with the message. Kept small on purpose — an
   * invoice PDF is a few kilobytes, and this transport has no chunking
   * or resumption, so it is not the place for a scanned exhibit.
   */
  attachments?: EmailAttachment[];
}

export interface EmailResult {
  /** The transport's own id where it provides one, kept on the invoice's delivery record. */
  messageId: string | undefined;
}

export interface EmailSender {
  readonly name: string;
  /** Whether this sender can actually deliver mail, or is a placeholder. */
  readonly canSend: boolean;
  readonly fromAddress: string;
  send(message: EmailMessage): Promise<EmailResult>;
}

/**
 * The default when no mail transport is configured. It refuses rather
 * than pretending, so the UI can say "email isn't set up" up front
 * instead of reporting a send that silently went nowhere — the same
 * reasoning as `ManualPaymentProcessor` reporting `canCharge: false`.
 */
export class UnconfiguredEmailSender implements EmailSender {
  readonly name = "unconfigured";
  readonly canSend = false;
  readonly fromAddress = "";

  async send(): Promise<EmailResult> {
    throw new Error(
      "no email transport is configured — set SMTP_HOST/SMTP_FROM to email invoices, or download the invoice and send it yourself",
    );
  }
}

/**
 * Rejects the shapes that would let a caller-supplied address inject a
 * second recipient or extra headers. This matters because the address
 * reaches an SMTP conversation where a bare newline starts a new
 * command, and an invoice is a privileged document: an injected `Bcc`
 * would silently copy a client's bill to an outsider.
 *
 * Deliberately conservative rather than fully RFC 5322 compliant —
 * rejecting an exotic-but-legal address costs someone a support
 * question, and the failure in the other direction leaks privileged
 * material.
 */
export function assertSafeEmailAddress(address: string): string {
  const trimmed = address.trim();
  if (!trimmed) throw new Error("an email address is required");
  if (!/^[^\s<>,;"'\\]+@[^\s<>,;"'\\@]+\.[a-z]{2,}$/i.test(trimmed)) {
    throw new Error(`'${address}' does not look like a single email address`);
  }
  return trimmed;
}
