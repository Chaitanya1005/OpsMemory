import { randomUUID } from "node:crypto";

/** Who initiated a Meko operation. Drives the activity feed and metrics. */
export type MekoActor = "knowledge-agent" | "investigator" | "engineer" | "system";

/** One real Meko call, recorded after it completes (success or failure). */
export interface MekoEvent {
  id: string;
  ts: string;
  actor: MekoActor;
  transport: "mcp" | "s3";
  op: string;
  datapackId: string | null;
  ok: boolean;
  latencyMs: number;
  attempts: number;
  /** Request arguments with long strings truncated. Never contains credentials. */
  request: Record<string, unknown>;
  /** Parsed response (truncated) or null on failure. */
  response: unknown;
  error: { code: string; message: string } | null;
}

export type MekoEventSink = (event: MekoEvent) => void;

/** In-process event log. The app will persist the same events to SQLite. */
export class MekoEventLog {
  private readonly events: MekoEvent[] = [];
  private readonly listeners = new Set<MekoEventSink>();

  record(e: Omit<MekoEvent, "id" | "ts">): MekoEvent {
    const event: MekoEvent = { id: randomUUID(), ts: new Date().toISOString(), ...e };
    this.events.push(event);
    for (const l of this.listeners) l(event);
    return event;
  }

  subscribe(listener: MekoEventSink): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  all(): readonly MekoEvent[] {
    return this.events;
  }
}

const MAX_STRING = 400;

/** Truncates long strings so the event log stays small and readable. */
/** Personal data Meko returns in listings (FRICTION_LOG #13); never persisted or shown. */
const REDACTED_KEYS = new Set(["promoted_by_email", "promoted_by_name", "user_email", "user_name"]);

export function truncateForLog(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… (${value.length} chars)` : value;
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 25).map((v) => truncateForLog(v, depth + 1));
  return Object.fromEntries(Object.entries(value).filter(([k]) => !REDACTED_KEYS.has(k)).map(([k, v]) => [k, truncateForLog(v, depth + 1)]));
}
