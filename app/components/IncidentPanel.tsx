"use client";

import { useEffect, useId, useState } from "react";
import type { IncidentInput } from "@/data/scenarios";
import { INCIDENT_LIMITS } from "@/lib/incident";
import type { RunningState } from "./Dashboard";
import type { Scenario } from "./types";
import { Chip, Mono, Panel, Spinner } from "./ui";

export type IncidentSource = "sample" | "custom";
export type IncidentDraft = IncidentInput;

export const EMPTY_DRAFT: IncidentDraft = { title: "", service: "", severity: "SEV2", description: "", logs: "" };

/** Client-side mirror of the server's limits (lib/incident.ts), so the button only enables for a submittable draft. */
export function draftProblems(d: IncidentDraft): string[] {
  const problems: string[] = [];
  if (d.title.trim().length < 3) problems.push("a title");
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(d.service.trim())) problems.push("a service name (letters, digits, . _ -)");
  if (!d.logs.trim()) problems.push("some logs");
  return problems;
}

export function IncidentPanel({ scenarios, scenario, onScenario, source, onSource, draft, onDraft, mode, onMode, running, onInvestigate }: {
  scenarios: Scenario[];
  scenario: Scenario | null;
  onScenario: (id: string) => void;
  source: IncidentSource;
  onSource: (s: IncidentSource) => void;
  draft: IncidentDraft;
  onDraft: (d: IncidentDraft) => void;
  mode: "on" | "off";
  onMode: (m: "on" | "off") => void;
  running: RunningState | null;
  onInvestigate: () => void;
}) {
  const elapsed = useElapsed(running?.startedAt ?? null);
  const missing = source === "custom" ? draftProblems(draft) : [];
  const ready = source === "sample" ? scenario !== null : missing.length === 0;

  return (
    <Panel kicker="1 · Incident" title="Choose an incident">
      <Toggle
        label="Incident source"
        value={source}
        onChange={onSource}
        disabled={running !== null}
        options={[{ value: "sample", label: "Sample incidents" }, { value: "custom", label: "Your own incident" }]}
      />

      {source === "sample" ? (
        <fieldset className="mt-3 space-y-2">
          <legend className="sr-only">Sample incident</legend>
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
                  <span className="whitespace-nowrap text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">Sample {i + 1}</span>
                  <span className="flex gap-1.5">
                    <Chip><Mono>{s.service}</Mono></Chip>
                    <Chip tone="serious" icon="▲">{s.severity}</Chip>
                  </span>
                </div>
                <div className="mt-1.5 text-[13.5px] font-medium leading-snug text-ink">{s.title}</div>
              </button>
            );
          })}
          <p className="pt-1 text-[12px] leading-relaxed text-ink-3">
            Synthetic incidents. Run sample 1 with Meko ON and approve it, then run sample 2: the fix verified for one service is recalled for another.
          </p>
        </fieldset>
      ) : (
        <IncidentForm draft={draft} onDraft={onDraft} disabled={running !== null} />
      )}

      <div className="mt-5">
        <div className="mb-2">
          <div className="text-[13px] font-medium text-ink">Compare with and without memory</div>
          <div className="text-[12px] text-ink-3">Same incident, model and prompt either way. Only access to Meko changes.</div>
        </div>
        <Toggle
          label="Meko mode"
          value={mode}
          onChange={onMode}
          disabled={running !== null}
          options={[
            { value: "on", label: "Meko ON", icon: <span style={{ color: mode === "on" ? "var(--memory)" : undefined }}>●</span> },
            { value: "off", label: "Meko OFF", icon: <span>○</span> },
          ]}
        />
        <p className="mt-2 text-[12px] leading-relaxed text-ink-3">
          {mode === "on"
            ? "Recalls verified resolutions and prior observations from Meko before reasoning, then records the finding."
            : "No Meko calls at all: the Investigator sees only the current incident's evidence."}
        </p>
      </div>

      <button
        type="button"
        onClick={onInvestigate}
        disabled={running !== null || !ready}
        className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-ink px-4 py-2.5 text-[14px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {running ? <><Spinner className="border-bg/40 border-t-bg" /> Investigating · {elapsed}s</> : <>Investigate with Meko {mode.toUpperCase()}</>}
      </button>
      {source === "custom" && missing.length > 0 && !running && (
        <p className="mt-2 text-[12px] text-ink-3">Add {missing.join(", ")} to investigate.</p>
      )}

      {source === "sample" && scenario && (
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

/** Two-option toggle buttons (the same control for the incident source and the Meko mode). */
function Toggle<T extends string>({ label, value, onChange, options, disabled }: {
  label: string; value: T; onChange: (v: T) => void; disabled: boolean; options: Array<{ value: T; label: string; icon?: React.ReactNode }>;
}) {
  return (
    <fieldset className="grid grid-cols-2 rounded-lg border border-line bg-surface-2 p-1">
      <legend className="sr-only">{label}</legend>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          disabled={disabled}
          className={`rounded-md px-3 py-2 text-[13px] font-semibold transition-colors disabled:cursor-not-allowed ${value === o.value ? "bg-surface-3 text-ink shadow-[inset_0_0_0_1px_var(--border-strong)]" : "text-ink-3 hover:text-ink-2"}`}
        >
          {o.icon && <span className="mr-1.5" aria-hidden>{o.icon}</span>}
          {o.label}
        </button>
      ))}
    </fieldset>
  );
}

function IncidentForm({ draft, onDraft, disabled }: { draft: IncidentDraft; onDraft: (d: IncidentDraft) => void; disabled: boolean }) {
  const set = <K extends keyof IncidentDraft>(key: K, value: IncidentDraft[K]) => onDraft({ ...draft, [key]: value });
  const lines = draft.logs ? draft.logs.split("\n").length : 0;
  const id = useId();
  const input = "w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] text-ink placeholder:text-ink-3 focus:border-line-strong focus:outline-none disabled:opacity-60";
  return (
    <div className="mt-3 space-y-3">
      <div className="rounded-lg border px-3.5 py-2.5 text-[12px] leading-relaxed text-ink-2" style={{ borderColor: "color-mix(in srgb, var(--warning) 45%, transparent)", background: "color-mix(in srgb, var(--warning) 8%, transparent)" }}>
        <span className="font-semibold text-ink">Public sandbox.</span> What you submit is sent to Google Gemini for analysis. With Meko ON, the title,
        description and the agent&apos;s finding are stored in shared memory that every visitor can see. Don&apos;t paste real production data. Emails, IP
        addresses, keys, tokens and passwords are redacted on the server before anything is analysed or stored; that is best effort, not a guarantee.
      </div>
      <Field label="Title" htmlFor={`${id}-title`}>
        <input id={`${id}-title`} className={input} value={draft.title} maxLength={INCIDENT_LIMITS.title} disabled={disabled} placeholder="Payments API timing out after deploy"
          onChange={(e) => set("title", e.target.value)} />
      </Field>
      <div className="grid grid-cols-[1fr_auto] gap-3">
        <Field label="Service" htmlFor={`${id}-service`}>
          <input id={`${id}-service`} className={`${input} font-mono`} value={draft.service} maxLength={INCIDENT_LIMITS.service} disabled={disabled} placeholder="payments-api"
            onChange={(e) => set("service", e.target.value)} />
        </Field>
        <Field label="Severity" htmlFor={`${id}-severity`}>
          <select id={`${id}-severity`} className={input} value={draft.severity} disabled={disabled} onChange={(e) => set("severity", e.target.value as IncidentDraft["severity"])}>
            <option value="SEV1">SEV1</option>
            <option value="SEV2">SEV2</option>
            <option value="SEV3">SEV3</option>
          </select>
        </Field>
      </div>
      <Field label="What are you seeing? (optional)" htmlFor={`${id}-description`}>
        <textarea id={`${id}-description`} className={`${input} resize-y`} rows={2} value={draft.description} maxLength={INCIDENT_LIMITS.description} disabled={disabled}
          placeholder="Error rate jumped after the 14:00 deploy; only some regions affected"
          onChange={(e) => set("description", e.target.value)} />
      </Field>
      <Field label="Logs" htmlFor={`${id}-logs`} hint={`${lines.toLocaleString("en-US")} / ${INCIDENT_LIMITS.logLines.toLocaleString("en-US")} lines · ${draft.logs.length.toLocaleString("en-US")} / ${INCIDENT_LIMITS.logChars.toLocaleString("en-US")} chars`}>
        <textarea id={`${id}-logs`} className={`${input} scrollbar-thin resize-y font-mono text-[11.5px] leading-[1.55]`} rows={8} value={draft.logs} maxLength={INCIDENT_LIMITS.logChars} disabled={disabled}
          placeholder={"2026-11-20T14:02:11Z ERROR payments-api upstream timeout after 5000ms\n2026-11-20T14:02:12Z WARN  gateway retrying POST /v1/charge"}
          onChange={(e) => set("logs", e.target.value)} />
      </Field>
      <p className="text-[12px] leading-relaxed text-ink-3">
        Lines shaped like <Mono>{"<ISO time> <LEVEL> <component> <message>"}</Mono> are grouped into error signatures; other lines are still read by the model.
      </p>
    </div>
  );
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[12px] font-medium text-ink-2">
        <label htmlFor={htmlFor}>{label}</label>
        {hint && <span className="font-normal text-ink-3">{hint}</span>}
      </div>
      {children}
    </div>
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
