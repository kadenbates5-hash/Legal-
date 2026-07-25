import { randomBytes } from "node:crypto";
import { AccessDeniedError, type Actor } from "../core/types.js";
import type { AuditLog } from "../core/audit.js";
import type { ClaudeClient } from "../integrations/anthropic.js";
import { AssistantSession } from "../assistant/assistant-session.js";
import { createAssistantTools, type AssistantToolDependencies } from "../assistant/tools.js";

/**
 * Backs Docket's "Assistant" panel — an internal AI assistant for
 * attorneys/paralegals, distinct from the client-facing receptionist
 * agent. Not receptionist-accessible: the receptionist's job is the
 * separate, hard-coded receptionist chat agent that handles callers.
 *
 * Sessions are in-memory and ephemeral, keyed by a random session id and
 * bound to the actor that created them (checked on every message) so one
 * authenticated user can't guess another's session id and read or
 * continue their conversation — a real risk here specifically because a
 * conversation can touch multiple matters' content over its lifetime,
 * unlike a single-purpose demo session.
 */
function requireAssistantRole(actor: Actor): void {
  if (actor.role !== "paralegal" && actor.role !== "attorney") {
    throw new AccessDeniedError(`the assistant is paralegal/attorney-only (got role '${actor.role}')`);
  }
}

interface StoredSession {
  actorId: string;
  session: AssistantSession;
}

export class AssistantService {
  #sessions = new Map<string, StoredSession>();
  #client: ClaudeClient;
  #auditLog: AuditLog;
  #toolDeps: AssistantToolDependencies;

  constructor(params: { client: ClaudeClient; auditLog: AuditLog; toolDeps: AssistantToolDependencies }) {
    this.#client = params.client;
    this.#auditLog = params.auditLog;
    this.#toolDeps = params.toolDeps;
  }

  start(actor: Actor): { sessionId: string } {
    requireAssistantRole(actor);
    const sessionId = randomBytes(16).toString("hex");
    const session = new AssistantSession({
      client: this.#client,
      tools: createAssistantTools(this.#toolDeps),
      actor,
      auditLog: this.#auditLog,
    });
    this.#sessions.set(sessionId, { actorId: actor.id, session });
    return { sessionId };
  }

  async sendMessage(actor: Actor, sessionId: string, text: string): Promise<{ reply: string }> {
    requireAssistantRole(actor);
    const stored = this.#sessions.get(sessionId);
    if (!stored || stored.actorId !== actor.id) {
      throw new Error(`no assistant session '${sessionId}'`);
    }
    const reply = await stored.session.sendMessage(text);
    return { reply };
  }

  end(actor: Actor, sessionId: string): void {
    requireAssistantRole(actor);
    const stored = this.#sessions.get(sessionId);
    if (stored && stored.actorId === actor.id) {
      this.#sessions.delete(sessionId);
    }
  }
}
