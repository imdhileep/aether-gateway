import { loadConfig, type ResolvedConfig } from "../src/config.js";
import { buildGateway, type Gateway } from "../src/gateway.js";

/** A config pinned for offline, deterministic tests (in-memory DB, local embeddings). */
export function testConfig(): ResolvedConfig {
  const c = loadConfig();
  c.keys.db_path = ":memory:";
  c.cache.embeddings.provider = "local";
  c.adminKey = "test-admin";
  return c;
}

export function testGateway(mutate?: (c: ResolvedConfig) => void): { gw: Gateway; config: ResolvedConfig } {
  const config = testConfig();
  mutate?.(config);
  return { gw: buildGateway(config), config };
}
