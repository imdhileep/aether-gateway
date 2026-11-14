import type { ResolvedConfig } from "../config.js";
import { log } from "../logger.js";
import type { AetherExtension, ChatCompletionRequest, ChatCompletionResponse } from "../types.js";
import { flattenMessages, genId, nowSec } from "../util.js";
import { cosine, makeEmbedder, type Embedder } from "./embeddings.js";

interface CacheEntry {
  vector: number[];
  response: ChatCompletionResponse;
  bucket: string;
  expiresAt: number;
  lastUsed: number;
}

export interface CacheHit {
  response: ChatCompletionResponse;
  similarity: number;
}

export interface CacheStats {
  enabled: boolean;
  embedder: "openai" | "local";
  entries: number;
  hits: number;
  misses: number;
  hitRate: number;
}

/** Round temperature into a coarse bucket so deterministic calls share a slot. */
function tempBucket(t: number | undefined): string {
  return String(Math.round((t ?? 0) * 10));
}

export class SemanticCache {
  private entries: CacheEntry[] = [];
  private hits = 0;
  private misses = 0;
  private readonly embedder: Embedder;

  constructor(
    private config: ResolvedConfig,
    embedder?: Embedder,
  ) {
    this.embedder = embedder ?? makeEmbedder(config);
  }

  private get c() {
    return this.config.cache;
  }

  private bucketOf(req: ChatCompletionRequest, ext?: AetherExtension): string {
    const scope = ext?.cache_scope ? `:${ext.cache_scope}` : "";
    return `${req.model}:${tempBucket(req.temperature)}${scope}`;
  }

  /** Cacheable only when enabled and the call is (near-)deterministic. */
  cacheable(req: ChatCompletionRequest): boolean {
    return this.c.enabled && (req.temperature ?? 0) <= this.c.max_temperature;
  }

  private async vectorFor(req: ChatCompletionRequest, ext?: AetherExtension): Promise<number[] | null> {
    try {
      return await this.embedder.embed(ext?.cache_key ?? flattenMessages(req.messages));
    } catch (e) {
      log.warn("cache embed failed; bypassing cache", { error: (e as Error).message });
      return null;
    }
  }

  async lookup(req: ChatCompletionRequest, ext?: AetherExtension): Promise<CacheHit | null> {
    if (!this.cacheable(req)) return null;
    const qv = await this.vectorFor(req, ext);
    if (!qv) return null;

    const bucket = this.bucketOf(req, ext);
    const now = Date.now();
    let best = -1;
    let bestIdx = -1;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]!;
      if (e.expiresAt < now || e.bucket !== bucket) continue;
      const sim = cosine(qv, e.vector);
      if (sim > best) {
        best = sim;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0 && best >= this.c.similarity_threshold) {
      const entry = this.entries[bestIdx]!;
      entry.lastUsed = now;
      this.hits++;
      // Return a fresh-looking clone so the client sees a normal response.
      const clone = structuredClone(entry.response);
      clone.id = genId("chatcmpl");
      clone.created = nowSec();
      return { response: clone, similarity: best };
    }
    this.misses++;
    return null;
  }

  async store(req: ChatCompletionRequest, response: ChatCompletionResponse, ext?: AetherExtension): Promise<void> {
    if (!this.cacheable(req)) return;
    const v = await this.vectorFor(req, ext);
    if (!v) return;

    const now = Date.now();
    this.entries = this.entries.filter((e) => e.expiresAt >= now);
    if (this.entries.length >= this.c.max_entries) {
      // Evict least-recently-used.
      let lruIdx = 0;
      for (let i = 1; i < this.entries.length; i++) {
        if (this.entries[i]!.lastUsed < this.entries[lruIdx]!.lastUsed) lruIdx = i;
      }
      this.entries.splice(lruIdx, 1);
    }
    this.entries.push({
      vector: v,
      response: structuredClone(response),
      bucket: this.bucketOf(req, ext),
      expiresAt: now + this.c.ttl_seconds * 1000,
      lastUsed: now,
    });
  }

  /** Drop every entry and reset hit/miss counters. Returns entries removed. */
  clear(): number {
    const n = this.entries.length;
    this.entries = [];
    this.hits = 0;
    this.misses = 0;
    return n;
  }

  stats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      enabled: this.c.enabled,
      embedder: this.embedder.kind,
      entries: this.entries.length,
      hits: this.hits,
      misses: this.misses,
      hitRate: total ? this.hits / total : 0,
    };
  }
}
