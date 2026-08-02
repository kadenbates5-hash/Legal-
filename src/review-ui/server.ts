import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { AccessDeniedError, ReviewGateError, type Actor } from "../core/types.js";
import { AuthError, MfaRequiredError, type AuthService } from "../core/auth.js";
import { LoginThrottle } from "../core/login-throttle.js";
import type { AuditLog } from "../core/audit.js";
import type { DeadlineType } from "../core/deadline.js";
import { SchedulingError, type AppointmentType, type SchedulingService } from "../core/scheduling.js";
import { ReviewGateService } from "./review-service.js";
import type { IntakeDemoSessions } from "./intake-demo.js";
import type { AccountsService } from "./accounts-service.js";
import type { DraftingService } from "./drafting-service.js";
import { DEFAULT_MAX_UPLOAD_BYTES, type DocumentsService } from "./documents-service.js";
import type { CasesService } from "./cases-service.js";
import type { AuditService } from "./audit-service.js";
import type { ResearchService } from "./research-service.js";
import type { AssistantService } from "./assistant-service.js";
import type { StaffService } from "./staff-service.js";
import type { MessagingService } from "./messaging-service.js";
import type { StaffScheduleService } from "./staff-schedule-service.js";
import type { StaffScheduleStatus } from "../core/staff-schedule.js";
import type { BillingHoursService } from "./billing-hours-service.js";
import type { PdfReportService } from "./pdf-report-service.js";
import type { MattersService } from "./matters-service.js";
import type { TrustService } from "./trust-service.js";
import type { ClientFileService } from "./client-file-service.js";
import type { InvoicingService } from "./invoicing-service.js";
import type { ClientPortalService } from "./client-portal-service.js";
import type { ClientMessagingService } from "./client-messaging-service.js";
import type { SearchService } from "./search-service.js";
import type { PayrollService } from "./payroll-service.js";
import type { TimeClockService } from "./time-clock-service.js";
import { TimeClockError, type BucketKind } from "../core/time-clock.js";
import { InvoicingError, type LineItemSource, type PaymentMethod } from "../core/invoicing.js";
import { PayrollError } from "../core/payroll.js";
import { TrustAccountingError, type TrustEntryType } from "../core/trust-ledger.js";
import type { MatterStatus, PartyRole } from "../core/matters.js";
import { MatterClosingError } from "./matters-service.js";
import type { VoiceCallSessions } from "../receptionist/voice-call-sessions.js";
import type { AudioClipStore } from "../receptionist/audio-clip-store.js";
import { verifyTwilioSignature, twimlPlayThenRecord, twimlPlayThenHangup, downloadTwilioRecording } from "../integrations/twilio-voice.js";
import type { UserRole } from "../core/auth.js";

/**
 * Attorney review-gate UI backend (§8 build order step 5): a small JSON API
 * over `ReviewGateService`, plus the static dashboard page in `public/`.
 * Deliberately dependency-free (Node's built-in `http`, no framework).
 *
 * Actor identity comes from a session cookie issued by `POST /api/login`
 * and validated against `AuthService` on every request — the earlier
 * `x-actor-id`/`x-actor-role` header stand-in is gone. There is no code
 * path to a valid `Actor` that doesn't go through a real login at least
 * once; "remember me" only extends how long that session lasts (see
 * `core/auth.ts`), it never skips authentication.
 *
 * The one exception is `x-system-api-key`: the calendar-integration
 * machine credential (§5's due-diligence item), which authenticates as
 * role `"system"` without a human session — see `handleDeadlineRequest`'s
 * `calendar_system`-source gating and `review-service.ts`.
 *
 * TLS itself is terminated upstream (a reverse proxy / load balancer), not
 * by this Node process — see `review-ui/start.ts`'s `TRUST_PROXY` env var.
 * When `trustProxy` is on, the session cookie gets the `Secure` flag
 * whenever the proxy reports the original request was HTTPS
 * (`X-Forwarded-Proto: https`); when it's off (the default — safe for
 * local `http://localhost` dev), the header is never trusted and the
 * cookie is never marked `Secure`, since an untrusted proxy could forge
 * that header to make a browser send the cookie over plain HTTP anyway.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const SESSION_COOKIE_NAME = "session_token";

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie;
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

/**
 * Only meaningful when `trustProxy` is true — otherwise a request is never
 * considered secure, no matter what headers it carries, since believing
 * `X-Forwarded-Proto` from an untrusted network path would let anyone
 * forge "this was HTTPS" and get a `Secure` cookie set over plain HTTP.
 */
function isSecureRequest(req: IncomingMessage, trustProxy: boolean): boolean {
  if (!trustProxy) return false;
  const proto = firstHeader(req.headers["x-forwarded-proto"]);
  if (!proto) return false;
  return proto.split(",")[0]!.trim().toLowerCase() === "https";
}

/**
 * The client's address for throttling purposes. `X-Forwarded-For` is
 * client-controllable and only meaningful when something we trust
 * rewrote it, so it's honoured under exactly the same `trustProxy` flag
 * that gates `X-Forwarded-Proto` — otherwise an attacker would defeat
 * per-IP throttling by varying a header. Falls back to the socket
 * address, and to a fixed bucket if even that is unavailable (better to
 * over-group than to silently stop counting).
 */
function clientIpFor(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = firstHeader(req.headers["x-forwarded-for"]);
    const first = forwarded?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

function sessionCookieHeader(token: string, expiresAt: string, secure: boolean): string {
  const maxAgeSeconds = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

/**
 * Resolves the caller's Actor. Checks the system API key first (the
 * calendar integration authenticates as a machine credential, not a human
 * session), then falls back to the session cookie. Throws AuthError if
 * neither is present/valid — callers must catch this and respond 401.
 */
function resolveActor(req: IncomingMessage, auth: AuthService): Actor {
  const apiKey = firstHeader(req.headers["x-system-api-key"]);
  if (apiKey) {
    if (!auth.verifySystemApiKey(apiKey)) {
      throw new AuthError("invalid system API key");
    }
    return { id: "calendar-integration", role: "system" };
  }

  const token = parseCookies(req)[SESSION_COOKIE_NAME];
  const actor = auth.actorForToken(token);
  if (!actor) {
    throw new AuthError("authentication required");
  }
  return actor as Actor;
}

export class RequestBodyTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestBodyTooLargeError";
  }
}

/**
 * Every request body is fully buffered in memory before it's parsed, so
 * without a ceiling a single POST can exhaust the process — and the
 * `DocumentsService` upload cap can't help, since it only runs *after*
 * the body has already been read. This is the real bound.
 *
 * The cap has to clear the largest legitimate request, which is a Cases
 * upload: base64 inflates bytes by 4/3, plus a small JSON envelope. See
 * `maxRequestBodyBytesFor` and `ReviewServerOptions.maxRequestBodyBytes`
 * — `start.ts` derives it from whatever per-file upload cap is
 * configured, so raising one raises the other. The default is derived
 * from `DocumentsService`'s own default rather than restated here, so the
 * two caps can't drift apart.
 */
export function maxRequestBodyBytesFor(maxUploadBytes: number): number {
  return Math.ceil((maxUploadBytes * 4) / 3) + 1024 * 1024;
}

const DEFAULT_MAX_REQUEST_BODY_BYTES = maxRequestBodyBytesFor(DEFAULT_MAX_UPLOAD_BYTES);

/**
 * Set once per request by `handleRequest`/`handleVoiceRequest`, so the
 * body readers can enforce the configured cap without threading it
 * through all ~20 route handlers. A `WeakMap` keeps this per-request and
 * per-server-instance (tests spin up several), with no monkey-patching
 * of `IncomingMessage`.
 */
const requestBodyLimits = new WeakMap<IncomingMessage, number>();

function bodyLimitFor(req: IncomingMessage): number {
  return requestBodyLimits.get(req) ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
}

/**
 * Rejects an oversized body on the declared `Content-Length` before a
 * single byte is buffered. `readBodyBuffer` still counts what actually
 * arrives, since the header is client-supplied and absent entirely on
 * chunked requests.
 */
function enforceContentLength(req: IncomingMessage, maxBytes: number): void {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new RequestBodyTooLargeError(`request body of ${declared} bytes exceeds the ${maxBytes}-byte limit`);
  }
}

async function readBodyBuffer(req: IncomingMessage): Promise<Buffer> {
  const maxBytes = bodyLimitFor(req);
  enforceContentLength(req, maxBytes);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      throw new RequestBodyTooLargeError(`request body exceeds the ${maxBytes}-byte limit`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBodyBuffer(req);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("invalid JSON body");
  }
}

/** Twilio posts webhook bodies as `application/x-www-form-urlencoded`, not JSON. */
async function readFormBody(req: IncomingMessage): Promise<Record<string, string>> {
  const params = new URLSearchParams((await readBodyBuffer(req)).toString("utf8"));
  return Object.fromEntries(params.entries());
}

function sendXml(res: ServerResponse, status: number, xml: string): void {
  res.writeHead(status, { "Content-Type": "text/xml; charset=utf-8", ...SECURITY_HEADERS });
  res.end(xml);
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS, ...extraHeaders });
  res.end(payload);
}

/**
 * A binary download. Kept separate from `sendJson` because an invoice
 * PDF is the one response in this API that isn't JSON — and because
 * `Content-Disposition` has to carry a filename that came from a matter
 * title, so it is quoted and stripped of anything that could terminate
 * the header.
 */
function sendBinary(
  res: ServerResponse,
  contentType: string,
  filename: string,
  data: Buffer,
): void {
  const safe = filename.replace(/[\r\n"\\]/g, "").slice(0, 120) || "download";
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": String(data.byteLength),
    "Content-Disposition": `attachment; filename="${safe}"`,
    ...SECURITY_HEADERS,
  });
  res.end(data);
}

function errorStatus(err: unknown): number {
  if (err instanceof RequestBodyTooLargeError) return 413;
  if (err instanceof AuthError) {
    // Account-creation validation (bad password/duplicate username) is a
    // 400 from an already-authenticated caller, not an auth failure —
    // only login/system-key mismatches are genuinely 401.
    if (err.message.includes("already exists") || err.message.includes("must be at least")) return 400;
    // A wrong *current* password on self-service change is a 403, not a 401 —
    // the caller has a perfectly valid session; a 401 here would trip the
    // dashboard's global "401 means log in again" redirect instead of just
    // showing an inline error and letting them retry.
    if (err.message.includes("current password is incorrect")) return 403;
    return 401;
  }
  if (err instanceof AccessDeniedError) return 403;
  // An overdraw or a double-reversal is a conflict with the ledger's current
  // state, not a malformed request — 409 says "the world says no", not "you typed it wrong".
  if (err instanceof InvoicingError) {
    if (err.message.startsWith("no invoice")) return 404;
    // "can't edit a sent invoice", "exceeds the balance", "already sent" are all
    // conflicts with the invoice's current state rather than malformed input.
    return /must be|is required|needs a|does not look like/.test(err.message) ? 400 : 409;
  }
  if (err instanceof MatterClosingError) return 409;
  if (err instanceof PayrollError) return 400;
  if (err instanceof TimeClockError) {
    // The error says which it is; "already clocked in" / "already posted"
    // are conflicts with the clock's current state, not malformed input.
    return { invalid: 400, not_found: 404, conflict: 409 }[err.kind];
  }
  if (err instanceof TrustAccountingError) {
    return err.message.startsWith("no trust entry") ? 404 : 409;
  }
  if (err instanceof ReviewGateError) return 409;
  if (err instanceof Error && err.message.startsWith("no work product")) return 404;
  if (err instanceof Error && err.message.startsWith("no intake demo session")) return 404;
  if (err instanceof Error && err.message.startsWith("no user")) return 404;
  if (err instanceof Error && err.message.startsWith("no document")) return 404;
  if (err instanceof Error && err.message.startsWith("no matter")) return 404;
  if (err instanceof Error && err.message === "invoicing is not configured on this server") return 404;
  if (err instanceof Error && err.message.startsWith("no trust entry")) return 404;
  if (err instanceof Error && err.message.startsWith("no worked-hours entry")) return 404;
  if (err instanceof Error && err.message.startsWith("no saved reference")) return 404;
  if (err instanceof Error && err.message.startsWith("no assistant session")) return 404;
  if (err instanceof Error && err.message.startsWith("cannot disable")) return 409;
  if (err instanceof Error && err.message.startsWith("matter assignment only applies")) return 400;
  if (err instanceof Error && err.message.startsWith("matter access only applies")) return 400;
  if (err instanceof SchedulingError) {
    return err.message.startsWith("no appointment") ? 404 : 409;
  }
  return 400;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/**
 * Sent on every response. The dashboard's CSS and JS live in real files
 * rather than inline blocks specifically so `script-src 'self'` can be
 * strict here — an inline-script allowance would make the policy little
 * more than decoration, and this is the layer that would contain an XSS
 * bug that slipped past output escaping.
 *
 * `frame-ancestors 'none'` (plus the legacy `X-Frame-Options`) is the
 * clickjacking defense that matters most for this app: the Review Queue
 * has one-click approve/release buttons that release privileged work
 * product, which is exactly what a framed overlay attack would target.
 * `data:` is allowed for images only, since documents download as data
 * URIs.
 */
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
};

/** Static assets other than the dashboard itself are always servable (the login page has to be reachable while logged out). */
async function serveStatic(res: ServerResponse, requestPath: string): Promise<void> {
  const relative = requestPath === "/" ? "index.html" : requestPath.slice(1);
  const resolved = path.normalize(path.join(PUBLIC_DIR, relative));
  // The separator matters: a bare `startsWith(PUBLIC_DIR)` would also accept
  // a sibling directory whose name merely begins with it (`.../public-x`),
  // which `../public-x/secret` would reach.
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }
  try {
    const content = await readFile(resolved);
    const ext = path.extname(resolved);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream", ...SECURITY_HEADERS });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "not found" });
  }
}

/**
 * `onMutated` fires after any successful state-changing request (approve,
 * reject, request-revision, release, clear-flag, appointment booking/
 * changes, login, logout) — a persistence layer can hook this to save
 * after every mutation without this file knowing anything about how or
 * where state is persisted. See `review-ui/start.ts` for the file-backed
 * wiring. `scheduling` is optional — omit it and `/api/appointments*`
 * 404s.
 */
export interface TwilioVoiceConfig {
  accountSid: string;
  authToken: string;
  /** The externally reachable base URL Twilio calls back to and fetches `<Play>` audio from (e.g. https://docket.example.com) — no trailing slash. */
  publicBaseUrl: string;
}

/**
 * `onMutated`/`scheduling`/etc. as an options object rather than a long
 * positional parameter list — this grew past a dozen optional pieces
 * (each gating a `/api/*` surface to 404 when absent) and a positional
 * list that long had already caused real bugs: inserting a new parameter
 * shifted every later positional argument in existing call sites without
 * a type error, since they're all optional. A single object makes an
 * omitted or misplaced piece a missing/misspelled key, not a silent
 * off-by-one.
 */
export interface ReviewServerOptions {
  onMutated?: () => void;
  scheduling?: SchedulingService;
  intake?: IntakeDemoSessions;
  accounts?: AccountsService;
  drafting?: DraftingService;
  documents?: DocumentsService;
  cases?: CasesService;
  audit?: AuditService;
  research?: ResearchService;
  assistant?: AssistantService;
  staff?: StaffService;
  messaging?: MessagingService;
  staffSchedule?: StaffScheduleService;
  billingHours?: BillingHoursService;
  pdfReports?: PdfReportService;
  matters?: MattersService;
  trust?: TrustService;
  clientFile?: ClientFileService;
  invoicing?: InvoicingService;
  clientPortal?: ClientPortalService;
  clientMessaging?: ClientMessagingService;
  search?: SearchService;
  payroll?: PayrollService;
  timeClock?: TimeClockService;
  /** Hard ceiling on any buffered request body — see `maxRequestBodyBytesFor`. Defaults to what a 25 MB upload needs. */
  maxRequestBodyBytes?: number;
  /** Brute-force protection for `POST /api/login`. Absent = unthrottled (tests that don't care); `start.ts` always supplies one. */
  loginThrottle?: LoginThrottle;
  /** Records login success/failure/lockout. The same log the Audit Log panel reads. */
  auditLog?: AuditLog;
  /** Real-call telephony voice channel (see `receptionist/voice-call-sessions.ts`) — `voiceCalls`/`audioClips`/`twilio` must all be set together for `/api/voice/*` to be configured. */
  voiceCalls?: VoiceCallSessions;
  audioClips?: AudioClipStore;
  twilio?: TwilioVoiceConfig;
  /** See the module doc comment above — off by default, only enable behind a real TLS-terminating proxy. */
  trustProxy?: boolean;
  /** Names the firm inside an authenticator app's entry (`otpauth://` issuer). Cosmetic; falls back to "Docket". */
  firmName?: string;
  /**
   * Roles that must have a second factor enrolled before reaching
   * anything beyond `/api/me`, `/api/mfa/*`, `/api/logout`, and
   * `/api/change-password`. Absent (the default) means MFA stays
   * opt-in for everyone — see `MFA_SETUP_ALLOWED_PATHS` below for what
   * "enrolling" itself still has to reach while blocked.
   *
   * Deliberately never blocks *login* — only what a session can do
   * afterward. Refusing the password step itself would mean the only
   * way back in for someone who lost their phone is an attorney's
   * `resetMfa`, and that path requires an attorney to already be able
   * to log in and act. This way the account can always sign in and is
   * routed straight to enrolling, with no one else's help needed
   * unless they've also lost their recovery codes.
   */
  mfaRequiredRoles?: ReadonlySet<UserRole>;
}

/**
 * The only routes an account under a firm-wide MFA requirement can
 * reach before it has enrolled: checking/starting/confirming a factor,
 * signing out, and fixing a password that needs changing first (an
 * attorney-reset password shouldn't have to wait on MFA setup to be
 * replaced). Everything else in `/api/*` is refused with a clear reason
 * rather than a generic 403, so the dashboard can say exactly what to
 * do next instead of just failing.
 */
const MFA_SETUP_ALLOWED_PATHS: readonly string[] = ["/api/me", "/api/mfa", "/api/logout", "/api/change-password"];

function needsMfaSetup(user: { mfa?: unknown; role: UserRole } | undefined, mfaRequiredRoles: ReadonlySet<UserRole> | undefined): boolean {
  return !!user && !!mfaRequiredRoles?.has(user.role) && user.mfa === undefined;
}

export function createReviewServer(service: ReviewGateService, auth: AuthService, options?: ReviewServerOptions): Server {
  return createServer((req, res) => {
    // Last-resort guard: `handleRequest` catches per-route errors itself, but
    // the paths that run before its try block (the Twilio webhook body read,
    // URL parsing) would otherwise reject with nothing attached — and an
    // unhandled rejection terminates the process on modern Node. A request
    // that fails in an unexpected place should fail that one request.
    void handleRequest(service, auth, req, res, options ?? {}).catch((err) => {
      if (!res.headersSent) {
        sendJson(res, errorStatus(err), { error: err instanceof Error ? err.message : "unknown error" });
      } else {
        res.end();
      }
    });
  });
}

async function handleRequest(
  service: ReviewGateService,
  auth: AuthService,
  req: IncomingMessage,
  res: ServerResponse,
  options: ReviewServerOptions,
): Promise<void> {
  const {
    onMutated,
    scheduling,
    intake,
    accounts,
    drafting,
    documents,
    cases,
    audit,
    research,
    assistant,
    staff,
    messaging,
    staffSchedule,
    billingHours,
    pdfReports,
    matters,
    trust,
    clientFile,
    invoicing,
    clientPortal,
    clientMessaging,
    search,
    payroll,
    timeClock,
    voiceCalls,
    audioClips,
    twilio,
    trustProxy = false,
    maxRequestBodyBytes = DEFAULT_MAX_REQUEST_BODY_BYTES,
    loginThrottle,
    auditLog,
    firmName,
    mfaRequiredRoles,
  } = options;
  // Bound every buffered body for this request before any route runs — see
  // `readBodyBuffer`. Applies to the unauthenticated routes (login, Twilio
  // webhooks) too, which is exactly where it matters most.
  requestBodyLimits.set(req, maxRequestBodyBytes);
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname.startsWith("/api/voice/")) {
    await handleVoiceRequest({ voiceCalls, audioClips, twilio }, req, res, url);
    return;
  }

  if (url.pathname === "/api/login" && req.method === "POST") {
    await handleLogin(auth, req, res, { throttle: loginThrottle, auditLog }, onMutated, trustProxy);
    return;
  }

  if (url.pathname === "/api/logout" && req.method === "POST") {
    const token = parseCookies(req)[SESSION_COOKIE_NAME];
    if (token) auth.logout(token);
    sendJson(res, 200, { ok: true }, { "Set-Cookie": clearSessionCookieHeader() });
    onMutated?.();
    return;
  }

  if (url.pathname === "/api/me" && req.method === "GET") {
    try {
      const actor = resolveActor(req, auth);
      const user = auth.userForToken(parseCookies(req)[SESSION_COOKIE_NAME]);
      sendJson(res, 200, {
        id: actor.id,
        role: actor.role,
        username: user?.username,
        mustChangePassword: user?.mustChangePassword ?? false,
        mfaSetupRequired: needsMfaSetup(user, mfaRequiredRoles),
      });
    } catch (err) {
      sendJson(res, errorStatus(err), { error: err instanceof Error ? err.message : "unknown error" });
    }
    return;
  }

  /**
   * Self-service password change — available to any logged-in user, any
   * role, no separate service/gate needed since it only ever acts on the
   * caller's own account. Changing a password revokes every live session
   * (see `AuthService.changePassword`), including the one making this
   * very request, so the response clears the cookie too and the client
   * has to log back in with the new password.
   */
  if (url.pathname === "/api/change-password" && req.method === "POST") {
    try {
      const user = auth.userForToken(parseCookies(req)[SESSION_COOKIE_NAME]);
      if (!user) throw new AuthError("authentication required");
      const body = await readJsonBody(req);
      auth.changePassword(user.id, String(body["currentPassword"] ?? ""), String(body["newPassword"] ?? ""));
      sendJson(res, 200, { ok: true }, { "Set-Cookie": clearSessionCookieHeader() });
      onMutated?.();
    } catch (err) {
      sendJson(res, errorStatus(err), { error: err instanceof Error ? err.message : "unknown error" });
    }
    return;
  }

  /**
   * Self-service second factor. Deliberately *not* on `AccountsService`:
   * enrolling a second factor onto someone else's account would be a way
   * to lock them out of it, so every route here acts only on the caller's
   * own account and takes no user id at all — the same reasoning that
   * puts `/api/change-password` here rather than behind the attorney
   * gate. Turning MFA *off* for someone else is the one MFA action an
   * attorney can take, and it lives on `/api/accounts/:id/reset-mfa`
   * where the rest of the overrides are.
   */
  if (url.pathname.startsWith("/api/mfa")) {
    try {
      const user = auth.userForToken(parseCookies(req)[SESSION_COOKIE_NAME]);
      if (!user) throw new AuthError("authentication required");

      if (url.pathname === "/api/mfa" && req.method === "GET") {
        sendJson(res, 200, auth.mfaStatus(user.id));
        return;
      }
      if (url.pathname === "/api/mfa/begin" && req.method === "POST") {
        // Re-proves the password, same as disable/regenerate below — a
        // session alone must not be enough to plant a factor either,
        // only to use one already agreed on. See `beginMfaEnrollment`.
        const body = await readJsonBody(req);
        const result = auth.beginMfaEnrollment(user.id, String(body["password"] ?? ""), { issuer: firmName ?? "Docket" });
        sendJson(res, 200, result);
        onMutated?.();
        return;
      }
      if (url.pathname === "/api/mfa/confirm" && req.method === "POST") {
        const body = await readJsonBody(req);
        const result = auth.confirmMfaEnrollment(user.id, String(body["code"] ?? ""));
        auditLog?.append({
          actor: { id: user.actorId, role: user.role },
          matterId: undefined,
          action: "mfa_enabled",
          detail: `user=${user.id}`,
        });
        sendJson(res, 200, result);
        onMutated?.();
        return;
      }
      // Both of the below re-prove the password first. A session alone
      // isn't enough to weaken the factor that protects it — otherwise a
      // borrowed unlocked laptop is a full account takeover.
      if (url.pathname === "/api/mfa/disable" && req.method === "POST") {
        const body = await readJsonBody(req);
        auth.verifyPassword(user.id, String(body["password"] ?? ""));
        auth.disableMfa(user.id);
        auditLog?.append({
          actor: { id: user.actorId, role: user.role },
          matterId: undefined,
          action: "mfa_disabled",
          detail: `user=${user.id} self-service`,
        });
        // disableMfa revokes every session, this one included.
        sendJson(res, 200, { ok: true }, { "Set-Cookie": clearSessionCookieHeader() });
        onMutated?.();
        return;
      }
      if (url.pathname === "/api/mfa/recovery-codes" && req.method === "POST") {
        const body = await readJsonBody(req);
        auth.verifyPassword(user.id, String(body["password"] ?? ""));
        const recoveryCodes = auth.regenerateRecoveryCodes(user.id);
        auditLog?.append({
          actor: { id: user.actorId, role: user.role },
          matterId: undefined,
          action: "mfa_recovery_codes_regenerated",
          detail: `user=${user.id}`,
        });
        sendJson(res, 200, { recoveryCodes });
        onMutated?.();
        return;
      }
      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      sendJson(res, errorStatus(err), { error: err instanceof Error ? err.message : "unknown error" });
    }
    return;
  }

  if (!url.pathname.startsWith("/api/")) {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const token = parseCookies(req)[SESSION_COOKIE_NAME];
      if (!auth.actorForToken(token)) {
        res.writeHead(302, { Location: "/login.html", ...SECURITY_HEADERS });
        res.end();
        return;
      }
    }
    await serveStatic(res, url.pathname);
    return;
  }

  try {
    const actor = resolveActor(req, auth);

    if (mfaRequiredRoles?.has(actor.role as UserRole)) {
      const user = auth.userForToken(parseCookies(req)[SESSION_COOKIE_NAME]);
      if (needsMfaSetup(user, mfaRequiredRoles) && !MFA_SETUP_ALLOWED_PATHS.some((p) => url.pathname === p || url.pathname.startsWith(`${p}/`))) {
        sendJson(res, 403, {
          error: "two-factor authentication is required by firm policy — set it up in the Security panel before continuing",
          mfaSetupRequired: true,
        });
        return;
      }
    }

    if (url.pathname.startsWith("/api/deadlines")) {
      await handleDeadlineRequest(service, req, res, actor, url, onMutated);
      return;
    }

    if (url.pathname.startsWith("/api/appointments")) {
      if (!scheduling) {
        sendJson(res, 404, { error: "scheduling is not configured on this server" });
        return;
      }
      await handleAppointmentsRequest(scheduling, matters, req, res, actor, url, onMutated);
      return;
    }

    if (url.pathname.startsWith("/api/intake")) {
      if (!intake) {
        sendJson(res, 404, { error: "the intake demo is not configured on this server" });
        return;
      }
      await handleIntakeRequest(intake, req, res, actor, url);
      return;
    }

    if (url.pathname.startsWith("/api/accounts")) {
      if (!accounts) {
        sendJson(res, 404, { error: "account management is not configured on this server" });
        return;
      }
      await handleAccountsRequest(accounts, req, res, actor, url, onMutated);
      return;
    }

    if (url.pathname.startsWith("/api/drafting")) {
      if (!drafting) {
        sendJson(res, 404, { error: "drafting is not configured on this server" });
        return;
      }
      await handleDraftingRequest(drafting, req, res, actor, url, onMutated);
      return;
    }

    if (url.pathname.startsWith("/api/documents")) {
      if (!documents) {
        sendJson(res, 404, { error: "case documents are not configured on this server" });
        return;
      }
      await handleDocumentsRequest(documents, req, res, actor, url, onMutated);
      return;
    }

    if (url.pathname.startsWith("/api/cases")) {
      if (!cases) {
        sendJson(res, 404, { error: "cases are not configured on this server" });
        return;
      }
      await handleCasesRequest(cases, req, res, actor, url);
      return;
    }

    if (url.pathname === "/api/audit/verify" && req.method === "GET") {
      if (!audit) {
        sendJson(res, 404, { error: "the audit log is not configured on this server" });
        return;
      }
      sendJson(res, 200, await audit.verifyIntegrity(actor));
      return;
    }

    if (url.pathname === "/api/audit/anchor" && req.method === "POST") {
      if (!audit) {
        sendJson(res, 404, { error: "the audit log is not configured on this server" });
        return;
      }
      sendJson(res, 200, await audit.anchorNow(actor));
      onMutated?.();
      return;
    }

    if (url.pathname.startsWith("/api/audit")) {
      if (!audit) {
        sendJson(res, 404, { error: "the audit log is not configured on this server" });
        return;
      }
      const q = url.searchParams;
      sendJson(
        res,
        200,
        audit.list(actor, {
          ...(q.get("matterId") ? { matterId: q.get("matterId")! } : {}),
          ...(q.get("actorId") ? { actorId: q.get("actorId")! } : {}),
          ...(q.get("action") ? { action: q.get("action")! } : {}),
          ...(q.get("from") ? { from: q.get("from")! } : {}),
          ...(q.get("to") ? { to: q.get("to")! } : {}),
        }),
      );
      return;
    }

    if (url.pathname.startsWith("/api/research")) {
      if (!research) {
        sendJson(res, 404, { error: "research is not configured on this server" });
        return;
      }
      await handleResearchRequest(research, req, res, actor, url, onMutated);
      return;
    }

    if (url.pathname.startsWith("/api/assistant")) {
      if (!assistant) {
        sendJson(res, 404, { error: "the assistant is not configured on this server" });
        return;
      }
      await handleAssistantRequest(assistant, req, res, actor, url);
      return;
    }

    if (url.pathname === "/api/staff" && req.method === "GET") {
      if (!staff) {
        sendJson(res, 404, { error: "the staff directory is not configured on this server" });
        return;
      }
      sendJson(res, 200, staff.list(actor));
      return;
    }

    if (url.pathname.startsWith("/api/messages")) {
      if (!messaging) {
        sendJson(res, 404, { error: "messaging is not configured on this server" });
        return;
      }
      await handleMessagingRequest(messaging, req, res, actor, url, onMutated);
      return;
    }

    if (url.pathname.startsWith("/api/staff-schedule")) {
      if (!staffSchedule) {
        sendJson(res, 404, { error: "the staff schedule is not configured on this server" });
        return;
      }
      await handleStaffScheduleRequest(staffSchedule, req, res, actor, url, onMutated);
      return;
    }

    if (url.pathname.startsWith("/api/billing-hours")) {
      if (!billingHours) {
        sendJson(res, 404, { error: "billing hours are not configured on this server" });
        return;
      }
      await handleBillingHoursRequest(billingHours, req, res, actor, url, onMutated);
      return;
    }

    if (url.pathname.startsWith("/api/client-file/")) {
      if (!clientFile) {
        sendJson(res, 404, { error: "client file export is not configured on this server" });
        return;
      }
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      const matterId = decodeURIComponent(url.pathname.slice("/api/client-file/".length));
      if (!matterId) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      sendJson(res, 200, clientFile.export(actor, matterId));
      // The export is audited, so it changes persisted state.
      onMutated?.();
      return;
    }

    if (url.pathname === "/api/search" && req.method === "GET") {
      if (!search) {
        sendJson(res, 404, { error: "search is not configured on this server" });
        return;
      }
      sendJson(res, 200, search.search(actor, url.searchParams.get("q") ?? ""));
      onMutated?.();
      return;
    }

    if (url.pathname.startsWith("/api/invoices")) {
      if (!invoicing) {
        sendJson(res, 404, { error: "invoicing is not configured on this server" });
        return;
      }
      await handleInvoicingRequest(invoicing, req, res, actor, url, onMutated);
      return;
    }

    if (url.pathname.startsWith("/api/client-portal")) {
      if (!clientPortal) {
        sendJson(res, 404, { error: "the client portal is not configured on this server" });
        return;
      }
      await handleClientPortalRequest(clientPortal, req, res, actor, url);
      return;
    }

    if (url.pathname.startsWith("/api/client-messages")) {
      if (!clientMessaging) {
        sendJson(res, 404, { error: "client messaging is not configured on this server" });
        return;
      }
      await handleClientMessagingRequest(clientMessaging, req, res, actor, url, onMutated);
      return;
    }

    if (url.pathname.startsWith("/api/time-clock")) {
      if (!timeClock) {
        sendJson(res, 404, { error: "the time clock is not configured on this server" });
        return;
      }
      await handleTimeClockRequest(timeClock, req, res, actor, url, onMutated);
      return;
    }

    if (url.pathname.startsWith("/api/payroll")) {
      if (!payroll) {
        sendJson(res, 404, { error: "payroll is not configured on this server" });
        return;
      }
      await handlePayrollRequest(payroll, req, res, actor, url, onMutated);
      return;
    }

    if (url.pathname.startsWith("/api/trust")) {
      if (!trust) {
        sendJson(res, 404, { error: "trust accounting is not configured on this server" });
        return;
      }
      await handleTrustRequest(trust, req, res, actor, url, onMutated);
      return;
    }

    if (url.pathname.startsWith("/api/matters") || url.pathname.startsWith("/api/conflicts")) {
      if (!matters) {
        sendJson(res, 404, { error: "matters are not configured on this server" });
        return;
      }
      await handleMattersRequest(matters, req, res, actor, url, onMutated);
      return;
    }

    if (url.pathname.startsWith("/api/pdf-reports")) {
      if (!pdfReports) {
        sendJson(res, 404, { error: "PDF reports are not configured on this server" });
        return;
      }
      await handlePdfReportsRequest(pdfReports, req, res, actor, url, onMutated);
      return;
    }

    const segments = url.pathname.replace(/^\/api\/work-products\/?/, "").split("/").filter(Boolean);

    if (segments.length === 0 && req.method === "GET") {
      const status = url.searchParams.get("status");
      const result = status === "pending_review" ? service.listPendingReview(actor) : service.listAll(actor);
      sendJson(res, 200, result);
      return;
    }

    const id = segments[0];
    if (!id) {
      sendJson(res, 404, { error: "not found" });
      return;
    }

    if (segments.length === 1 && req.method === "GET") {
      sendJson(res, 200, service.get(actor, id));
      return;
    }

    if (segments.length === 2 && req.method === "POST") {
      const action = segments[1];
      const body = await readJsonBody(req);
      let result;
      switch (action) {
        case "approve":
          result = service.approve(actor, id);
          break;
        case "reject":
          result = service.reject(actor, id, String(body["reason"] ?? ""));
          break;
        case "request-revision":
          result = service.requestRevision(actor, id, String(body["note"] ?? ""));
          break;
        case "release":
          result = service.release(actor, id);
          break;
        case "clear-flag":
          result = service.clearFlag(
            actor,
            id,
            String(body["flag"] ?? ""),
            body["deadlineType"] as DeadlineType | undefined,
          );
          break;
        default:
          sendJson(res, 404, { error: "not found" });
          return;
      }
      sendJson(res, 200, result);
      onMutated?.();
      return;
    }

    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    sendJson(res, errorStatus(err), { error: err instanceof Error ? err.message : "unknown error" });
  }
}

async function handleLogin(
  auth: AuthService,
  req: IncomingMessage,
  res: ServerResponse,
  deps: { throttle: LoginThrottle | undefined; auditLog: AuditLog | undefined },
  onMutated?: () => void,
  trustProxy = false,
): Promise<void> {
  const { throttle, auditLog } = deps;
  const ip = clientIpFor(req, trustProxy);
  let username = "";
  try {
    const body = await readJsonBody(req);
    username = String(body["username"] ?? "");
    const password = String(body["password"] ?? "");
    const remember = body["remember"] === true;
    const keys = [LoginThrottle.usernameKey(username), LoginThrottle.ipKey(ip)];

    // Checked before `auth.login`, so a locked-out attempt never pays the
    // scrypt cost — that's what makes this a DoS defense and not just an
    // anti-guessing one.
    const decision = throttle?.check(keys) ?? { allowed: true, retryAfterSeconds: 0 };
    if (!decision.allowed) {
      auditLog?.append({
        actor: { id: username || "unknown", role: "anonymous" },
        matterId: undefined,
        action: "login_blocked",
        detail: `too many failed attempts; ip=${ip} retryAfter=${decision.retryAfterSeconds}s`,
      });
      sendJson(
        res,
        429,
        { error: `too many failed login attempts — try again in ${decision.retryAfterSeconds} seconds` },
        { "Retry-After": String(decision.retryAfterSeconds) },
      );
      onMutated?.();
      return;
    }

    try {
      const session = auth.login(username, password, remember, String(body["mfaCode"] ?? ""));
      const user = auth.userForToken(session.token);
      throttle?.recordSuccess(keys);
      auditLog?.append({
        actor: { id: user?.actorId ?? username, role: user?.role ?? "anonymous" },
        matterId: undefined,
        action: "login_succeeded",
        detail: `ip=${ip}`,
      });
      sendJson(
        res,
        200,
        { id: user?.actorId, role: user?.role, username: user?.username },
        { "Set-Cookie": sessionCookieHeader(session.token, session.expiresAt, isSecureRequest(req, trustProxy)) },
      );
      onMutated?.();
    } catch (loginErr) {
      // The password was right; the login page now needs to ask for a
      // code. Deliberately *not* counted as a failed attempt — this is
      // the ordinary first half of every MFA login, and counting it
      // would lock an attorney out of their own matters after five
      // normal sign-ins. Logged, though: a burst of these is somebody
      // working through a list of correct passwords.
      if (loginErr instanceof MfaRequiredError) {
        auditLog?.append({
          actor: { id: username || "unknown", role: "anonymous" },
          matterId: undefined,
          action: "login_mfa_challenged",
          detail: `ip=${ip}`,
        });
        sendJson(res, 401, { error: loginErr.message, mfaRequired: true });
        onMutated?.();
        return;
      }
      if (loginErr instanceof AuthError) {
        throttle?.recordFailure(keys);
        // Deliberately logs the *attempted* username, not whether it exists —
        // the response itself stays the same generic message either way.
        auditLog?.append({
          actor: { id: username || "unknown", role: "anonymous" },
          matterId: undefined,
          action: "login_failed",
          detail: `ip=${ip}`,
        });
        onMutated?.();
      }
      throw loginErr;
    }
  } catch (err) {
    // errorStatus keeps a bad login a 401 while still mapping an oversized body to 413.
    sendJson(res, errorStatus(err), { error: err instanceof Error ? err.message : "invalid request" });
  }
}

async function handleDeadlineRequest(
  service: ReviewGateService,
  req: IncomingMessage,
  res: ServerResponse,
  actor: Actor,
  url: URL,
  onMutated?: () => void,
): Promise<void> {
  if (url.pathname === "/api/deadlines/conflicts" && req.method === "GET") {
    sendJson(res, 200, service.listDeadlineConflicts(actor));
    return;
  }

  if (url.pathname === "/api/deadlines/upcoming" && req.method === "GET") {
    const withinDays = Number(url.searchParams.get("withinDays"));
    sendJson(
      res,
      200,
      service.listUpcomingDeadlines(actor, {
        ...(Number.isFinite(withinDays) && withinDays > 0 ? { withinDays } : {}),
        ...(url.searchParams.get("today") ? { today: url.searchParams.get("today")! } : {}),
      }),
    );
    return;
  }

  if (url.pathname === "/api/deadlines" && req.method === "GET") {
    const matterId = url.searchParams.get("matterId");
    const type = url.searchParams.get("type") as DeadlineType | null;
    if (!matterId || !type) {
      sendJson(res, 400, { error: "matterId and type query params are required" });
      return;
    }
    sendJson(res, 200, {
      ...service.getDeadlineStatus(actor, matterId, type),
      // What would confirm it, in words. "unconfirmed" alone leaves
      // people guessing, and the usual answer — "someone else needs to
      // check this" — isn't something anyone would infer from it.
      hint: service.deadlineVerificationHint(actor, matterId, type),
    });
    return;
  }

  if (url.pathname === "/api/deadlines/confirm" && req.method === "POST") {
    const body = await readJsonBody(req);
    const source = body["source"];
    if (source !== "human" && source !== "calendar_system") {
      sendJson(res, 400, { error: "source must be 'human' or 'calendar_system'" });
      return;
    }
    const result = service.confirmDeadline(
      actor,
      String(body["matterId"] ?? ""),
      body["type"] as DeadlineType,
      String(body["date"] ?? ""),
      source,
    );
    sendJson(res, 200, result);
    onMutated?.();
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

async function handleIntakeRequest(
  intake: IntakeDemoSessions,
  req: IncomingMessage,
  res: ServerResponse,
  actor: Actor,
  url: URL,
): Promise<void> {
  if (url.pathname === "/api/intake/start" && req.method === "POST") {
    const { sessionId, turn } = intake.start(actor);
    sendJson(res, 200, { sessionId, ...turn });
    return;
  }

  const segments = url.pathname.replace(/^\/api\/intake\/?/, "").split("/").filter(Boolean);
  if (segments.length === 2 && segments[1] === "message" && req.method === "POST") {
    const sessionId = segments[0]!;
    const body = await readJsonBody(req);
    const turn = intake.handleMessage(sessionId, String(body["text"] ?? ""));
    sendJson(res, 200, turn);
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

async function handleAccountsRequest(
  accounts: AccountsService,
  req: IncomingMessage,
  res: ServerResponse,
  actor: Actor,
  url: URL,
  onMutated?: () => void,
): Promise<void> {
  if (url.pathname === "/api/accounts" && req.method === "GET") {
    sendJson(res, 200, accounts.list(actor));
    return;
  }

  if (url.pathname === "/api/accounts" && req.method === "POST") {
    const body = await readJsonBody(req);
    const result = accounts.create(actor, {
      username: String(body["username"] ?? ""),
      password: String(body["password"] ?? ""),
      role: body["role"] as UserRole,
      ...(typeof body["actorId"] === "string" && body["actorId"] ? { actorId: body["actorId"] } : {}),
      ...(typeof body["displayName"] === "string" && body["displayName"] ? { displayName: body["displayName"] } : {}),
    });
    sendJson(res, 200, result);
    onMutated?.();
    return;
  }

  const segments = url.pathname.replace(/^\/api\/accounts\/?/, "").split("/").filter(Boolean);
  if (segments.length === 2 && req.method === "POST") {
    const id = segments[0]!;
    const action = segments[1];
    const body = await readJsonBody(req);
    let result;
    switch (action) {
      case "disable":
        result = accounts.disable(actor, id);
        break;
      case "enable":
        result = accounts.enable(actor, id);
        break;
      case "assign-matter":
        result = accounts.assignMatter(
          actor,
          id,
          String(body["matterId"] ?? ""),
          body["highSensitivityGranted"] === true,
        );
        break;
      case "unassign-matter":
        result = accounts.unassignMatter(actor, id);
        break;
      case "clear-login-lockout":
        result = accounts.clearLoginLockout(actor, String(body["username"] ?? ""));
        break;
      case "reset-password":
        result = accounts.resetPassword(actor, id, String(body["newPassword"] ?? ""));
        break;
      case "reset-mfa":
        result = accounts.resetMfa(actor, id);
        break;
      case "grant-matter-access":
        result = accounts.grantMatterAccess(actor, id, String(body["matterId"] ?? ""));
        break;
      case "revoke-matter-access":
        result = accounts.revokeMatterAccess(actor, id, String(body["matterId"] ?? ""));
        break;
      default:
        sendJson(res, 404, { error: "not found" });
        return;
    }
    sendJson(res, 200, result);
    onMutated?.();
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

async function handleDraftingRequest(
  drafting: DraftingService,
  req: IncomingMessage,
  res: ServerResponse,
  actor: Actor,
  url: URL,
  onMutated?: () => void,
): Promise<void> {
  const segments = url.pathname.replace(/^\/api\/drafting\/?/, "").split("/").filter(Boolean);

  if (segments.length === 1 && segments[0] === "templates" && req.method === "GET") {
    sendJson(res, 200, drafting.listTemplates(actor));
    return;
  }

  if (segments[0] !== "matters" || !segments[1]) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const matterId = segments[1]!;

  if (segments.length === 2 && req.method === "GET") {
    sendJson(res, 200, drafting.listMatterWorkProduct(actor, matterId));
    return;
  }

  if (segments.length === 3 && req.method === "POST") {
    const body = await readJsonBody(req);
    let result;
    switch (segments[2]) {
      case "draft-template":
        result = drafting.draftFromTemplate(actor, matterId, {
          templateId: String(body["templateId"] ?? ""),
          content: String(body["content"] ?? ""),
          ...(body["context"] && typeof body["context"] === "object" ? { context: body["context"] as Record<string, unknown> } : {}),
          ...(typeof body["deadlineDate"] === "string" && body["deadlineDate"] ? { deadlineDate: body["deadlineDate"] } : {}),
          ...(typeof body["deadlineType"] === "string" && body["deadlineType"] ? { deadlineType: body["deadlineType"] as DeadlineType } : {}),
        });
        break;
      case "draft-research":
        result = drafting.draftResearchSummary(actor, matterId, {
          content: String(body["content"] ?? ""),
          citations: Array.isArray(body["citations"]) ? (body["citations"] as string[]) : [],
        });
        break;
      case "draft-billing":
        result = drafting.draftBillingNarrative(actor, matterId, { content: String(body["content"] ?? "") });
        break;
      default:
        sendJson(res, 404, { error: "not found" });
        return;
    }
    sendJson(res, 200, result);
    onMutated?.();
    return;
  }

  if (segments[2] !== "work-products" || !segments[3]) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const workProductId = segments[3]!;

  if (segments.length === 4 && req.method === "GET") {
    sendJson(res, 200, drafting.get(actor, matterId, workProductId));
    return;
  }

  if (segments.length === 5 && req.method === "POST") {
    const body = await readJsonBody(req);
    let result;
    if (segments[4] === "revise") {
      result = drafting.reviseDraft(actor, matterId, workProductId, String(body["content"] ?? ""));
    } else if (segments[4] === "submit") {
      result = drafting.submitForReview(actor, matterId, workProductId);
    } else {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    sendJson(res, 200, result);
    onMutated?.();
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

async function handleDocumentsRequest(
  documents: DocumentsService,
  req: IncomingMessage,
  res: ServerResponse,
  actor: Actor,
  url: URL,
  onMutated?: () => void,
): Promise<void> {
  const segments = url.pathname.replace(/^\/api\/documents\/?/, "").split("/").filter(Boolean);

  if (segments.length === 1 && segments[0] === "limits" && req.method === "GET") {
    sendJson(res, 200, { maxUploadBytes: documents.getMaxUploadBytes() });
    return;
  }

  if (segments[0] !== "matters" || !segments[1]) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const matterId = segments[1]!;

  if (segments.length === 2 && req.method === "GET") {
    sendJson(res, 200, documents.listMatterDocuments(actor, matterId));
    return;
  }

  if (segments.length === 2 && req.method === "POST") {
    const body = await readJsonBody(req);
    const result = documents.upload(actor, matterId, {
      fileName: String(body["fileName"] ?? ""),
      contentType: String(body["contentType"] ?? ""),
      content: String(body["content"] ?? ""),
    });
    sendJson(res, 200, result);
    onMutated?.();
    return;
  }

  const id = segments[2];
  if (!id) {
    sendJson(res, 404, { error: "not found" });
    return;
  }

  if (segments.length === 3 && req.method === "GET") {
    sendJson(res, 200, documents.getWithContent(actor, matterId, id));
    return;
  }

  if (segments.length === 3 && req.method === "DELETE") {
    documents.delete(actor, matterId, id);
    sendJson(res, 200, { ok: true });
    onMutated?.();
    return;
  }

  if (segments.length === 4 && segments[3] === "client-visibility" && req.method === "POST") {
    const body = await readJsonBody(req);
    const result = documents.setClientVisibility(actor, matterId, id, body["visible"] === true);
    sendJson(res, 200, result);
    onMutated?.();
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

async function handleInvoicingRequest(
  invoicing: InvoicingService,
  req: IncomingMessage,
  res: ServerResponse,
  actor: Actor,
  url: URL,
  onMutated?: () => void,
): Promise<void> {
  if (url.pathname === "/api/invoices/processor" && req.method === "GET") {
    sendJson(res, 200, invoicing.processorInfo(actor));
    return;
  }

  if (url.pathname === "/api/invoices/outstanding" && req.method === "GET") {
    sendJson(res, 200, invoicing.listOutstanding(actor));
    return;
  }

  if (url.pathname === "/api/invoices/email-transport" && req.method === "GET") {
    sendJson(res, 200, invoicing.emailInfo(actor));
    return;
  }

  const segments = url.pathname.replace(/^\/api\/invoices\/?/, "").split("/").filter(Boolean);
  if (segments[0] !== "matters" || !segments[1]) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const matterId = segments[1]!;

  if (segments.length === 2 && req.method === "GET") {
    sendJson(res, 200, invoicing.listForMatter(actor, matterId));
    return;
  }

  if (segments.length === 2 && req.method === "POST") {
    const body = await readJsonBody(req);
    const result = invoicing.createDraft(actor, matterId, {
      ...(typeof body["dueDate"] === "string" && body["dueDate"] ? { dueDate: body["dueDate"] } : {}),
      ...(typeof body["note"] === "string" && body["note"] ? { note: body["note"] } : {}),
    });
    sendJson(res, 200, result);
    onMutated?.();
    return;
  }

  const invoiceId = segments[2];
  if (!invoiceId) {
    sendJson(res, 404, { error: "not found" });
    return;
  }

  if (segments.length === 3 && req.method === "GET") {
    sendJson(res, 200, invoicing.get(actor, matterId, invoiceId));
    return;
  }

  if (segments.length === 4 && req.method === "POST") {
    const body = await readJsonBody(req);
    let result;
    switch (segments[3]) {
      case "lines":
        result = invoicing.addLineItem(actor, matterId, invoiceId, {
          description: String(body["description"] ?? ""),
          source: (body["source"] as LineItemSource) ?? "flat",
          quantityMilli: Number(body["quantityMilli"]),
          unitAmountCents: Number(body["unitAmountCents"]),
        });
        break;
      case "add-time":
        result = invoicing.addTimeFromBillingHours(actor, matterId, invoiceId, Number(body["hourlyRateCents"]));
        break;
      case "send":
        result = invoicing.send(actor, matterId, invoiceId);
        break;
      case "void":
        result = invoicing.void(actor, matterId, invoiceId, String(body["reason"] ?? ""));
        break;
      case "payments":
        result = invoicing.recordPayment(actor, matterId, invoiceId, {
          amountCents: Number(body["amountCents"]),
          method: (body["method"] as PaymentMethod) ?? "other",
          ...(typeof body["reference"] === "string" && body["reference"] ? { reference: body["reference"] } : {}),
        });
        break;
      case "charge":
        result = await invoicing.chargePayment(actor, matterId, invoiceId, {
          amountCents: Number(body["amountCents"]),
          ...(typeof body["instrumentToken"] === "string" && body["instrumentToken"]
            ? { instrumentToken: body["instrumentToken"] }
            : {}),
        });
        break;
      case "pay-from-trust":
        result = invoicing.payFromTrust(actor, matterId, invoiceId, Number(body["amountCents"]));
        break;
      case "remind":
        result = await invoicing.emailReminder(
          actor,
          matterId,
          invoiceId,
          typeof body["to"] === "string" && body["to"] ? body["to"] : undefined,
        );
        break;
      case "email":
        result = await invoicing.emailInvoice(
          actor,
          matterId,
          invoiceId,
          typeof body["to"] === "string" && body["to"] ? body["to"] : undefined,
        );
        break;
      default:
        sendJson(res, 404, { error: "not found" });
        return;
    }
    sendJson(res, 200, result);
    onMutated?.();
    return;
  }

  if (segments.length === 4 && segments[3] === "pdf" && req.method === "GET") {
    const { filename, data } = await invoicing.renderPdf(actor, matterId, invoiceId);
    sendBinary(res, "application/pdf", filename, data);
    return;
  }

  if (segments.length === 4 && segments[3] === "preview" && req.method === "GET") {
    sendJson(res, 200, invoicing.preview(actor, matterId, invoiceId));
    return;
  }

  if (segments.length === 5 && segments[3] === "lines" && req.method === "DELETE") {
    sendJson(res, 200, invoicing.removeLineItem(actor, matterId, invoiceId, segments[4]!));
    onMutated?.();
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

async function handleTimeClockRequest(
  timeClock: TimeClockService,
  req: IncomingMessage,
  res: ServerResponse,
  actor: Actor,
  url: URL,
  onMutated?: () => void,
): Promise<void> {
  const tz = url.searchParams.get("tz") ?? undefined;
  const segments = url.pathname.replace(/^\/api\/time-clock\/?/, "").split("/").filter(Boolean);

  // Punching is always self-service, so these take no actor id.
  if (segments.length === 1 && (segments[0] === "clock-in" || segments[0] === "clock-out") && req.method === "POST") {
    const body = await readJsonBody(req);
    const note = typeof body["note"] === "string" && body["note"] ? body["note"] : undefined;
    const shift = segments[0] === "clock-in" ? timeClock.clockIn(actor, note) : timeClock.clockOut(actor, note);
    sendJson(res, 200, shift);
    onMutated?.();
    return;
  }

  if (segments.length === 1 && segments[0] === "on-the-clock" && req.method === "GET") {
    sendJson(res, 200, timeClock.whoIsOnTheClock(actor, tz));
    return;
  }

  if (segments.length === 3 && segments[0] === "shifts" && segments[2] === "adjust" && req.method === "POST") {
    const body = await readJsonBody(req);
    const shift = timeClock.adjust(actor, segments[1]!, {
      ...(typeof body["clockInAt"] === "string" && body["clockInAt"] ? { clockInAt: body["clockInAt"] } : {}),
      ...(typeof body["clockOutAt"] === "string" && body["clockOutAt"] ? { clockOutAt: body["clockOutAt"] } : {}),
      reason: String(body["reason"] ?? ""),
    });
    sendJson(res, 200, shift);
    onMutated?.();
    return;
  }

  if (segments.length === 3 && segments[0] === "shifts" && segments[2] === "post-to-payroll" && req.method === "POST") {
    sendJson(res, 200, timeClock.postToPayroll(actor, segments[1]!));
    onMutated?.();
    return;
  }

  if (segments[0] !== "actor" || !segments[1]) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const actorId = decodeURIComponent(segments[1]!);
  const from = url.searchParams.get("from") ?? undefined;
  const to = url.searchParams.get("to") ?? undefined;

  if (segments.length === 3 && segments[2] === "summary" && req.method === "GET") {
    sendJson(res, 200, timeClock.summary(actor, actorId, tz));
    return;
  }

  if (segments.length === 3 && segments[2] === "shifts" && req.method === "GET") {
    sendJson(res, 200, timeClock.listShifts(actor, actorId, tz, from, to));
    return;
  }

  if (segments.length === 3 && segments[2] === "totals" && req.method === "GET") {
    const kind = (url.searchParams.get("kind") ?? "day") as BucketKind;
    if (!["day", "week", "month"].includes(kind)) {
      sendJson(res, 400, { error: "kind must be day, week or month" });
      return;
    }
    sendJson(res, 200, timeClock.totals(actor, actorId, kind, tz, from, to));
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

async function handlePayrollRequest(
  payroll: PayrollService,
  req: IncomingMessage,
  res: ServerResponse,
  actor: Actor,
  url: URL,
  onMutated?: () => void,
): Promise<void> {
  if (url.pathname === "/api/payroll/summary" && req.method === "GET") {
    sendJson(
      res,
      200,
      payroll.summarize(actor, url.searchParams.get("from") ?? "", url.searchParams.get("to") ?? ""),
    );
    onMutated?.();
    return;
  }

  const segments = url.pathname.replace(/^\/api\/payroll\/?/, "").split("/").filter(Boolean);
  if (segments[0] !== "actor" || !segments[1]) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const actorId = decodeURIComponent(segments[1]!);

  if (segments[2] === "rates") {
    if (req.method === "GET") {
      sendJson(res, 200, payroll.listRates(actor, actorId));
      return;
    }
    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const result = payroll.setRate(actor, actorId, {
        hourlyCents: Number(body["hourlyCents"]),
        effectiveFrom: String(body["effectiveFrom"] ?? ""),
        ...(typeof body["note"] === "string" && body["note"] ? { note: body["note"] } : {}),
      });
      sendJson(res, 200, result);
      onMutated?.();
      return;
    }
  }

  if (segments[2] === "hours") {
    if (segments.length === 3 && req.method === "GET") {
      sendJson(
        res,
        200,
        payroll.listHours(
          actor,
          actorId,
          url.searchParams.get("from") ?? undefined,
          url.searchParams.get("to") ?? undefined,
        ),
      );
      return;
    }
    if (segments.length === 3 && req.method === "POST") {
      const body = await readJsonBody(req);
      const result = payroll.recordHours(actor, actorId, {
        date: String(body["date"] ?? ""),
        hoursMilli: Number(body["hoursMilli"]),
        description: String(body["description"] ?? ""),
      });
      sendJson(res, 200, result);
      onMutated?.();
      return;
    }
    if (segments.length === 4 && req.method === "DELETE") {
      payroll.deleteHours(actor, actorId, segments[3]!);
      sendJson(res, 200, { ok: true });
      onMutated?.();
      return;
    }
  }

  sendJson(res, 404, { error: "not found" });
}

async function handleTrustRequest(
  trust: TrustService,
  req: IncomingMessage,
  res: ServerResponse,
  actor: Actor,
  url: URL,
  onMutated?: () => void,
): Promise<void> {
  // Reconciliation is firm-wide, so it isn't nested under a matter id.
  if (url.pathname === "/api/trust/reconcile" && req.method === "POST") {
    const body = await readJsonBody(req);
    sendJson(res, 200, trust.reconcile(actor, Number(body["bankBalanceCents"])));
    onMutated?.();
    return;
  }

  const segments = url.pathname.replace(/^\/api\/trust\/?/, "").split("/").filter(Boolean);
  if (segments[0] !== "matters" || !segments[1]) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const matterId = segments[1]!;

  if (segments.length === 2 && req.method === "GET") {
    sendJson(res, 200, trust.getMatterLedger(actor, matterId));
    return;
  }

  if (segments.length === 2 && req.method === "POST") {
    const body = await readJsonBody(req);
    const result = trust.record(actor, matterId, {
      type: body["type"] as Exclude<TrustEntryType, "reversal">,
      amountCents: Number(body["amountCents"]),
      description: String(body["description"] ?? ""),
      ...(typeof body["reference"] === "string" && body["reference"] ? { reference: body["reference"] } : {}),
    });
    sendJson(res, 200, result);
    onMutated?.();
    return;
  }

  if (segments.length === 4 && segments[3] === "reverse" && req.method === "POST") {
    const body = await readJsonBody(req);
    const result = trust.reverse(actor, matterId, segments[2]!, String(body["reason"] ?? ""));
    sendJson(res, 200, result);
    onMutated?.();
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

/**
 * `GET /api/client-portal/matters` (the client's own matter list),
 * `GET /api/client-portal/matters/:matterId` (one matter's detail — trust
 * balance, non-draft invoices, shared documents), and the two download
 * routes for an invoice PDF / a shared document's bytes. No POST routes
 * at all: the whole surface is read-only, since a client never creates
 * or changes anything through this API — see `ClientPortalService`'s
 * doc comment for why.
 */
async function handleClientPortalRequest(
  clientPortal: ClientPortalService,
  req: IncomingMessage,
  res: ServerResponse,
  actor: Actor,
  url: URL,
): Promise<void> {
  const segments = url.pathname.replace(/^\/api\/client-portal\/?/, "").split("/").filter(Boolean);

  if (segments.length === 1 && segments[0] === "matters" && req.method === "GET") {
    sendJson(res, 200, clientPortal.listMyMatters(actor));
    return;
  }

  if (segments[0] !== "matters" || !segments[1]) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const matterId = segments[1]!;

  if (segments.length === 2 && req.method === "GET") {
    sendJson(res, 200, clientPortal.getMatter(actor, matterId));
    return;
  }

  if (segments.length === 5 && segments[2] === "invoices" && segments[4] === "preview" && req.method === "GET") {
    sendJson(res, 200, clientPortal.previewInvoice(actor, matterId, segments[3]!));
    return;
  }

  if (segments.length === 5 && segments[2] === "invoices" && segments[4] === "pdf" && req.method === "GET") {
    const { filename, data } = await clientPortal.invoicePdf(actor, matterId, segments[3]!);
    sendBinary(res, "application/pdf", filename, data);
    return;
  }

  if (segments.length === 4 && segments[2] === "documents" && req.method === "GET") {
    const doc = clientPortal.getDocument(actor, matterId, segments[3]!);
    sendBinary(res, doc.contentType || "application/octet-stream", doc.fileName, Buffer.from(doc.content, "base64"));
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

/**
 * `GET|POST /api/client-messages/matters/:matterId` — the one surface
 * both a client and staff read and write. `ClientMessagingService`
 * itself picks the right `AccessControl` category by role, so this
 * handler doesn't need to know which kind of actor it's serving.
 */
async function handleClientMessagingRequest(
  clientMessaging: ClientMessagingService,
  req: IncomingMessage,
  res: ServerResponse,
  actor: Actor,
  url: URL,
  onMutated?: () => void,
): Promise<void> {
  const segments = url.pathname.replace(/^\/api\/client-messages\/?/, "").split("/").filter(Boolean);
  if (segments[0] !== "matters" || !segments[1]) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const matterId = segments[1]!;

  if (segments.length === 2 && req.method === "GET") {
    sendJson(res, 200, clientMessaging.list(actor, matterId));
    return;
  }

  if (segments.length === 2 && req.method === "POST") {
    const body = await readJsonBody(req);
    const result = clientMessaging.post(actor, matterId, String(body["body"] ?? ""));
    sendJson(res, 200, result);
    onMutated?.();
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

async function handleMattersRequest(
  matters: MattersService,
  req: IncomingMessage,
  res: ServerResponse,
  actor: Actor,
  url: URL,
  onMutated?: () => void,
): Promise<void> {
  // Conflicts screening is firm-wide by design (Rule 1.10 imputation), so
  // it deliberately isn't nested under a matter id.
  if (url.pathname === "/api/conflicts/check" && req.method === "POST") {
    const body = await readJsonBody(req);
    const names = Array.isArray(body["names"]) ? body["names"].map(String) : [];
    const result = matters.checkConflicts(actor, {
      names,
      ...(body["roleByName"] && typeof body["roleByName"] === "object"
        ? { roleByName: body["roleByName"] as Record<string, PartyRole> }
        : {}),
      ...(typeof body["excludeMatterId"] === "string" && body["excludeMatterId"]
        ? { excludeMatterId: body["excludeMatterId"] }
        : {}),
    });
    sendJson(res, 200, result);
    // A conflicts check writes an audit entry, so it counts as a mutation.
    onMutated?.();
    return;
  }

  // Also firm-wide rather than per-matter: the question is "which closed
  // files are now past their retention period", across everything.
  if (url.pathname === "/api/matters/retention-due" && req.method === "GET") {
    sendJson(res, 200, matters.listRetentionDue(actor));
    return;
  }

  const segments = url.pathname.replace(/^\/api\/matters\/?/, "").split("/").filter(Boolean);

  if (segments.length === 0 && req.method === "GET") {
    sendJson(res, 200, matters.list(actor));
    return;
  }

  const matterId = segments[0];
  if (!matterId) {
    sendJson(res, 404, { error: "not found" });
    return;
  }

  if (segments.length === 1 && req.method === "GET") {
    sendJson(res, 200, matters.get(actor, matterId));
    return;
  }


  if (segments.length === 2 && segments[1] === "close" && req.method === "POST") {
    const body = await readJsonBody(req);
    sendJson(
      res,
      200,
      matters.close(actor, matterId, {
        closingNote: String(body["closingNote"] ?? ""),
        ...(typeof body["retentionYears"] === "number" ? { retentionYears: body["retentionYears"] } : {}),
      }),
    );
    onMutated?.();
    return;
  }

  if (segments.length === 2 && segments[1] === "reopen" && req.method === "POST") {
    const body = await readJsonBody(req);
    sendJson(res, 200, matters.reopen(actor, matterId, String(body["reason"] ?? "")));
    onMutated?.();
    return;
  }

  if (segments.length === 1 && req.method === "PUT") {
    const body = await readJsonBody(req);
    const parties = Array.isArray(body["parties"])
      ? body["parties"].map((p) => {
          const party = p as Record<string, unknown>;
          return {
            name: String(party["name"] ?? ""),
            role: (party["role"] as PartyRole) ?? "related",
            note: typeof party["note"] === "string" && party["note"] ? party["note"] : undefined,
            email: typeof party["email"] === "string" && party["email"] ? party["email"] : undefined,
          };
        })
      : undefined;
    const result = matters.upsert(actor, matterId, {
      ...(typeof body["title"] === "string" ? { title: body["title"] } : {}),
      ...(typeof body["status"] === "string" ? { status: body["status"] as MatterStatus } : {}),
      ...(typeof body["practiceAreaId"] === "string" ? { practiceAreaId: body["practiceAreaId"] } : {}),
      ...(typeof body["responsibleAttorneyId"] === "string" ? { responsibleAttorneyId: body["responsibleAttorneyId"] } : {}),
      ...(typeof body["description"] === "string" ? { description: body["description"] } : {}),
      ...(parties ? { parties } : {}),
    });
    sendJson(res, 200, result);
    onMutated?.();
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

async function handlePdfReportsRequest(
  pdfReports: PdfReportService,
  req: IncomingMessage,
  res: ServerResponse,
  actor: Actor,
  url: URL,
  onMutated?: () => void,
): Promise<void> {
  const segments = url.pathname.replace(/^\/api\/pdf-reports\/?/, "").split("/").filter(Boolean);

  if (segments[0] !== "matters" || !segments[1] || !segments[2] || !segments[3]) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const matterId = segments[1]!;
  const documentId = segments[2]!;
  const action = segments[3]!;

  if (action === "draft-report" && req.method === "POST") {
    const result = await pdfReports.draftReportFromDocument(actor, matterId, documentId);
    sendJson(res, 200, result);
    onMutated?.();
    return;
  }

  if (action === "condense" && req.method === "POST") {
    const result = await pdfReports.condenseDocument(actor, matterId, documentId);
    sendJson(res, 200, result);
    onMutated?.();
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

async function handleCasesRequest(
  cases: CasesService,
  req: IncomingMessage,
  res: ServerResponse,
  actor: Actor,
  url: URL,
): Promise<void> {
  const segments = url.pathname.replace(/^\/api\/cases\/?/, "").split("/").filter(Boolean);

  if (segments.length === 0 && req.method === "GET") {
    sendJson(res, 200, cases.listCases(actor));
    return;
  }

  if (segments.length === 1 && req.method === "GET") {
    sendJson(res, 200, cases.getCase(actor, segments[0]!));
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

async function handleMessagingRequest(
  messaging: MessagingService,
  req: IncomingMessage,
  res: ServerResponse,
  actor: Actor,
  url: URL,
  onMutated?: () => void,
): Promise<void> {
  const segments = url.pathname.replace(/^\/api\/messages\/?/, "").split("/").filter(Boolean);

  if (segments.length === 1 && segments[0] === "announcements" && req.method === "GET") {
    sendJson(res, 200, messaging.listAnnouncements(actor));
    return;
  }

  if (segments.length === 1 && segments[0] === "announcements" && req.method === "POST") {
    const body = await readJsonBody(req);
    const result = messaging.postAnnouncement(actor, String(body["body"] ?? ""));
    sendJson(res, 200, result);
    onMutated?.();
    return;
  }

  if (segments.length === 1 && segments[0] === "conversations" && req.method === "GET") {
    sendJson(res, 200, messaging.listConversations(actor));
    return;
  }

  if (segments.length === 2 && segments[0] === "conversations" && segments[1] === "direct" && req.method === "POST") {
    const body = await readJsonBody(req);
    const result = messaging.startDirectConversation(actor, String(body["otherActorId"] ?? ""));
    sendJson(res, 200, result);
    onMutated?.();
    return;
  }

  if (segments.length === 2 && segments[0] === "conversations" && segments[1] === "group" && req.method === "POST") {
    const body = await readJsonBody(req);
    const memberActorIds = Array.isArray(body["memberActorIds"]) ? body["memberActorIds"].map(String) : [];
    const result = messaging.createGroup(actor, String(body["name"] ?? ""), memberActorIds);
    sendJson(res, 200, result);
    onMutated?.();
    return;
  }

  if (segments[0] === "conversations" && segments[1] && segments[2] === "messages") {
    const conversationId = segments[1]!;
    if (req.method === "GET") {
      sendJson(res, 200, messaging.listMessages(actor, conversationId));
      return;
    }
    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const result = messaging.postMessage(actor, conversationId, String(body["body"] ?? ""));
      sendJson(res, 200, result);
      onMutated?.();
      return;
    }
  }

  if (segments[0] === "conversations" && segments[1] && segments[2] === "members") {
    const conversationId = segments[1]!;
    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const result = messaging.addMember(actor, conversationId, String(body["actorId"] ?? ""));
      sendJson(res, 200, result);
      onMutated?.();
      return;
    }
    if (req.method === "DELETE" && segments[3]) {
      const result = messaging.removeMember(actor, conversationId, segments[3]!);
      sendJson(res, 200, result);
      onMutated?.();
      return;
    }
  }

  sendJson(res, 404, { error: "not found" });
}

async function handleStaffScheduleRequest(
  staffSchedule: StaffScheduleService,
  req: IncomingMessage,
  res: ServerResponse,
  actor: Actor,
  url: URL,
  onMutated?: () => void,
): Promise<void> {
  const segments = url.pathname.replace(/^\/api\/staff-schedule\/?/, "").split("/").filter(Boolean);

  if (segments[0] === "date" && segments[1] && req.method === "GET") {
    sendJson(res, 200, staffSchedule.listForDate(actor, segments[1]!));
    return;
  }

  if (segments[0] === "actor" && segments[1] && segments.length === 2 && req.method === "GET") {
    sendJson(res, 200, staffSchedule.listForActor(actor, segments[1]!));
    return;
  }

  if (segments[0] === "actor" && segments[1] && segments.length === 2 && req.method === "POST") {
    const body = await readJsonBody(req);
    const result = staffSchedule.setEntry(
      actor,
      segments[1]!,
      String(body["date"] ?? ""),
      body["status"] as StaffScheduleStatus,
      typeof body["note"] === "string" && body["note"] ? body["note"] : undefined,
    );
    sendJson(res, 200, result);
    onMutated?.();
    return;
  }

  if (segments[0] === "actor" && segments[1] && segments.length === 3 && req.method === "DELETE") {
    staffSchedule.removeEntry(actor, segments[1]!, segments[2]!);
    sendJson(res, 200, { ok: true });
    onMutated?.();
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

async function handleBillingHoursRequest(
  billingHours: BillingHoursService,
  req: IncomingMessage,
  res: ServerResponse,
  actor: Actor,
  url: URL,
  onMutated?: () => void,
): Promise<void> {
  const segments = url.pathname.replace(/^\/api\/billing-hours\/?/, "").split("/").filter(Boolean);

  if (segments.length === 1 && segments[0] === "mine" && req.method === "GET") {
    sendJson(res, 200, billingHours.listMyHours(actor));
    return;
  }

  if (segments[0] !== "matters" || !segments[1]) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const matterId = segments[1]!;

  if (segments.length === 2 && req.method === "GET") {
    sendJson(res, 200, billingHours.listMatterHours(actor, matterId));
    return;
  }

  if (segments.length === 2 && req.method === "POST") {
    const body = await readJsonBody(req);
    const result = billingHours.logHours(actor, matterId, {
      date: String(body["date"] ?? ""),
      hours: Number(body["hours"]),
      description: String(body["description"] ?? ""),
    });
    sendJson(res, 200, result);
    onMutated?.();
    return;
  }

  if (segments.length === 3 && req.method === "DELETE") {
    billingHours.deleteEntry(actor, matterId, segments[2]!);
    sendJson(res, 200, { ok: true });
    onMutated?.();
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

async function handleResearchRequest(
  research: ResearchService,
  req: IncomingMessage,
  res: ServerResponse,
  actor: Actor,
  url: URL,
  onMutated?: () => void,
): Promise<void> {
  if (url.pathname === "/api/research/search" && req.method === "GET") {
    const results = await research.search(actor, url.searchParams.get("q") ?? "");
    sendJson(res, 200, results);
    return;
  }

  const segments = url.pathname.replace(/^\/api\/research\/?/, "").split("/").filter(Boolean);
  if (segments[0] !== "matters" || !segments[1]) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const matterId = segments[1]!;

  if (segments.length === 2 && req.method === "GET") {
    sendJson(res, 200, research.listMatterReferences(actor, matterId));
    return;
  }

  if (segments.length === 2 && req.method === "POST") {
    const body = await readJsonBody(req);
    const result = research.saveReference(actor, matterId, {
      citation: String(body["citation"] ?? ""),
      title: String(body["title"] ?? ""),
      ...(typeof body["url"] === "string" && body["url"] ? { url: body["url"] } : {}),
      ...(typeof body["note"] === "string" && body["note"] ? { note: body["note"] } : {}),
    });
    sendJson(res, 200, result);
    onMutated?.();
    return;
  }

  if (segments.length === 3 && req.method === "DELETE") {
    research.deleteReference(actor, matterId, segments[2]!);
    sendJson(res, 200, { ok: true });
    onMutated?.();
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

async function handleAssistantRequest(
  assistant: AssistantService,
  req: IncomingMessage,
  res: ServerResponse,
  actor: Actor,
  url: URL,
): Promise<void> {
  if (url.pathname === "/api/assistant/start" && req.method === "POST") {
    sendJson(res, 200, assistant.start(actor));
    return;
  }

  const segments = url.pathname.replace(/^\/api\/assistant\/?/, "").split("/").filter(Boolean);
  if (segments.length !== 2 || req.method !== "POST") {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const sessionId = segments[0]!;

  if (segments[1] === "message") {
    const body = await readJsonBody(req);
    const result = await assistant.sendMessage(actor, sessionId, String(body["text"] ?? ""));
    sendJson(res, 200, result);
    return;
  }

  if (segments[1] === "end") {
    assistant.end(actor, sessionId);
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

/**
 * `/api/voice/*` — the real-call telephony surface, deliberately handled
 * outside the normal `resolveActor()`/cookie-session flow: Twilio's
 * webhooks aren't a Docket user, so there's no cookie or
 * `x-system-api-key` to check. `verifyTwilioSignature` is the entire auth
 * story for `/api/voice/twilio/*`; `/api/voice/audio/:clipId` is
 * intentionally public (Twilio's own media fetcher doesn't sign its
 * requests either) but only ever serves a short-lived, unguessable clip
 * id — see `receptionist/audio-clip-store.ts`.
 */
async function handleVoiceRequest(
  config: { voiceCalls: VoiceCallSessions | undefined; audioClips: AudioClipStore | undefined; twilio: TwilioVoiceConfig | undefined },
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if (url.pathname.startsWith("/api/voice/audio/")) {
    if (!config.audioClips) {
      sendJson(res, 404, { error: "voice audio is not configured on this server" });
      return;
    }
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    const clipId = url.pathname.slice("/api/voice/audio/".length);
    const clip = config.audioClips.get(clipId);
    if (!clip) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    res.writeHead(200, { "Content-Type": clip.contentType, ...SECURITY_HEADERS });
    res.end(clip.data);
    return;
  }

  if (!url.pathname.startsWith("/api/voice/twilio/")) {
    sendJson(res, 404, { error: "not found" });
    return;
  }

  if (!config.voiceCalls || !config.audioClips || !config.twilio) {
    sendJson(res, 404, { error: "the telephony integration is not configured on this server" });
    return;
  }
  const { voiceCalls, audioClips, twilio } = config;

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  const formParams = await readFormBody(req);
  const signature = firstHeader(req.headers["x-twilio-signature"]);
  const fullUrl = `${twilio.publicBaseUrl}${url.pathname}`;
  if (!verifyTwilioSignature({ authToken: twilio.authToken, url: fullUrl, formParams, signature })) {
    sendJson(res, 403, { error: "invalid Twilio signature" });
    return;
  }

  const recordingActionUrl = (callSid: string) => `${twilio.publicBaseUrl}/api/voice/twilio/${encodeURIComponent(callSid)}/recording`;
  const audioUrl = (clipId: string) => `${twilio.publicBaseUrl}/api/voice/audio/${clipId}`;

  // A downstream failure anywhere below (Voicebox unreachable, a recording
  // download failing, an unexpected exception) still needs a valid TwiML
  // response, or Twilio just plays its own generic error tone with no
  // trace of what happened. Twilio's own `<Say>` is the one acceptable use
  // of the carrier's built-in TTS in this file, reserved for this exact
  // fallback path so a real error doesn't strand the caller silently.
  const errorFallbackXml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, something went wrong. Please try calling again.</Say><Hangup /></Response>`;

  if (url.pathname === "/api/voice/twilio/incoming") {
    const callSid = formParams["CallSid"];
    if (!callSid) {
      sendJson(res, 400, { error: "CallSid is required" });
      return;
    }
    try {
      const greetingAudio = (await voiceCalls.start(callSid)) as Buffer;
      const clipId = audioClips.store(greetingAudio, "audio/wav");
      sendXml(res, 200, twimlPlayThenRecord({ audioUrl: audioUrl(clipId), recordingActionUrl: recordingActionUrl(callSid) }));
    } catch {
      voiceCalls.end(callSid);
      sendXml(res, 200, errorFallbackXml);
    }
    return;
  }

  const segments = url.pathname.replace(/^\/api\/voice\/twilio\/?/, "").split("/").filter(Boolean);
  if (segments.length === 2 && segments[1] === "recording") {
    const callSid = decodeURIComponent(segments[0]!);
    const recordingUrl = formParams["RecordingUrl"];
    if (!recordingUrl) {
      sendJson(res, 400, { error: "RecordingUrl is required" });
      return;
    }
    try {
      const audioBuffer = await downloadTwilioRecording({ recordingUrl, accountSid: twilio.accountSid, authToken: twilio.authToken });
      const turn = await voiceCalls.handleTurn(callSid, { data: audioBuffer, mimeType: "audio/wav" });
      const clipId = audioClips.store(turn.audioReply as Buffer, "audio/wav");
      if (turn.done) {
        sendXml(res, 200, twimlPlayThenHangup({ audioUrl: audioUrl(clipId) }));
      } else {
        sendXml(res, 200, twimlPlayThenRecord({ audioUrl: audioUrl(clipId), recordingActionUrl: recordingActionUrl(callSid) }));
      }
    } catch {
      voiceCalls.end(callSid);
      sendXml(res, 200, errorFallbackXml);
    }
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

async function handleAppointmentsRequest(
  scheduling: SchedulingService,
  matters: MattersService | undefined,
  req: IncomingMessage,
  res: ServerResponse,
  actor: Actor,
  url: URL,
  onMutated?: () => void,
): Promise<void> {
  if (url.pathname === "/api/appointments/reminders/due" && req.method === "GET") {
    const due = scheduling.getDueReminders(actor);
    // Enrichment only, and only for the system credential: the
    // reminder-sending job needs somewhere to mail the reminder, but no
    // human-facing view of this list currently shows it, so there's no
    // reason to widen what a receptionist/paralegal session gets back.
    // Best-effort — a matter with no client email on record (or no
    // MattersService configured at all) just sends nothing for that item.
    const enriched = due.map(({ appointment, reminder }) => ({
      appointment:
        actor.role === "system" && matters
          ? { ...appointment, recipientEmail: matters.clientEmailFor(actor, appointment.matterId) }
          : appointment,
      reminder,
    }));
    sendJson(res, 200, enriched);
    return;
  }

  const segments = url.pathname.replace(/^\/api\/appointments\/?/, "").split("/").filter(Boolean);

  if (segments.length === 0 && req.method === "GET") {
    const matterId = url.searchParams.get("matterId");
    const attorneyId = url.searchParams.get("attorneyId");
    const result =
      url.searchParams.get("pendingCalendarSync") === "true"
        ? scheduling.listPendingCalendarSync(actor)
        : matterId
          ? scheduling.listByMatter(actor, matterId)
          : attorneyId
            ? scheduling.listByAttorney(actor, attorneyId)
            : scheduling.listAll(actor);
    sendJson(res, 200, result);
    return;
  }

  if (segments.length === 0 && req.method === "POST") {
    const body = await readJsonBody(req);
    const appointment = scheduling.scheduleConsultation(actor, {
      matterId: String(body["matterId"] ?? ""),
      startTime: new Date(String(body["startTime"] ?? "")),
      ...(typeof body["durationMinutes"] === "number" ? { durationMinutes: body["durationMinutes"] } : {}),
      ...(typeof body["type"] === "string" ? { type: body["type"] as AppointmentType } : {}),
      ...(typeof body["attorneyId"] === "string" ? { attorneyId: body["attorneyId"] } : {}),
      ...(typeof body["practiceAreaId"] === "string" ? { practiceAreaId: body["practiceAreaId"] } : {}),
      allowOutsideBusinessHours: body["allowOutsideBusinessHours"] === true,
    });
    sendJson(res, 200, appointment);
    onMutated?.();
    return;
  }

  const id = segments[0];
  if (!id) {
    sendJson(res, 404, { error: "not found" });
    return;
  }

  if (segments.length === 1 && req.method === "GET") {
    const appointment = scheduling.get(actor, id);
    if (!appointment) {
      sendJson(res, 404, { error: `no appointment '${id}'` });
      return;
    }
    sendJson(res, 200, appointment);
    return;
  }

  if (segments.length === 2 && req.method === "POST") {
    const action = segments[1];
    const body = await readJsonBody(req);
    let result;
    switch (action) {
      case "reschedule":
        result = scheduling.reschedule(actor, id, {
          newStartTime: new Date(String(body["newStartTime"] ?? "")),
          allowOutsideBusinessHours: body["allowOutsideBusinessHours"] === true,
        });
        break;
      case "cancel":
        result = scheduling.cancel(actor, id, typeof body["reason"] === "string" ? body["reason"] : undefined);
        break;
      case "complete":
        result = scheduling.complete(actor, id);
        break;
      case "calendar-sync":
        // The calendar-push sync engine's write-back — system-role only,
        // same credential confirmDeadline requires for a calendar_system
        // source. Records the vendor's event id (or clears it once a
        // cancelled appointment's event has been deleted there).
        result = scheduling.recordCalendarSync(
          actor,
          id,
          typeof body["calendarEventId"] === "string" ? body["calendarEventId"] : undefined,
        );
        break;
      default:
        sendJson(res, 404, { error: "not found" });
        return;
    }
    sendJson(res, 200, result);
    onMutated?.();
    return;
  }

  if (segments.length === 3 && segments[1] === "reminders" && req.method === "POST") {
    const appointment = scheduling.markReminderSent(actor, id, segments[2]!);
    sendJson(res, 200, appointment);
    onMutated?.();
    return;
  }

  sendJson(res, 404, { error: "not found" });
}
