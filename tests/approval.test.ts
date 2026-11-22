/**
 * The approval state machine (lib/approval.ts) against an in-memory Meko fake.
 *
 * TEST-ONLY: the fake injects failures (uncertain writes, failed read-back,
 * not-found promotion). Nothing here contacts Meko or Gemini, and each test uses
 * a throwaway SQLite file. It checks that `approved` is only stored after a
 * confirmed promotion and read-back, and that retries never duplicate writes.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import type { z } from "zod";
import type { LlmProvider } from "../lib/llm/types";
import { type MekoClient, MekoError } from "../lib/meko/client";
import type { Datapacks } from "../lib/meko/scopes";
import { Store } from "../lib/store";
import { ApprovalFailure, OpsMemory } from "../lib/workflow";

type Fault = { op: string; kind: "uncertain_applied" | "uncertain_lost" | "readback_miss" | "promote_not_found" };

/** In-memory stand-in for the handful of Meko tools approve() uses. */
class FakeMeko {
  calls: string[] = [];
  faults: Fault[] = [];
  personal: Array<{ id: string; conversation_id: string }> = [];
  promoted: Array<{ id: string; conversation_id: string }> = [];
  private n = 0;

  async call<T>(_actor: string, op: string, args: Record<string, unknown>, schema?: z.ZodType<T>): Promise<T> {
    this.calls.push(op);
    const fault = this.faults.find((f) => f.op === op);
    if (fault) this.faults.splice(this.faults.indexOf(fault), 1);
    const out = (v: unknown) => (schema ? schema.parse(v) : v) as T;
    const uncertain = () => new MekoError("uncertain_outcome", `injected: ${op} may or may not have been applied`, op);

    switch (op) {
      case "conversation_create":
        return out({ id: `conv-${++this.n}` });
      case "memory_add": {
        const row = { id: `mem-${++this.n}`, conversation_id: String(args.conversation_id) };
        if (fault?.kind === "uncertain_lost") throw uncertain();
        this.personal.push(row);
        if (fault?.kind === "uncertain_applied") throw uncertain();
        return out({ results: [{ id: row.id, memory: String(args.text) }] });
      }
      case "memory_promote": {
        const ids = args.memory_ids as string[];
        if (fault?.kind === "promote_not_found") return out({ inserted_ids: [], updated_ids: [], not_found_ids: ids });
        const moving = this.personal.filter((r) => ids.includes(r.id));
        this.personal = this.personal.filter((r) => !ids.includes(r.id));
        this.promoted.push(...moving);
        if (fault?.kind === "uncertain_applied") throw uncertain();
        return out({ inserted_ids: moving.map((r) => r.id), updated_ids: [], not_found_ids: ids.filter((i) => !moving.some((r) => r.id === i)) });
      }
      case "memory_get_all":
        return args.promoted
          ? out({ promoted_memories: this.promoted, total: this.promoted.length })
          : out({ memories: this.personal, total: this.personal.length });
      case "knowledgebase_search":
        if (fault?.kind === "readback_miss") return out({ results: [] });
        return out({ results: this.promoted.map((r) => ({ metadata_filters: { source: "memory", memory_id: r.id } })) });
      default:
        throw new Error(`fake Meko does not implement ${op}`);
    }
  }
  count(op: string) {
    return this.calls.filter((c) => c === op).length;
  }
}

class TestOpsMemory extends OpsMemory {
  constructor(dbPath: string, readonly fake: FakeMeko) {
    super({ mekoApiKey: "unused", datapackPrefix: "unused", dbPath, createDatapacks: false } as never, {} as LlmProvider);
  }
  override async meko(): Promise<{ meko: MekoClient; datapacks: Datapacks }> {
    return { meko: this.fake as unknown as MekoClient, datapacks: { knowledge: "dp-knowledge", investigator: "dp-investigator" } };
  }
}

const dir = mkdtempSync(join(tmpdir(), "opsmemory-approval-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function setup(name: string) {
  const fake = new FakeMeko();
  const app = new TestOpsMemory(join(dir, `${name}.db`), fake);
  app.store.insertInvestigation({
    id: "inv_test", incidentRef: "INC-TEST", mode: "on", status: "proposed",
    incident: { title: "Pool exhausted", service: "checkout-api", severity: "SEV2", description: "test", logs: "" },
    knowledge: null,
    result: { outcome: { investigation: { rootCause: { statement: "pool too large" }, recommendedFix: { immediate: ["shrink pool"] }, appliesWhen: "always" } } },
    decision: null, createdAt: new Date().toISOString(), decidedAt: null,
  });
  return { app, fake, status: () => app.store.getInvestigation("inv_test")!.status };
}

async function expectFailure(p: Promise<unknown>): Promise<ApprovalFailure> {
  const err = await p.then(() => null, (e: unknown) => e);
  assert.ok(err instanceof ApprovalFailure, `expected ApprovalFailure, got ${String(err)}`);
  return err;
}

test("happy path ends approved and verified; repeating it writes nothing", async () => {
  const { app, fake, status } = setup("happy");
  const d = await app.approve("inv_test");
  assert.equal(status(), "approved");
  assert.ok(d.retrievableAfterPromotion && d.promotionConfirmed);
  const again = await app.approve("inv_test");
  assert.equal(fake.count("memory_add"), 1);
  assert.equal(fake.count("memory_promote"), 1);
  assert.equal(again.memoryIds[0], d.memoryIds[0]);
});

test("failed read-back is not stored as approved; retry only re-reads", async () => {
  const { app, fake, status } = setup("readback");
  fake.faults.push({ op: "knowledgebase_search", kind: "readback_miss" });
  const f = await expectFailure(app.approve("inv_test"));
  assert.equal(status(), "promotion_unverified");
  assert.equal(f.decision.failure?.stage, "read_back");
  await app.approve("inv_test");
  assert.equal(status(), "approved");
  assert.equal(fake.count("memory_add"), 1);
  assert.equal(fake.count("memory_promote"), 1);
});

test("uncertain promote needs reconciliation; retry does not promote again", async () => {
  const { app, fake, status } = setup("promote-uncertain");
  fake.faults.push({ op: "memory_promote", kind: "uncertain_applied" });
  await expectFailure(app.approve("inv_test"));
  assert.equal(status(), "needs_reconciliation");
  await app.approve("inv_test");
  assert.equal(status(), "approved");
  assert.equal(fake.count("memory_promote"), 1, fake.calls.join(","));
  assert.equal(fake.count("memory_add"), 1);
});

test("uncertain memory_add that landed: retry adopts it instead of writing a duplicate", async () => {
  const { app, fake, status } = setup("add-uncertain-applied");
  fake.faults.push({ op: "memory_add", kind: "uncertain_applied" });
  await expectFailure(app.approve("inv_test"));
  assert.equal(status(), "needs_reconciliation");
  await app.approve("inv_test");
  assert.equal(status(), "approved");
  assert.equal(fake.count("memory_add"), 1);
  assert.equal(fake.promoted.length, 1);
});

test("uncertain memory_add that was lost: retry writes exactly once more", async () => {
  const { app, fake, status } = setup("add-uncertain-lost");
  fake.faults.push({ op: "memory_add", kind: "uncertain_lost" });
  await expectFailure(app.approve("inv_test"));
  await app.approve("inv_test");
  assert.equal(status(), "approved");
  assert.equal(fake.count("memory_add"), 2);
  assert.equal(fake.promoted.length, 1);
});

test("promotion reported not_found is a definite approval_failed", async () => {
  const { app, fake, status } = setup("not-found");
  fake.faults.push({ op: "memory_promote", kind: "promote_not_found" });
  const f = await expectFailure(app.approve("inv_test"));
  assert.equal(status(), "approval_failed");
  assert.equal(f.decision.failure?.code, "not_found");
  assert.equal(f.decision.failure?.uncertain, false);
});

test("concurrent double-click: one approval runs, the other is refused", async () => {
  const { app, fake } = setup("concurrent");
  const results = await Promise.allSettled([app.approve("inv_test"), app.approve("inv_test")]);
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  assert.equal(rejected.length, 1);
  assert.match(String(rejected[0]?.reason), /already being approved/);
  assert.equal(fake.count("memory_add"), 1);
});

test("databases from before the approval states migrate and keep their rows", () => {
  const path = join(dir, "legacy.db");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE investigations (id TEXT PRIMARY KEY, incident_ref TEXT NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('on','off')),
    status TEXT NOT NULL CHECK (status IN ('proposed','approved','rejected','failed')), incident_json TEXT NOT NULL, knowledge_json TEXT,
    result_json TEXT, decision_json TEXT, created_at TEXT NOT NULL, decided_at TEXT);
    INSERT INTO investigations VALUES ('inv_old','INC-OLD','on','approved','{}',NULL,NULL,NULL,'2026-10-31T00:00:00Z',NULL);`);
  db.close();
  const store = new Store(path);
  store.updateDecision("inv_old", "needs_reconciliation", {}, null);
  assert.equal(store.getInvestigation("inv_old")?.status, "needs_reconciliation");
  store.close();
});
