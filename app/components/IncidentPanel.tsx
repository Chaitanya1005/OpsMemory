"use client";

import { useEffect, useState } from "react";
import type { RunningState } from "./Dashboard";
import type { Scenario } from "./types";
import { Chip, Mono, Panel, Spinner } from "./ui";

export function IncidentPanel({ scenarios, scenario, onScenario, mode, onMode, running, onInvestigate }: {
  scenarios: Scenario[];
  scenario: Scenario | null;
  onScenario: (id: string) => void;
  mode: "on" | "off";
  onMode: (m: "on" | "off") => void;
  running: RunningState | null;
  onInvestigate: () => void;
}) {
  const elapsed = useElapsed(running?.startedAt ?? null);

  return (
    <Panel kicker="1 · Incident" title="Choose an incident">
      <fieldset className="space-y-2">
        <legend className="sr-only">Incident</legend>
        {scenarios.map((s, i) => {
          const active = s.id === scenario?.id;
          return (
            <button
              key={s.id}
              type="button"
              aria-pressed={active}
              onClick={() => onScenario(s.id)}
              disabled={running !== null}
              className={`w-full rounded-lg border px-3.5 py-3 text-left transition-colors disabled:cursor-not-allowed ${active ? "border-line-strong bg-surface-3" : "border-line bg-surface-2 hover:border-line-strong"}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="whitespace-nowrap text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">Incident {i + 1}</span>
                <span className="flex gap-1.5">
                  <Chip><Mono>{s.service}</Mono></Chip>
                  <Chip tone="serious" icon="▲">{s.severity}</Chip>
                </span>
              </div>
              <div className="mt-1.5 text-[13.5px] font-medium leading-snug text-ink">{s.title}</div>
            </button>
          );
        })}
      </fieldset>

      <div className="mt-5">
        <div className="mb-2">
          <div className="text-[13px] font-medium text-ink">Meko memory</div>
          <div className="text-[12px] text-ink-3">Same incident, model and prompt either way</div>
        </div>
        <fieldset className="grid grid-cols-2 rounded-lg border border-line bg-surface-2 p-1">
          <legend className="sr-only">Meko mode</legend>
          {(["on", "off"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => onMode(m)}
              disabled={running !== null}
              className={`rounded-md px-3 py-2 text-[13px] font-semibold transition-colors disabled:cursor-not-allowed ${mode === m ? "bg-surface-3 text-ink shadow-[inset_0_0_0_1px_var(--border-strong)]" : "text-ink-3 hover:text-ink-2"}`}
            >
              <span className="mr-1.5" style={{ color: mode === m && m === "on" ? "var(--memory)" : undefined }} aria-hidden>{m === "on" ? "●" : "○"}</span>
              Meko {m.toUpperCase()}
            </button>
          ))}
        </fieldset>
        <p className="mt-2 text-[12px] leading-relaxed text-ink-3">
          {mode === "on"
            ? "Recalls verified resolutions and prior observations from Meko before reasoning, then records the finding."
            : "No Meko calls at all: the Investigator sees only the current incident's evidence."}
        </p>
      </div>

      <button type="button"
        onClick={onInvestigate}
        disabled={running !== null || !scenario}
        className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-ink px-4 py-2.5 text-[14px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {running ? <><Spinner className="border-bg/40 border-t-bg" /> Investigating · {elapsed}s</> : <>Investigate with Meko {mode.toUpperCase()}</>}
      </button>

      {scenario && (
        <details className="group mt-5 rounded-lg border border-line bg-surface-2">
          <summary className="cursor-pointer list-none px-3.5 py-2.5 text-[13px] font-medium text-ink-2 hover:text-ink">
            <span className="mr-1.5 inline-block transition-transform group-open:rotate-90" aria-hidden>›</span>
            Incident evidence · {scenario.logs.split("\n").length} log lines
          </summary>
          <div className="border-t border-line px-3.5 py-3">
            <p className="text-[13px] leading-relaxed text-ink-2">{scenario.description}</p>
            <pre className="scrollbar-thin mt-3 max-h-72 overflow-auto rounded-md bg-bg p-3 font-mono text-[11px] leading-[1.6] text-ink-2">{scenario.logs}</pre>
          </div>
        </details>
      )}
    </Panel>
  );
}

function useElapsed(startedAt: string | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [startedAt]);
  return startedAt ? Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000)) : 0;
}
