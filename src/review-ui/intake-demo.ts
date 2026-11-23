import { randomBytes } from "node:crypto";
import { ReceptionistChatSession, type TurnTrace } from "../receptionist/chat-agent.js";
import { Router } from "../core/router.js";
import type { AccessControl } from "../core/access-control.js";
import type { AuditLog } from "../core/audit.js";
import type { PracticeAreaModule } from "../config/practice-area.js";
import type { Actor } from "../core/types.js";
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
}

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
 * the actual logged-in actor — so the demo also doubles as a live view of
 * access control: a non-receptionist/attorney actor will hit the same
 * `AccessDeniedError` here that a real misconfigured caller session would.
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
    const sessionId = randomBytes(8).toString("hex");
    const session = new ReceptionistChatSession({
      matterId: `demo_${sessionId}`,
      module: this.#module,
      router: this.#router,
      actor,
      ...(this.#utilization ? { utilization: this.#utilization } : {}),
      ...(this.#firmConfig ? { firmConfig: this.#firmConfig } : {}),
      ...(this.#conflictChecker ? { conflictChecker: this.#conflictChecker } : {}),
    });
    this.#sessions.set(sessionId, { session, naturalPhrasing: options.naturalPhrasing === true && this.naturalPhrasingAvailable });
    const trace: TurnTrace = { label: "Greeting", triggers: [], state: { ...session.state } };
    return { sessionId, turn: { reply: session.greet(), done: false, trace } };
  }

  /** One turn, always the exact script. */
  handleMessage(sessionId: string, text: string): IntakeDemoTurn {
    const entry = this.#sessions.get(sessionId);
    if (!entry) {
      throw new Error(`no intake demo session '${sessionId}'`);
    }
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
  async respond(sessionId: string, text: string): Promise<IntakeDemoTurn> {
    const entry = this.#sessions.get(sessionId);
    if (!entry) {
      throw new Error(`no intake demo session '${sessionId}'`);
    }
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
