import type { StoredEvent } from "../lib/store";
import type { InvestigationRecord } from "../lib/workflow";

const KIND_LABEL = { verified_resolution: "VERIFIED", runbook: "RUNBOOK", unverified_observation: "UNVERIFIED" } as const;

export function printInvestigation(rec: InvestigationRecord): void {
  const inv = rec.result.outcome.investigation;
  console.log(`\n── ${rec.id}  ${rec.incidentRef}  Meko ${rec.mode.toUpperCase()}  [${rec.status}]`);
  console.log(`   ${rec.incident.service} — ${rec.incident.title}`);

  if (rec.knowledge) {
    const k = rec.knowledge;
    console.log(`\n   Knowledge Agent: ${k.retrieved.length} item(s) retrieved from Meko, ${k.relevant.length} judged relevant`);
    for (const item of k.retrieved) {
      const rel = k.relevant.find((r) => r.ref === item.ref);
      const id = item.source.memoryId ?? item.source.documentId ?? "";
      console.log(`     ${rel ? "✔" : "·"} ${item.ref} ${KIND_LABEL[item.kind].padEnd(10)} ${item.source.datapack}/${item.source.tool} ${id.slice(0, 8)}  ${truncate(item.text, 110)}`);
      if (rel) console.log(`         why: ${truncate(rel.why, 150)}`);
    }
    if (k.discardedRefs.length) console.log(`     discarded invented refs: ${k.discardedRefs.join(", ")}`);
    console.log(`     summary: ${truncate(k.summary, 200)}`);
  } else {
    console.log("\n   Knowledge Agent: skipped (Meko OFF) — no historical context retrieved");
  }

  console.log(`\n   Root cause (${inv.rootCause.basis}, confidence ${inv.confidence.toFixed(2)}):\n     ${inv.rootCause.statement}`);
  console.log("   Evidence:");
  for (const e of inv.evidence) console.log(`     - [${e.source}:${e.reference}] ${truncate(e.claim, 140)}`);
  console.log(`   History used: ${inv.historicalContextUsed.length ? inv.historicalContextUsed.map((h) => `${h.ref} (${truncate(h.how, 90)})`).join("; ") : "none"}`);
  console.log("   Recommended fix:");
  for (const s of inv.recommendedFix.immediate) console.log(`     • ${s}`);
  for (const s of inv.recommendedFix.longTerm) console.log(`     ◦ (long-term) ${s}`);
  if (inv.recommendedFix.configChanges.length) console.log("   Config changes:");
  for (const c of inv.recommendedFix.configChanges) console.log(`     ⚙ ${c.setting} = ${c.value}  [${c.source}${c.ref ? `:${c.ref}` : ""}] ${truncate(c.rationale, 100)}`);
  if (inv.unresolvedQuestions.length) console.log(`   Unresolved: ${inv.unresolvedQuestions.map((q) => truncate(q, 100)).join(" | ")}`);
  if (inv.alternativeHypotheses.length) console.log(`   Alternatives: ${inv.alternativeHypotheses.map((a) => a.hypothesis).join(" | ")}`);
  if (rec.result.outcome.integrityWarnings.length) console.log(`   Integrity warnings: ${rec.result.outcome.integrityWarnings.join("; ")}`);

  const w = rec.result.mekoWrites;
  console.log(`\n   Meko writes: ${w === null ? "none (Meko OFF)" : "error" in w ? `FAILED — ${w.error}` : `conversation ${w.conversationId.slice(0, 8)}, finding memory ${w.findingMemoryIds.map((x) => x.slice(0, 8)).join(",")}`}`);
  const t = rec.result.timings;
  console.log(`   ${rec.mekoCalls} Meko call(s) | model ${rec.result.outcome.llm.model} | knowledge ${t.knowledgeMs}ms, investigator ${t.investigatorMs}ms, total ${t.totalMs}ms`);
}

export function printEvents(events: StoredEvent[]): void {
  for (const e of events) {
    const err = e.error as { code?: string; message?: string } | null;
    console.log(`  ${e.ts.slice(11, 23)} ${e.ok ? "ok  " : "FAIL"} ${e.actor.padEnd(15)} ${e.op.padEnd(28)} ${String(e.latencyMs).padStart(5)}ms${e.datapackId ? ` dp=${e.datapackId.slice(0, 8)}` : ""}${err ? `  ${err.code}: ${truncate(err.message ?? "", 80)}` : ""}`);
  }
}

export const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
