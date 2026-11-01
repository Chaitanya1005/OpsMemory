/**
 * Clears the local demo dashboard: investigation history (including ON/OFF
 * comparison runs and approval decisions) and the recorded Meko activity log.
 *
 *   npm run demo:reset                 # dry run: shows what would be cleared
 *   npm run demo:reset -- --confirm    # clears it
 *
 * Local only. It never connects to Meko, so datapacks and promoted memories
 * are untouched. It refuses to run unless the configuration is the demo one
 * (prefix `opsmemory`, database `data/opsmemory.db`), so the e2e and rehearsal
 * databases cannot be cleared by mistake. Rows are deleted; the file and schema
 * stay, so a running server keeps working and shows the blank dashboard on reload.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../lib/config";

const DEMO_PREFIX = "opsmemory";
const DEMO_DB = resolve(import.meta.dirname, "../data/opsmemory.db");
const TABLES = ["investigations", "meko_events"] as const;

const confirm = process.argv.includes("--confirm");
const config = loadConfig();
const dbPath = resolve(config.dbPath);

const refuse = (why: string): never => {
  console.error(`REFUSED: ${why}\nNothing was changed.`);
  process.exit(1);
};

if (config.datapackPrefix !== DEMO_PREFIX) refuse(`MEKO_DATAPACK_PREFIX is "${config.datapackPrefix}", not the demo prefix "${DEMO_PREFIX}".`);
if (dbPath !== DEMO_DB) refuse(`OPSMEMORY_DB resolves to ${dbPath}; only the demo database ${DEMO_DB} may be reset.`);

console.log(`Demo database: ${dbPath}`);
if (!existsSync(dbPath)) {
  console.log("It does not exist yet, so the dashboard is already blank. Nothing to clear.");
  process.exit(0);
}

const db = new DatabaseSync(dbPath);
const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map((t) => t.name);
const unexpected = tables.filter((t) => !(TABLES as readonly string[]).includes(t));
if (!TABLES.every((t) => tables.includes(t)) || unexpected.length) {
  db.close();
  refuse(`${dbPath} does not look like an OpsMemory database (tables: ${tables.join(", ") || "none"}).`);
}

const counts = Object.fromEntries(TABLES.map((t) => [t, Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n)]));
const byStatus = db.prepare(`SELECT status, mode, COUNT(*) AS n FROM investigations GROUP BY status, mode ORDER BY status, mode`).all() as Array<{ status: string; mode: string; n: number }>;
console.log(`  investigations: ${counts.investigations}${byStatus.length ? ` (${byStatus.map((r) => `${r.n} ${r.status}/${r.mode}`).join(", ")})` : ""}`);
console.log(`  meko_events:    ${counts.meko_events}`);

if (!confirm) {
  console.log("\nDry run. Re-run with --confirm to delete these rows. Meko is not contacted either way.");
  db.close();
  process.exit(0);
}

db.exec("BEGIN");
try {
  for (const t of TABLES) db.exec(`DELETE FROM ${t}`);
  db.exec("COMMIT");
} catch (err) {
  db.exec("ROLLBACK");
  throw err;
}
db.exec("VACUUM");
db.close();
console.log("\nCleared. Meko datapacks and promoted memories were not touched. Reload the dashboard (or restart the server) to see the blank state.");
