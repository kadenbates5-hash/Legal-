import type { SmsMessage, SmsResult, SmsSender } from "./sms-sender.js";

/**
 * The real vendor behind `SmsSender`, reusing the exact same
 * `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` credential the voice
 * integration (`twilio-voice.ts`) already authenticates with — a firm
 * that's set up Twilio for the voice channel needs only one more env
 * var (`TWILIO_SMS_FROM_NUMBER`) to also text appointment reminders.
 * Hand-rolled over `fetch` with Basic auth and a `application/
 * x-www-form-urlencoded` body, matching Twilio's REST API directly
 * rather than pulling in the `twilio` SDK — same dependency-light
 * choice `google-calendar.ts` makes over `googleapis`.
 */
export class TwilioSmsSender implements SmsSender {
  readonly name = "twilio";
  readonly canSend = true;

  #accountSid: string;
  #authToken: string;
  #fromNumber: string;

  constructor(params: { accountSid: string; authToken: string; fromNumber: string }) {
    this.#accountSid = params.accountSid;
    this.#authToken = params.authToken;
    this.#fromNumber = params.fromNumber;
  }

  async send(message: SmsMessage): Promise<SmsResult> {
    const auth = Buffer.from(`${this.#accountSid}:${this.#authToken}`).toString("base64");
    const body = new URLSearchParams({ To: message.to, From: this.#fromNumber, Body: message.text });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.#accountSid}/Messages.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      throw new Error(`Twilio SMS send failed (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as { sid?: string };
    return { messageId: data.sid };
  }
}
