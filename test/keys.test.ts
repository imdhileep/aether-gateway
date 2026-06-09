import { describe, expect, it } from "vitest";
import { KeyService } from "../src/keys/keys.js";
import { Store } from "../src/keys/store.js";
import { testConfig } from "./helpers.js";

function service() {
  const config = testConfig();
  return new KeyService(new Store(":memory:"), config);
}

describe("KeyService", () => {
  it("creates and authenticates a key", () => {
    const ks = service();
    const { key, row } = ks.createKey({ name: "test" });
    expect(key).toMatch(/^sk-aether-/);
    const auth = ks.authenticate(key);
    expect(auth.ok).toBe(true);
    if (auth.ok) expect(auth.key?.id).toBe(row.id);
    expect(ks.authenticate("sk-aether-bogus").ok).toBe(false);
  });

  it("enforces budgets after spend is recorded", () => {
    const ks = service();
    const { key } = ks.createKey({ name: "budget", budgetUsd: 0.001 });
    const k1 = ks.authenticate(key);
    expect(k1.ok && ks.authorize(k1.ok ? k1.key : null, "mock").ok).toBe(true);

    ks.record({
      keyId: k1.ok ? k1.key!.id : null,
      requestedModel: "smart",
      provider: "openai",
      upstreamModel: "gpt-4o",
      promptTokens: 1000,
      completionTokens: 1000,
      costUsd: 0.0125,
      cached: false,
      latencyMs: 10,
      status: 200,
    });

    const k2 = ks.authenticate(key); // fresh row with updated spend
    expect(k2.ok).toBe(true);
    const authz = k2.ok ? ks.authorize(k2.key, "mock") : { ok: true as const, key: null };
    expect(authz.ok).toBe(false);
    if (!authz.ok) expect(authz.status).toBe(402);
  });

  it("enforces per-minute rate limits", () => {
    const ks = service();
    const { row } = ks.createKey({ name: "rl", rpmLimit: 1 });
    expect(ks.authorize(row, "mock").ok).toBe(true);
    const second = ks.authorize(row, "mock");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.status).toBe(429);
  });

  it("restricts models via allowlist", () => {
    const ks = service();
    const { row } = ks.createKey({ name: "scoped", models: ["mock"] });
    expect(ks.authorize(row, "mock").ok).toBe(true);
    expect(ks.authorize(row, "gpt-4o").ok).toBe(false);
  });

  it("aggregates usage into a summary", () => {
    const ks = service();
    ks.record({
      keyId: null,
      requestedModel: "mock",
      provider: "mock",
      upstreamModel: "mock-1",
      promptTokens: 5,
      completionTokens: 7,
      costUsd: 0,
      cached: false,
      latencyMs: 3,
      status: 200,
    });
    const s = ks.summary();
    expect(s.totals.requests).toBe(1);
    expect(s.byModel[0]!.model).toBe("mock");
  });
});
