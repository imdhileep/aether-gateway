import { ProviderError } from "../types.js";
import type { ChatCompletionChunk, ChatCompletionRequest, ChatCompletionResponse, ChatMessage } from "../types.js";
import { isRetryableStatus, nowSec, sseEvents } from "../util.js";
import type { ChatOptions, Provider } from "./base.js";
import { makeChunk, newCompletionId } from "./openai.js";

const DEFAULT_MAX_TOKENS = 1024;

interface AnthropicMsg {
  role: "user" | "assistant";
  content: string;
}

// Split OpenAI-style messages into Anthropic's (system, messages) and merge
// consecutive same-role turns (Anthropic rejects adjacent same-role messages).
function adapt(messages: ChatMessage[]): { system: string; messages: AnthropicMsg[] } {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content ?? "")
    .join("\n\n");

  const merged: AnthropicMsg[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    const role: "user" | "assistant" = m.role === "assistant" ? "assistant" : "user";
    const content = m.content ?? "";
    const last = merged[merged.length - 1];
    if (last && last.role === role) last.content += `\n\n${content}`;
    else merged.push({ role, content });
  }
  if (merged.length === 0) merged.push({ role: "user", content: "" });
  return { system, messages: merged };
}

function mapStop(reason: string | null | undefined): string {
  if (reason === "max_tokens") return "length";
  return "stop";
}

function buildBody(req: ChatCompletionRequest, model: string, stream: boolean) {
  const { system, messages } = adapt(req.messages);
  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: req.max_tokens ?? DEFAULT_MAX_TOKENS,
    stream,
  };
  if (system) body.system = system;
  if (typeof req.temperature === "number") body.temperature = req.temperature;
  if (typeof req.top_p === "number") body.top_p = req.top_p;
  if (req.stop) body.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  return JSON.stringify(body);
}

function headers(opts: ChatOptions) {
  return {
    "content-type": "application/json",
    "x-api-key": opts.apiKey,
    "anthropic-version": opts.extra?.anthropicVersion ?? "2023-06-01",
  };
}

async function fail(res: Response): Promise<never> {
  const text = await res.text().catch(() => "");
  throw new ProviderError(
    `anthropic ${res.status}: ${text.slice(0, 300)}`,
    res.status,
    "anthropic",
    isRetryableStatus(res.status),
  );
}

export const anthropicProvider: Provider = {
  name: "anthropic",

  async chat(req, opts) {
    let res: Response;
    try {
      res = await fetch(`${opts.baseUrl}/messages`, {
        method: "POST",
        headers: headers(opts),
        body: buildBody(req, opts.model, false),
        signal: opts.signal,
      });
    } catch (e) {
      throw new ProviderError(`anthropic network error: ${(e as Error).message}`, 0, "anthropic", true);
    }
    if (!res.ok) await fail(res);
    const json = (await res.json()) as {
      content: { type: string; text?: string }[];
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
    };
    const text = json.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    const prompt = json.usage?.input_tokens ?? 0;
    const completion = json.usage?.output_tokens ?? 0;
    const result: ChatCompletionResponse = {
      id: newCompletionId(),
      object: "chat.completion",
      created: nowSec(),
      model: opts.model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: mapStop(json.stop_reason) }],
      usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
    };
    return result;
  },

  async *stream(req, opts): AsyncGenerator<ChatCompletionChunk> {
    let res: Response;
    try {
      res = await fetch(`${opts.baseUrl}/messages`, {
        method: "POST",
        headers: headers(opts),
        body: buildBody(req, opts.model, true),
        signal: opts.signal,
      });
    } catch (e) {
      throw new ProviderError(`anthropic network error: ${(e as Error).message}`, 0, "anthropic", true);
    }
    if (!res.ok) await fail(res);
    if (!res.body) throw new ProviderError("anthropic: empty stream body", 502, "anthropic", true);

    const id = newCompletionId();
    let stopReason: string | null = null;
    for await (const data of sseEvents(res.body)) {
      const evt = JSON.parse(data) as {
        type: string;
        delta?: { type?: string; text?: string; stop_reason?: string };
      };
      if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
        yield makeChunk(id, opts.model, evt.delta.text ?? "", null);
      } else if (evt.type === "message_delta" && evt.delta?.stop_reason) {
        stopReason = evt.delta.stop_reason;
      } else if (evt.type === "message_stop") {
        yield makeChunk(id, opts.model, "", mapStop(stopReason));
        return;
      }
    }
    yield makeChunk(id, opts.model, "", mapStop(stopReason));
  },
};
