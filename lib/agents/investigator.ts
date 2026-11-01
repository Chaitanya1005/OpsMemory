import { z } from "zod";
import type { IncidentInput } from "../../data/scenarios";
import { formatAnalysis, type LogAnalysis } from "../analysis/logs";
import type { LlmProvider, LlmResult } from "../llm";
import type { MekoClient } from "../meko/client";
import type { Datapacks } from "../meko/scopes";
import type { RetrievedItem } from "./knowledge";

export const INVESTIGATOR_AGENT_ID = "opsmemory_investigator";

export const Investigation = z.object({
  summary: z.string(),
  rootCause: z.object({
    statement: z.string(),
    basis: z.enum(["current_evidence", "current_evidence_and_history", "inconclusive"]),
  }),
  evidence: z.array(z.object({
    claim: z.string(),
    source: z.enum(["logs", "history"]),
    /** A log signature id (S1…), a log timestamp, or a history ref (K1…). */
    reference: z.string(),
  })).min(1),
  historicalContextUsed: z.array(z.object({
    ref: z.string(),
    /** Which specific facts from the item were applied, and to which recommendation. */
    how: z.string(),
  })),
  recommendedFix: z.object({
    immediate: z.array(z.string()).min(1),
    longTerm: z.array(z.string()),
    /** Every concrete configuration value, with where it came from. */
    configChanges: z.array(z.object({
      setting: z.string(),
      value: z.string(),
      source: z.enum(["current_evidence", "history", "assumption"]),
      /** History ref (K1…) when source is "history"; otherwise empty. */
      ref: z.string(),
      rationale: z.string(),
    })),
  }),
  appliesWhen: z.string(),
  alternativeHypotheses: z.array(z.object({ hypothesis: z.string(), whyLessLikely: z.string() })),
  confidence: z.number().min(0).max(1),
  unresolvedQuestions: z.array(z.string()),
});
export type Investigation = z.infer<typeof Investigation>;

export interface InvestigationOutcome {
  investigation: Investigation;
  llm: Omit<LlmResult<unknown>, "data">;
  /** Citations of history the agent was never given — removed before the result is used. */
  integrityWarnings: string[];
}

const SYSTEM = `You are the Investigator Agent of an incident-response team.
Produce a root cause analysis from the evidence provided.
Rules:
- Every claim must cite evidence: a log signature (S1, S2…), a log timestamp, or a historical item ref (K1, K2…).
- Historical items are context from past incidents. Use one only if the current evidence matches its conditions, and say how it applies.
- Only items marked VERIFIED were approved by a human. Treat UNVERIFIED items as hints, never as fact.
- Do not present a hypothesis as confirmed. If the evidence is insufficient, set basis to "inconclusive".
- Recommend fixes a human can apply; never claim a fix has been applied.
- List every concrete configuration value you recommend in configChanges and give its source:
  "current_evidence" if the value is stated in the incident, "history" (with its ref) if it comes from a historical item,
  or "assumption" if neither establishes it. If no source establishes a safe value, say so and add it to unresolvedQuestions.
- confidence is your calibrated probability that the root cause statement is correct.`;

const NO_CONTEXT = "No historical context was retrieved.";

/** Same template in both modes; only the historical-context section differs. */
export function buildInvestigatorPrompt(incident: IncidentInput, analysis: LogAnalysis, context: Array<RetrievedItem & { why?: string }>): string {
  const history = context.length
    ? context.map((c) => `${c.ref} [${c.kind === "verified_resolution" ? "VERIFIED resolution" : c.kind === "runbook" ? "RUNBOOK" : "UNVERIFIED observation"}] ${c.text}`).join("\n")
    : NO_CONTEXT;
  return `INCIDENT
Service: ${incident.service}
Severity: ${incident.severity}
Title: ${incident.title}
Description: ${incident.description}

LOG ANALYSIS (signatures)
${formatAnalysis(analysis)}

RAW LOGS
${incident.logs}

HISTORICAL CONTEXT
${history}`;
}

export async function runInvestigator(
  llm: LlmProvider,
  incident: IncidentInput,
  analysis: LogAnalysis,
  context: Array<RetrievedItem & { why?: string }>,
): Promise<InvestigationOutcome> {
  const res = await llm.generateJson({ system: SYSTEM, prompt: buildInvestigatorPrompt(incident, analysis, context), schema: Investigation });
  const { data, ...meta } = res;

  // The model may only cite history it was actually given.
  const allowed = new Set(context.map((c) => c.ref));
  const integrityWarnings: string[] = [];
  const historicalContextUsed = data.historicalContextUsed.filter((h) => {
    if (allowed.has(h.ref)) return true;
    integrityWarnings.push(`removed citation of unknown history ref ${h.ref}`);
    return false;
  });
  const evidence = data.evidence.filter((e) => {
    if (e.source !== "history" || allowed.has(e.reference)) return true;
    integrityWarnings.push(`removed history evidence citing unknown ref ${e.reference}`);
    return false;
  });
  const contextText = new Map(context.map((c) => [c.ref, c.text]));
  const incidentText = `${incident.title} ${incident.description} ${incident.logs}`;
  const configChanges = data.recommendedFix.configChanges.map((c) => {
    if (c.source === "history") {
      const text = contextText.get(c.ref);
      if (!text) {
        integrityWarnings.push(`config ${c.setting}=${c.value} cites unknown ref "${c.ref}"; re-labelled as assumption`);
        return { ...c, source: "assumption" as const, ref: "" };
      }
      const missing = numbersIn(c.value).filter((n) => !numbersIn(text).includes(n));
      if (missing.length) integrityWarnings.push(`config ${c.setting}=${c.value}: ${missing.join(", ")} not found in ${c.ref}`);
    } else if (c.source === "current_evidence") {
      const missing = numbersIn(c.value).filter((n) => !numbersIn(incidentText).includes(n));
      if (missing.length) integrityWarnings.push(`config ${c.setting}=${c.value}: ${missing.join(", ")} not found in the incident evidence`);
    }
    return c;
  });
  const investigation = {
    ...data,
    historicalContextUsed,
    evidence: evidence.length ? evidence : data.evidence.filter((e) => e.source === "logs"),
    recommendedFix: { ...data.recommendedFix, configChanges },
  };
  return { investigation, llm: meta, integrityWarnings };
}

/** Standalone numbers in a string, e.g. "maxReplicas 10 (10 x 8)" -> ["10", "10", "8"]. */
function numbersIn(text: string): string[] {
  // Ignore digits inside timestamps, ids and versions (e.g. 13:10:05, 2026-10-31, v2.14).
  return text.match(/(?<![\w.:-])\d+(\.\d+)?(?![\w.:-])/g) ?? [];
}

/**
 * Writes the investigation into the Investigator's own datapack (Meko ON only):
 * a conversation turn (trace + automatic extraction) and one explicit unverified finding.
 */
export async function recordInvestigation(
  meko: MekoClient,
  datapacks: Datapacks,
  incidentRef: string,
  incident: IncidentInput,
  inv: Investigation,
): Promise<{ conversationId: string; findingMemoryIds: string[] }> {
  const conv = await meko.call("investigator", "conversation_create", {
    agent_id: INVESTIGATOR_AGENT_ID, datapack_id: datapacks.investigator,
    title: `${incidentRef} ${incident.title}`, metadata: JSON.stringify({ incident_ref: incidentRef, service: incident.service }),
  }, z.object({ id: z.string() }).loose());

  await meko.call("investigator", "conversation_add_message", {
    conversation_id: conv.id, agent_id: INVESTIGATOR_AGENT_ID, datapack_id: datapacks.investigator, seed: `${incidentRef}-investigation`,
    input: `Investigate ${incidentRef} on ${incident.service}: ${incident.title}. ${incident.description}`,
    output: `Proposed root cause (unverified, confidence ${inv.confidence.toFixed(2)}): ${inv.rootCause.statement} Recommended fix: ${inv.recommendedFix.immediate.join("; ")}`,
  });

  const finding = await meko.call("investigator", "memory_add", {
    text: `Unverified investigation finding for ${incidentRef} on ${incident.service} (${incident.title}): proposed root cause — ${inv.rootCause.statement} Confidence ${inv.confidence.toFixed(2)}. Not yet approved by an engineer.`,
    agent_id: INVESTIGATOR_AGENT_ID, conversation_id: conv.id, datapack_id: datapacks.investigator,
    metadata: JSON.stringify({ kind: "finding", status: "unverified", incident_ref: incidentRef, service: incident.service }),
  }, z.object({ results: z.array(z.object({ id: z.string() }).loose()) }).loose());

  return { conversationId: conv.id, findingMemoryIds: finding.results.map((r) => r.id) };
}
