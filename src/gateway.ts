import { costFor } from "./analytics/pricing.js";
import { SemanticCache } from "./cache/semantic-cache.js";
import type { ResolvedConfig } from "./config.js";
import { applyInputGuardrails, applyOutputGuardrails, type InputGuardResult } from "./guardrails/index.js";
import { KeyService } from "./keys/keys.js";
import { Store, type VirtualKeyRow } from "./keys/store.js";
import { Router } from "./router/router.js";
import type { ChatCompletionRequest, ChatCompletionResponse, RequestContext } from "./types.js";
import { estimateTokens, flattenMessages, genId, nowSec } from "./util.js";

export interface GatewayDeps {
  store?: Store;
  cache?: SemanticCache;
}

export interface Prepared {
  req: ChatCompletionRequest;
  key: VirtualKeyRow | null;
  ctx: RequestContext;
  guard: InputGuardResult;
}

export type PrepareResult = { ok: true; prepared: Prepared } | { ok: false; status: number; message: string };

export interface CompleteResult {
  response: ChatCompletionResponse;
  cache: "HIT" | "MISS";
  similarity?: number;
}

function contentOf(res: ChatCompletionResponse): string {
  return res.choices[0]?.message.content ?? "";
}

export class Gateway {
  readonly router: Router;
  readonly cache: SemanticCache;
  readonly keys: KeyService;

  constructor(
    readonly config: ResolvedConfig,
    deps: GatewayDeps = {},
  ) {
    this.router = new Router(config);
    this.cache = deps.cache ?? new SemanticCache(config);
    const store = deps.store ?? new Store(config.keys.db_path);
    this.keys = new KeyService(store, config);
  }

  /** Auth → authorize → input guardrails. Mutates req.messages with redactions. */
  prepare(req: ChatCompletionRequest, bearer: string | null): PrepareResult {
    const auth = this.keys.authenticate(bearer);
    if (!auth.ok) return auth;

    const ctx: RequestContext = {
      requestedModel: req.model,
      keyId: auth.key?.id ?? null,
      cached: false,
      startedAt: Date.now(),
    };

    const authz = this.keys.authorize(auth.key, req.model);
    if (!authz.ok) return authz;

    const guard = applyInputGuardrails(req.messages, this.config);
    if (guard.blocked) return { ok: false, status: 400, message: guard.blockReason ?? "Blocked by guardrails" };
    req.messages = guard.messages;

    return { ok: true, prepared: { req, key: auth.key, ctx, guard } };
  }

  /** Non-streaming completion: cache → route+failover → output guardrails → record. */
  async complete(p: Prepared, signal?: AbortSignal): Promise<CompleteResult> {
    const hit = await this.cache.lookup(p.req);
    if (hit) {
      p.ctx.cached = true;
      this.redactOutput(hit.response);
      this.recordUsage(p, hit.response, 0, true);
      return { response: hit.response, cache: "HIT", similarity: hit.similarity };
    }

    const res = await this.router.chat(p.req, p.ctx, signal);
    this.redactOutput(res);
    await this.cache.store(p.req, res);
    const cost = costFor(p.ctx.servedModel ?? p.req.model, res.usage);
    this.recordUsage(p, res, cost, false);
    return { response: res, cache: "MISS" };
  }

  /** Build a response object for an accumulated stream, then cache + record it. */
  async finishStream(p: Prepared, fullText: string): Promise<void> {
    const promptTokens = estimateTokens(flattenMessages(p.req.messages));
    const completionTokens = estimateTokens(fullText);
    const response: ChatCompletionResponse = {
      id: genId("chatcmpl"),
      object: "chat.completion",
      created: nowSec(),
      model: p.ctx.servedModel ?? p.req.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: applyOutputGuardrails(fullText, this.config).content },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
    };
    await this.cache.store(p.req, response);
    const cost = costFor(p.ctx.servedModel ?? p.req.model, response.usage);
    this.recordUsage(p, response, cost, false);
  }

  recordCachedStream(p: Prepared, cached: ChatCompletionResponse): void {
    p.ctx.cached = true;
    this.recordUsage(p, cached, 0, true);
  }

  private redactOutput(res: ChatCompletionResponse): void {
    const choice = res.choices[0];
    if (!choice) return;
    choice.message.content = applyOutputGuardrails(contentOf(res), this.config).content;
  }

  private recordUsage(p: Prepared, res: ChatCompletionResponse, cost: number, cached: boolean): void {
    this.keys.record({
      keyId: p.ctx.keyId,
      requestedModel: p.ctx.requestedModel,
      provider: p.ctx.servedBy ?? (cached ? "cache" : null),
      upstreamModel: p.ctx.servedModel ?? null,
      promptTokens: res.usage.prompt_tokens,
      completionTokens: res.usage.completion_tokens,
      costUsd: cost,
      cached,
      latencyMs: Date.now() - p.ctx.startedAt,
      status: 200,
    });
  }
}

export function buildGateway(config: ResolvedConfig, deps?: GatewayDeps): Gateway {
  return new Gateway(config, deps);
}
