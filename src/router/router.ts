import type { ResolvedConfig, ResolvedProvider } from "../config.js";
import { log } from "../logger.js";
import { getProvider } from "../providers/index.js";
import { ProviderError } from "../types.js";
import type { ChatCompletionChunk, ChatCompletionRequest, ChatCompletionResponse, RequestContext } from "../types.js";

const REQUEST_TIMEOUT_MS = 120_000;

export interface ResolvedTarget {
  provider: string;
  model: string;
  cfg: ResolvedProvider;
}

interface CircuitState {
  failures: number;
  openUntil: number;
}

function inferProvider(model: string): string {
  const m = model.toLowerCase();
  if (m.startsWith("claude")) return "anthropic";
  if (m.startsWith("gemini")) return "gemini";
  if (m.startsWith("mock")) return "mock";
  return "openai"; // gpt-*, o1/o3/o4, chatgpt-*, text-*, …
}

export class Router {
  private circuits = new Map<string, CircuitState>();
  private rr = new Map<string, number>();

  constructor(private config: ResolvedConfig) {}

  /** Logical models the gateway advertises (explicit config + each provider). */
  listModels(): string[] {
    return Object.keys(this.config.models);
  }

  /** Snapshot of circuit-breaker state for /healthz. */
  health(): Record<string, { open: boolean; failures: number }> {
    const out: Record<string, { open: boolean; failures: number }> = {};
    const now = Date.now();
    for (const [k, v] of this.circuits) out[k] = { open: v.openUntil > now, failures: v.failures };
    return out;
  }

  resolveTargets(model: string): ResolvedTarget[] {
    const entry = this.config.models[model];
    const raw = entry ? entry.targets : [{ provider: inferProvider(model), model }];
    const resolved: ResolvedTarget[] = [];
    for (const t of raw) {
      const cfg = this.config.providers[t.provider];
      if (cfg) resolved.push({ provider: t.provider, model: t.model, cfg });
    }
    return resolved;
  }

  private pickKey(cfg: ResolvedProvider): string | null {
    if (cfg.name === "mock") return "mock-key";
    if (cfg.apiKeys.length === 0) return null;
    const i = (this.rr.get(cfg.name) ?? 0) % cfg.apiKeys.length;
    this.rr.set(cfg.name, i + 1);
    return cfg.apiKeys[i] ?? null;
  }

  private circuitKey(t: ResolvedTarget): string {
    return `${t.provider}:${t.model}`;
  }

  private circuitOpen(key: string): boolean {
    const c = this.circuits.get(key);
    return !!c && c.openUntil > Date.now();
  }

  private onSuccess(key: string): void {
    this.circuits.set(key, { failures: 0, openUntil: 0 });
  }

  private onFailure(key: string): void {
    const c = this.circuits.get(key) ?? { failures: 0, openUntil: 0 };
    c.failures += 1;
    if (c.failures >= this.config.retry.circuit_failure_threshold) {
      c.openUntil = Date.now() + this.config.retry.circuit_cooldown_ms;
      log.warn("circuit opened", { target: key, cooldownMs: this.config.retry.circuit_cooldown_ms });
    }
    this.circuits.set(key, c);
  }

  private mkSignal(external?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    return external ? AbortSignal.any([external, timeout]) : timeout;
  }

  private chatOptions(t: ResolvedTarget, apiKey: string, signal: AbortSignal) {
    return {
      apiKey,
      model: t.model,
      baseUrl: t.cfg.baseUrl,
      signal,
      extra: t.cfg.anthropicVersion ? { anthropicVersion: t.cfg.anthropicVersion } : undefined,
    };
  }

  async chat(req: ChatCompletionRequest, ctx: RequestContext, external?: AbortSignal): Promise<ChatCompletionResponse> {
    const targets = this.resolveTargets(ctx.requestedModel);
    if (targets.length === 0) {
      throw new ProviderError(`No configured provider for model "${ctx.requestedModel}"`, 400, "router", false);
    }
    const signal = this.mkSignal(external);
    const maxAttempts = this.config.retry.max_attempts_per_target;
    let lastErr: ProviderError | null = null;

    for (const t of targets) {
      const ckey = this.circuitKey(t);
      if (this.circuitOpen(ckey)) {
        log.debug("skip target (circuit open)", { target: ckey });
        continue;
      }
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const apiKey = this.pickKey(t.cfg);
        if (!apiKey) break; // provider has no credentials configured — try next target
        try {
          const provider = getProvider(t.provider);
          const res = await provider.chat(req, this.chatOptions(t, apiKey, signal));
          this.onSuccess(ckey);
          ctx.servedBy = t.provider;
          ctx.servedModel = t.model;
          return res;
        } catch (e) {
          const err = e instanceof ProviderError ? e : new ProviderError((e as Error).message, 500, t.provider, true);
          lastErr = err;
          if (!err.retryable) throw err;
          this.onFailure(ckey);
          log.warn("target attempt failed", { target: ckey, attempt, status: err.status });
        }
      }
    }
    throw lastErr ?? new ProviderError(`All targets failed for "${ctx.requestedModel}"`, 503, "router", true);
  }

  async *stream(
    req: ChatCompletionRequest,
    ctx: RequestContext,
    external?: AbortSignal,
  ): AsyncGenerator<ChatCompletionChunk> {
    const targets = this.resolveTargets(ctx.requestedModel);
    if (targets.length === 0) {
      throw new ProviderError(`No configured provider for model "${ctx.requestedModel}"`, 400, "router", false);
    }
    const signal = this.mkSignal(external);
    const maxAttempts = this.config.retry.max_attempts_per_target;
    let lastErr: ProviderError | null = null;

    for (const t of targets) {
      const ckey = this.circuitKey(t);
      if (this.circuitOpen(ckey)) continue;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const apiKey = this.pickKey(t.cfg);
        if (!apiKey) break;
        const provider = getProvider(t.provider);
        const gen = provider.stream(req, this.chatOptions(t, apiKey, signal));
        try {
          // Pull the first chunk so connection errors fail over BEFORE we commit
          // to streaming bytes to the client.
          const first = await gen.next();
          this.onSuccess(ckey);
          ctx.servedBy = t.provider;
          ctx.servedModel = t.model;
          if (!first.done && first.value) yield first.value;
          // Past the first chunk we are committed — no failover mid-stream.
          let next = await gen.next();
          while (!next.done) {
            yield next.value;
            next = await gen.next();
          }
          return;
        } catch (e) {
          const err = e instanceof ProviderError ? e : new ProviderError((e as Error).message, 500, t.provider, true);
          lastErr = err;
          if (!err.retryable) throw err;
          this.onFailure(ckey);
          log.warn("stream attempt failed", { target: ckey, attempt, status: err.status });
        }
      }
    }
    throw lastErr ?? new ProviderError(`All targets failed for "${ctx.requestedModel}"`, 503, "router", true);
  }
}
