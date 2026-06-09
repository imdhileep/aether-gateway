import { ProviderError } from "../types.js";
import type { ChatCompletionChunk, ChatCompletionRequest, ChatCompletionResponse, ChatMessage } from "../types.js";
import { isRetryableStatus, nowSec, sseEvents } from "../util.js";
import type { ChatOptions, Provider } from "./base.js";
import { makeChunk, newCompletionId } from "./openai.js";

interface GeminiContent {
  role: "user" | "model";
  parts: { text: string }[];
}

function adapt(messages: ChatMessage[]): { system: string; contents: GeminiContent[] } {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content ?? "")
    .join("\n\n");

  const contents: GeminiContent[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    const role: "user" | "model" = m.role === "assistant" ? "model" : "user";
    const text = m.content ?? "";
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push({ text });
    else contents.push({ role, parts: [{ text }] });
  }
  if (contents.length === 0) contents.push({ role: "user", parts: [{ text: "" }] });
  return { system, contents };
}

function mapFinish(reason: string | undefined): string {
  if (reason === "MAX_TOKENS") return "length";
  if (reason === "SAFETY" || reason === "RECITATION") return "content_filter";
  return "stop";
}

function buildBody(req: ChatCompletionRequest) {
  const { system, contents } = adapt(req.messages);
  const generationConfig: Record<string, unknown> = {};
  if (typeof req.temperature === "number") generationConfig.temperature = req.temperature;
  if (typeof req.top_p === "number") generationConfig.topP = req.top_p;
  if (typeof req.max_tokens === "number") generationConfig.maxOutputTokens = req.max_tokens;
  if (req.stop) generationConfig.stopSequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  const body: Record<string, unknown> = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
  return JSON.stringify(body);
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

function extractText(r: GeminiResponse): string {
  return (r.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
}

async function fail(res: Response): Promise<never> {
  const text = await res.text().catch(() => "");
  throw new ProviderError(
    `gemini ${res.status}: ${text.slice(0, 300)}`,
    res.status,
    "gemini",
    isRetryableStatus(res.status),
  );
}

export const geminiProvider: Provider = {
  name: "gemini",

  async chat(req, opts) {
    const url = `${opts.baseUrl}/models/${encodeURIComponent(opts.model)}:generateContent?key=${encodeURIComponent(opts.apiKey)}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: buildBody(req),
        signal: opts.signal,
      });
    } catch (e) {
      throw new ProviderError(`gemini network error: ${(e as Error).message}`, 0, "gemini", true);
    }
    if (!res.ok) await fail(res);
    const json = (await res.json()) as GeminiResponse;
    const prompt = json.usageMetadata?.promptTokenCount ?? 0;
    const completion = json.usageMetadata?.candidatesTokenCount ?? 0;
    const result: ChatCompletionResponse = {
      id: newCompletionId(),
      object: "chat.completion",
      created: nowSec(),
      model: opts.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: extractText(json) },
          finish_reason: mapFinish(json.candidates?.[0]?.finishReason),
        },
      ],
      usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
    };
    return result;
  },

  async *stream(req, opts): AsyncGenerator<ChatCompletionChunk> {
    const url = `${opts.baseUrl}/models/${encodeURIComponent(opts.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(opts.apiKey)}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: buildBody(req),
        signal: opts.signal,
      });
    } catch (e) {
      throw new ProviderError(`gemini network error: ${(e as Error).message}`, 0, "gemini", true);
    }
    if (!res.ok) await fail(res);
    if (!res.body) throw new ProviderError("gemini: empty stream body", 502, "gemini", true);

    const id = newCompletionId();
    let finish: string | undefined;
    for await (const data of sseEvents(res.body)) {
      const json = JSON.parse(data) as GeminiResponse;
      const text = extractText(json);
      if (text) yield makeChunk(id, opts.model, text, null);
      const fr = json.candidates?.[0]?.finishReason;
      if (fr) finish = fr;
    }
    yield makeChunk(id, opts.model, "", mapFinish(finish));
  },
};
