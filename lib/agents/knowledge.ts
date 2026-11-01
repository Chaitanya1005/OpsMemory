import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { IncidentInput } from "../../data/scenarios";
import { formatAnalysis, type LogAnalysis } from "../analysis/logs";
import type { LlmProvider } from "../llm";
import type { MekoClient } from "../meko/client";
import type { DatapackRole, Datapacks } from "../meko/scopes";

export const KNOWLEDGE_AGENT_ID = "opsmemory_knowledge_agent";

export type RetrievedKind = "verified_resolution" | "runbook" | "unverified_observation";

/** One item exactly as Meko returned it. `ref` is how agents cite it. */
export interface RetrievedItem {
  ref: string;
  kind: RetrievedKind;
  text: string;
  source: { datapack: DatapackRole; tool: string; memoryId: string | null; documentId: string | null; score: number | null; createdAt: string | null };
}

export interface KnowledgeBrief {
  query: string;
  retrieved: RetrievedItem[];
  relevant: Array<RetrievedItem & { why: string }>;
  /** Items judged not applicable, with the model's reason (kept for transparency). */
  rejected: Array<{ ref: string; why: string }>;
  summary: string;
  /** Refs the model cited that Meko never returned — discarded, never passed on. */
  discardedRefs: string[];
}

const KbResults = z.object({
  results: z.array(z.object({
    id: z.string(),
    chunk_text: z.string(),
    document_id: z.string().nullish(),
    metadata_filters: z.record(z.string(), z.unknown()).nullish(),
    rerank_score: z.number().nullish(),
  }).loose()),
}).loose();

const MemoryResults = z.object({
  results: z.array(z.object({
    id: z.string(),
    memory: z.string(),
    score: z.number().nullish(),
    metadata: z.record(z.string(), z.unknown()).nullish(),
    created_at: z.string().nullish(),
  }).loose()),
}).loose();

const Assessment = z.object({
  assessments: z.array(z.object({ ref: z.string(), relevant: z.boolean(), why: z.string() })),
  summary: z.string(),
});

const SYSTEM = `You are the Knowledge Agent of an incident-response team.
You receive a new incident and items retrieved from the team's institutional memory.
Decide, for each item, whether it is genuinely relevant to diagnosing or fixing THIS incident.
Rules:
- Judge only the items given. Never invent incidents, resolutions or facts.
- "verified_resolution" items were approved by a human engineer. "unverified_observation" items are earlier agent observations that no human has confirmed. "runbook" items are reference documents.
- An item is relevant only if its conditions match the new incident's evidence. Similar wording alone is not enough.
- Judge applicability by the failure mechanism, the item's stated "Applies when" conditions and shared infrastructure (for example the same database cluster), not by the service name. A verified resolution recorded for a different service is relevant when the same conditions hold, and its constraints may apply directly.
- Explain each judgement in one sentence citing the matching evidence.`;

/**
 * Retrieves historical context from Meko, then asks the model which items apply.
 * Called only when Meko is ON.
 */
export async function runKnowledgeAgent(
  deps: { meko: MekoClient; llm: LlmProvider; datapacks: Datapacks },
  incident: IncidentInput,
  analysis: LogAnalysis,
): Promise<KnowledgeBrief> {
  const trace = randomUUID().replaceAll("-", "");
  const query = buildQuery(incident, analysis);

  // Verified resolutions (promoted memories) and runbooks live in the knowledge datapack's KB.
  const kb = await deps.meko.call("knowledge-agent", "knowledgebase_search", {
    query, conversation_id: trace, datapack_id: deps.datapacks.knowledge, agent_id: KNOWLEDGE_AGENT_ID, limit: 8,
  }, KbResults);
  // Earlier unverified observations live in the Investigator's datapack.
  const mem = await deps.meko.call("knowledge-agent", "memory_search", {
    query, conversation_id: trace, datapack_id: deps.datapacks.investigator, agent_id: KNOWLEDGE_AGENT_ID, limit: 6,
  }, MemoryResults);

  const retrieved: RetrievedItem[] = [];
  for (const r of kb.results) {
    const promoted = r.metadata_filters?.source === "memory";
    retrieved.push({
      ref: `K${retrieved.length + 1}`,
      kind: promoted ? "verified_resolution" : "runbook",
      text: r.chunk_text,
      source: {
        datapack: "knowledge", tool: "knowledgebase_search",
        memoryId: promoted ? String(r.metadata_filters?.memory_id ?? "") || null : null,
        documentId: r.document_id ?? null, score: r.rerank_score ?? null, createdAt: null,
      },
    });
  }
  for (const r of mem.results) {
    retrieved.push({
      ref: `K${retrieved.length + 1}`,
      kind: "unverified_observation",
      text: r.memory,
      source: { datapack: "investigator", tool: "memory_search", memoryId: r.id, documentId: null, score: r.score ?? null, createdAt: r.created_at ?? null },
    });
  }

  if (retrieved.length === 0) {
    return { query, retrieved, relevant: [], rejected: [], summary: "Meko returned no historical context for this incident.", discardedRefs: [] };
  }

  const items = retrieved.map((i) => `${i.ref} [${i.kind}] ${i.text}`).join("\n");
  const res = await deps.llm.generateJson({
    system: SYSTEM,
    prompt: `NEW INCIDENT\nService: ${incident.service}\nTitle: ${incident.title}\nDescription: ${incident.description}\n\nLOG ANALYSIS\n${formatAnalysis(analysis)}\n\nRETRIEVED ITEMS\n${items}\n\nAssess every item by its ref.`,
    schema: Assessment,
  });

  const byRef = new Map(retrieved.map((i) => [i.ref, i]));
  const discardedRefs = res.data.assessments.map((a) => a.ref).filter((ref) => !byRef.has(ref));
  const relevant = res.data.assessments
    .filter((a) => a.relevant && byRef.has(a.ref))
    .map((a) => ({ ...byRef.get(a.ref)!, why: a.why }));
  const rejected = res.data.assessments.filter((a) => !a.relevant && byRef.has(a.ref)).map((a) => ({ ref: a.ref, why: a.why }));
  return { query, retrieved, relevant, rejected, summary: res.data.summary, discardedRefs };
}

/** Deterministic recall query: service, symptoms and the strongest error signatures. */
function buildQuery(incident: IncidentInput, analysis: LogAnalysis): string {
  const sigs = analysis.signatures.filter((s) => s.level === "ERROR" || s.level === "WARN").slice(0, 3).map((s) => s.pattern);
  return `${incident.service}: ${incident.title}. ${incident.description} Errors: ${sigs.join("; ")}`.slice(0, 600);
}
