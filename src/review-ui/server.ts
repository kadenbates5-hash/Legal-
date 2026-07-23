import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { AccessDeniedError, ReviewGateError, type Actor } from "../core/types.js";
import { ReviewGateService } from "./review-service.js";

/**
 * Attorney review-gate UI backend (§8 build order step 5): a small JSON API
 * over `ReviewGateService`, plus the static dashboard page in `public/`.
 * Deliberately dependency-free (Node's built-in `http`, no framework) —
 * this is a seed implementation to prove the UI surface end to end, not a
 * production auth story. Actor identity comes from `x-actor-id`/
 * `x-actor-role` request headers, which is a stand-in for real
 * authentication (§5/§6 flag real auth/session handling as launch
 * prerequisites, not yet built here).
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

function actorFromHeaders(req: IncomingMessage): Actor {
  const id = firstHeader(req.headers["x-actor-id"]) ?? "unknown";
  const role = firstHeader(req.headers["x-actor-role"]) ?? "unknown";
  return { id, role: role as Actor["role"] };
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

function errorStatus(err: unknown): number {
  if (err instanceof AccessDeniedError) return 403;
  if (err instanceof ReviewGateError) return 409;
  if (err instanceof Error && err.message.startsWith("no work product")) return 404;
  return 400;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

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
 * reject, request-revision, release, clear-flag) — a persistence layer can
 * hook this to save after every mutation without this file knowing
 * anything about how or where state is persisted. See
 * `review-ui/start.ts` for the file-backed wiring.
 */
export function createReviewServer(service: ReviewGateService, onMutated?: () => void): Server {
  return createServer((req, res) => {
    void handleRequest(service, req, res, onMutated);
  });
}

async function handleRequest(
  service: ReviewGateService,
  req: IncomingMessage,
  res: ServerResponse,
  onMutated?: () => void,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (!url.pathname.startsWith("/api/")) {
    if (req.method === "GET") await serveStatic(res, url.pathname);
    else sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  try {
    const actor = actorFromHeaders(req);
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
          result = service.clearFlag(actor, id, String(body["flag"] ?? ""));
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
