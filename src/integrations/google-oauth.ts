/**
 * Hand-rolled OAuth 2.0 Authorization Code flow against Google's own
 * endpoints, over plain `fetch` — same dependency-light choice
 * `google-calendar.ts`'s service-account JWT flow already makes over
 * `googleapis`/`google-auth-library`. This is the *other* way Docket
 * can authenticate to Google Calendar: instead of one shared service
 * account calendar for the whole firm, each attorney can connect their
 * own Google account from the Security panel (see
 * `calendar-connection-service.ts`), and appointments/deadlines for a
 * matter they're responsible for sync against their own calendar.
 *
 * Deliberately narrow: these are pure request-building/response-parsing
 * functions, unit-testable without a live Google OAuth consent screen
 * (same reasoning `parseDeadlineEvent()`/`buildAppointmentEventBody()`
 * give for staying exported and standalone) — nothing here stores a
 * token or decides who's connecting; that's `calendar-connection-
 * service.ts`'s job.
 */

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo";

/** The one scope this integration ever asks for — read/write access to events, nothing broader (no Drive, no profile beyond the email used to label the connection in the UI). */
export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events email";

export function buildGoogleAuthUrl(params: { clientId: string; redirectUri: string; state: string }): string {
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_CALENDAR_SCOPE);
  url.searchParams.set("state", params.state);
  // Without these two, Google issues a refresh token only on the
  // *first* consent ever granted for this client+account — exactly
  // wrong for "reconnect after disconnecting," which needs a fresh
  // one every time.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

export interface GoogleTokens {
  accessToken: string;
  /** Present on the *first* exchange for a given consent; a refresh-token response never repeats it. */
  refreshToken: string | undefined;
  expiresInSeconds: number;
}

async function parseTokenResponse(res: Response, action: string): Promise<GoogleTokens> {
  if (!res.ok) {
    throw new Error(`Google OAuth ${action} failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!body.access_token) {
    throw new Error(`Google OAuth ${action} response did not include an access_token`);
  }
  return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresInSeconds: body.expires_in ?? 3600 };
}

export async function exchangeCodeForTokens(params: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<GoogleTokens> {
  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: params.redirectUri,
      code: params.code,
      grant_type: "authorization_code",
    }).toString(),
  });
  return parseTokenResponse(res, "code exchange");
}

/**
 * The refresh-token grant never returns a new refresh token itself —
 * the original one (stored once, at connect time) keeps working until
 * the account holder revokes access or disconnects from the Security
 * panel.
 */
export async function refreshAccessToken(params: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<GoogleTokens> {
  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      refresh_token: params.refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  return parseTokenResponse(res, "token refresh");
}

/** Best-effort — used only to label a connection ("connected as x@gmail.com") in the Security panel, never to authorize anything. A failure here doesn't fail the connection itself. */
export async function fetchGoogleAccountEmail(accessToken: string): Promise<string | undefined> {
  try {
    const res = await fetch(GOOGLE_USERINFO_ENDPOINT, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { email?: string };
    return body.email;
  } catch {
    return undefined;
  }
}
