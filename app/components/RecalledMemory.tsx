"use client";

import { useState } from "react";
import { isComplete, type Investigation, type RetrievedItem } from "./types";
import { Chip, KIND, Mono, Panel, Spinner, fmtMs } from "./ui";

export function RecalledMemory({ investigation, forgetting, onForget }: {
  investigation: Investigation; forgetting: string | null; onForget: (memoryId: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  if (!isComplete(investigation)) return null;
  const k = investigation.knowledge;

  if (investigation.mode === "off" || !k) {
    return (
      <Panel kicker="2 · Knowledge Agent" title="Historical context">
        <div className="flex items-start gap-3 text-[13px] text-ink-2">
          <span className="mt-0.5 text-ink-3" aria-hidden>○</span>
          <p>Meko was OFF. The Knowledge Agent did not run and no historical context was retrieved. This investigation saw only the current incident.</p>
        </div>
      </Panel>
    );
  }

  const inv = investigation.result.outcome.investigation;
  const recallEvents = investigation.events.filter((e) => e.actor === "knowledge-agent");

  return (
    <Panel
      kicker="2 · Knowledge Agent"
      title={`Recalled from Meko — ${k.retrieved.length} item${k.retrieved.length === 1 ? "" : "s"}, ${k.relevant.length} relevant`}
      action={<span className="text-[12px] text-ink-3">{recallEvents.map((e) => `${e.op} ${fmtMs(e.latencyMs)}`).join(" · ")}</span>}
    >
      {k.retrieved.length === 0 ? (
        <p className="text-[13px] text-ink-2">Meko returned no historical context for this incident. Nothing was invented to fill the gap.</p>
      ) : (
        <ul className="space-y-3">
          {ordered(k.retrieved, k.relevant.map((r) => r.ref), showAll).map((item) => {
            const kind = KIND[item.kind];
            const rel = k.relevant.find((r) => r.ref === item.ref);
            const used = inv.historicalContextUsed.find((h) => h.ref === item.ref);
            const configs = inv.recommendedFix.configChanges.filter((c) => c.source === "history" && c.ref === item.ref);
            return (
              <li key={item.ref} className={`rounded-lg border px-4 py-3 ${rel ? "border-line-strong bg-surface-2" : "border-line bg-surface opacity-70"}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <Mono className="font-semibold text-ink">{item.ref}</Mono>
                  <Chip tone={kind.tone} icon={kind.icon}>{kind.label}</Chip>
                  <Chip tone={rel ? "good" : "neutral"} icon={rel ? "✓" : "–"}>{rel ? "Relevant" : "Not relevant"}</Chip>
                  {used && <Chip tone="memory" icon="↳">Used by Investigator</Chip>}
                  {item.kind === "unverified_observation" && item.source.memoryId && (
                    <ForgetControl memoryId={item.source.memoryId} forgotten={investigation.forgotten ?? []} forgetting={forgetting} onForget={onForget} />
                  )}
                </div>
                <p className="mt-2 text-[13px] leading-relaxed text-ink">{item.text}</p>
                <dl className="mt-2.5 grid grid-cols-1 gap-x-6 gap-y-1 text-[12px] sm:grid-cols-[auto_1fr]">
                  <dt className="text-ink-3">Source</dt>
                  <dd className="text-ink-2"><Mono>{item.source.datapack} datapack · {item.source.tool}</Mono></dd>
                  {item.source.memoryId && (<><dt className="text-ink-3">Memory ID</dt><dd className="break-all text-ink-2"><Mono>{item.source.memoryId}</Mono></dd></>)}
                  {item.source.score !== null && (<><dt className="text-ink-3">Meko score</dt><dd className="text-ink-2"><Mono>{item.source.score.toFixed(3)}</Mono></dd></>)}
                  {rel && (<><dt className="text-ink-3">Why relevant</dt><dd className="text-ink-2">{rel.why}</dd></>)}
                  {!rel && rejectedWhy(k, item.ref) && (<><dt className="text-ink-3">Why not relevant</dt><dd className="text-ink-2">{rejectedWhy(k, item.ref)}</dd></>)}
                  {used && (<><dt className="text-ink-3">How it was used</dt><dd className="text-ink-2">{used.how}</dd></>)}
                  {configs.length > 0 && (
                    <>
                      <dt className="text-ink-3">Values taken</dt>
                      <dd className="flex flex-wrap gap-1.5">{configs.map((c) => <Chip key={c.setting} tone="good" icon="✓"><Mono>{c.setting} = {c.value}</Mono></Chip>)}</dd>
                    </>
                  )}
                </dl>
              </li>
            );
          })}
        </ul>
      )}
      {k.retrieved.length > k.relevant.length && (
        <button type="button" onClick={() => setShowAll(!showAll)} className="mt-3 text-[12.5px] font-medium text-ink-2 hover:text-ink">
          {showAll ? "Hide" : "Show"} {k.retrieved.length - k.relevant.length} item{k.retrieved.length - k.relevant.length === 1 ? "" : "s"} judged not relevant
        </button>
      )}
      {k.discardedRefs.length > 0 && <p className="mt-3 text-[12px] text-ink-3">Discarded references the model invented: {k.discardedRefs.join(", ")}</p>}
      <p className="mt-3 text-[12px] leading-relaxed text-ink-3">{k.summary}</p>
    </Panel>
  );
}

/** Unverified observations can be deleted from Meko; the chip appears only after the backend confirmed the delete. */
export function ForgetControl({ memoryId, forgotten, forgetting, onForget }: {
  memoryId: string; forgotten: string[]; forgetting: string | null; onForget: (memoryId: string) => void;
}) {
  if (forgotten.includes(memoryId)) return <Chip icon="⌫">Forgotten from Meko</Chip>;
  return (
    <button type="button"
      onClick={() => onForget(memoryId)}
      disabled={forgetting !== null}
      title="Delete this unverified observation from Meko so future investigations no longer recall it"
      className="ml-auto flex items-center gap-1.5 rounded-md border border-line px-2 py-0.5 text-[11.5px] font-medium text-ink-2 hover:bg-surface-3 hover:text-ink disabled:opacity-50"
    >
      {forgetting === memoryId ? <><Spinner /> Forgetting…</> : "Forget"}
    </button>
  );
}

/** Relevant items first (verified before unverified); not-relevant ones only when expanded. */
function ordered(items: RetrievedItem[], relevantRefs: string[], showAll: boolean): RetrievedItem[] {
  const rank = { verified_resolution: 0, runbook: 1, unverified_observation: 2 };
  const rel = items.filter((i) => relevantRefs.includes(i.ref)).sort((a, b) => rank[a.kind] - rank[b.kind]);
  return showAll ? [...rel, ...items.filter((i) => !relevantRefs.includes(i.ref))] : rel;
}

// Older stored investigations predate `rejected`, so it may be absent.
function rejectedWhy(k: { rejected?: Array<{ ref: string; why: string }> }, ref: string): string | undefined {
  return k.rejected?.find((r) => r.ref === ref)?.why;
}
