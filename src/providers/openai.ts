import { ProviderError } from "../types.js";
import type { ChatCompletionChunk, ChatCompletionRequest, ChatCompletionResponse } from "../types.js";
import { estimateTokens, flattenMessages, genId, isRetryableStatus, nowSec, sseEvents } from "../util.js";
import type { ChatOptions, EmbedOptions, Provider } from "./base.js";

// OpenAI is the reference wire format, so adaptation is mostly a passthrough.
// We still normalize usage + ids so downstream accounting is uniform.

function buildBody(req: ChatCompletionRequest, model: string, stream: boolean) {
  const { model: _ignored, stream: _s, ...rest } = req;
  return JSON.stringify({ ...rest, model, stream });
}

async function fail(res: Response, provider: string): Promise<never> {
  const text = await res.text().catch(() => "");
  throw new ProviderError(
    `${provider} ${res.status}: ${text.slice(0, 300)}`,
    res.status,
    provider,
    isRetryableStatus(res.status),
  );
}

export const openaiProvider: Provider = {
  name: "openai",

  async chat(req, opts) {
    let res: Response;
    try {
      res = await fetch(`${opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
        body: buildBody(req, opts.model, false),
        signal: opts.signal,
      });
    } catch (e) {
      throw new ProviderError(`openai network error: ${(e as Error).message}`, 0, "openai", true);
    }
    if (!res.ok) await fail(res, "openai");
    const json = (await res.json()) as ChatCompletionResponse;
    if (!json.usage) {
      const out = json.choices?.[0]?.message?.content ?? "";
      json.usage = {
        prompt_tokens: estimateTokens(flattenMessages(req.messages)),
        completion_tokens: estimateTokens(out),
        total_tokens: 0,
      };
      json.usage.total_tokens = json.usage.prompt_tokens + json.usage.completion_tokens;
    }
    return json;
  },

  async *stream(req, opts): AsyncGenerator<ChatCompletionChunk> {
    let res: Response;
    try {
      res = await fetch(`${opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
        body: buildBody(req, opts.model, true),
        signal: opts.signal,
      });
    } catch (e) {
      throw new ProviderError(`openai network error: ${(e as Error).message}`, 0, "openai", true);
    }
    if (!res.ok) await fail(res, "openai");
    if (!res.body) throw new ProviderError("openai: empty stream body", 502, "openai", true);
    for await (const data of sseEvents(res.body)) {
      if (data === "[DONE]") return;
      yield JSON.parse(data) as ChatCompletionChunk;
    }
  },

  async embed(input, opts: EmbedOptions) {
    let res: Response;
    try {
      res = await fetch(`${opts.baseUrl}/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({ model: opts.model, input }),
      });
    } catch (e) {
      throw new ProviderError(`openai network error: ${(e as Error).message}`, 0, "openai", true);
    }
    if (!res.ok) await fail(res, "openai");
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return json.data.map((d) => d.embedding);
  },
};

// Re-exported helpers for adapters that mimic OpenAI's chunk shape.
export function makeChunk(id: string, model: string, content: string, finish: string | null): ChatCompletionChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created: nowSec(),
    model,
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finish }],
  };
}

export function newCompletionId(): string {
  return genId("chatcmpl");
}
