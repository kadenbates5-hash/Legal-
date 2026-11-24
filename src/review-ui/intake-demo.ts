import { randomBytes } from "node:crypto";
import { ReceptionistChatSession, type TurnTrace } from "../receptionist/chat-agent.js";
import { Router } from "../core/router.js";
import type { AccessControl } from "../core/access-control.js";
import type { AuditLog } from "../core/audit.js";
import type { PracticeAreaModule } from "../config/practice-area.js";
import { AccessDeniedError, type Actor } from "../core/types.js";
import type { FirmConfig } from "../config/firm-config.js";
import type { ConflictChecker } from "../core/conflicts.js";
import type { UtilizationTracker } from "../core/utilization.js";
import type { AcknowledgementSource } from "../receptionist/acknowledgements.js";

export interface IntakeDemoTurn {
  reply: string;
  done: boolean;
  /** What just happened — see `chat-agent.ts`'s `TurnTrace`. Purely observational, for the training UI's status display. */
  trace: TurnTrace;
  /**
   * The sentence natural phrasing put in front of the scripted reply, when
   * it did — so the training view can show exactly which words were the
   * script and which were added. Absent means `reply` is the script verbatim.
   */
  acknowledgement?: string;
}

interface DemoSession {
  session: ReceptionistChatSession;
  naturalPhrasing: boolean;
  /** Who started it. Only they can continue it: a transcript is whatever the trainee typed. */
  actorId: string;
}

/**
 * The roles that run intake for real — the only ones a training call is
 * for. The script screens every name a caller gives against the firm's
 * matters *before* any role check, so a demo open to anyone signed in was
 * a way to ask the firm, unaudited, "do you act for or against this
 * person?": a client account typing a party's name got "There may be a
 * conflict of interest here", and an unknown name didn't. The public
 * booking form never answers that question, and neither may this.
 */
const INTAKE_ROLES: ReadonlySet<Actor["role"]> = new Set(["receptionist", "attorney"]);

/**
 * In-memory, ephemeral sessions backing the dashboard's "Live Intake Demo"
 * panel — lets a logged-in attorney/staff member see exactly what a caller
 * would experience from `receptionist/chat-agent.ts`, from inside Docket,
 * without a real phone call or chat-widget integration. Deliberately NOT
 * persisted to `system-state.ts`: these are throwaway preview
 * conversations, not real caller intake — real intake is whatever channel
 * (chat widget, `voice-agent.ts`) drives a `ReceptionistChatSession`
 * directly, not this demo map. Sessions are pruned from memory as soon as
 * a conversation reaches `done: true`.
 *
 * Every turn still goes through the real `Router`/`AccessControl`, using
 * the actual logged-in actor. Only a receptionist or attorney can start
 * one (`INTAKE_ROLES`) — refused up front, before any session or
 * conflicts screen exists, rather than partway through a call.
 */
export class IntakeDemoSessions {
  #sessions = new Map<string, DemoSession>();
  #router: Router;
  #module: PracticeAreaModule;
  #utilization: UtilizationTracker | undefined;
  #firmConfig: FirmConfig | undefined;
  /** Firm-wide conflicts screen. Optional so a firm with no matter records yet still runs intake. */
  #conflictChecker: ConflictChecker | undefined;
  /** Optional natural phrasing — see `receptionist/acknowledgements.ts`. Absent, every reply is the script. */
  #acknowledgements: AcknowledgementSource | undefined;

  constructor(params: {
    accessControl: AccessControl;
    auditLog: AuditLog;
    module: PracticeAreaModule;
    utilization?: UtilizationTracker;
    firmConfig?: FirmConfig;
    conflictChecker?: ConflictChecker;
    acknowledgements?: AcknowledgementSource;
  }) {
    this.#router = new Router(params.accessControl, params.auditLog);
    this.#module = params.module;
    this.#utilization = params.utilization;
    this.#firmConfig = params.firmConfig;
    this.#conflictChecker = params.conflictChecker;
    this.#acknowledgements = params.acknowledgements;
  }

  /** Whether this server can offer natural phrasing at all. */
  get naturalPhrasingAvailable(): boolean {
    return this.#acknowledgements !== undefined;
  }

  start(actor: Actor, options: { naturalPhrasing?: boolean } = {}): { sessionId: string; turn: IntakeDemoTurn } {
    if (!INTAKE_ROLES.has(actor.role)) {
      throw new AccessDeniedError(`the intake demo is for receptionists and attorneys (got role '${actor.role}')`);
    }
    const sessionId = randomBytes(16).toString("hex");
    const session = new ReceptionistChatSession({
      matterId: `demo_${sessionId}`,
      module: this.#module,
      router: this.#router,
      actor,
      ...(this.#utilization ? { utilization: this.#utilization } : {}),
      ...(this.#firmConfig ? { firmConfig: this.#firmConfig } : {}),
      ...(this.#conflictChecker ? { conflictChecker: this.#conflictChecker } : {}),
    });
    this.#sessions.set(sessionId, {
      session,
      naturalPhrasing: options.naturalPhrasing === true && this.naturalPhrasingAvailable,
      actorId: actor.id,
    });
    const trace: TurnTrace = { label: "Greeting", triggers: [], state: { ...session.state } };
    return { sessionId, turn: { reply: session.greet(), done: false, trace } };
  }

  /**
   * A session someone else started reads as not existing, the same answer
   * as an unknown id, so a guessed id confirms nothing.
   */
  #entryFor(actor: Actor, sessionId: string): DemoSession {
    const entry = this.#sessions.get(sessionId);
    if (!entry || entry.actorId !== actor.id) {
      throw new Error(`no intake demo session '${sessionId}'`);
    }
    return entry;
  }

  /** One turn, always the exact script. */
  handleMessage(actor: Actor, sessionId: string, text: string): IntakeDemoTurn {
    const entry = this.#entryFor(actor, sessionId);
    const { acknowledgeable: _acknowledgeable, ...result } = entry.session.handleMessage(text);
    if (result.done) {
      this.#sessions.delete(sessionId);
    }
    return result;
  }

  /**
   * One turn, with natural phrasing when the conversation asked for it and
   * the session marked this turn acknowledgeable. Whatever happens with the
   * acknowledgement — added, rejected, timed out — the routing already
   * happened in `handleMessage` and the scripted question is unchanged.
   */
  async respond(actor: Actor, sessionId: string, text: string): Promise<IntakeDemoTurn> {
    const entry = this.#entryFor(actor, sessionId);
    const result = entry.session.handleMessage(text);
    if (result.done) {
      this.#sessions.delete(sessionId);
    }
    const { acknowledgeable, ...turn } = result;
    if (!acknowledgeable || result.done || !entry.naturalPhrasing || !this.#acknowledgements) {
      return turn;
    }
    const acknowledgement = await this.#acknowledgements.acknowledge({ callerMessage: text, nextQuestion: turn.reply });
    return acknowledgement ? { ...turn, reply: `${acknowledgement} ${turn.reply}`, acknowledgement } : turn;
  }
}
