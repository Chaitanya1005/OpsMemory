import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import type { MekoEvent } from "../lib/meko/events";
import { Store } from "../lib/store";

const dir = mkdtempSync(join(tmpdir(), "opsmemory-store-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const event = (id: string, ts: string, op = "memory_search"): MekoEvent => ({
  id, ts, actor: "knowledge-agent", transport: "mcp", op, datapackId: "dp", ok: true, latencyMs: 1, attempts: 1, request: {}, response: null, error: null,
});

test("the activity feed includes events that share the `since` millisecond", () => {
  const store = new Store(join(dir, "feed.db"));
  store.insertEvent(event("a", "2026-11-01T00:00:00.000Z"), null);
  store.insertEvent(event("b", "2026-11-01T00:00:01.000Z"), null);
  store.insertEvent(event("c", "2026-11-01T00:00:01.000Z"), null);
  assert.deepEqual(store.eventFeed({ since: "2026-11-01T00:00:01.000Z", limit: 10 }).map((e) => e.id).sort(), ["b", "c"]);
  store.close();
});

test("without `since` the feed returns the newest events, oldest first", () => {
  const store = new Store(join(dir, "recent.db"));
  for (let i = 0; i < 5; i++) store.insertEvent(event(`e${i}`, `2026-11-01T00:00:0${i}.000Z`), null);
  assert.deepEqual(store.eventFeed({ limit: 2 }).map((e) => e.id), ["e3", "e4"]);
  store.close();
});

test("a database from before samples were tracked gains sample_id and keeps its rows", () => {
  const path = join(dir, "pre-sample.db");
  const store = new Store(path);
  store.insertInvestigation({ id: "inv_a", incidentRef: "INC-A", mode: "off", status: "proposed", incident: {}, knowledge: null, result: null, decision: null, createdAt: "2026-11-01T00:00:00Z", decidedAt: null });
  store.close();
  // Recreate the previous schema (approval statuses, no sample_id), then reopen.
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE old AS SELECT id, incident_ref, mode, status, incident_json, knowledge_json, result_json, decision_json, created_at, decided_at FROM investigations;
    DROP TABLE investigations;
    CREATE TABLE investigations (id TEXT PRIMARY KEY, incident_ref TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('proposed','approving','approved','approval_failed','promotion_unverified','needs_reconciliation','rejected','failed')),
      incident_json TEXT NOT NULL, knowledge_json TEXT, result_json TEXT, decision_json TEXT, created_at TEXT NOT NULL, decided_at TEXT);
    INSERT INTO investigations SELECT * FROM old; DROP TABLE old;`);
  db.close();
  const reopened = new Store(path);
  assert.equal(reopened.getInvestigation("inv_a")?.sampleId, null);
  reopened.insertInvestigation({ id: "inv_b", incidentRef: "INC-B", mode: "on", status: "proposed", incident: {}, knowledge: null, result: null, decision: null, createdAt: "2026-11-02T00:00:00Z", decidedAt: null, sampleId: "db-pool-1" });
  assert.equal(reopened.getInvestigation("inv_b")?.sampleId, "db-pool-1");
  reopened.close();
});

test("eventsForOps returns only the requested operations", () => {
  const store = new Store(join(dir, "ops.db"));
  store.insertEvent(event("x", "2026-11-01T00:00:00.000Z", "memory_delete_by_id"), null);
  store.insertEvent(event("y", "2026-11-01T00:00:01.000Z", "memory_search"), null);
  assert.deepEqual(store.eventsForOps(["memory_delete_by_id", "memory_get_by_id"]).map((e) => e.id), ["x"]);
  store.close();
});
