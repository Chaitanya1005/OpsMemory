"use client";

import type { RunningState } from "./Dashboard";
import { isComplete, type Investigation } from "./types";
import { Chip, Mono, Panel, SOURCE, Spinner } from "./ui";

/** Side-by-side ON vs OFF for one incident reference. Everything shown is computed from the two stored runs. */
export function Comparison({ selected, counterpart, running, onRunOther }: {
  selected: Investigation; counterpart: Investigation | null; running: RunningState | null; onRunOther: () => void;
}) {
  const other = selected.mode === "on" ? "OFF" : "ON";
  if (!counterpart) {
    return (
      <Panel kicker="Meko ON vs OFF" title="Compare the same incident">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-xl text-[13px] text-ink-2">
            Run <Mono>{selected.incidentRef}</Mono> again with Meko {other}: same logs, same model, same instructions. Only access to Meko changes.
          </p>
          <button
            onClick={onRunOther}
            disabled={running !== null}
            className="flex items-center gap-2 rounded-lg border border-line-strong px-4 py-2 text-[13px] font-medium text-ink hover:bg-surface-3 disabled:opacity-50"
          >
            {running ? <><Spinner /> Running…</> : `Run with Meko ${other}`}
          </button>
        </div>
      </Panel>
    );
  }

  const on = selected.mode === "on" ? selected : counterpart;
  const off = selected.mode === "on" ? counterpart : selected;
  if (!isComplete(on) || !isComplete(off)) return null;
  const a = on.result.outcome.investigation;
  const b = off.result.outcome.investigation;
  const count = (inv: typeof a, src: "history" | "assumption" | "current_evidence") => inv.recommendedFix.configChanges.filter((c) => c.source === src).length;

  const rows: Array<{ label: string; on: React.ReactNode; off: React.ReactNode }> = [
    { label: "Meko calls", on: <Mono>{on.mekoCalls}</Mono>, off: <Mono>{off.mekoCalls}</Mono> },
    {
      label: "Verified memory used",
      on: a.historicalContextUsed.length ? a.historicalContextUsed.map((h) => h.ref).join(", ") : "none",
      off: b.historicalContextUsed.length ? b.historicalContextUsed.map((h) => h.ref).join(", ") : "none",
    },
    { label: "Root cause", on: a.rootCause.statement, off: b.rootCause.statement },
    { label: "Configuration values", on: <Configs inv={a} />, off: <Configs inv={b} /> },
    {
      label: "Open questions",
      on: a.unresolvedQuestions.length ? <Questions qs={a.unresolvedQuestions} /> : "none",
      off: b.unresolvedQuestions.length ? <Questions qs={b.unresolvedQuestions} /> : "none",
    },
    { label: "Confidence", on: <Mono>{Math.round(a.confidence * 100)}%</Mono>, off: <Mono>{Math.round(b.confidence * 100)}%</Mono> },
  ];

  return (
    <Panel kicker="Meko ON vs OFF" title={`Same incident ${on.incidentRef}, two runs`}>
      <p className="mb-4 text-[13px] leading-relaxed text-ink-2">
        With Meko ON, <span className="text-ink">{count(a, "history")}</span> configuration value{count(a, "history") === 1 ? "" : "s"} came from verified memory and{" "}
        <span className="text-ink">{count(a, "assumption")}</span> {count(a, "assumption") === 1 ? "was an assumption" : "were assumptions"}. With Meko OFF,{" "}
        <span className="text-ink">{count(b, "history")}</span> came from memory and <span className="text-ink">{count(b, "assumption")}</span> {count(b, "assumption") === 1 ? "was an assumption" : "were assumptions"}.
      </p>
      <div className="divide-y divide-line">
        <div className="hidden grid-cols-[9rem_1fr_1fr] gap-4 pb-2 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-3 md:grid">
          <span />
          <span><span style={{ color: "var(--memory)" }} aria-hidden>●</span> Meko ON</span>
          <span>○ Meko OFF</span>
        </div>
        {rows.map((r) => (
          <div key={r.label} className="grid grid-cols-1 gap-2 py-3 md:grid-cols-[9rem_1fr_1fr] md:gap-4">
            <div className="text-[12px] font-medium text-ink-3">{r.label}</div>
            <div className="min-w-0 text-[13px] leading-relaxed text-ink">
              <span className="mb-0.5 block text-[11px] text-ink-3 md:hidden">● Meko ON</span>{r.on}
            </div>
            <div className="min-w-0 text-[13px] leading-relaxed text-ink">
              <span className="mb-0.5 block text-[11px] text-ink-3 md:hidden">○ Meko OFF</span>{r.off}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function Configs({ inv }: { inv: { recommendedFix: { configChanges: Array<{ setting: string; value: string; source: keyof typeof SOURCE; ref: string }> } } }) {
  if (!inv.recommendedFix.configChanges.length) return <span className="text-ink-3">none proposed</span>;
  return (
    <ul className="space-y-1.5">
      {inv.recommendedFix.configChanges.map((c, i) => {
        const s = SOURCE[c.source];
        return (
          <li key={i} className="flex flex-wrap items-center gap-2">
            <Mono>{c.setting} = {c.value}</Mono>
            <Chip tone={s.tone} icon={s.icon}>{s.label}{c.ref ? ` · ${c.ref}` : ""}</Chip>
          </li>
        );
      })}
    </ul>
  );
}

function Questions({ qs }: { qs: string[] }) {
  return <ul className="space-y-1 text-ink-2">{qs.map((q, i) => <li key={i}>• {q}</li>)}</ul>;
}
