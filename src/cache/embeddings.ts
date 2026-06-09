import type { ResolvedConfig } from "../config.js";
import { log } from "../logger.js";
import { openaiProvider } from "../providers/openai.js";

export interface Embedder {
  readonly kind: "openai" | "local";
  embed(text: string): Promise<number[]>;
}

const LOCAL_DIMS = 384;

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic, dependency-free embedding via feature hashing of token
 * unigrams + bigrams into a fixed L2-normalized vector. It captures lexical
 * overlap (good for near-duplicate prompts) — not true semantics, but a
 * sensible offline fallback when no embedding API key is available.
 */
export function localEmbed(text: string, dims = LOCAL_DIMS): number[] {
  const v = new Array<number>(dims).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const add = (token: string) => {
    const idx = fnv1a(token) % dims;
    const sign = (fnv1a(token + "#") & 1) === 0 ? 1 : -1; // signed hashing reduces collisions
    v[idx] = (v[idx] ?? 0) + sign;
  };
  for (let i = 0; i < tokens.length; i++) {
    add(tokens[i]!);
    if (i + 1 < tokens.length) add(`${tokens[i]}_${tokens[i + 1]}`);
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => x / norm);
}

export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Build the embedder the cache should use, honoring config + available keys. */
export function makeEmbedder(config: ResolvedConfig): Embedder {
  const mode = config.cache.embeddings.provider;
  const openaiCfg = config.providers.openai;
  const hasOpenAiKey = !!openaiCfg && openaiCfg.apiKeys.length > 0;
  const useOpenai = mode === "openai" || (mode === "auto" && hasOpenAiKey);

  if (useOpenai && openaiCfg && hasOpenAiKey) {
    const model = config.cache.embeddings.model;
    log.info("semantic cache: OpenAI embeddings", { model });
    return {
      kind: "openai",
      async embed(text) {
        const vecs = await openaiProvider.embed!([text], {
          apiKey: openaiCfg.apiKeys[0]!,
          model,
          baseUrl: openaiCfg.baseUrl,
        });
        return vecs[0]!;
      },
    };
  }

  log.info("semantic cache: local hashing embeddings (set OPENAI_API_KEY for semantic matching)");
  return {
    kind: "local",
    async embed(text) {
      return localEmbed(text);
    },
  };
}
