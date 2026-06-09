import type { ChatCompletionChunk, ChatCompletionRequest, ChatCompletionResponse } from "../types.js";

export interface ChatOptions {
  apiKey: string;
  /** Concrete upstream model name to send to the provider. */
  model: string;
  baseUrl: string;
  signal?: AbortSignal;
  /** Provider-specific extras (e.g. anthropic version header). */
  extra?: Record<string, string>;
}

export interface EmbedOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
}

export interface Provider {
  readonly name: string;
  chat(req: ChatCompletionRequest, opts: ChatOptions): Promise<ChatCompletionResponse>;
  stream(req: ChatCompletionRequest, opts: ChatOptions): AsyncGenerator<ChatCompletionChunk, void, unknown>;
  /** Optional — only providers that expose an embeddings endpoint implement this. */
  embed?(input: string[], opts: EmbedOptions): Promise<number[][]>;
}
