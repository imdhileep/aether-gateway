// ── Core OpenAI-compatible wire types ──────────────────────────────────────
// The gateway speaks the OpenAI Chat Completions schema on its public edge and
// normalizes every provider into these shapes.

export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream?: boolean;
  stop?: string | string[];
  user?: string;
  // Allow provider-specific passthrough fields without losing type-safety elsewhere.
  [key: string]: unknown;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatChoice {
  index: number;
  message: { role: "assistant"; content: string };
  finish_reason: string;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatChoice[];
  usage: Usage;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: {
    index: number;
    delta: { role?: "assistant"; content?: string };
    finish_reason: string | null;
  }[];
}

// ── Internal request context threaded through the pipeline ──────────────────

export interface RequestContext {
  /** The logical model the client asked for (e.g. "smart"). */
  requestedModel: string;
  /** Resolved virtual key id, or null when unauthenticated. */
  keyId: string | null;
  /** Whether the served response came from the semantic cache. */
  cached: boolean;
  /** Provider that ultimately served the request. */
  servedBy?: string;
  /** Concrete upstream model that served the request. */
  servedModel?: string;
  startedAt: number;
}

/** Normalized error so the router can decide whether to fail over. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly provider: string,
    /** Retryable errors trigger failover to the next target. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
