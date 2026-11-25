import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { IncidentInput } from "../data/scenarios";
import { runKnowledgeAgent, type KnowledgeBrief } from "./agents/knowledge";
import { recordInvestigation, runInvestigator, type InvestigationOutcome } from "./agents/investigator";
import { analyzeLogs, type LogAnalysis } from "./analysis/logs";
import { APPROVALS_AGENT_ID, MemoryAdded, approveInvestigation, type ApprovalDecision, type ApprovalEdits } from "./approval";
import type { AppConfig } from "./config";
import { getLlm, type LlmProvider } from "./llm";
import { MekoClient, MekoError } from "./meko/client";
import { MekoEventLog } from "./meko/events";
import { resolveDatapacks, scopePolicy, type Datapacks } from "./meko/scopes";
import { redact, redactFields, type Redacted } from "./redact";
import { Store, type InvestigationRow } from "./store";

export { ApprovalFailure, type ApprovalDecision, type ApprovalStage, type ApprovalStatus } from "./approval";

export type MekoMode = "on" | "off";

export interface InvestigationResult {
  analysis: LogAnalysis;
  outcome: InvestigationOutcome;
  /** What the Investigator wrote to Meko (ON only), or the write error. */
  mekoWrites: { conversationId: string; findingMemoryIds: string[] } | { error: string } | null;
  timings: { knowledgeMs: number; investigatorMs: number; totalMs: number };
  /** Secrets and personal data replaced in the incident before anything used it (absent on older records). */
  redactions?: Redacted["counts"];
}

export interface InvestigationRecord {
  id: string;
  incidentRef: string;
  mode: MekoMode;
  status: InvestigationRow["status"];
  incident: IncidentInput;
  knowledge: KnowledgeBrief | null;
  result: InvestigationResult;
  mekoCalls: number;
}

export interface RejectionDecision {
  status: "rejected";
  rejectedAt: string;
  reason: string;
  observationMemoryIds: string[];
}

/**
 * The OpsMemory workflow. Sequential by design:
 *   analyse logs → (ON) Knowledge Agent recall → Investigator → (ON) record finding
 *   → human approve/reject → (approve) store + promote into shared knowledge.
 * Meko ON and OFF share the same LLM instance, prompt template and inputs.
 */
export class OpsMemory {
  readonly store: Store;
  private llmProvider: LlmProvider | null;
  private mekoClient: MekoClient | null = null;
  private datapacks: Datapacks | null = null;
  private currentInvestigation: string | null = null;
  private readonly log = new MekoEventLog();

  constructor(private readonly config: AppConfig, llm?: LlmProvider) {
    this.store = new Store(config.dbPath);
    this.llmProvider = llm ?? null;
    this.log.subscribe((e) => this.store.insertEvent(e, this.currentInvestigation));
  }

  /** Created on first use, so a missing GEMINI_API_KEY only fails the requests that need the model. */
  get llm(): LlmProvider {
    this.llmProvider ??= getLlm();
    return this.llmProvider;
  }

  /** Connects lazily: a Meko OFF investigation never opens a connection. */
  async meko(): Promise<{ meko: MekoClient; datapacks: Datapacks }> {
    if (!this.mekoClient) {
      this.mekoClient = await MekoClient.connect({ apiKey: this.config.mekoApiKey, log: this.log, authorize: scopePolicy(() => this.datapacks) });
      this.datapacks = await resolveDatapacks(this.mekoClient, this.config.datapackPrefix, { create: this.config.createDatapacks });
    }
    return { meko: this.mekoClient, datapacks: this.datapacks! };
  }

  async investigate(input: IncidentInput, mode: MekoMode, opts: { incidentRef?: string; sampleId?: string | null } = {}): Promise<InvestigationRecord> {
    // Only the incident fields reach agents and storage (scenario fixtures such as approvalEdit never do),
    // and only after secrets and personal data are redacted: the raw text is never stored or sent anywhere.
    const { value: incident, counts: redactions } = redactFields<IncidentInput>({
      title: input.title, service: input.service, severity: input.severity, description: input.description, logs: input.logs,
    });
    const id = `inv_${randomBytes(4).toString("hex")}`;
    const incidentRef = opts.incidentRef ?? newIncidentRef();
    const started = Date.now();
    this.currentInvestigation = id;
    try {
      const analysis = analyzeLogs(incident.logs);

      let knowledge: KnowledgeBrief | null = null;
      let knowledgeMs = 0;
      if (mode === "on") {
        // No fallback: if recall fails, the investigation fails visibly.
        const { meko, datapacks } = await this.meko();
        const t = Date.now();
        knowledge = await runKnowledgeAgent({ meko, llm: this.llm, datapacks }, incident, analysis);
        knowledgeMs = Date.now() - t;
      }

      const t = Date.now();
      const outcome = await runInvestigator(this.llm, incident, analysis, knowledge?.relevant ?? []);
      const investigatorMs = Date.now() - t;

      let mekoWrites: InvestigationResult["mekoWrites"] = null;
      if (mode === "on") {
        const { meko, datapacks } = await this.meko();
        try {
          mekoWrites = await recordInvestigation(meko, datapacks, incidentRef, incident, outcome.investigation);
        } catch (err) {
          mekoWrites = { error: err instanceof MekoError ? `${err.op} ${err.code}: ${err.message}` : String(err) };
        }
      }

      const result: InvestigationResult = { analysis, outcome, mekoWrites, timings: { knowledgeMs, investigatorMs, totalMs: Date.now() - started }, redactions };
      this.store.insertInvestigation({
        id, incidentRef, mode, status: "proposed", incident, knowledge, result, decision: null, createdAt: new Date().toISOString(), decidedAt: null, sampleId: opts.sampleId ?? null,
      });
      return { id, incidentRef, mode, status: "proposed", incident, knowledge, result, mekoCalls: this.store.events(id).length };
    } catch (err) {
      this.store.insertInvestigation({
        id, incidentRef, mode, status: "failed", incident, knowledge: null,
        result: { error: err instanceof Error ? err.message : String(err) }, decision: null, createdAt: new Date().toISOString(), decidedAt: null, sampleId: opts.sampleId ?? null,
      });
      throw err;
    } finally {
      this.currentInvestigation = null;
    }
  }

  /**
   * Human approval: stores, promotes and verifies the resolution (see lib/approval.ts).
   * Only a successful read-back sets `approved`; anything else throws ApprovalFailure.
   */
  approve(id: string, edits: ApprovalEdits = {}): Promise<ApprovalDecision> {
    return approveInvestigation({ store: this.store, connect: () => this.meko(), track: (i) => (this.currentInvestigation = i) }, id, edits);
  }

  /**
   * Forget an unverified observation: the Investigator's own finding for this
   * investigation, or an unverified item it recalled. Deletes it from the
   * investigator datapack and confirms with a read-back that it is gone.
   * Verified (promoted) knowledge cannot be forgotten through Meko's API (FRICTION_LOG #14).
   */
  async forget(id: string, memoryId: string): Promise<{ memoryId: string; forgottenAt: string }> {
    const row = this.store.getInvestigation(id);
    if (!row) throw new Error(`No investigation ${id}`);
    if (row.mode !== "on" || !row.result || !("outcome" in (row.result as object))) throw new Error(`Investigation ${id} has no Meko observations to forget`);
    const writes = (row.result as InvestigationResult).mekoWrites;
    const own = writes && "findingMemoryIds" in writes ? writes.findingMemoryIds : [];
    const recalled = ((row.knowledge as KnowledgeBrief | null)?.retrieved ?? [])
      .filter((i) => i.kind === "unverified_observation" && i.source.datapack === "investigator" && i.source.memoryId)
      .map((i) => i.source.memoryId!);
    if (![...own, ...recalled].includes(memoryId)) {
      throw new Error(`Memory ${memoryId} is not an unverified observation of investigation ${id}; verified knowledge cannot be forgotten here`);
    }

    this.currentInvestigation = id;
    try {
      const { meko, datapacks } = await this.meko();
      const args = { memory_id: memoryId, conversation_id: randomBytes(16).toString("hex"), agent_id: APPROVALS_AGENT_ID, datapack_id: datapacks.investigator };
      try {
        await meko.call("engineer", "memory_delete_by_id", args);
      } catch (err) {
        // Already gone (e.g. a repeated click) is fine; the read-back below decides.
        if (!(err instanceof MekoError && err.code === "not_found")) throw err;
      }
      // Read back: success means Meko no longer has it.
      try {
        await meko.call("engineer", "memory_get_by_id", args);
      } catch (err) {
        if (err instanceof MekoError && err.code === "not_found") return { memoryId, forgottenAt: new Date().toISOString() };
        throw err;
      }
      throw new MekoError("still_present", `Meko still returns memory ${memoryId} after memory_delete_by_id`, "memory_get_by_id");
    } finally {
      this.currentInvestigation = null;
    }
  }

  /** Human rejection. With Meko ON, the rejected hypothesis is kept as an unverified observation. */
  async reject(id: string, rawReason: string): Promise<RejectionDecision> {
    const row = this.requireProposed(id);
    // The reason is stored in Meko as an observation, so it is redacted like any submitted text.
    const reason = redact(rawReason).text;
    const rejectedAt = new Date().toISOString();
    let observationMemoryIds: string[] = [];
    if (row.mode === "on") {
      this.currentInvestigation = id;
      try {
        const { meko, datapacks } = await this.meko();
        const writes = (row.result as InvestigationResult).mekoWrites;
        const conversationId = writes && "conversationId" in writes
          ? writes.conversationId
          : (await meko.call("engineer", "conversation_create", {
              agent_id: APPROVALS_AGENT_ID, datapack_id: datapacks.investigator, title: `Rejection ${row.incidentRef}`,
            }, z.object({ id: z.string() }).loose())).id;
        const inv = (row.result as InvestigationResult).outcome.investigation;
        const added = await meko.call("engineer", "memory_add", {
          text: `Engineer rejected the proposed root cause for ${row.incidentRef} on ${(row.incident as IncidentInput).service}: "${inv.rootCause.statement}". Reason: ${reason}`,
          agent_id: APPROVALS_AGENT_ID, conversation_id: conversationId, datapack_id: datapacks.investigator,
          metadata: JSON.stringify({ kind: "rejection", incident_ref: row.incidentRef }),
        }, MemoryAdded);
        observationMemoryIds = added.results.map((r) => r.id);
      } finally {
        this.currentInvestigation = null;
      }
    }
    const decision: RejectionDecision = { status: "rejected", rejectedAt, reason, observationMemoryIds };
    this.store.updateDecision(id, "rejected", decision, rejectedAt);
    return decision;
  }

  async close(): Promise<void> {
    await this.mekoClient?.close();
    this.store.close();
  }

  private requireProposed(id: string): InvestigationRow {
    const row = this.store.getInvestigation(id);
    if (!row) throw new Error(`No investigation ${id}`);
    if (row.status !== "proposed") throw new Error(`Investigation ${id} is ${row.status}, not awaiting a decision`);
    return row;
  }
}

function newIncidentRef(): string {
  const d = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `INC-${d}-${randomBytes(2).toString("hex").toUpperCase()}`;
}
