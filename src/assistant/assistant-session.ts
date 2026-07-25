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

export class AssistantSession {
  #client: ClaudeClient;
  #tools: AssistantTool[];
  #actor: Actor;
  #auditLog: AuditLog;
  #systemPrompt: string;
  #messages: ClaudeMessage[] = [];

  constructor(params: { client: ClaudeClient; tools: AssistantTool[]; actor: Actor; auditLog: AuditLog; systemPrompt?: string }) {
    this.#client = params.client;
    this.#tools = params.tools;
    this.#actor = params.actor;
    this.#auditLog = params.auditLog;
    this.#systemPrompt = params.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  }

  async sendMessage(text: string): Promise<string> {
    this.#messages.push({ role: "user", content: text });

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const response = await this.#client.createMessage({
        system: this.#systemPrompt,
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
