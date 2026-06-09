import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { buildGateway } from "./gateway.js";
import { log } from "./logger.js";
import { buildServer } from "./server.js";

// Load .env if present (Node ≥20.6 built-in; ignore if missing).
const loadEnvFile = (process as { loadEnvFile?: (p?: string) => void }).loadEnvFile;
try {
  loadEnvFile?.(".env");
} catch {
  /* no .env file — that's fine */
}

const config = loadConfig();
const gateway = buildGateway(config);
const app = buildServer(gateway);

serve({ fetch: app.fetch, port: config.server.port, hostname: config.server.host }, (info) => {
  const base = `http://localhost:${info.port}`;
  log.info("Aether Gateway listening", { api: `${base}/v1/chat/completions`, dashboard: `${base}/dashboard` });
  const withKeys = Object.values(config.providers)
    .filter((p) => p.name !== "mock" && p.apiKeys.length > 0)
    .map((p) => `${p.name}(${p.apiKeys.length})`);
  log.info("provider credentials", {
    configured: withKeys.length ? withKeys : ['none — call model "mock" to try the gateway offline'],
  });
  if (config.auth.required && !config.adminKey) {
    log.warn("auth.required is true but GATEWAY_ADMIN_KEY is unset — you cannot mint keys via the admin API");
  }
});
