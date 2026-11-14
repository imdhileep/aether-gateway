import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { dashboardHtml } from "./dashboard/dashboard.js";
import type { Gateway } from "./gateway.js";
import type { InputGuardResult } from "./guardrails/index.js";
import { log } from "./logger.js";
import { makeChunk } from "./providers/openai.js";
import { ProviderError, type ChatCompletionChunk, type ChatCompletionRequest, type ChatMessage } from "./types.js";
import { genId } from "./util.js";

const MessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.string().nullable().optional(),
    name: z.string().optional(),
  })
  .passthrough();

const ChatBodySchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(MessageSchema).min(1),
    stream: z.boolean().optional(),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().positive().optional(),
  })
  .passthrough();

const CreateKeySchema = z.object({
  name: z.string().min(1),
  budgetUsd: z.number().positive().nullable().optional(),
  rpmLimit: z.number().int().positive().nullable().optional(),
  models: z.array(z.string()).nullable().optional(),
});

function jsonResponse(obj: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...headers } });
}

function errorResponse(status: number, message: string, type = "gateway_error"): Response {
  return jsonResponse({ error: { message, type, code: status } }, status);
}

function bearerFrom(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  return authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : authHeader.trim();
}

// Surfaces guardrail activity to the caller so `flag` mode is observable rather
// than silent. Redactions already happened in-place inside the gateway.
function guardHeaders(guard: InputGuardResult): Record<string, string> {
  const h: Record<string, string> = {};
  if (guard.pii.length > 0) h["x-guardrail-pii"] = guard.pii.map((f) => `${f.type}:${f.count}`).join(",");
  if (guard.injection.detected) {
    h["x-guardrail-injection"] = `score=${guard.injection.score}; patterns=${guard.injection.patterns.join("|")}`;
  }
  return h;
}

function providerErrorResponse(e: unknown): Response {
  if (e instanceof ProviderError) {
    const status = e.status >= 400 ? e.status : 502;
    return errorResponse(status, e.message, "upstream_error");
  }
  log.error("unhandled error", { error: (e as Error).message });
  return errorResponse(500, (e as Error).message ?? "internal error");
}

export function buildServer(gw: Gateway): Hono {
  const app = new Hono();

  app.use("/v1/*", cors());
  app.use("/metrics", cors());

  app.get("/", (c) => c.html(dashboardHtml()));
  app.get("/dashboard", (c) => c.html(dashboardHtml()));

  app.get("/healthz", () =>
    jsonResponse({ status: "ok", version: "0.1.0", models: gw.router.listModels(), circuits: gw.router.health() }),
  );

  app.get("/v1/models", () => {
    const data = gw.router.listModels().map((id) => ({ id, object: "model", created: 0, owned_by: "aether" }));
    return jsonResponse({ object: "list", data });
  });

  // `?since=<epoch ms>` scopes the DB-backed aggregates to a time window, so a
  // load test or eval run can read its own numbers without resetting the gateway.
  app.get("/metrics", (c) =>
    jsonResponse({
      ...gw.keys.summary(Number(c.req.query("since")) || 0),
      cache: gw.cache.stats(),
      circuits: gw.router.health(),
      models: gw.router.listModels(),
      recent: gw.keys.recent(40),
    }),
  );

  // ── Chat completions ──────────────────────────────────────────────────────
  app.post("/v1/chat/completions", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return errorResponse(400, "Invalid JSON body", "invalid_request_error");
    }
    const parsed = ChatBodySchema.safeParse(raw);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      return errorResponse(400, msg, "invalid_request_error");
    }
    const body = parsed.data;
    const req: ChatCompletionRequest = {
      ...body,
      messages: body.messages.map((m) => ({ ...m, content: m.content ?? null })) as ChatMessage[],
    };

    const prep = gw.prepare(req, bearerFrom(c.req.header("authorization")));
    if (!prep.ok) return errorResponse(prep.status, prep.message);
    const p = prep.prepared;
    const signal = c.req.raw.signal;
    const guarded = guardHeaders(p.guard);
    if (p.guard.injection.detected) {
      log.warn("guardrail: prompt injection flagged", {
        model: req.model,
        score: p.guard.injection.score,
        patterns: p.guard.injection.patterns,
      });
    }

    if (body.stream !== true) {
      try {
        const { response, cache, similarity } = await gw.complete(p, signal);
        const headers: Record<string, string> = { "x-cache": cache, ...guarded };
        if (p.ctx.servedBy) headers["x-served-by"] = p.ctx.servedBy;
        if (p.ctx.servedModel) headers["x-served-model"] = p.ctx.servedModel;
        if (similarity != null) headers["x-cache-similarity"] = similarity.toFixed(4);
        return jsonResponse(response, 200, headers);
      } catch (e) {
        return providerErrorResponse(e);
      }
    }

    // Look the cache up BEFORE opening the stream so x-cache can ride on the headers.
    const hit = await gw.cache.lookup(p.req, p.ctx.aether);
    c.header("x-cache", hit ? "HIT" : "MISS");
    if (hit) c.header("x-cache-similarity", hit.similarity.toFixed(4));
    for (const [k, v] of Object.entries(guarded)) c.header(k, v);
    return streamSSE(c, async (s) => {
      if (hit) {
        gw.recordCachedStream(p, hit.response, Date.now() - p.ctx.startedAt);
        const id = genId("chatcmpl");
        const text = hit.response.choices[0]?.message.content ?? "";
        for (const tok of text.split(/(\s+)/)) {
          if (tok) await s.writeSSE({ data: JSON.stringify(makeChunk(id, req.model, tok, null)) });
        }
        await s.writeSSE({ data: JSON.stringify(makeChunk(id, req.model, "", "stop")) });
        await s.writeSSE({ data: "[DONE]" });
        return;
      }
      let full = "";
      let usage: ChatCompletionChunk["usage"];
      let ttft: number | undefined;
      try {
        for await (const chunk of gw.router.stream(p.req, p.ctx, signal)) {
          const delta = chunk.choices[0]?.delta?.content ?? "";
          if (delta && ttft === undefined) ttft = Date.now() - p.ctx.startedAt;
          full += delta;
          if (chunk.usage) usage = chunk.usage;
          await s.writeSSE({ data: JSON.stringify(chunk) });
        }
        await s.writeSSE({ data: "[DONE]" });
        await gw.finishStream(p, full, usage, ttft);
      } catch (e) {
        const message = e instanceof Error ? e.message : "stream error";
        await s.writeSSE({ event: "error", data: JSON.stringify({ error: { message, type: "upstream_error" } }) });
      }
    });
  });

  // ── Admin: virtual key management ─────────────────────────────────────────
  function requireAdmin(adminHeader: string | undefined, authHeader: string | undefined): Response | null {
    if (!gw.config.adminKey) return errorResponse(503, "Admin API disabled: set GATEWAY_ADMIN_KEY", "admin_disabled");
    const provided = adminHeader ?? bearerFrom(authHeader);
    if (provided !== gw.config.adminKey) return errorResponse(401, "Invalid admin key", "unauthorized");
    return null;
  }

  app.post("/admin/keys", async (c) => {
    const guard = requireAdmin(c.req.header("x-admin-key"), c.req.header("authorization"));
    if (guard) return guard;
    const parsed = CreateKeySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return errorResponse(400, "Invalid key spec", "invalid_request_error");
    const { key, row } = gw.keys.createKey(parsed.data);
    return jsonResponse(
      {
        id: row.id,
        name: row.name,
        key,
        prefix: row.prefix,
        budget_usd: row.budget_usd,
        rpm_limit: row.rpm_limit,
        models: row.models ? JSON.parse(row.models) : null,
        note: "Store this key now — it will not be shown again.",
      },
      201,
    );
  });

  app.get("/admin/keys", (c) => {
    const guard = requireAdmin(c.req.header("x-admin-key"), c.req.header("authorization"));
    if (guard) return guard;
    const keys = gw.keys.listKeys().map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      budget_usd: k.budget_usd,
      spent_usd: Math.round(k.spent_usd * 1e6) / 1e6,
      rpm_limit: k.rpm_limit,
      models: k.models ? JSON.parse(k.models) : null,
      disabled: !!k.disabled,
      created_at: k.created_at,
    }));
    return jsonResponse({ object: "list", data: keys });
  });

  app.post("/admin/keys/:id/:action{(enable|disable)}", (c) => {
    const guard = requireAdmin(c.req.header("x-admin-key"), c.req.header("authorization"));
    if (guard) return guard;
    const disabled = c.req.param("action") === "disable";
    const ok = gw.keys.setDisabled(c.req.param("id"), disabled);
    return ok ? jsonResponse({ ok: true, disabled }) : errorResponse(404, "Key not found", "not_found");
  });

  app.delete("/admin/keys/:id", (c) => {
    const guard = requireAdmin(c.req.header("x-admin-key"), c.req.header("authorization"));
    if (guard) return guard;
    const ok = gw.keys.deleteKey(c.req.param("id"));
    return ok ? jsonResponse({ ok: true }) : errorResponse(404, "Key not found", "not_found");
  });

  // Clear the semantic cache (e.g. before a benchmark so the first pass is cold).
  app.post("/admin/cache/clear", (c) => {
    const guard = requireAdmin(c.req.header("x-admin-key"), c.req.header("authorization"));
    if (guard) return guard;
    return jsonResponse({ ok: true, removed: gw.cache.clear() });
  });

  app.onError((err) => providerErrorResponse(err));
  app.notFound(() => errorResponse(404, "Not found", "not_found"));

  return app;
}
