import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

// node:sqlite is a newer built-in that Vite's static import analysis can't
// resolve (it strips the `node:` prefix). Load it at runtime via require so the
// import survives bundling under vitest while still working natively under tsx.
const { DatabaseSync: DatabaseSyncCtor } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

export interface VirtualKeyRow {
  id: string;
  name: string;
  prefix: string;
  budget_usd: number | null;
  spent_usd: number;
  rpm_limit: number | null;
  models: string | null;
  disabled: number;
  created_at: number;
}

export interface CreateKeyInput {
  name: string;
  budgetUsd?: number | null;
  rpmLimit?: number | null;
  models?: string[] | null;
}

export interface UsageEvent {
  keyId: string | null;
  requestedModel: string;
  provider: string | null;
  upstreamModel: string | null;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  cached: boolean;
  latencyMs: number;
  status: number;
}

export interface MetricsSummary {
  totals: {
    requests: number;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
    cacheHits: number;
    cacheHitRate: number;
    avgLatencyMs: number;
  };
  byModel: { model: string; requests: number; costUsd: number; tokens: number }[];
  byProvider: { provider: string; requests: number; costUsd: number }[];
}

export function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function generateKeyValue(): string {
  return `sk-aether-${randomBytes(24).toString("hex")}`;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSyncCtor(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS virtual_keys (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        key_hash    TEXT NOT NULL UNIQUE,
        prefix      TEXT NOT NULL,
        budget_usd  REAL,
        spent_usd   REAL NOT NULL DEFAULT 0,
        rpm_limit   INTEGER,
        models      TEXT,
        disabled    INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_events (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        ts               INTEGER NOT NULL,
        key_id           TEXT,
        requested_model  TEXT NOT NULL,
        provider         TEXT,
        upstream_model   TEXT,
        prompt_tokens    INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        cost_usd         REAL NOT NULL,
        cached           INTEGER NOT NULL,
        latency_ms       INTEGER NOT NULL,
        status           INTEGER NOT NULL
      );
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events(ts);");
  }

  createKey(input: CreateKeyInput): { key: string; row: VirtualKeyRow } {
    const value = generateKeyValue();
    const id = `vk_${randomBytes(8).toString("hex")}`;
    const prefix = value.slice(0, 16);
    const createdAt = Date.now();
    const models = input.models && input.models.length ? JSON.stringify(input.models) : null;
    this.db
      .prepare(
        `INSERT INTO virtual_keys (id, name, key_hash, prefix, budget_usd, spent_usd, rpm_limit, models, disabled, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, 0, ?)`,
      )
      .run(id, input.name, hashKey(value), prefix, input.budgetUsd ?? null, input.rpmLimit ?? null, models, createdAt);
    return { key: value, row: this.getById(id)! };
  }

  getByValue(value: string): VirtualKeyRow | null {
    const row = this.db.prepare("SELECT * FROM virtual_keys WHERE key_hash = ?").get(hashKey(value));
    return (row as VirtualKeyRow | undefined) ?? null;
  }

  getById(id: string): VirtualKeyRow | null {
    const row = this.db.prepare("SELECT * FROM virtual_keys WHERE id = ?").get(id);
    return (row as VirtualKeyRow | undefined) ?? null;
  }

  list(): VirtualKeyRow[] {
    return this.db.prepare("SELECT * FROM virtual_keys ORDER BY created_at DESC").all() as unknown as VirtualKeyRow[];
  }

  setDisabled(id: string, disabled: boolean): boolean {
    const res = this.db.prepare("UPDATE virtual_keys SET disabled = ? WHERE id = ?").run(disabled ? 1 : 0, id);
    return res.changes > 0;
  }

  deleteKey(id: string): boolean {
    const res = this.db.prepare("DELETE FROM virtual_keys WHERE id = ?").run(id);
    return res.changes > 0;
  }

  recordUsage(e: UsageEvent): void {
    this.db
      .prepare(
        `INSERT INTO usage_events
          (ts, key_id, requested_model, provider, upstream_model, prompt_tokens, completion_tokens, cost_usd, cached, latency_ms, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        e.keyId,
        e.requestedModel,
        e.provider,
        e.upstreamModel,
        e.promptTokens,
        e.completionTokens,
        e.costUsd,
        e.cached ? 1 : 0,
        e.latencyMs,
        e.status,
      );
    if (e.keyId && e.costUsd > 0) {
      this.db.prepare("UPDATE virtual_keys SET spent_usd = spent_usd + ? WHERE id = ?").run(e.costUsd, e.keyId);
    }
  }

  summary(): MetricsSummary {
    const t = this.db
      .prepare(
        `SELECT
           COUNT(*)                AS requests,
           COALESCE(SUM(prompt_tokens),0)     AS promptTokens,
           COALESCE(SUM(completion_tokens),0) AS completionTokens,
           COALESCE(SUM(cost_usd),0)          AS costUsd,
           COALESCE(SUM(cached),0)            AS cacheHits,
           COALESCE(AVG(latency_ms),0)        AS avgLatencyMs
         FROM usage_events`,
      )
      .get() as {
      requests: number;
      promptTokens: number;
      completionTokens: number;
      costUsd: number;
      cacheHits: number;
      avgLatencyMs: number;
    };

    const byModel = this.db
      .prepare(
        `SELECT requested_model AS model, COUNT(*) AS requests, COALESCE(SUM(cost_usd),0) AS costUsd,
                COALESCE(SUM(prompt_tokens + completion_tokens),0) AS tokens
         FROM usage_events GROUP BY requested_model ORDER BY requests DESC`,
      )
      .all() as unknown as { model: string; requests: number; costUsd: number; tokens: number }[];

    const byProvider = this.db
      .prepare(
        `SELECT COALESCE(provider,'(none)') AS provider, COUNT(*) AS requests, COALESCE(SUM(cost_usd),0) AS costUsd
         FROM usage_events GROUP BY provider ORDER BY requests DESC`,
      )
      .all() as unknown as { provider: string; requests: number; costUsd: number }[];

    return {
      totals: {
        requests: t.requests,
        promptTokens: t.promptTokens,
        completionTokens: t.completionTokens,
        costUsd: Math.round(t.costUsd * 1e6) / 1e6,
        cacheHits: t.cacheHits,
        cacheHitRate: t.requests ? t.cacheHits / t.requests : 0,
        avgLatencyMs: Math.round(t.avgLatencyMs),
      },
      byModel,
      byProvider,
    };
  }

  recentEvents(limit = 50): Record<string, unknown>[] {
    return this.db
      .prepare("SELECT ts, key_id, requested_model, provider, upstream_model, cost_usd, cached, latency_ms, status FROM usage_events ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as Record<string, unknown>[];
  }

  close(): void {
    this.db.close();
  }
}
