import "server-only";
import { loadConfig } from "@/lib/config";
import { MekoError } from "@/lib/meko/client";
import type { InvestigationRow, StoredEvent } from "@/lib/store";
import { ApprovalFailure, OpsMemory } from "@/lib/workflow";

/**
 * One OpsMemory instance per server process (keeps the Meko MCP session open).
 * Workflow calls are serialised: the workflow attributes Meko events to the
 * investigation in progress, so two concurrent runs would mix their event logs.
 */
const g = globalThis as unknown as { __opsmemory?: OpsMemory; __opsmemoryQueue?: Promise<unknown> };

export function getApp(): OpsMemory {
  g.__opsmemory ??= new OpsMemory(loadConfig());
  return g.__opsmemory;
}

export function serialized<T>(fn: (app: OpsMemory) => Promise<T>): Promise<T> {
  const run = (g.__opsmemoryQueue ?? Promise.resolve()).catch(() => undefined).then(() => fn(getApp()));
  g.__opsmemoryQueue = run;
  return run;
}

export interface InvestigationDto extends InvestigationRow {
  mekoCalls: number;
  events: StoredEvent[];
}

export function toDto(app: OpsMemory, row: InvestigationRow): InvestigationDto {
  const events = app.store.events(row.id);
  return { ...row, mekoCalls: events.length, events };
}

/** Maps workflow failures to an honest JSON error; Meko failures keep their code and operation. */
export function errorResponse(err: unknown): Response {
  if (err instanceof ApprovalFailure) {
    // The approval did not reach a verified state; report the persisted stage, not a success.
    const f = err.decision.failure;
    return Response.json({ error: err.message, code: f?.code, op: f?.stage, source: "meko", approvalStatus: err.decision.status }, { status: 502 });
  }
  if (err instanceof MekoError) {
    return Response.json({ error: err.message, code: err.code, op: err.op, source: "meko" }, { status: 502 });
  }
  const message = err instanceof Error ? err.message : String(err);
  const isLlm = err instanceof Error && err.name === "LlmError";
  return Response.json({ error: message, source: isLlm ? "llm" : "app" }, { status: isLlm ? 502 : 400 });
}
