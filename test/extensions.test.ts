import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { localEmbed, type Embedder } from "../src/cache/embeddings.js";
import { SemanticCache } from "../src/cache/semantic-cache.js";
import { stats } from "../src/keys/store.js";
import { buildServer } from "../src/server.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../src/types.js";
import { testGateway } from "./helpers.js";

const localEmbedder: Embedder = { kind: "local", embed: async (t) => localEmbed(t) };

function rag(question: string, context: string): ChatCompletionRequest {
  return {
    model: "mock",
    messages: [
      { role: "system", content: "Answer from the excerpts." },
      { role: "user", content: `${context}\n\nQuestion: ${question}` },
    ],
  };
}

const res = (text: string): ChatCompletionResponse => ({
  id: "x",
  object: "chat.completion",
  created: 0,
  model: "mock-1",
  choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

describe("aether cache extension", () => {
  const ctx = "lorem ipsum ".repeat(400); // long shared RAG context dominates the prompt

  it("without cache_key, a long shared context makes different questions collide", async () => {
    const cache = new SemanticCache(loadConfig(), localEmbedder);
    await cache.store(rag("who signed the treaty?", ctx), res("A"));
    // This is the failure mode cache_key exists to prevent.
    expect(await cache.lookup(rag("what year did the war end?", ctx))).not.toBeNull();
  });

  it("with cache_key, different questions over the same context miss", async () => {
    const cache = new SemanticCache(loadConfig(), localEmbedder);
    await cache.store(rag("who signed the treaty?", ctx), res("A"), { cache_key: "who signed the treaty?" });
    const miss = await cache.lookup(rag("what year did the war end?", ctx), { cache_key: "what year did the war end?" });
    expect(miss).toBeNull();
    const hit = await cache.lookup(rag("who signed the treaty?", ctx), { cache_key: "who signed the treaty?" });
    expect(hit?.response.choices[0]?.message.content).toBe("A");
  });

  it("cache_scope isolates identical questions about different documents", async () => {
    const cache = new SemanticCache(loadConfig(), localEmbedder);
    const ext = (scope: string) => ({ cache_key: "what is the deadline?", cache_scope: scope });
    await cache.store(rag("what is the deadline?", ctx), res("doc-a answer"), ext("doc-a"));
    expect(await cache.lookup(rag("what is the deadline?", ctx), ext("doc-b"))).toBeNull();
    expect(await cache.lookup(rag("what is the deadline?", ctx), ext("doc-a"))).not.toBeNull();
  });

  it("strips the aether field before routing and reports x-cache on streams", async () => {
    const { gw } = testGateway();
    const app = buildServer(gw);
    const body = (stream: boolean) =>
      JSON.stringify({
        model: "mock",
        stream,
        messages: [{ role: "user", content: "stream me please" }],
        aether: { cache_key: "stream me please", cache_scope: "t1" },
      });
    const post = (stream: boolean) =>
      app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: body(stream) });
    const first = await post(true);
    expect(first.headers.get("x-cache")).toBe("MISS");
    await first.text();
    const second = await post(true);
    expect(second.headers.get("x-cache")).toBe("HIT");
    await second.text();

    const m = (await (await app.request("/metrics")).json()) as {
      totals: { requests: number; cacheHits: number };
      latency: { uncached: { n: number }; cached: { n: number }; ttftUncached: { n: number } };
    };
    expect(m.totals.requests).toBe(2);
    expect(m.totals.cacheHits).toBe(1);
    expect(m.latency.uncached.n).toBe(1);
    expect(m.latency.cached.n).toBe(1);
    expect(m.latency.ttftUncached.n).toBe(1);

    const later = (await (await app.request(`/metrics?since=${Date.now() + 60_000}`)).json()) as { totals: { requests: number } };
    expect(later.totals.requests).toBe(0);
  });
});

describe("admin cache clear", () => {
  it("requires the admin key and empties the cache", async () => {
    const { gw } = testGateway();
    const app = buildServer(gw);
    await gw.cache.store({ model: "mock", messages: [{ role: "user", content: "hi" }] }, res("x"));
    expect((await app.request("/admin/cache/clear", { method: "POST" })).status).toBe(401);
    const ok = await app.request("/admin/cache/clear", { method: "POST", headers: { "x-admin-key": "test-admin" } });
    expect(((await ok.json()) as { removed: number }).removed).toBe(1);
    expect(gw.cache.stats().entries).toBe(0);
  });
});

describe("latency stats", () => {
  it("nearest-rank percentiles", () => {
    const s = stats([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 100]);
    expect(s.n).toBe(20);
    expect(s.p50).toBe(10);
    expect(s.p95).toBe(19);
    expect(stats([]).n).toBe(0);
  });
});

describe("GATEWAY_AUTH_REQUIRED override", () => {
  it("forces auth on from the environment", async () => {
    const { loadConfig: load } = await import("../src/config.js");
    process.env.GATEWAY_AUTH_REQUIRED = "true";
    try {
      expect(load().auth.required).toBe(true);
    } finally {
      delete process.env.GATEWAY_AUTH_REQUIRED;
    }
    expect(load().auth.required).toBe(false);
  });
});
