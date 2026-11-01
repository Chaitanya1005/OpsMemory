"use client";

import type { RunningState } from "./Dashboard";
import { isComplete, type ApprovalDecision, type Investigation, type StoredEvent } from "./types";
import { fmtMs, shortId } from "./ui";

type StageState = "done" | "active" | "pending" | "skipped" | "failed";
interface Stage { key: string; label: string; state: StageState; detail: string }

const RECALL_OPS = new Set(["knowledgebase_search", "memory_search"]);
const RECORD_OPS = new Set(["conversation_create", "conversation_add_message", "memory_add"]);

/**
 * The Meko memory lifecycle for the selected (or running) investigation.
 * Every stage state is derived from recorded backend events and stored results.
 */
export function Lifecycle({ selected, running, events, investigations }: {
  selected: Investigation | null; running: RunningState | null; events: StoredEvent[]; investigations: Investigation[];
}) {
  const stages = running ? runningStages(running, events) : selected ? selectedStages(selected, events, investigations) : idleStages();
  const heading = running
    ? `Running · Meko ${running.mode.toUpperCase()}`
    : selected ? `${selected.incidentRef} · Meko ${selected.mode.toUpperCase()}` : "No investigation selected";

  return (
    <section aria-label="Meko memory lifecycle" className="rounded-xl border border-line bg-surface px-5 py-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-semibold text-ink">Memory lifecycle</h2>
        <span className="font-mono text-[12px] text-ink-3">{heading}</span>
      </div>
      <ol className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 lg:grid-cols-6">
        {stages.map((s, i) => (
          <li key={s.key} className="relative min-w-0">
            <div className="flex items-center gap-2">
              <StageDot state={s.state} />
              <span className={`text-[12.5px] font-semibold ${s.state === "pending" || s.state === "skipped" ? "text-ink-3" : "text-ink"}`}>{i + 1}. {s.label}</span>
              {i < stages.length - 1 && <span className="hidden h-px flex-1 bg-line lg:block" aria-hidden />}
            </div>
            <p className="mt-1.5 pl-6 text-[12px] leading-snug text-ink-2">{s.detail}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function StageDot({ state }: { state: StageState }) {
  const map: Record<StageState, { c: string; icon: string; label: string }> = {
    done: { c: "var(--good)", icon: "✓", label: "done" },
    active: { c: "var(--memory)", icon: "●", label: "in progress" },
    pending: { c: "var(--text-3)", icon: "○", label: "pending" },
    skipped: { c: "var(--text-3)", icon: "–", label: "skipped" },
    failed: { c: "var(--critical)", icon: "✕", label: "failed" },
  };
  const m = map[state];
  return (
    <span
      className={`grid size-4.5 shrink-0 place-items-center rounded-full border text-[10px] font-bold ${state === "active" ? "pulse-dot" : ""}`}
      style={{ borderColor: m.c, color: m.c }}
      title={m.label}
      aria-label={m.label}
    >
      {m.icon}
    </span>
  );
}

function idleStages(): Stage[] {
  return [
    { key: "recall", label: "Recall", state: "pending", detail: "Knowledge Agent searches Meko" },
    { key: "reason", label: "Reason", state: "pending", detail: "Investigator analyses evidence" },
    { key: "record", label: "Record", state: "pending", detail: "Unverified finding stored" },
    { key: "review", label: "Review", state: "pending", detail: "Engineer approves or rejects" },
    { key: "promote", label: "Promote", state: "pending", detail: "Becomes verified knowledge" },
    { key: "reuse", label: "Reuse", state: "pending", detail: "Recalled by the next incident" },
  ];
}

/**
 * While a run is in flight the only backend signal is the Meko event log, so
 * stages show what those events confirm and nothing more: no expected totals,
 * and no stage is marked done because it would normally come next.
 */
function runningStages(run: RunningState, events: StoredEvent[]): Stage[] {
  const live = events.filter((e) => e.ts >= run.startedAt);
  const s = idleStages();
  const notReported = "In progress · the backend reports this when the run returns";
  if (run.mode === "off") {
    s[0] = { ...s[0]!, state: "skipped", detail: "Meko OFF — no recall" };
    s[1] = { ...s[1]!, state: "active", detail: notReported };
    s[2] = { ...s[2]!, state: "skipped", detail: "Meko OFF — nothing stored" };
    return s;
  }
  const recall = live.filter((e) => e.actor === "knowledge-agent" && RECALL_OPS.has(e.op));
  const record = live.filter((e) => e.actor === "investigator" && RECORD_OPS.has(e.op));
  s[0] = recall.length
    ? { ...s[0]!, state: recall.some((e) => !e.ok) ? "failed" : "active", detail: `${recall.length} Meko search${recall.length === 1 ? "" : "es"} recorded · last ${fmtMs(recall.at(-1)!.latencyMs)}` }
    : { ...s[0]!, state: "active", detail: "Started · no Meko search recorded yet" };
  s[1] = { ...s[1]!, state: "pending", detail: notReported };
  if (record.length) s[2] = { ...s[2]!, state: record.some((e) => !e.ok) ? "failed" : "active", detail: `${record.length} write${record.length === 1 ? "" : "s"} recorded to investigator datapack` };
  return s;
}

function selectedStages(inv: Investigation, events: StoredEvent[], all: Investigation[]): Stage[] {
  const own = mergeEvents(inv.events, events.filter((e) => e.investigationId === inv.id));
  const s = idleStages();
  if (!isComplete(inv)) return s.map((x, i) => (i === 0 ? { ...x, state: "failed", detail: "Investigation failed" } : x));
  const { knowledge, result, decision } = inv;

  if (inv.mode === "off") {
    s[0] = { ...s[0]!, state: "skipped", detail: "Meko OFF — no recall" };
  } else {
    const failed = own.some((e) => e.actor === "knowledge-agent" && !e.ok);
    const verified = knowledge?.retrieved.filter((r) => r.kind === "verified_resolution").length ?? 0;
    s[0] = { ...s[0]!, state: failed ? "failed" : "done", detail: `${knowledge?.retrieved.length ?? 0} retrieved · ${verified} verified · ${knowledge?.relevant.length ?? 0} relevant` };
  }
  s[1] = { ...s[1]!, state: "done", detail: `${result.outcome.llm.model} · ${fmtMs(result.timings.investigatorMs)}` };

  const writes = result.mekoWrites;
  if (inv.mode === "off") s[2] = { ...s[2]!, state: "skipped", detail: "Meko OFF — nothing stored" };
  else if (writes && "error" in writes) s[2] = { ...s[2]!, state: "failed", detail: writes.error };
  else if (writes) s[2] = { ...s[2]!, state: "done", detail: `Finding ${shortId(writes.findingMemoryIds[0])} (unverified)` };

  if (inv.mode === "off") {
    s[3] = { ...s[3]!, state: "skipped", detail: "OFF runs cannot be promoted" };
    s[4] = { ...s[4]!, state: "skipped", detail: "—" };
    s[5] = { ...s[5]!, state: "skipped", detail: "—" };
    return s;
  }
  if (!decision) {
    s[3] = { ...s[3]!, state: "active", detail: "Awaiting engineer decision" };
    return s;
  }
  if (decision.status === "rejected") {
    s[3] = { ...s[3]!, state: "done", detail: "Rejected — kept as an observation" };
    s[4] = { ...s[4]!, state: "skipped", detail: "Rejected resolutions are not promoted" };
    s[5] = { ...s[5]!, state: "skipped", detail: "—" };
    return s;
  }
  const d = decision as ApprovalDecision;
  const promoteEvent = own.find((e) => e.op === "memory_promote");
  // Records from before read-back was required have no promotionConfirmed; fall back to the promote response.
  const promotionConfirmed = d.promotionConfirmed ?? (d.promotion.inserted.length + d.promotion.updated.length > 0);
  s[3] = { ...s[3]!, state: "done", detail: d.edited ? "Approved with engineer edits" : "Approved as proposed" };
  if (d.status === "approving") {
    s[4] = { ...s[4]!, state: "active", detail: "Approval in progress" };
    return s;
  }
  if (d.status !== "approved" || !d.retrievableAfterPromotion) {
    const why = d.failure ? `${d.failure.stage}: ${d.failure.code}${d.failure.uncertain ? " (outcome unknown)" : ""}` : "NOT found on read-back";
    s[4] = { ...s[4]!, state: "failed", detail: `${promotionConfirmed ? "Promotion acknowledged, not verified" : "Not promoted"} · ${why}` };
    s[5] = { ...s[5]!, state: "skipped", detail: "Only verified knowledge counts as reusable" };
    return s;
  }
  s[4] = {
    ...s[4]!,
    state: promoteEvent && !promoteEvent.ok && !promotionConfirmed ? "failed" : "done",
    detail: `${d.memoryIds.length} promoted · read back via knowledgebase_search`,
  };
  const reusers = all.filter((o) => o.id !== inv.id && o.knowledge?.retrieved.some((r) => r.source.memoryId && d.memoryIds.includes(r.source.memoryId)));
  s[5] = reusers.length
    ? { ...s[5]!, state: "done", detail: `Recalled by ${[...new Set(reusers.map((r) => r.incidentRef))].join(", ")}` }
    : { ...s[5]!, state: "pending", detail: "Not recalled by a later incident yet" };
  return s;
}

function mergeEvents(a: StoredEvent[], b: StoredEvent[]): StoredEvent[] {
  const seen = new Map(a.map((e) => [e.id, e]));
  for (const e of b) seen.set(e.id, e);
  return [...seen.values()].sort((x, y) => x.ts.localeCompare(y.ts));
}
