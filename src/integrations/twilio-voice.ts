import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Twilio-specific pieces of the telephony integration — everything that
 * actually knows this vendor is Twilio. `voice-call-sessions.ts` (the
 * session/turn logic) and `voicebox.ts` (STT/TTS) stay vendor-agnostic;
 * this file is only: verifying a webhook really came from Twilio,
 * building the TwiML XML Twilio expects back, and downloading a
 * completed call recording so it can be handed to `SpeechToText`.
 *
 * Twilio webhooks aren't Docket user sessions — there's no cookie, no
 * `x-system-api-key`. `verifyTwilioSignature` is the entire auth story
 * for these routes, so it fails closed (any mismatch, including a
 * missing signature, is a rejection) and uses a timing-safe comparison.
 */

/**
 * Twilio's signature algorithm: HMAC-SHA1 over the exact webhook URL
 * (scheme+host+path+query, as configured in the Twilio console) with
 * every POST parameter's key immediately followed by its value, sorted by
 * key name and appended directly to the URL — see Twilio's "Validating
 * Requests" docs. `url` must be the full public URL Twilio was configured
 * to call, not a path.
 */
export function verifyTwilioSignature(params: {
  authToken: string;
  url: string;
  formParams: Record<string, string>;
  signature: string | undefined;
}): boolean {
  if (!params.signature) return false;

  const sortedKeys = Object.keys(params.formParams).sort();
  let data = params.url;
  for (const key of sortedKeys) {
    data += key + params.formParams[key];
  }

  const expected = createHmac("sha1", params.authToken).update(data, "utf8").digest("base64");
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(params.signature);
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** `<Play>` the given audio, then `<Record>` the caller's reply back to `recordingActionUrl`. */
export function twimlPlayThenRecord(params: { audioUrl: string; recordingActionUrl: string }): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Play>${escapeXml(params.audioUrl)}</Play>` +
    `<Record action="${escapeXml(params.recordingActionUrl)}" method="POST" maxLength="30" playBeep="true" trimSilence="true" />` +
    `</Response>`
  );
}

/** `<Play>` the given audio, then hang up — the conversation-ending turn. */
export function twimlPlayThenHangup(params: { audioUrl: string }): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Play>${escapeXml(params.audioUrl)}</Play>` +
    `<Hangup />` +
    `</Response>`
  );
}

/**
 * Downloads a completed recording from Twilio's API (Basic auth with the
 * account SID/auth token — the same credential that authenticates the
 * account, not a per-call token) as WAV bytes.
 */
export async function downloadTwilioRecording(params: {
  recordingUrl: string;
  accountSid: string;
  authToken: string;
}): Promise<Buffer> {
  const url = params.recordingUrl.endsWith(".wav") ? params.recordingUrl : `${params.recordingUrl}.wav`;
  const auth = Buffer.from(`${params.accountSid}:${params.authToken}`).toString("base64");
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) {
    throw new Error(`Twilio recording download failed (${res.status}): ${await res.text()}`);
  }
  return Buffer.from(await res.arrayBuffer());
}
