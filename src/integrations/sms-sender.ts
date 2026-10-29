/**
 * Outbound SMS, behind a vendor-agnostic interface — the same pattern
 * `email-sender.ts` already uses for mail, and `SpeechToText`/
 * `PaymentProcessor`/`ClaudeClient` use elsewhere in this directory.
 * Nothing above this file knows whether a text message leaves via
 * Twilio or any other carrier.
 *
 * **What a firm should know before pointing this at a real phone
 * number.** An appointment reminder names the firm and the appointment
 * type — nothing as sensitive as an invoice's itemisation, but still a
 * client communication, so §5's vendor due-diligence questions
 * (retention, training on message content, storage jurisdiction,
 * subpoena exposure) still apply to whichever carrier sends it.
 */
export interface SmsMessage {
  /** E.164 format (e.g. "+15551234567") — the shape every SMS carrier's API expects. */
  to: string;
  text: string;
}

export interface SmsResult {
  /** The carrier's own id where it provides one, kept the same way EmailResult's messageId is. */
  messageId: string | undefined;
}

export interface SmsSender {
  readonly name: string;
  /** Whether this sender can actually deliver texts, or is a placeholder. */
  readonly canSend: boolean;
  send(message: SmsMessage): Promise<SmsResult>;
}

/**
 * The default when no SMS transport is configured. Refuses rather than
 * pretending, same reasoning as `UnconfiguredEmailSender` — a caller
 * should learn "SMS isn't set up" immediately, not discover a silent
 * no-op later.
 */
export class UnconfiguredSmsSender implements SmsSender {
  readonly name = "unconfigured";
  readonly canSend = false;

  async send(): Promise<SmsResult> {
    throw new Error("no SMS transport is configured — set TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_SMS_FROM_NUMBER to text reminders");
  }
}

/**
 * A conservative E.164 check — rejects almost anything that isn't a
 * plain "+" followed by digits, rather than trying to validate every
 * country's numbering plan. Same reasoning `assertSafeEmailAddress`
 * gives for its own strictness: a false rejection costs a support
 * question, sending to a malformed number costs nothing back at all
 * (the carrier rejects it) — but letting a stray character through
 * uninspected has no upside here.
 */
export function assertSafePhoneNumber(number: string): string {
  const trimmed = number.trim();
  if (!/^\+[1-9]\d{6,14}$/.test(trimmed)) {
    throw new Error(`'${number}' does not look like an E.164 phone number (e.g. +15551234567)`);
  }
  return trimmed;
}
