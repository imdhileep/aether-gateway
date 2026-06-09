import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { cosine, localEmbed, type Embedder } from "../src/cache/embeddings.js";
import { SemanticCache } from "../src/cache/semantic-cache.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../src/types.js";

const localEmbedder: Embedder = { kind: "local", embed: async (t) => localEmbed(t) };

function req(content: string, model = "mock", temperature = 0): ChatCompletionRequest {
  return { model, messages: [{ role: "user", content }], temperature };
}

function res(text: string): ChatCompletionResponse {
  return {
    id: "x",
    object: "chat.completion",
    created: 0,
    model: "mock-1",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

describe("embeddings", () => {
  it("identical text -> cosine 1", () => {
    expect(cosine(localEmbed("hello there"), localEmbed("hello there"))).toBeCloseTo(1, 5);
  });
  it("overlapping text scores higher than unrelated", () => {
    const base = localEmbed("the quick brown fox jumps");
    const near = cosine(base, localEmbed("the quick brown fox leaps"));
    const far = cosine(base, localEmbed("completely unrelated banana topic"));
    expect(near).toBeGreaterThan(far);
  });
});

describe("SemanticCache", () => {
  it("returns a hit for an identical prompt", async () => {
    const cache = new SemanticCache(loadConfig(), localEmbedder);
    await cache.store(req("what is the capital of France?"), res("Paris"));
    const hit = await cache.lookup(req("what is the capital of France?"));
    expect(hit).not.toBeNull();
    expect(hit!.response.choices[0]!.message.content).toBe("Paris");
    expect(hit!.similarity).toBeGreaterThan(0.99);
  });

  it("misses across different model buckets", async () => {
    const cache = new SemanticCache(loadConfig(), localEmbedder);
    await cache.store(req("hello", "mock"), res("hi"));
    expect(await cache.lookup(req("hello", "other-model"))).toBeNull();
  });

  it("does not cache high-temperature requests", async () => {
    const config = loadConfig();
    const cache = new SemanticCache(config, localEmbedder);
    const hot = req("hello", "mock", 1.0); // above max_temperature
    expect(cache.cacheable(hot)).toBe(false);
    await cache.store(hot, res("hi"));
    expect(await cache.lookup(hot)).toBeNull();
  });

  it("tracks hit/miss stats", async () => {
    const cache = new SemanticCache(loadConfig(), localEmbedder);
    await cache.lookup(req("nope")); // miss
    await cache.store(req("yes"), res("ok"));
    await cache.lookup(req("yes")); // hit
    const s = cache.stats();
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(1);
    expect(s.embedder).toBe("local");
  });
});
