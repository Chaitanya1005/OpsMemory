import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { IncidentInput } from "../data/scenarios";
import { runKnowledgeAgent, type KnowledgeBrief } from "./agents/knowledge";
import { recordInvestigation, runInvestigator, type Investigation, type InvestigationOutcome } from "./agents/investigator";
import { analyzeLogs, type LogAnalysis } from "./analysis/logs";
import type { AppConfig } from "./config";
import { getLlm, type LlmProvider } from "./llm";
import { MekoClient, MekoError } from "./meko/client";
import { MekoEventLog } from "./meko/events";
import { resolveDatapacks, scopePolicy, type Datapacks } from "./meko/scopes";
import { Store, type InvestigationRow } from "./store";

export type MekoMode = "on" | "off";
const APPROVALS_AGENT_ID = "opsmemory_approvals";

export interface InvestigationResult {
  analysis: LogAnalysis;
  outcome: InvestigationOutcome;
  /** What the Investigator wrote to Meko (ON only), or the write error. */
  mekoWrites: { conversationId: string; findingMemoryIds: string[] } | { error: string } | null;
  timings: { knowledgeMs: number; investigatorMs: number; totalMs: number };
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

export type ApprovalStatus = "approving" | "approved" | "approval_failed" | "promotion_unverified" | "needs_reconciliation";
export type ApprovalStage = "connect" | "conversation_create" | "reconcile" | "memory_add" | "memory_promote" | "read_back";

/**
 * Persisted after every confirmed Meko step, so a retry resumes from the last
 * confirmed step instead of writing again. `status` is the real outcome, not the click.
 */
export interface ApprovalDecision {
  status: ApprovalStatus;
  approvedAt: string;
  rootCause: string;
  fix: string;
  notes: string | null;
  edited: boolean;
  /** Approval conversation in the knowledge datapack; memories written in it carry its id. */
  conversationId: string | null;
  storedText: string[];
  memoryIds: string[];
  promotion: { inserted: string[]; updated: string[]; notFound: string[] };
  /** True once Meko confirmed (in the promote response or a listing) that every memory id is promoted. */
  promotionConfirmed: boolean;
  /** True only if knowledgebase_search returned the promoted memory afterwards. */
  retrievableAfterPromotion: boolean;
  verifiedAt: string | null;
  attempts: number;
  attemptStartedAt: string;
  /** The step that stopped the last attempt. `uncertain` means Meko may have applied it anyway. */
  failure: { stage: ApprovalStage; code: string; message: string; uncertain: boolean } | null;
}

/** Thrown when an approval did not reach `approved`; carries the persisted decision. */
export class ApprovalFailure extends Error {
  constructor(readonly decision: ApprovalDecision) {
    const f = decision.failure;
    super(f ? `Approval ${decision.status.replaceAll("_", " ")} at ${f.stage}: ${f.message}` : `Approval ${decision.status}`);
    this.name = "ApprovalFailure";
  }
}

export interface RejectionDecision {
  status: "rejected";
  rejectedAt: string;
  reason: string;
  observationMemoryIds: string[];
}

const MemoryAdded = z.object({ results: z.array(z.object({ id: z.string(), memory: z.string().optional() }).loose()) }).loose();
const Promoted = z.object({
  inserted_ids: z.array(z.string()).default([]),
  updated_ids: z.array(z.string()).default([]),
  not_found_ids: z.array(z.string()).default([]),
}).loose();
const MemoryRow = z.object({ id: z.string(), conversation_id: z.string().nullish() }).loose();
const PersonalListing = z.object({ memories: z.array(MemoryRow).default([]), total: z.number() }).loose();
const PromotedListing = z.object({ promoted_memories: z.array(MemoryRow).default([]), total: z.number() }).loose();
/** Statuses an approval may (re)start from. `approving` only when stale, i.e. the process died mid-approval. */
const RESUMABLE: InvestigationRow["status"][] = ["proposed", "approval_failed", "promotion_unverified", "needs_reconciliation"];
const STALE_APPROVING_MS = 5 * 60_000;
const KbHits = z.object({ results: z.array(z.object({ metadata_filters: z.record(z.string(), z.unknown()).nullish() }).loose()) }).loose();

/**
 * The OpsMemory workflow. Sequential by design:
 *   analyse logs → (ON) Knowledge Agent recall → Investigator → (ON) record finding
 *   → human approve/reject → (approve) store + promote into shared knowledge.
 * Meko ON and OFF share the same LLM instance, prompt template and inputs.
 */
export class OpsMemory {
  readonly store: Store;
  readonly llm: LlmProvider;
  private mekoClient: MekoClient | null = null;
  private datapacks: Datapacks | null = null;
  private currentInvestigation: string | null = null;
  private readonly log = new MekoEventLog();

  constructor(private readonly config: AppConfig, llm?: LlmProvider) {
    this.store = new Store(config.dbPath);
    this.llm = llm ?? getLlm();
    this.log.subscribe((e) => this.store.insertEvent(e, this.currentInvestigation));
  }

  /** Connects lazily: a Meko OFF investigation never opens a connection. */
  async meko(): Promise<{ meko: MekoClient; datapacks: Datapacks }> {
    if (!this.mekoClient) {
      this.mekoClient = await MekoClient.connect({ apiKey: this.config.mekoApiKey, log: this.log, authorize: scopePolicy(() => this.datapacks) });
      this.datapacks = await resolveDatapacks(this.mekoClient, this.config.datapackPrefix);
    }
    return { meko: this.mekoClient, datapacks: this.datapacks! };
  }

  async investigate(input: IncidentInput, mode: MekoMode, opts: { incidentRef?: string } = {}): Promise<InvestigationRecord> {
    // Only the incident fields reach agents and storage (scenario fixtures such as approvalEdit never do).
    const incident: IncidentInput = { title: input.title, service: input.service, severity: input.severity, description: input.description, logs: input.logs };
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

      const result: InvestigationResult = { analysis, outcome, mekoWrites, timings: { knowledgeMs, investigatorMs, totalMs: Date.now() - started } };
      this.store.insertInvestigation({
        id, incidentRef, mode, status: "proposed", incident, knowledge, result, decision: null, createdAt: new Date().toISOString(), decidedAt: null,
      });
      return { id, incidentRef, mode, status: "proposed", incident, knowledge, result, mekoCalls: this.store.events(id).length };
    } catch (err) {
      this.store.insertInvestigation({
        id, incidentRef, mode, status: "failed", incident, knowledge: null,
        result: { error: err instanceof Error ? err.message : String(err) }, decision: null, createdAt: new Date().toISOString(), decidedAt: null,
      });
      throw err;
    } finally {
      this.currentInvestigation = null;
    }
  }

  /**
   * Human approval. Stores the (optionally edited) resolution in the knowledge
   * datapack, promotes it into shared knowledge, then verifies it is retrievable.
   *
   * Meko has no transactions, so this is a resumable sequence: each confirmed
   * step is persisted, a failed step is recorded with its stage, and a retry
   * resumes after the last confirmed step. Writes whose outcome is unknown are
   * reconciled against Meko's listings before anything is written again.
   * Only a successful read-back sets `approved`; anything else throws ApprovalFailure.
   */
  async approve(id: string, edits: { rootCause?: string; fix?: string; notes?: string } = {}): Promise<ApprovalDecision> {
    const row = this.store.getInvestigation(id);
    if (!row) throw new Error(`No investigation ${id}`);
    if (row.mode !== "on") throw new Error("Meko was OFF for this investigation, so its resolution cannot be promoted into Meko.");
    // A repeated approval of a verified resolution is a no-op, never a second write.
    if (row.status === "approved") return row.decision as ApprovalDecision;
    const prior = row.decision as ApprovalDecision | null;
    const stale = row.status === "approving" && prior !== null && Date.now() - Date.parse(prior.attemptStartedAt) > STALE_APPROVING_MS;
    if (!RESUMABLE.includes(row.status) && !stale) {
      throw new Error(row.status === "approving" ? `Investigation ${id} is already being approved` : `Investigation ${id} is ${row.status}, not awaiting approval`);
    }

    const incident = row.incident as IncidentInput;
    const inv = (row.result as InvestigationResult).outcome.investigation;
    const now = new Date().toISOString();
    // A retry keeps the original content: memories may already hold it, and edits must not fork it.
    let d: ApprovalDecision = prior
      ? { ...prior, status: "approving", attempts: prior.attempts + 1, attemptStartedAt: now, failure: null }
      : {
          status: "approving", approvedAt: now, rootCause: edits.rootCause ?? inv.rootCause.statement, fix: edits.fix ?? inv.recommendedFix.immediate.join("; "),
          notes: edits.notes ?? null, edited: Boolean(edits.rootCause || edits.fix), conversationId: null, storedText: [], memoryIds: [],
          promotion: { inserted: [], updated: [], notFound: [] }, promotionConfirmed: false, retrievableAfterPromotion: false,
          verifiedAt: null, attempts: 1, attemptStartedAt: now, failure: null,
        };
    if (!this.store.claimApproval(id, stale ? [...RESUMABLE, "approving"] : RESUMABLE, d)) throw new Error(`Investigation ${id} is already being approved`);
    // Anything other than a clean, definitive failure of the previous attempt may have left writes we have not recorded.
    const mayHaveUnrecordedWrites = prior !== null && (prior.status === "needs_reconciliation" || prior.status === "approving");

    const save = (patch: Partial<ApprovalDecision>) => {
      d = { ...d, ...patch };
      this.store.updateDecision(id, d.status, d, d.status === "approved" ? d.verifiedAt : null);
    };
    const stop = (stage: ApprovalStage, code: string, message: string, uncertain: boolean): never => {
      save({ status: uncertain ? "needs_reconciliation" : stage === "read_back" ? "promotion_unverified" : "approval_failed", failure: { stage, code, message, uncertain } });
      throw new ApprovalFailure(d);
    };
    const step = async <T>(stage: ApprovalStage, fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        const code = err instanceof MekoError ? err.code : "unexpected";
        const isWrite = stage === "conversation_create" || stage === "memory_add" || stage === "memory_promote";
        // A conversation is harmless to orphan, so only memory writes leave the approval uncertain.
        const uncertain = (code === "uncertain_outcome" || (!(err instanceof MekoError) && isWrite)) && stage !== "conversation_create";
        return stop(stage, code, err instanceof Error ? err.message : String(err), uncertain);
      }
    };

    this.currentInvestigation = id;
    try {
      const { meko, datapacks } = await step("connect", () => this.meko());

      if (!d.conversationId) {
        const conv = await step("conversation_create", () => meko.call("engineer", "conversation_create", {
          agent_id: APPROVALS_AGENT_ID, datapack_id: datapacks.knowledge, title: `Approval ${row.incidentRef}`,
          metadata: JSON.stringify({ incident_ref: row.incidentRef, investigation_id: id }),
        }, z.object({ id: z.string() }).loose()));
        save({ conversationId: conv.id });
      }
      const conversationId = d.conversationId!;

      // Before writing again, find out what the earlier attempt actually left in Meko.
      if (mayHaveUnrecordedWrites || (d.memoryIds.length > 0 && !d.promotionConfirmed && prior !== null)) {
        const found = await step("reconcile", () => this.findApprovalMemories(meko, datapacks.knowledge, conversationId));
        const known = new Set(d.memoryIds);
        const promoted = found.promoted.filter((m) => known.size === 0 || known.has(m));
        const unpromoted = found.unpromoted.filter((m) => known.size === 0 || known.has(m));
        if (promoted.length && !unpromoted.length) save({ memoryIds: [...new Set([...d.memoryIds, ...promoted])], promotionConfirmed: true });
        else if (unpromoted.length) save({ memoryIds: [...new Set([...d.memoryIds, ...unpromoted, ...promoted])], promotionConfirmed: false });
        else if (d.memoryIds.length === 0 && !found.complete) {
          stop("reconcile", "inconclusive", "Meko's listings are larger than one page, so an earlier memory_add cannot be ruled out; check the knowledge datapack in the Meko portal", true);
        } else if (d.memoryIds.length > 0) {
          stop("reconcile", "missing", `Recorded memory ${d.memoryIds.join(", ")} is in neither the personal nor the promoted listing`, true);
        }
      }

      if (d.memoryIds.length === 0) {
        // Approval facts go in the text itself: memory metadata is dropped on promotion (FRICTION_LOG #6).
        const text = resolutionText(row.incidentRef, incident, d.rootCause, d.fix, inv, d.approvedAt, d.notes ?? undefined);
        const added = await step("memory_add", () => meko.call("engineer", "memory_add", {
          text, agent_id: APPROVALS_AGENT_ID, conversation_id: conversationId, datapack_id: datapacks.knowledge,
          metadata: JSON.stringify({ kind: "resolution", status: "approved", incident_ref: row.incidentRef, approved_at: d.approvedAt }),
        }, MemoryAdded));
        if (added.results.length === 0) stop("memory_add", "not_stored", "memory_add returned no memory ids", true);
        save({ memoryIds: added.results.map((r) => r.id), storedText: added.results.map((r) => r.memory ?? "") });
      }

      if (!d.promotionConfirmed) {
        const promoted = await step("memory_promote", () => meko.call("engineer", "memory_promote", {
          conversation_id: conversationId, memory_ids: d.memoryIds, agent_id: APPROVALS_AGENT_ID, datapack_id: datapacks.knowledge,
        }, Promoted));
        const promotion = { inserted: promoted.inserted_ids, updated: promoted.updated_ids, notFound: promoted.not_found_ids };
        const acknowledged = new Set([...promotion.inserted, ...promotion.updated]);
        save({ promotion });
        if (!d.memoryIds.every((m) => acknowledged.has(m))) {
          const missing = d.memoryIds.filter((m) => !acknowledged.has(m));
          if (missing.every((m) => promotion.notFound.includes(m))) stop("memory_promote", "not_found", `Meko reported ${missing.join(", ")} as not found`, false);
          stop("memory_promote", "unacknowledged", `memory_promote did not acknowledge ${missing.join(", ")}`, true);
        }
        save({ promotionConfirmed: true });
      }

      // Read back through the same path the Knowledge Agent uses.
      const hits = await step("read_back", () => meko.call("engineer", "knowledgebase_search", {
        query: `${row.incidentRef} ${incident.service} ${d.rootCause}`.slice(0, 500), conversation_id: conversationId.replaceAll("-", ""),
        datapack_id: datapacks.knowledge, agent_id: APPROVALS_AGENT_ID, limit: 10,
      }, KbHits));
      const retrievable = hits.results.some((h) => d.memoryIds.includes(String(h.metadata_filters?.memory_id ?? "")));
      if (!retrievable) stop("read_back", "not_retrievable", "Promotion was acknowledged, but knowledgebase_search did not return the promoted memory", false);

      save({ status: "approved", retrievableAfterPromotion: true, verifiedAt: new Date().toISOString() });
      return d;
    } finally {
      this.currentInvestigation = null;
    }
  }

  /** Approval memories written in one approval conversation, split by whether Meko lists them as promoted. */
  private async findApprovalMemories(meko: MekoClient, datapackId: string, conversationId: string): Promise<{ promoted: string[]; unpromoted: string[]; complete: boolean }> {
    const trace = conversationId.replaceAll("-", "");
    const args = { agent_id: APPROVALS_AGENT_ID, conversation_id: trace, datapack_id: datapackId };
    const mine = await meko.call("engineer", "memory_get_all", args, PersonalListing);
    const shared = await meko.call("engineer", "memory_get_all", { ...args, promoted: true }, PromotedListing);
    const inConv = (r: z.infer<typeof MemoryRow>) => (r.conversation_id ?? "").replaceAll("-", "").toLowerCase() === trace.toLowerCase();
    return {
      promoted: shared.promoted_memories.filter(inConv).map((r) => r.id),
      unpromoted: mine.memories.filter(inConv).map((r) => r.id),
      complete: mine.total <= mine.memories.length && shared.total <= shared.promoted_memories.length,
    };
  }

  /** Human rejection. With Meko ON, the rejected hypothesis is kept as an unverified observation. */
  async reject(id: string, reason: string): Promise<RejectionDecision> {
    const row = this.requireProposed(id);
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

function resolutionText(ref: string, incident: IncidentInput, rootCause: string, fix: string, inv: Investigation, approvedAt: string, notes?: string): string {
  return [
    `Verified resolution for incident ${ref} on ${incident.service} (${incident.title}), approved by the on-call engineer at ${approvedAt}.`,
    `Root cause: ${rootCause}`,
    `Fix: ${fix}`,
    `Applies when: ${inv.appliesWhen}`,
    notes ? `Engineer notes: ${notes}` : "",
  ].filter(Boolean).join(" ");
}
