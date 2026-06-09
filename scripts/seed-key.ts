// Mint a virtual key directly against the DB (bypasses the admin API).
// Usage: npm run seed-key -- "key name" [budgetUsd] [rpmLimit]
import { loadConfig } from "../src/config.js";
import { Store } from "../src/keys/store.js";

const name = process.argv[2] ?? "default";
const budgetUsd = process.argv[3] ? Number(process.argv[3]) : null;
const rpmLimit = process.argv[4] ? Number(process.argv[4]) : null;

const config = loadConfig();
const store = new Store(config.keys.db_path);
const { key, row } = store.createKey({ name, budgetUsd, rpmLimit });

process.stdout.write(
  JSON.stringify({ id: row.id, name: row.name, key, budget_usd: row.budget_usd, rpm_limit: row.rpm_limit }, null, 2) + "\n",
);
store.close();
