import { describe, expect, it } from "vitest";
import { AssistantSession } from "../src/assistant/assistant-session.js";
import type { AssistantTool } from "../src/assistant/tools.js";
import type { ClaudeClient, ClaudeMessage, ClaudeResponse, ClaudeToolDefinition } from "../src/integrations/anthropic.js";
import { AuditLog } from "../src/core/audit.js";
import type { Actor } from "../src/core/types.js";

const actor: Actor = { id: "p1", role: "paralegal" };

/** Scripted fake: returns queued responses in order, recording every request it was called with. */
class ScriptedClaudeClient implements ClaudeClient {
  #responses: ClaudeResponse[];
  calls: { system: string; messages: ClaudeMessage[]; tools?: ClaudeToolDefinition[] }[] = [];

  constructor(responses: ClaudeResponse[]) {
    this.#responses = responses;
  }

  async createMessage(params: { system: string; messages: ClaudeMessage[]; tools?: ClaudeToolDefinition[] }): Promise<ClaudeResponse> {
    this.calls.push({ ...params, messages: [...params.messages] });
    const next = this.#responses.shift();
    if (!next) throw new Error("ScriptedClaudeClient ran out of scripted responses");
    return next;
  }
}

function textResponse(text: string): ClaudeResponse {
  return { id: "msg_1", role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" };
}

function toolUseResponse(name: string, input: Record<string, unknown>): ClaudeResponse {
  return { id: "msg_1", role: "assistant", content: [{ type: "tool_use", id: "tu_1", name, input }], stop_reason: "tool_use" };
}

describe("AssistantSession", () => {
  it("returns a plain text reply when Claude doesn't call a tool", async () => {
    const client = new ScriptedClaudeClient([textResponse("Hello, how can I help?")]);
    const session = new AssistantSession({ client, tools: [], actor, auditLog: new AuditLog() });
    const reply = await session.sendMessage("hi");
    expect(reply).toBe("Hello, how can I help?");
  });

  it("executes a tool call and feeds the result back, looping to a final reply", async () => {
    const echoTool: AssistantTool = {
      definition: { name: "echo", description: "echoes input", input_schema: { type: "object" } },
      execute: async (_actor, input) => ({ echoed: input["text"] }),
    };
    const client = new ScriptedClaudeClient([toolUseResponse("echo", { text: "ping" }), textResponse("Done — echoed 'ping'.")]);
    const session = new AssistantSession({ client, tools: [echoTool], actor, auditLog: new AuditLog() });

    const reply = await session.sendMessage("echo ping please");
    expect(reply).toBe("Done — echoed 'ping'.");

    // Second call's messages should include the tool_result from the first.
    const secondCallMessages = client.calls[1]!.messages;
    const toolResultMessage = secondCallMessages.find(
      (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"),
    );
    expect(toolResultMessage).toBeDefined();
  });

  it("logs every executed tool call to the audit log", async () => {
    const auditLog = new AuditLog();
    const tool: AssistantTool = {
      definition: { name: "draft_thing", description: "d", input_schema: { type: "object" } },
      execute: async () => ({ ok: true }),
    };
    const client = new ScriptedClaudeClient([toolUseResponse("draft_thing", { matterId: "m1" }), textResponse("done")]);
    const session = new AssistantSession({ client, tools: [tool], actor, auditLog });

    await session.sendMessage("do the thing");
    const entries = auditLog.read("attorney");
    expect(entries.some((e) => e.action === "assistant_tool_call" && e.matterId === "m1")).toBe(true);
  });

  it("returns a tool_result error for an unknown tool name without throwing", async () => {
    const client = new ScriptedClaudeClient([toolUseResponse("nonexistent_tool", {}), textResponse("I couldn't do that.")]);
    const session = new AssistantSession({ client, tools: [], actor, auditLog: new AuditLog() });
    const reply = await session.sendMessage("do something impossible");
    expect(reply).toBe("I couldn't do that.");
  });

  it("surfaces a tool's thrown error as a tool_result error rather than crashing the turn", async () => {
    const failingTool: AssistantTool = {
      definition: { name: "fail", description: "d", input_schema: { type: "object" } },
      execute: async () => {
        throw new Error("access denied on matter m2");
      },
    };
    const client = new ScriptedClaudeClient([toolUseResponse("fail", {}), textResponse("That matter isn't accessible to you.")]);
    const session = new AssistantSession({ client, tools: [failingTool], actor, auditLog: new AuditLog() });
    const reply = await session.sendMessage("try the forbidden thing");
    expect(reply).toBe("That matter isn't accessible to you.");
  });

  it("throws after exceeding the max tool-call iteration guard", async () => {
    const loopingTool: AssistantTool = {
      definition: { name: "loop", description: "d", input_schema: { type: "object" } },
      execute: async () => ({ again: true }),
    };
    const responses = Array.from({ length: 10 }, () => toolUseResponse("loop", {}));
    const client = new ScriptedClaudeClient(responses);
    const session = new AssistantSession({ client, tools: [loopingTool], actor, auditLog: new AuditLog() });
    await expect(session.sendMessage("loop forever")).rejects.toThrow(/maximum number of tool-call steps/);
  });

  it("maintains conversation history across multiple sendMessage calls", async () => {
    const client = new ScriptedClaudeClient([textResponse("first reply"), textResponse("second reply")]);
    const session = new AssistantSession({ client, tools: [], actor, auditLog: new AuditLog() });
    await session.sendMessage("first message");
    await session.sendMessage("second message");
    const secondCallMessages = client.calls[1]!.messages;
    expect(secondCallMessages).toHaveLength(3); // user, assistant, user
  });
});
