import type { ResolvedConfig } from "../config.js";
import { Store, type CreateKeyInput, type UsageEvent, type VirtualKeyRow } from "./store.js";

export type AuthResult =
  | { ok: true; key: VirtualKeyRow | null }
  | { ok: false; status: number; message: string };

export class KeyService {
  private rate = new Map<string, number[]>();

  constructor(
    private store: Store,
    private config: ResolvedConfig,
  ) {}

  /** Validate the bearer token against the auth.required policy. */
  authenticate(bearer: string | null): AuthResult {
    if (!bearer) {
      if (this.config.auth.required) return { ok: false, status: 401, message: "Missing API key" };
      return { ok: true, key: null };
    }
    const row = this.store.getByValue(bearer);
    if (!row) return { ok: false, status: 401, message: "Invalid API key" };
    if (row.disabled) return { ok: false, status: 403, message: "API key disabled" };
    return { ok: true, key: row };
  }

  /** Enforce budget, model allowlist and rate limits for a resolved key. */
  authorize(key: VirtualKeyRow | null, model: string): AuthResult {
    if (!key) return { ok: true, key: null };

    if (key.budget_usd != null && key.spent_usd >= key.budget_usd) {
      return {
        ok: false,
        status: 402,
        message: `Budget exceeded ($${key.spent_usd.toFixed(4)} of $${key.budget_usd.toFixed(2)})`,
      };
    }

    if (key.models) {
      const allowed = JSON.parse(key.models) as string[];
      if (allowed.length > 0 && !allowed.includes(model)) {
        return { ok: false, status: 403, message: `Key not permitted to use model "${model}"` };
      }
    }

    if (key.rpm_limit != null) {
      const now = Date.now();
      const win = (this.rate.get(key.id) ?? []).filter((t) => now - t < 60_000);
      if (win.length >= key.rpm_limit) {
        return { ok: false, status: 429, message: `Rate limit exceeded (${key.rpm_limit} requests/min)` };
      }
      win.push(now);
      this.rate.set(key.id, win);
    }

    return { ok: true, key };
  }

  record(event: UsageEvent): void {
    this.store.recordUsage(event);
  }

  summary(sinceMs?: number) {
    return this.store.summary(sinceMs);
  }

  recent(limit?: number) {
    return this.store.recentEvents(limit);
  }

  createKey(input: CreateKeyInput) {
    return this.store.createKey(input);
  }

  listKeys(): VirtualKeyRow[] {
    return this.store.list();
  }

  setDisabled(id: string, disabled: boolean): boolean {
    return this.store.setDisabled(id, disabled);
  }

  deleteKey(id: string): boolean {
    return this.store.deleteKey(id);
  }
}
