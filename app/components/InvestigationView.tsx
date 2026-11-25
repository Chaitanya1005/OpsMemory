"use client";

import { isComplete, type Investigation } from "./types";
import { ForgetControl } from "./RecalledMemory";
import { Chip, Mono, Panel, SOURCE, fmtMs, shortId } from "./ui";

const BASIS = {
  current_evidence: { tone: "memory" as const, icon: "◆", label: "Current evidence" },
  current_evidence_and_history: { tone: "good" as const, icon: "✓", label: "Evidence + verified history" },
  inconclusive: { tone: "serious" as const, icon: "?", label: "Inconclusive" },
};

const REDACTION_LABEL: Record<string, string> = {
  private_key: "private key", jwt: "JWT", api_key: "API key", bearer_token: "bearer token", secret_value: "secret value",
  url_credentials: "URL credential", email: "email", ip: "IP address", card_number: "card number",
};

export function InvestigationView({ investigation, forgetting, onForget }: {
  investigation: Investigation; forgetting: string | null; onForget: (memoryId: string) => void;
}) {
  if (!isComplete(investigation)) return null;
  const { outcome, mekoWrites, timings, redactions } = investigation.result;
  const redacted = Object.entries(redactions ?? {}).filter(([, n]) => n > 0);
  const inv = outcome.investigation;
  const basis = BASIS[inv.rootCause.basis];

  return (
    <Panel kicker="3 · Investigator" title="Root cause analysis" action={<Chip tone={basis.tone} icon={basis.icon}>{basis.label}</Chip>}>
      <div className="grid gap-5 md:grid-cols-[1fr_auto]">
        <p className="text-[15.5px] font-medium leading-relaxed text-ink">{inv.rootCause.statement}</p>
        {/* A single headline number: a stat tile, not a chart. */}
        <div className="rounded-lg border border-line bg-surface-2 px-4 py-3 md:min-w-36">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">Confidence</div>
          <div className="mt-0.5 font-mono text-[28px] font-semibold leading-none text-ink">{Math.round(inv.confidence * 100)}%</div>
          <div className="mt-1.5 text-[11px] text-ink-3">model-stated</div>
        </div>
      </div>
      <p className="mt-3 text-[13px] leading-relaxed text-ink-2">{inv.summary}</p>

      <Section title="Evidence">
        <ul className="space-y-1.5">
          {inv.evidence.map((e, i) => (
            <li key={i} className="flex gap-3 text-[13px] leading-relaxed">
              <span className="w-24 shrink-0">
                <Chip tone={e.source === "history" ? "good" : "memory"} icon={e.source === "history" ? "✓" : "◆"}><Mono>{e.reference}</Mono></Chip>
              </span>
              <span className="text-ink-2">{e.claim}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Recommended remediation">
        <ol className="list-decimal space-y-1 pl-5 text-[13px] leading-relaxed text-ink marker:text-ink-3">
          {inv.recommendedFix.immediate.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
        {inv.recommendedFix.longTerm.length > 0 && (
          <ul className="mt-2 space-y-1 text-[13px] leading-relaxed text-ink-2">
            {inv.recommendedFix.longTerm.map((s, i) => <li key={i}><span className="mr-2 text-ink-3">Later</span>{s}</li>)}
          </ul>
        )}
      </Section>

      <Section title="Configuration values and where they come from">
        {inv.recommendedFix.configChanges.length === 0 ? (
          <p className="text-[13px] text-ink-3">No concrete configuration values were proposed.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-[13px]">
              <thead className="text-[11px] uppercase tracking-[0.06em] text-ink-3">
                <tr><th className="pb-2 pr-3 font-medium">Setting</th><th className="pb-2 pr-3 font-medium">Value</th><th className="pb-2 pr-3 font-medium">Source</th><th className="pb-2 font-medium">Rationale</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {inv.recommendedFix.configChanges.map((c, i) => {
                  const src = SOURCE[c.source];
                  return (
                    <tr key={i} className="align-top">
                      <td className="py-2 pr-3"><Mono className="text-ink">{c.setting}</Mono></td>
                      <td className="py-2 pr-3"><Mono className="font-semibold text-ink">{c.value}</Mono></td>
                      <td className="py-2 pr-3"><Chip tone={src.tone} icon={src.icon}>{src.label}{c.ref ? ` · ${c.ref}` : ""}</Chip></td>
                      <td className="py-2 text-ink-2">{c.rationale}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {inv.unresolvedQuestions.length > 0 && (
        <Section title="Open questions">
          <ul className="space-y-1 text-[13px] text-ink-2">
            {inv.unresolvedQuestions.map((q, i) => <li key={i} className="flex gap-2"><span className="text-ink-3" style={{ color: "var(--serious)" }} aria-hidden>?</span>{q}</li>)}
          </ul>
        </Section>
      )}

      {inv.alternativeHypotheses.length > 0 && (
        <Section title="Alternatives considered">
          <ul className="space-y-1 text-[13px] text-ink-2">
            {inv.alternativeHypotheses.map((a, i) => <li key={i}><span className="text-ink">{a.hypothesis}</span> — {a.whyLessLikely}</li>)}
          </ul>
        </Section>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4 text-[12px] text-ink-3">
        {outcome.integrityWarnings.length === 0
          ? <Chip tone="good" icon="✓">Traceability checks passed</Chip>
          : <Chip tone="critical" icon="!">{outcome.integrityWarnings.length} traceability warning{outcome.integrityWarnings.length > 1 ? "s" : ""}</Chip>}
        {redacted.length > 0 && (
          <Chip tone="warning" icon="▨">Redacted before analysis: {redacted.map(([kind, n]) => `${n} ${REDACTION_LABEL[kind] ?? kind}${n === 1 ? "" : "s"}`).join(", ")}</Chip>
        )}
        {mekoWrites === null && <Chip icon="○">No Meko writes (OFF)</Chip>}
        {mekoWrites && "error" in mekoWrites && <Chip tone="critical" icon="✕">Meko write failed: {mekoWrites.error}</Chip>}
        {mekoWrites && "conversationId" in mekoWrites && <Chip tone="warning" icon="◌">Stored as unverified finding <Mono>{shortId(mekoWrites.findingMemoryIds[0])}</Mono></Chip>}
        {mekoWrites && "conversationId" in mekoWrites && mekoWrites.findingMemoryIds[0] && (
          <ForgetControl memoryId={mekoWrites.findingMemoryIds[0]} forgotten={investigation.forgotten ?? []} forgetting={forgetting} onForget={onForget} />
        )}
        <span className="ml-auto">{outcome.llm.model} · reasoning {fmtMs(timings.investigatorMs)} · total {fmtMs(timings.totalMs)}</span>
      </div>
      {outcome.integrityWarnings.length > 0 && (
        <ul className="mt-2 space-y-1 text-[12px] text-ink-2">{outcome.integrityWarnings.map((w, i) => <li key={i}>• {w}</li>)}</ul>
      )}
    </Panel>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-5">
      <h3 className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">{title}</h3>
      {children}
    </div>
  );
}
