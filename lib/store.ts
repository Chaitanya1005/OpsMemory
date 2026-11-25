import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MekoEvent } from "./meko/events";

/**
 * Local application state: incidents, investigations, decisions and the Meko
 * event log. It is never used for recall — historical knowledge comes only from Meko.
 */
export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // Databases created before the approval states existed have a narrower CHECK; rebuild the table once.
    const ddl = (this.db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'investigations'`).get() as { sql: string } | undefined)?.sql;
    if (ddl && !ddl.includes("needs_reconciliation")) {
      const cols = "id, incident_ref, mode, status, incident_json, knowledge_json, result_json, decision_json, created_at, decided_at";
      this.db.exec(`ALTER TABLE investigations RENAME TO investigations_v1; ${INVESTIGATIONS_DDL}; INSERT INTO investigations (${cols}) SELECT ${cols} FROM investigations_v1; DROP TABLE investigations_v1;`);
    }
    // Added with user-submitted incidents: which built-in sample (if any) an investigation ran.
    if (ddl && !(this.db.prepare(`PRAGMA table_info(investigations)`).all() as Array<{ name: string }>).some((c) => c.name === "sample_id")) {
      this.db.exec(`ALTER TABLE investigations ADD COLUMN sample_id TEXT`);
    }
    this.db.exec(`
      ${INVESTIGATIONS_DDL};
      CREATE TABLE IF NOT EXISTS meko_events (
        id TEXT PRIMARY KEY,
        investigation_id TEXT,
        ts TEXT NOT NULL,
        actor TEXT NOT NULL,
        transport TEXT NOT NULL,
        op TEXT NOT NULL,
        datapack_id TEXT,
        ok INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        attempts INTEGER NOT NULL,
        request_json TEXT NOT NULL,
        response_json TEXT,
        error_json TEXT
      );
      CREATE INDEX IF NOT EXISTS meko_events_by_investigation ON meko_events (investigation_id, ts);
      CREATE INDEX IF NOT EXISTS meko_events_by_ts ON meko_events (ts);
    `);
  }

  insertInvestigation(row: InvestigationRow): void {
    this.db.prepare(
      `INSERT INTO investigations (id, incident_ref, mode, status, incident_json, knowledge_json, result_json, decision_json, created_at, decided_at, sample_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.id, row.incidentRef, row.mode, row.status, json(row.incident), json(row.knowledge), json(row.result), json(row.decision), row.createdAt, row.decidedAt, row.sampleId ?? null);
  }

  /**
   * Atomically moves an investigation into `approving` if its status is still one of `from`.
   * Returns false if another request got there first, so a second click cannot start a second approval.
   */
  claimApproval(id: string, from: InvestigationRow["status"][], decision: unknown): boolean {
    const placeholders = from.map(() => "?").join(", ");
    const res = this.db.prepare(`UPDATE investigations SET status = 'approving', decision_json = ? WHERE id = ? AND status IN (${placeholders})`)
      .run(json(decision), id, ...from);
    return Number(res.changes) === 1;
  }

  updateDecision(id: string, status: InvestigationRow["status"], decision: unknown, decidedAt: string | null): void {
    this.db.prepare(`UPDATE investigations SET status = ?, decision_json = ?, decided_at = ? WHERE id = ?`).run(status, json(decision), decidedAt, id);
  }

  getInvestigation(id: string): InvestigationRow | null {
    const r = this.db.prepare(`SELECT * FROM investigations WHERE id = ?`).get(id) as Record<string, string | null> | undefined;
    return r ? toInvestigation(r) : null;
  }

  listInvestigations(limit = 20): InvestigationRow[] {
    const rows = this.db.prepare(`SELECT * FROM investigations ORDER BY created_at DESC LIMIT ?`).all(limit) as Array<Record<string, string | null>>;
    return rows.map(toInvestigation);
  }

  insertEvent(e: MekoEvent, investigationId: string | null): void {
    this.db.prepare(
      `INSERT INTO meko_events (id, investigation_id, ts, actor, transport, op, datapack_id, ok, latency_ms, attempts, request_json, response_json, error_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(e.id, investigationId, e.ts, e.actor, e.transport, e.op, e.datapackId, e.ok ? 1 : 0, e.latencyMs, e.attempts, json(e.request) ?? "{}", json(e.response), json(e.error));
  }

  events(investigationId?: string): StoredEvent[] {
    const rows = (investigationId
      ? this.db.prepare(`SELECT * FROM meko_events WHERE investigation_id = ? ORDER BY ts`).all(investigationId)
      : this.db.prepare(`SELECT * FROM meko_events ORDER BY ts`).all()) as EventRow[];
    return rows.map(toEvent);
  }

  /**
   * The activity feed: events at or after `since` (inclusive, so events sharing a
   * millisecond are never skipped; callers de-duplicate by id), else the newest `limit`.
   */
  eventFeed(opts: { since?: string; limit: number }): StoredEvent[] {
    const rows = (opts.since
      ? this.db.prepare(`SELECT * FROM meko_events WHERE ts >= ? ORDER BY ts LIMIT ?`).all(opts.since, opts.limit)
      : this.db.prepare(`SELECT * FROM (SELECT * FROM meko_events ORDER BY ts DESC LIMIT ?) ORDER BY ts`).all(opts.limit)) as EventRow[];
    return rows.map(toEvent);
  }

  /** All events for the given operations, oldest first. */
  eventsForOps(ops: string[]): StoredEvent[] {
    const rows = this.db.prepare(`SELECT * FROM meko_events WHERE op IN (${ops.map(() => "?").join(", ")}) ORDER BY ts`).all(...ops) as EventRow[];
    return rows.map(toEvent);
  }

  close(): void {
    this.db.close();
  }
}

export interface InvestigationRow {
  id: string;
  incidentRef: string;
  mode: "on" | "off";
  /**
   * approving: an approval is in flight (or the process died during one).
   * approved: written, promoted and read back from the knowledge datapack.
   * approval_failed: a Meko step failed definitively; retrying resumes from the last confirmed step.
   * promotion_unverified: promotion was acknowledged but read-back did not find it.
   * needs_reconciliation: a write's outcome is unknown; retrying checks Meko before writing again.
   */
  status: "proposed" | "approving" | "approved" | "approval_failed" | "promotion_unverified" | "needs_reconciliation" | "rejected" | "failed";
  incident: unknown;
  knowledge: unknown;
  result: unknown;
  decision: unknown;
  createdAt: string;
  decidedAt: string | null;
  /** The built-in sample this ran (e.g. "db-pool-1"); null for an incident the user submitted. */
  sampleId?: string | null;
}

export interface StoredEvent {
  id: string;
  investigationId: string | null;
  ts: string;
  actor: string;
  transport: string;
  op: string;
  datapackId: string | null;
  ok: boolean;
  latencyMs: number;
  attempts: number;
  request: unknown;
  response: unknown;
  error: unknown;
}

const INVESTIGATIONS_DDL = `CREATE TABLE IF NOT EXISTS investigations (
  id TEXT PRIMARY KEY,
  incident_ref TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('on','off')),
  status TEXT NOT NULL CHECK (status IN ('proposed','approving','approved','approval_failed','promotion_unverified','needs_reconciliation','rejected','failed')),
  incident_json TEXT NOT NULL,
  knowledge_json TEXT,
  result_json TEXT,
  decision_json TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  sample_id TEXT
)`;

type EventRow = Record<string, string | number | null>;

function toEvent(r: EventRow): StoredEvent {
  return {
    id: String(r.id), investigationId: r.investigation_id as string | null, ts: String(r.ts), actor: String(r.actor),
    transport: String(r.transport), op: String(r.op), datapackId: r.datapack_id as string | null, ok: r.ok === 1,
    latencyMs: Number(r.latency_ms), attempts: Number(r.attempts), request: parse(r.request_json as string),
    response: parse(r.response_json as string | null), error: parse(r.error_json as string | null),
  };
}

function toInvestigation(r: Record<string, string | null>): InvestigationRow {
  return {
    id: String(r.id), incidentRef: String(r.incident_ref), mode: r.mode as "on" | "off", status: r.status as InvestigationRow["status"],
    incident: parse(r.incident_json ?? null), knowledge: parse(r.knowledge_json ?? null), result: parse(r.result_json ?? null),
    decision: parse(r.decision_json ?? null), createdAt: String(r.created_at), decidedAt: r.decided_at ?? null, sampleId: r.sample_id ?? null,
  };
}

const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));
const parse = (v: string | null): unknown => (v === null ? null : JSON.parse(v));
