import { randomBytes } from "node:crypto";
import { ReceptionistChatSession } from "../receptionist/chat-agent.js";
import { Router } from "../core/router.js";
import type { AccessControl } from "../core/access-control.js";
import type { AuditLog } from "../core/audit.js";
import type { PracticeAreaModule } from "../config/practice-area.js";
import type { Actor } from "../core/types.js";
import type { FirmConfig } from "../config/firm-config.js";
import type { UtilizationTracker } from "../core/utilization.js";

export interface IntakeDemoTurn {
  reply: string;
  done: boolean;
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
  #sessions = new Map<string, ReceptionistChatSession>();
  #router: Router;
  #module: PracticeAreaModule;
  #utilization: UtilizationTracker | undefined;
  #firmConfig: FirmConfig | undefined;

  constructor(params: {
    accessControl: AccessControl;
    auditLog: AuditLog;
    module: PracticeAreaModule;
    utilization?: UtilizationTracker;
    firmConfig?: FirmConfig;
  }) {
    this.#router = new Router(params.accessControl, params.auditLog);
    this.#module = params.module;
    this.#utilization = params.utilization;
    this.#firmConfig = params.firmConfig;
  }

  start(actor: Actor): { sessionId: string; turn: IntakeDemoTurn } {
    const sessionId = randomBytes(8).toString("hex");
    const session = new ReceptionistChatSession({
      matterId: `demo_${sessionId}`,
      module: this.#module,
      router: this.#router,
      actor,
      ...(this.#utilization ? { utilization: this.#utilization } : {}),
      ...(this.#firmConfig ? { firmConfig: this.#firmConfig } : {}),
    });
    this.#sessions.set(sessionId, session);
    return { sessionId, turn: { reply: session.greet(), done: false } };
  }

  handleMessage(sessionId: string, text: string): IntakeDemoTurn {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      throw new Error(`no intake demo session '${sessionId}'`);
    }
    const result = session.handleMessage(text);
    if (result.done) {
      this.#sessions.delete(sessionId);
    }
    return result;
  }
}
