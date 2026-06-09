import { describe, expect, it } from "vitest";
import { Router } from "../src/router/router.js";
import type { RequestContext } from "../src/types.js";
import { testConfig } from "./helpers.js";

function ctx(model: string): RequestContext {
  return { requestedModel: model, keyId: null, cached: false, startedAt: Date.now() };
}

const messages = [{ role: "user" as const, content: "hello" }];

describe("Router", () => {
  it("fails over to the next target when the first one errors", async () => {
    const config = testConfig();
    config.models["failover"] = { targets: [{ provider: "mock", model: "mock-fail" }, { provider: "mock", model: "mock-1" }] };
    const router = new Router(config);
    const c = ctx("failover");
    const res = await router.chat({ model: "failover", messages }, c);
    expect(c.servedModel).toBe("mock-1");
    expect(res.choices[0]!.message.content).toContain("mock-1");
  });

  it("throws when every target fails", async () => {
    const config = testConfig();
    config.models["broken"] = { targets: [{ provider: "mock", model: "mock-fail" }] };
    const router = new Router(config);
    await expect(router.chat({ model: "broken", messages }, ctx("broken"))).rejects.toThrow();
  });

  it("opens the circuit breaker after repeated failures", async () => {
    const config = testConfig();
    config.retry.max_attempts_per_target = 1;
    config.retry.circuit_failure_threshold = 2;
    config.models["dead"] = { targets: [{ provider: "mock", model: "mock-fail" }] };
    const router = new Router(config);
    await router.chat({ model: "dead", messages }, ctx("dead")).catch(() => {});
    await router.chat({ model: "dead", messages }, ctx("dead")).catch(() => {});
    expect(router.health()["mock:mock-fail"]?.open).toBe(true);
  });

  it("infers a provider for unconfigured models by prefix", () => {
    const router = new Router(testConfig());
    expect(router.resolveTargets("claude-3-5-sonnet-latest")[0]?.provider).toBe("anthropic");
    expect(router.resolveTargets("gpt-4o")[0]?.provider).toBe("openai");
    expect(router.resolveTargets("gemini-1.5-flash")[0]?.provider).toBe("gemini");
  });
});
