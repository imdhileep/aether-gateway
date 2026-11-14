import { costFor } from "./analytics/pricing.js";
import { SemanticCache } from "./cache/semantic-cache.js";
import type { ResolvedConfig } from "./config.js";
import { applyInputGuardrails, applyOutputGuardrails, type InputGuardResult } from "./guardrails/index.js";
import { KeyService } from "./keys/keys.js";
import { Store, type VirtualKeyRow } from "./keys/store.js";
import { Router } from "./router/router.js";
import type { AetherExtension, ChatCompletionRequest, ChatCompletionResponse, RequestContext, Usage } from "./types.js";
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

    // The `aether` extension is gateway-only: strip it so it never reaches an upstream API.
    const { aether, ...upstream } = req;
    req = upstream as ChatCompletionRequest;
    const ctx: RequestContext = {
      requestedModel: req.model,
      keyId: auth.key?.id ?? null,
      cached: false,
      startedAt: Date.now(),
      aether: parseExtension(aether),
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
    const hit = await this.cache.lookup(p.req, p.ctx.aether);
    if (hit) {
      p.ctx.cached = true;
      this.redactOutput(hit.response);
      this.recordUsage(p, hit.response, 0, true);
      return { response: hit.response, cache: "HIT", similarity: hit.similarity };
    }

    const res = await this.router.chat(p.req, p.ctx, signal);
    this.redactOutput(res);
    await this.cache.store(p.req, res, p.ctx.aether);
    const cost = costFor(p.ctx.servedModel ?? p.req.model, res.usage);
    this.recordUsage(p, res, cost, false);
    return { response: res, cache: "MISS" };
  }

  /** Build a response object for an accumulated stream, then cache + record it. */
  async finishStream(p: Prepared, fullText: string, usage?: Usage, ttftMs?: number): Promise<void> {
    // Prefer the upstream's real token counts; estimate only when it sent none.
    const promptTokens = usage?.prompt_tokens || estimateTokens(flattenMessages(p.req.messages));
    const completionTokens = usage?.completion_tokens || estimateTokens(fullText);
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
    await this.cache.store(p.req, response, p.ctx.aether);
    const cost = costFor(p.ctx.servedModel ?? p.req.model, response.usage);
    this.recordUsage(p, response, cost, false, ttftMs);
  }

  recordCachedStream(p: Prepared, cached: ChatCompletionResponse, ttftMs?: number): void {
    p.ctx.cached = true;
    this.recordUsage(p, cached, 0, true, ttftMs);
  }

  private redactOutput(res: ChatCompletionResponse): void {
    const choice = res.choices[0];
    if (!choice) return;
    choice.message.content = applyOutputGuardrails(contentOf(res), this.config).content;
  }

  private recordUsage(p: Prepared, res: ChatCompletionResponse, cost: number, cached: boolean, ttftMs?: number): void {
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
      ttftMs: ttftMs ?? null,
      status: 200,
    });
  }
}

function parseExtension(raw: unknown): AetherExtension | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const ext: AetherExtension = {};
  if (typeof r.cache_key === "string" && r.cache_key.trim()) ext.cache_key = r.cache_key;
  if (typeof r.cache_scope === "string" && r.cache_scope.trim()) ext.cache_scope = r.cache_scope;
  return Object.keys(ext).length ? ext : undefined;
}

export function buildGateway(config: ResolvedConfig, deps?: GatewayDeps): Gateway {
  return new Gateway(config, deps);
}
