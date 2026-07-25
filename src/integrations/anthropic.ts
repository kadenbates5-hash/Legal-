/**
 * Real Claude API client (Anthropic Messages API) — the model behind
 * Docket's internal "Assistant" panel. Hand-rolled via `fetch` rather
 * than the `@anthropic-ai/sdk` package, matching this project's
 * dependency-light style (`server.ts` is dependency-free; `pg` was the
 * one justified exception) — the Messages API is a single well-documented
 * JSON endpoint, not worth a dependency.
 *
 * Unlike the Voicebox/CourtListener/Google Calendar integrations, this
 * one isn't a best-effort reconstruction from partial docs — the
 * Messages API shape here (endpoint, headers, request/response schema,
 * tool-use blocks) is written with high confidence.
 */
const API_VERSION = "2023-06-01";
const DEFAULT_BASE_URL = "https://api.anthropic.com";
/** Per the harness's own model-selection guidance: default to the latest, most capable Claude model for a new AI application. Override via ANTHROPIC_MODEL. */
export const DEFAULT_MODEL = "claude-sonnet-5";

export interface ClaudeToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type ClaudeContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: string | ClaudeContentBlock[];
}

export interface ClaudeResponse {
  id: string;
  role: "assistant";
  content: ClaudeContentBlock[];
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
}

export interface AnthropicClientConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
}

/** Vendor-agnostic seam `AssistantSession` depends on, same pattern as `SpeechToText`/`CaseLawSearchClient` elsewhere — lets tests use a fake client instead of a real network call. */
export interface ClaudeClient {
  createMessage(params: { system: string; messages: ClaudeMessage[]; tools?: ClaudeToolDefinition[] }): Promise<ClaudeResponse>;
}

export class AnthropicClient implements ClaudeClient {
  #apiKey: string;
  #model: string;
  #baseUrl: string;
  #maxTokens: number;

  constructor(config: AnthropicClientConfig) {
    this.#apiKey = config.apiKey;
    this.#model = config.model ?? DEFAULT_MODEL;
    this.#baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#maxTokens = config.maxTokens ?? 2048;
  }

  async createMessage(params: { system: string; messages: ClaudeMessage[]; tools?: ClaudeToolDefinition[] }): Promise<ClaudeResponse> {
    const res = await fetch(`${this.#baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.#apiKey,
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify({
        model: this.#model,
        max_tokens: this.#maxTokens,
        system: params.system,
        messages: params.messages,
        ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`Claude API request failed (${res.status}): ${await res.text()}`);
    }
    return (await res.json()) as ClaudeResponse;
  }
}
