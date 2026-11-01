"use client";

import { useState } from "react";
import type { RunningState } from "./Dashboard";
import type { Investigation, StoredEvent } from "./types";
import { ACTOR, Chip, Mono, Panel, fmtMs, shortId } from "./ui";

function mergeById(a: StoredEvent[], b: StoredEvent[]): StoredEvent[] {
  const m = new Map(a.map((e) => [e.id, e]));
  for (const e of b) m.set(e.id, e);
  return [...m.values()].sort((x, y) => x.ts.localeCompare(y.ts));
}

/** Live Meko activity. Rows come only from the backend's recorded event log (/api/events). */
export function Timeline({ events, selected, running }: { events: StoredEvent[]; selected: Investigation | null; running: RunningState | null }) {
  const [scope, setScope] = useState<"run" | "all">("run");
  const [open, setOpen] = useState<string | null>(null);

  const rows = (scope === "all"
    ? events
    : running
      ? events.filter((e) => e.ts >= running.startedAt)
      : selected ? mergeById(selected.events, events.filter((e) => e.investigationId === selected.id)) : []
  ).slice().reverse();

  const failures = rows.filter((e) => !e.ok).length;

  return (
    <Panel
      kicker="Live"
      title="Meko activity"
      action={
        <div className="flex rounded-md border border-line bg-surface-2 p-0.5 text-[12px]">
          {(["run", "all"] as const).map((s) => (
            <button key={s} onClick={() => setScope(s)} className={`rounded px-2 py-1 ${scope === s ? "bg-surface-3 text-ink" : "text-ink-3 hover:text-ink-2"}`}>
              {s === "run" ? (running ? "This run" : "Selected") : "All"}
            </button>
          ))}
        </div>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-3">
        {Object.entries(ACTOR).map(([k, a]) => (
          <span key={k} className="flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: a.color }} aria-hidden />{a.label}</span>
        ))}
      </div>

      {running && running.mode === "off" && scope === "run" && (
        <p className="mb-2 text-[12.5px] text-ink-2">Meko OFF: this run makes no Meko calls, so nothing will appear here.</p>
      )}
      {rows.length === 0 ? (
        <p className="text-[13px] text-ink-3">{running ? "Waiting for the first Meko call…" : "No Meko calls recorded for this selection."}</p>
      ) : (
        <>
          <div className="mb-2 text-[12px] text-ink-3">{rows.length} call{rows.length === 1 ? "" : "s"}{failures ? ` · ${failures} failed` : ""}</div>
          <ol className="scrollbar-thin -mx-2 max-h-[420px] space-y-0.5 overflow-auto">
            {rows.map((e) => {
              const a = ACTOR[e.actor] ?? { color: "var(--text-3)", label: e.actor };
              const err = e.error as { code?: string; message?: string } | null;
              return (
                <li key={e.id} className="row-in">
                  <button onClick={() => setOpen(open === e.id ? null : e.id)} className="w-full rounded-md px-2 py-1.5 text-left hover:bg-surface-2" aria-expanded={open === e.id}>
                    <div className="flex items-center gap-2">
                      <span className="size-2 shrink-0 rounded-full" style={{ background: a.color }} title={a.label} aria-hidden />
                      <Mono className="min-w-0 flex-1 truncate text-ink">{e.op}</Mono>
                      {e.ok ? <span className="text-[11px] text-ink-3">{fmtMs(e.latencyMs)}</span> : <Chip tone="critical" icon="✕">failed</Chip>}
                    </div>
                    <div className="mt-0.5 flex gap-2 pl-4 text-[11px] text-ink-3">
                      <span>{new Date(e.ts).toLocaleTimeString([], { hour12: false })}</span>
                      <span>{a.label}</span>
                      {e.datapackId && <Mono className="text-[11px]">dp {shortId(e.datapackId)}</Mono>}
                      {e.attempts > 1 && <span>{e.attempts} attempts</span>}
                    </div>
                    {err && <div className="mt-1 pl-4 text-[11.5px] text-ink-2"><Mono>{err.code}</Mono>: {err.message}</div>}
                  </button>
                  {open === e.id && (
                    <pre className="scrollbar-thin mx-2 mb-2 max-h-64 overflow-auto rounded-md bg-bg p-2.5 font-mono text-[10.5px] leading-[1.55] text-ink-2">
                      {JSON.stringify({ request: e.request, response: e.response, error: e.error }, null, 2)}
                    </pre>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </Panel>
  );
}
