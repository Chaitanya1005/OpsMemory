"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApprovalPanel } from "./ApprovalPanel";
import { Comparison } from "./Comparison";
import { IncidentPanel } from "./IncidentPanel";
import { InvestigationView } from "./InvestigationView";
import { Lifecycle } from "./Lifecycle";
import { RecalledMemory } from "./RecalledMemory";
import { RunHistory } from "./RunHistory";
import { Timeline } from "./Timeline";
import { isComplete, type ApiError, type Investigation, type Scenario, type Status, type StoredEvent } from "./types";
import { Chip, ErrorBox, Mono, Spinner, fmtMs } from "./ui";

export interface RunningState {
  scenarioId: string;
  mode: "on" | "off";
  startedAt: string;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json" }, cache: "no-store" });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw body as ApiError;
  return body as T;
}

export function Dashboard() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [investigations, setInvestigations] = useState<Investigation[]>([]);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [scenarioId, setScenarioId] = useState("db-pool-1");
  const [mode, setMode] = useState<"on" | "off">("on");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [running, setRunning] = useState<RunningState | null>(null);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [forgetting, setForgetting] = useState<string | null>(null);
  const [error, setError] = useState<{ context: string; err: ApiError } | null>(null);
  const lastEventTs = useRef<string>("");

  const refreshInvestigations = useCallback(async () => {
    setInvestigations(await api<Investigation[]>("/api/investigations"));
  }, []);

  // Initial load.
  useEffect(() => {
    void (async () => {
      try {
        const [s, st, inv, ev] = await Promise.all([
          api<Scenario[]>("/api/scenarios"), api<Status>("/api/status"), api<Investigation[]>("/api/investigations"), api<StoredEvent[]>("/api/events"),
        ]);
        setScenarios(s);
        setStatus(st);
        setInvestigations(inv);
        setEvents(ev);
        lastEventTs.current = ev.at(-1)?.ts ?? "";
        if (inv[0]) setSelectedId(inv[0].id);
      } catch (err) {
        setError({ context: "Could not load the dashboard", err: err as ApiError });
      }
    })();
  }, []);

  // Poll the backend's recorded Meko events: fast while work is in flight, slow otherwise.
  useEffect(() => {
    const active = running !== null || busy !== null;
    const t = setInterval(async () => {
      try {
        const q = lastEventTs.current ? `?since=${encodeURIComponent(lastEventTs.current)}` : "";
        const fresh = await api<StoredEvent[]>(`/api/events${q}`);
        if (fresh.length) {
          lastEventTs.current = fresh.at(-1)!.ts;
          // `since` is inclusive, so the last event seen comes back again; keep one copy of each.
          setEvents((prev) => {
            const seen = new Set(prev.map((e) => e.id));
            return [...prev, ...fresh.filter((e) => !seen.has(e.id))].slice(-400);
          });
        }
      } catch {
        /* the next tick retries; errors from actions are shown separately */
      }
    }, active ? 700 : 4000);
    return () => clearInterval(t);
  }, [running, busy]);

  const selected = investigations.find((i) => i.id === selectedId) ?? null;
  const counterpart = useMemo(
    () => (selected ? investigations.find((i) => i.incidentRef === selected.incidentRef && i.mode !== selected.mode && isComplete(i)) ?? null : null),
    [selected, investigations],
  );

  const investigate = async (opts: { scenarioId: string; mode: "on" | "off"; incidentRef?: string }) => {
    setError(null);
    setRunning({ scenarioId: opts.scenarioId, mode: opts.mode, startedAt: new Date().toISOString() });
    try {
      const rec = await api<Investigation>("/api/investigations", { method: "POST", body: JSON.stringify(opts) });
      await refreshInvestigations();
      setSelectedId(rec.id);
    } catch (err) {
      setError({ context: `Investigation failed (Meko ${opts.mode.toUpperCase()})`, err: err as ApiError });
      await refreshInvestigations().catch(() => undefined);
    } finally {
      setRunning(null);
    }
  };

  const decide = async (kind: "approve" | "reject", body: Record<string, string>) => {
    if (!selected) return;
    setError(null);
    setBusy(kind);
    try {
      await api(`/api/investigations/${selected.id}/${kind}`, { method: "POST", body: JSON.stringify(body) });
      await refreshInvestigations();
    } catch (err) {
      setError({ context: kind === "approve" ? "Approval or promotion failed" : "Rejection failed", err: err as ApiError });
      await refreshInvestigations().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  };

  const forget = async (memoryId: string) => {
    if (!selected) return;
    setError(null);
    setForgetting(memoryId);
    try {
      await api(`/api/investigations/${selected.id}/forget`, { method: "POST", body: JSON.stringify({ memoryId }) });
      await refreshInvestigations();
    } catch (err) {
      setError({ context: "Forget failed", err: err as ApiError });
    } finally {
      setForgetting(null);
    }
  };

  const scenario = scenarios.find((s) => s.id === scenarioId) ?? null;
  const selectedScenario = selected ? scenarios.find((s) => s.title === selected.incident.title) ?? null : null;

  return (
    <div className="mx-auto max-w-[1440px] px-4 pb-16 pt-6 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="grid size-7 place-items-center rounded-md border border-line-strong bg-surface-2 text-[13px] font-bold" style={{ color: "var(--memory)" }} aria-hidden>◎</span>
            <h1 className="text-[19px] font-semibold tracking-tight">OpsMemory</h1>
          </div>
          <p className="mt-1 text-sm text-ink-2">Your infrastructure should never forget how it was fixed.</p>
        </div>
        {status && (
          <div className="flex flex-wrap items-center gap-2 text-ink-2">
            <Chip tone={status.mekoConfigured ? "good" : "critical"} icon={status.mekoConfigured ? "●" : "✕"}>Meko {status.mekoConfigured ? "key configured" : "key missing"}</Chip>
            <Chip icon="▤"><Mono>{status.datapacks.knowledge}</Mono></Chip>
            <Chip icon="▤"><Mono>{status.datapacks.investigator}</Mono></Chip>
            <Chip icon="◇"><Mono>{status.model}</Mono></Chip>
          </div>
        )}
      </header>

      <Lifecycle selected={selected} running={running} events={events} investigations={investigations} />

      {error && (
        <div className="mt-4">
          <ErrorBox title={error.context}>
            {error.err.source === "meko" ? "Meko operation failed" : error.err.source === "llm" ? "Model call failed" : "Error"}
            {error.err.op ? <> in <Mono>{error.err.op}</Mono></> : null}
            {error.err.code ? <> (<Mono>{error.err.code}</Mono>)</> : null}: {error.err.error}
            <div className="mt-1 text-ink-3">Nothing was substituted: no local memory fallback is used.</div>
          </ErrorBox>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(300px,360px)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-6">
          <IncidentPanel
            scenarios={scenarios}
            scenario={scenario}
            onScenario={setScenarioId}
            mode={mode}
            onMode={setMode}
            running={running}
            onInvestigate={() => investigate({ scenarioId, mode })}
          />
          <Timeline events={events} selected={selected} running={running} />
          <RunHistory investigations={investigations} selectedId={selectedId} onSelect={setSelectedId} />
        </div>

        <div className="min-w-0 space-y-6">
          {!selected && !running && (
            <div className="grid place-items-center rounded-xl border border-dashed border-line px-6 py-16 text-center">
              <div className="max-w-md text-sm text-ink-2">
                Pick an incident and run an investigation. With Meko ON, the Knowledge Agent recalls verified resolutions before the Investigator reasons; with Meko OFF it works from the current logs alone.
              </div>
            </div>
          )}
          {running && <RunningCard running={running} scenario={scenarios.find((x) => x.id === running.scenarioId) ?? null} events={events} />}
          {selected && !running && (!isComplete(selected) ? (
                <ErrorBox title={`Investigation ${selected.id} failed`}>{(selected.result as { error: string }).error}</ErrorBox>
              ) : (
                <>
                  <RecalledMemory investigation={selected} forgetting={forgetting} onForget={forget} />
                  <InvestigationView investigation={selected} forgetting={forgetting} onForget={forget} />
                  <ApprovalPanel
                    investigation={selected}
                    scenario={selectedScenario}
                    busy={busy}
                    onApprove={(body) => decide("approve", body)}
                    onReject={(reason) => decide("reject", { reason })}
                  />
                  <Comparison
                    selected={selected}
                    counterpart={counterpart}
                    running={running}
                    onRunOther={() => selectedScenario && investigate({ scenarioId: selectedScenario.id, mode: selected.mode === "on" ? "off" : "on", incidentRef: selected.incidentRef })}
                  />
                </>
              ))}
        </div>
      </div>
    </div>
  );
}

/** Shown while an investigation runs, so the previous result is never mistaken for the new one. */
function RunningCard({ running, scenario, events }: { running: RunningState; scenario: Scenario | null; events: StoredEvent[] }) {
  const live = events.filter((e) => e.ts >= running.startedAt);
  const last = live.at(-1);
  return (
    <section className="rounded-xl border border-line-strong bg-surface px-5 py-6">
      <div className="flex items-center gap-3">
        <Spinner />
        <h2 className="text-[15px] font-semibold text-ink">Investigating{scenario ? ` ${scenario.service}` : ""} with Meko {running.mode.toUpperCase()}</h2>
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
        {running.mode === "on"
          ? "The Knowledge Agent is recalling from Meko, then the Investigator reasons and records its finding. Each Meko call appears in the live activity feed as it completes."
          : "Meko is OFF: no recall and no writes. The Investigator reasons over the current incident only."}
      </p>
      {running.mode === "on" && (
        <p className="mt-3 font-mono text-[12px] text-ink-3">
          {last ? `${live.length} Meko call${live.length === 1 ? "" : "s"} so far · last: ${last.op} (${fmtMs(last.latencyMs)})` : "Waiting for the first Meko call…"}
        </p>
      )}
    </section>
  );
}
