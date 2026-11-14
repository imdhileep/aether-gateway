import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// ── Schema ──────────────────────────────────────────────────────────────────

const ProviderSchema = z.object({
  base_url: z.string(),
  api_key_env: z.string().optional(),
  anthropic_version: z.string().optional(),
});

const TargetSchema = z.object({
  provider: z.string(),
  model: z.string(),
});

const ModelSchema = z.object({
  description: z.string().optional(),
  targets: z.array(TargetSchema).min(1),
});

const ConfigSchema = z.object({
  server: z
    .object({ port: z.number().default(8787), host: z.string().default("0.0.0.0") })
    .default({ port: 8787, host: "0.0.0.0" }),
  auth: z
    .object({ required: z.boolean().default(false), admin_key_env: z.string().default("GATEWAY_ADMIN_KEY") })
    .default({ required: false, admin_key_env: "GATEWAY_ADMIN_KEY" }),
  providers: z.record(z.string(), ProviderSchema),
  models: z.record(z.string(), ModelSchema),
  cache: z
    .object({
      enabled: z.boolean().default(true),
      similarity_threshold: z.number().min(0).max(1).default(0.93),
      ttl_seconds: z.number().default(3600),
      max_entries: z.number().default(2000),
      max_temperature: z.number().default(0.4),
      embeddings: z
        .object({
          provider: z.enum(["auto", "openai", "local"]).default("auto"),
          model: z.string().default("text-embedding-3-small"),
        })
        .default({ provider: "auto", model: "text-embedding-3-small" }),
    })
    .default({
      enabled: true,
      similarity_threshold: 0.93,
      ttl_seconds: 3600,
      max_entries: 2000,
      max_temperature: 0.4,
      embeddings: { provider: "auto", model: "text-embedding-3-small" },
    }),
  guardrails: z
    .object({
      pii: z
        .object({
          mode: z.enum(["off", "flag", "redact", "block"]).default("redact"),
          scan_output: z.boolean().default(true),
        })
        .default({ mode: "redact", scan_output: true }),
      injection: z
        .object({ mode: z.enum(["off", "flag", "block"]).default("flag") })
        .default({ mode: "flag" }),
    })
    .default({ pii: { mode: "redact", scan_output: true }, injection: { mode: "flag" } }),
  keys: z.object({ db_path: z.string().default("./data/gateway.db") }).default({ db_path: "./data/gateway.db" }),
  retry: z
    .object({
      max_attempts_per_target: z.number().default(2),
      circuit_failure_threshold: z.number().default(4),
      circuit_cooldown_ms: z.number().default(15000),
    })
    .default({ max_attempts_per_target: 2, circuit_failure_threshold: 4, circuit_cooldown_ms: 15000 }),
});

export type RawConfig = z.infer<typeof ConfigSchema>;

// ── Resolved config (env vars expanded) ──────────────────────────────────────

export interface ResolvedProvider {
  name: string;
  baseUrl: string;
  /** All keys parsed from the comma-separated env var (may be empty). */
  apiKeys: string[];
  anthropicVersion?: string;
}

export interface ResolvedConfig extends Omit<RawConfig, "providers"> {
  providers: Record<string, ResolvedProvider>;
  adminKey: string | null;
}

function readKeys(envName?: string): string[] {
  if (!envName) return [];
  const raw = process.env[envName];
  if (!raw) return [];
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

export function loadConfig(path?: string): ResolvedConfig {
  const configPath = resolve(path ?? process.env.GATEWAY_CONFIG ?? "./gateway.config.yaml");
  const parsed = ConfigSchema.parse(parseYaml(readFileSync(configPath, "utf8")));

  const providers: Record<string, ResolvedProvider> = {};
  for (const [name, p] of Object.entries(parsed.providers)) {
    providers[name] = {
      name,
      baseUrl: p.base_url,
      apiKeys: readKeys(p.api_key_env),
      anthropicVersion: p.anthropic_version,
    };
  }

  if (process.env.PORT) parsed.server.port = Number(process.env.PORT);
  // Deploy-time override so a public instance can require virtual keys
  // without editing the shared config file.
  const authEnv = process.env.GATEWAY_AUTH_REQUIRED?.toLowerCase();
  if (authEnv === "true" || authEnv === "1") parsed.auth.required = true;
  if (authEnv === "false" || authEnv === "0") parsed.auth.required = false;

  return {
    ...parsed,
    providers,
    adminKey: process.env[parsed.auth.admin_key_env] ?? null,
  };
}
