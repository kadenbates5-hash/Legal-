import { utcOffsetLabel } from "../core/instant.js";
import type { Actor } from "../core/types.js";
import type { AuditLog } from "../core/audit.js";
import type { ClaudeClient, ClaudeContentBlock, ClaudeMessage } from "../integrations/anthropic.js";
import type { AssistantTool } from "./tools.js";

/** A tool-calling loop that never terminates would be a real-money bug against a metered API — this is the circuit breaker. */
const MAX_TOOL_ITERATIONS = 8;

export const DEFAULT_SYSTEM_PROMPT = `You are Docket's internal AI assistant for this law firm's attorneys and paralegals — not a client-facing tool (that's the separate receptionist agent). You have real tools to search case law, draft and revise work product, manage the research library, and handle scheduling, all scoped to exactly what the current user is already allowed to do.

Hard limits, not suggestions:
- You cannot approve, reject, request revision on, release, or otherwise change the review status of any work product. Submitting a draft for review is as far as you go — an attorney must take it from there.
- You cannot confirm a deadline. Deadline confirmation exists specifically to require a second, independent, non-agent source; you calling a tool would defeat that purpose entirely.
- You cannot create, disable, or modify any account.
- A case-law search result is not a verified citation, and a drafted research summary is not verified legal analysis — say so when it's relevant, and never present either as ready to send to a client or file with a court.
- If something you're asked to do isn't covered by your tools, say so plainly instead of improvising around the restriction.`;

/**
 * What "today" and "10am" mean at this firm, for the system prompt. The
 * model has no clock: asked to book "tomorrow at 10", it guessed the date
 * from its training and wrote the time with no zone, which the server
 * read as UTC. This tells it the date, the time and the firm's offset,
 * and how to write a time so it lands where it was meant.
 */
export function firmClockContext(timeZone: string, now: Date): string {
  let zone = timeZone;
  let when: string;
  try {
    when = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(now);
  } catch {
    zone = "UTC";
    when = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "full", timeStyle: "short" }).format(now);
  }
  const offset = utcOffsetLabel(zone, now) ?? "+00:00";
  return [
    `Right now it is ${when} in the firm's time zone, ${zone} (UTC${offset}).`,
    `Read "today", "tomorrow" and weekday names from that date. When a tool takes a date and time, write it in the firm's zone with its offset — for example ${exampleTime(zone, now, offset)} — unless the user names another zone. Daylight saving can change the offset between now and the date meant; use the offset in force on that date.`,
  ].join(" ");
}

function exampleTime(timeZone: string, now: Date, offset: string): string {
  // Tomorrow's date in the firm's zone, at 10:00.
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const day = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(tomorrow);
  return `${day}T10:00:00${offset}`;
}

export class AssistantSession {
  #client: ClaudeClient;
  #tools: AssistantTool[];
  #actor: Actor;
  #auditLog: AuditLog;
  #systemPrompt: string;
  #context: (() => string) | undefined;
  #messages: ClaudeMessage[] = [];

  constructor(params: {
    client: ClaudeClient;
    tools: AssistantTool[];
    actor: Actor;
    auditLog: AuditLog;
    systemPrompt?: string;
    /** Facts that change while a conversation runs (today's date), worked out afresh for every request. */
    context?: () => string;
  }) {
    this.#client = params.client;
    this.#tools = params.tools;
    this.#actor = params.actor;
    this.#auditLog = params.auditLog;
    this.#systemPrompt = params.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.#context = params.context;
  }

  async sendMessage(text: string): Promise<string> {
    this.#messages.push({ role: "user", content: text });

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const context = this.#context?.();
      const response = await this.#client.createMessage({
        system: context ? `${this.#systemPrompt}\n\n${context}` : this.#systemPrompt,
        messages: this.#messages,
        tools: this.#tools.map((t) => t.definition),
      });
      this.#messages.push({ role: "assistant", content: response.content });

      const toolUses = response.content.filter((block): block is Extract<ClaudeContentBlock, { type: "tool_use" }> => block.type === "tool_use");
      if (toolUses.length === 0) {
        return response.content
          .filter((block): block is Extract<ClaudeContentBlock, { type: "text" }> => block.type === "text")
          .map((block) => block.text)
          .join("\n");
      }

      const toolResults: ClaudeContentBlock[] = [];
      for (const toolUse of toolUses) {
        toolResults.push(await this.#runTool(toolUse));
      }
      this.#messages.push({ role: "user", content: toolResults });
    }

    throw new Error("assistant exceeded the maximum number of tool-call steps for one turn");
  }

  async #runTool(toolUse: Extract<ClaudeContentBlock, { type: "tool_use" }>): Promise<ClaudeContentBlock> {
    const tool = this.#tools.find((t) => t.definition.name === toolUse.name);
    if (!tool) {
      return { type: "tool_result", tool_use_id: toolUse.id, content: `no such tool '${toolUse.name}'`, is_error: true };
    }
    try {
      const result = await tool.execute(this.#actor, toolUse.input);
      const matterId = typeof toolUse.input["matterId"] === "string" ? toolUse.input["matterId"] : undefined;
      this.#auditLog.append({
        actor: this.#actor,
        matterId,
        action: "assistant_tool_call",
        detail: `${toolUse.name}(${JSON.stringify(toolUse.input)})`,
      });
      return { type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify(result) };
    } catch (err) {
      return { type: "tool_result", tool_use_id: toolUse.id, content: err instanceof Error ? err.message : String(err), is_error: true };
    }
  }
}
