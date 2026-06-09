import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { testGateway } from "./helpers.js";

function app() {
  return buildServer(testGateway().gw);
}

function chat(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://local/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("HTTP server", () => {
  it("serves a non-streaming completion via the mock model", async () => {
    const a = app();
    const res = await a.request(chat({ model: "mock", messages: [{ role: "user", content: "hello world" }] }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(json.choices[0]!.message.content).toContain("hello world");
    expect(res.headers.get("x-cache")).toBe("MISS");
    expect(res.headers.get("x-served-by")).toBe("mock");
  });

  it("returns a semantic cache HIT on an identical follow-up", async () => {
    const a = app();
    const body = { model: "mock", messages: [{ role: "user", content: "capital of France?" }] };
    await a.request(chat(body));
    const res2 = await a.request(chat(body));
    expect(res2.headers.get("x-cache")).toBe("HIT");
  });

  it("redacts PII from the input before it reaches the model", async () => {
    const a = app();
    const res = await a.request(chat({ model: "mock", messages: [{ role: "user", content: "reach me at bob@acme.io" }] }));
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(json.choices[0]!.message.content).toContain("[REDACTED_EMAIL]");
    expect(json.choices[0]!.message.content).not.toContain("bob@acme.io");
  });

  it("streams SSE chunks ending in [DONE]", async () => {
    const a = app();
    const res = await a.request(chat({ model: "mock", messages: [{ role: "user", content: "stream this" }], stream: true }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("data:");
    expect(text).toContain("[DONE]");
  });

  it("rejects an invalid request body", async () => {
    const a = app();
    const res = await a.request(chat({ messages: [] }));
    expect(res.status).toBe(400);
  });

  it("lists models and exposes metrics", async () => {
    const a = app();
    await a.request(chat({ model: "mock", messages: [{ role: "user", content: "warm up metrics" }] }));
    const models = (await (await a.request("http://local/v1/models")).json()) as { data: unknown[] };
    expect(models.data.length).toBeGreaterThan(0);
    const metrics = (await (await a.request("http://local/metrics")).json()) as { totals: { requests: number } };
    expect(metrics.totals.requests).toBeGreaterThanOrEqual(1);
  });

  it("guards the admin API and mints virtual keys", async () => {
    const a = app();
    const unauthorized = await a.request("http://local/admin/keys", { method: "POST", body: "{}" });
    expect(unauthorized.status).toBe(401);

    const created = await a.request("http://local/admin/keys", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": "test-admin" },
      body: JSON.stringify({ name: "ci-key", budgetUsd: 5 }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { key: string };
    expect(body.key).toMatch(/^sk-aether-/);
  });

  it("serves the dashboard HTML", async () => {
    const a = app();
    const res = await a.request("http://local/dashboard");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Aether Gateway");
  });
});
