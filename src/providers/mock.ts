import { ProviderError } from "../types.js";
import type { ChatCompletionChunk } from "../types.js";
import { estimateTokens, nowSec } from "../util.js";
import type { Provider } from "./base.js";
import { makeChunk, newCompletionId } from "./openai.js";

// Offline provider: needs no credentials, deterministic output (so the semantic
// cache and tests behave predictably). Include "__FAIL__" in a message to force
// a retryable error — handy for exercising the router's failover path.

function lastUser(messages: { role: string; content: string | null }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") return m.content ?? "";
  }
  return "";
}

function reply(prompt: string, model: string): string {
  // Two deterministic failure triggers for exercising failover/circuit-breaking:
  // a "__FAIL__" marker in the prompt, or a model name containing "fail".
  if (prompt.includes("__FAIL__") || model.includes("fail")) {
    throw new ProviderError(`mock: forced failure (${model})`, 503, "mock", true);
  }
  return `[${model}] You said: ${prompt.trim()}`;
}

export const mockProvider: Provider = {
  name: "mock",

  async chat(req, opts) {
    const text = reply(lastUser(req.messages), opts.model);
    const prompt = estimateTokens(req.messages.map((m) => m.content ?? "").join(" "));
    const completion = estimateTokens(text);
    return {
      id: newCompletionId(),
      object: "chat.completion",
      created: nowSec(),
      model: opts.model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
    };
  },

  async *stream(req, opts): AsyncGenerator<ChatCompletionChunk> {
    const text = reply(lastUser(req.messages), opts.model);
    const id = newCompletionId();
    for (const word of text.split(" ")) {
      yield makeChunk(id, opts.model, word + " ", null);
    }
    yield makeChunk(id, opts.model, "", "stop");
  },
};
