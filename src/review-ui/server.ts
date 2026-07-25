import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { AccessDeniedError, ReviewGateError, type Actor } from "../core/types.js";
import { AuthError, type AuthService } from "../core/auth.js";
import type { DeadlineType } from "../core/deadline.js";
import { SchedulingError, type AppointmentType, type SchedulingService } from "../core/scheduling.js";
import { ReviewGateService } from "./review-service.js";
import type { IntakeDemoSessions } from "./intake-demo.js";
import type { AccountsService } from "./accounts-service.js";
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

function sessionCookieHeader(token: string, expiresAt: string): string {
  const maxAgeSeconds = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
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

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid JSON body");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...extraHeaders });
  res.end(payload);
}

function errorStatus(err: unknown): number {
  if (err instanceof AuthError) {
    // Account-creation validation (bad password/duplicate username) is a
    // 400 from an already-authenticated caller, not an auth failure —
    // only login/system-key mismatches are genuinely 401.
    if (err.message.includes("already exists") || err.message.includes("must be at least")) return 400;
    return 401;
  }
  if (err instanceof AccessDeniedError) return 403;
  if (err instanceof ReviewGateError) return 409;
  if (err instanceof Error && err.message.startsWith("no work product")) return 404;
  if (err instanceof Error && err.message.startsWith("no intake demo session")) return 404;
  if (err instanceof Error && err.message.startsWith("no user")) return 404;
  if (err instanceof Error && err.message.startsWith("cannot disable")) return 409;
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

/** Static assets other than the dashboard itself are always servable (the login page has to be reachable while logged out). */
async function serveStatic(res: ServerResponse, requestPath: string): Promise<void> {
  const relative = requestPath === "/" ? "index.html" : requestPath.slice(1);
  const resolved = path.normalize(path.join(PUBLIC_DIR, relative));
  if (!resolved.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }
  try {
    const content = await readFile(resolved);
    const ext = path.extname(resolved);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream" });
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
export function createReviewServer(
  service: ReviewGateService,
  auth: AuthService,
  onMutated?: () => void,
  scheduling?: SchedulingService,
  intake?: IntakeDemoSessions,
  accounts?: AccountsService,
): Server {
  return createServer((req, res) => {
    void handleRequest(service, auth, req, res, onMutated, scheduling, intake, accounts);
  });
}

async function handleRequest(
  service: ReviewGateService,
  auth: AuthService,
  req: IncomingMessage,
  res: ServerResponse,
  onMutated?: () => void,
  scheduling?: SchedulingService,
  intake?: IntakeDemoSessions,
  accounts?: AccountsService,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/api/login" && req.method === "POST") {
    await handleLogin(auth, req, res, onMutated);
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
      sendJson(res, 200, { id: actor.id, role: actor.role, username: user?.username });
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
        res.writeHead(302, { Location: "/login.html" });
        res.end();
        return;
      }
    }
    await serveStatic(res, url.pathname);
    return;
  }

  try {
    const actor = resolveActor(req, auth);

    if (url.pathname.startsWith("/api/deadlines")) {
      await handleDeadlineRequest(service, req, res, actor, url, onMutated);
      return;
    }

    if (url.pathname.startsWith("/api/appointments")) {
      if (!scheduling) {
        sendJson(res, 404, { error: "scheduling is not configured on this server" });
        return;
      }
      await handleAppointmentsRequest(scheduling, req, res, actor, url, onMutated);
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
  onMutated?: () => void,
): Promise<void> {
  try {
    const body = await readJsonBody(req);
    const username = String(body["username"] ?? "");
    const password = String(body["password"] ?? "");
    const remember = body["remember"] === true;
    const session = auth.login(username, password, remember);
    const user = auth.userForToken(session.token);
    sendJson(
      res,
      200,
      { id: user?.actorId, role: user?.role, username: user?.username },
      { "Set-Cookie": sessionCookieHeader(session.token, session.expiresAt) },
    );
    onMutated?.();
  } catch (err) {
    sendJson(res, err instanceof AuthError ? 401 : 400, { error: err instanceof Error ? err.message : "invalid request" });
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

  if (url.pathname === "/api/deadlines" && req.method === "GET") {
    const matterId = url.searchParams.get("matterId");
    const type = url.searchParams.get("type") as DeadlineType | null;
    if (!matterId || !type) {
      sendJson(res, 400, { error: "matterId and type query params are required" });
      return;
    }
    sendJson(res, 200, service.getDeadlineStatus(actor, matterId, type));
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
    });
    sendJson(res, 200, result);
    onMutated?.();
    return;
  }

  const segments = url.pathname.replace(/^\/api\/accounts\/?/, "").split("/").filter(Boolean);
  if (segments.length === 2 && req.method === "POST") {
    const id = segments[0]!;
    const action = segments[1];
    let result;
    if (action === "disable") result = accounts.disable(actor, id);
    else if (action === "enable") result = accounts.enable(actor, id);
    else {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    sendJson(res, 200, result);
    onMutated?.();
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

async function handleAppointmentsRequest(
  scheduling: SchedulingService,
  req: IncomingMessage,
  res: ServerResponse,
  actor: Actor,
  url: URL,
  onMutated?: () => void,
): Promise<void> {
  if (url.pathname === "/api/appointments/reminders/due" && req.method === "GET") {
    sendJson(res, 200, scheduling.getDueReminders());
    return;
  }

  const segments = url.pathname.replace(/^\/api\/appointments\/?/, "").split("/").filter(Boolean);

  if (segments.length === 0 && req.method === "GET") {
    const matterId = url.searchParams.get("matterId");
    const attorneyId = url.searchParams.get("attorneyId");
    const result = matterId ? scheduling.listByMatter(matterId) : attorneyId ? scheduling.listByAttorney(attorneyId) : scheduling.listAll();
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
    const appointment = scheduling.get(id);
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
      default:
        sendJson(res, 404, { error: "not found" });
        return;
    }
    sendJson(res, 200, result);
    onMutated?.();
    return;
  }

  if (segments.length === 3 && segments[1] === "reminders" && req.method === "POST") {
    scheduling.markReminderSent(id, segments[2]!);
    sendJson(res, 200, scheduling.get(id));
    onMutated?.();
    return;
  }

  sendJson(res, 404, { error: "not found" });
}
