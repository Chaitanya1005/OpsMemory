import { z } from "zod";
import type { IncidentInput } from "../data/scenarios";
import type { Investigation } from "./agents/investigator";
import { MekoError, type MekoClient } from "./meko/client";
import { redactFields } from "./redact";
import type { Datapacks } from "./meko/scopes";
import type { InvestigationRow, Store } from "./store";
import type { InvestigationResult } from "./workflow";

export const APPROVALS_AGENT_ID = "opsmemory_approvals";

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
  /** Name or role the approver gave; it is written into the shared memory text. */
  approvedBy: string | null;
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

export type ApprovalEdits = { rootCause?: string; fix?: string; notes?: string; approvedBy?: string };

/** What the approval needs from the workflow: state, a Meko connection, and event attribution. */
export interface ApprovalContext {
  store: Store;
  connect: () => Promise<{ meko: MekoClient; datapacks: Datapacks }>;
  /** Attributes Meko events recorded until the next call to this investigation (null to stop). */
  track: (investigationId: string | null) => void;
}

export const MemoryAdded = z.object({ results: z.array(z.object({ id: z.string(), memory: z.string().optional() }).loose()) }).loose();
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
 * Human approval. Stores the (optionally edited) resolution in the knowledge
 * datapack, promotes it into shared knowledge, then verifies it is retrievable.
 *
 * Meko has no transactions, so this is a resumable sequence: each confirmed
 * step is persisted, a failed step is recorded with its stage, and a retry
 * resumes after the last confirmed step. Writes whose outcome is unknown are
 * reconciled against Meko's listings before anything is written again.
 * Only a successful read-back sets `approved`; anything else throws ApprovalFailure.
 */
export async function approveInvestigation(ctx: ApprovalContext, id: string, edits: ApprovalEdits = {}): Promise<ApprovalDecision> {
  const row = ctx.store.getInvestigation(id);
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
  // Engineer edits are written into shared knowledge, so they are redacted like a submitted incident.
  edits = redactFields(edits).value;
  // A retry keeps the original content: memories may already hold it, and edits must not fork it.
  let d: ApprovalDecision = prior
    ? { ...prior, status: "approving", attempts: prior.attempts + 1, attemptStartedAt: now, failure: null }
    : {
        status: "approving", approvedAt: now, rootCause: edits.rootCause ?? inv.rootCause.statement, fix: edits.fix ?? inv.recommendedFix.immediate.join("; "),
        notes: edits.notes ?? null, approvedBy: edits.approvedBy ?? null, edited: Boolean(edits.rootCause || edits.fix), conversationId: null, storedText: [], memoryIds: [],
        promotion: { inserted: [], updated: [], notFound: [] }, promotionConfirmed: false, retrievableAfterPromotion: false,
        verifiedAt: null, attempts: 1, attemptStartedAt: now, failure: null,
      };
  if (!ctx.store.claimApproval(id, stale ? [...RESUMABLE, "approving"] : RESUMABLE, d)) throw new Error(`Investigation ${id} is already being approved`);
  // Anything other than a clean, definitive failure of the previous attempt may have left writes we have not recorded.
  const mayHaveUnrecordedWrites = prior !== null && (prior.status === "needs_reconciliation" || prior.status === "approving");

  const save = (patch: Partial<ApprovalDecision>) => {
    d = { ...d, ...patch };
    ctx.store.updateDecision(id, d.status, d, d.status === "approved" ? d.verifiedAt : null);
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

  ctx.track(id);
  try {
    const { meko, datapacks } = await step("connect", ctx.connect);

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
      const found = await step("reconcile", () => findApprovalMemories(meko, datapacks.knowledge, conversationId));
      const known = new Set(d.memoryIds);
      const promoted = found.promoted.filter((m) => known.size === 0 || known.has(m));
      const unpromoted = found.unpromoted.filter((m) => known.size === 0 || known.has(m));
      if (promoted.length && !unpromoted.length) save({ memoryIds: [...new Set([...d.memoryIds, ...promoted])], promotionConfirmed: true });
      else if (unpromoted.length) save({ memoryIds: [...new Set([...d.memoryIds, ...unpromoted, ...promoted])], promotionConfirmed: false });
      else if (d.memoryIds.length === 0 && !found.complete) {
        stop("reconcile", "inconclusive", "Meko's listings exceed one 100-row page, so an earlier memory_add cannot be ruled out; check the knowledge datapack in the Meko portal", true);
      } else if (d.memoryIds.length > 0) {
        stop("reconcile", "missing", `Recorded memory ${d.memoryIds.join(", ")} is in neither the personal nor the promoted listing`, true);
      }
    }

    if (d.memoryIds.length === 0) {
      // Approval facts go in the text itself: memory metadata is dropped on promotion (FRICTION_LOG #6).
      const text = resolutionText(row.incidentRef, incident, d, inv);
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
    ctx.track(null);
  }
}

/** Approval memories written in one approval conversation, split by whether Meko lists them as promoted. */
async function findApprovalMemories(meko: MekoClient, datapackId: string, conversationId: string): Promise<{ promoted: string[]; unpromoted: string[]; complete: boolean }> {
  const trace = conversationId.replaceAll("-", "");
  const args = { agent_id: APPROVALS_AGENT_ID, conversation_id: trace, datapack_id: datapackId, page_size: 100 };
  const mine = await meko.call("engineer", "memory_get_all", args, PersonalListing);
  const shared = await meko.call("engineer", "memory_get_all", { ...args, promoted: true }, PromotedListing);
  const inConv = (r: z.infer<typeof MemoryRow>) => (r.conversation_id ?? "").replaceAll("-", "").toLowerCase() === trace.toLowerCase();
  return {
    promoted: shared.promoted_memories.filter(inConv).map((r) => r.id),
    unpromoted: mine.memories.filter(inConv).map((r) => r.id),
    complete: mine.total <= mine.memories.length && shared.total <= shared.promoted_memories.length,
  };
}

function resolutionText(ref: string, incident: IncidentInput, d: ApprovalDecision, inv: Investigation): string {
  // Records made before approvers could give a name have no approvedBy.
  const approver = d.approvedBy ?? "an engineer";
  return [
    `Verified resolution for incident ${ref} on ${incident.service} (${incident.title}), approved by ${approver} at ${d.approvedAt}.`,
    `Root cause: ${d.rootCause}`,
    `Fix: ${d.fix}`,
    `Applies when: ${inv.appliesWhen}`,
    d.notes ? `Engineer notes: ${d.notes}` : "",
  ].filter(Boolean).join(" ");
}
