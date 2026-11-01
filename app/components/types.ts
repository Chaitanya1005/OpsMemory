// Client-side views of the backend's own types (type-only imports; nothing runs in the browser).
import type { Scenario } from "@/data/scenarios";
import type { KnowledgeBrief, RetrievedItem } from "@/lib/agents/knowledge";
import type { InvestigationRow, StoredEvent } from "@/lib/store";
import type { ApprovalDecision, InvestigationResult, RejectionDecision } from "@/lib/workflow";

export type { ApprovalDecision, KnowledgeBrief, RejectionDecision, RetrievedItem, Scenario, StoredEvent };

export interface Investigation extends Omit<InvestigationRow, "incident" | "knowledge" | "result" | "decision"> {
  incident: Scenario;
  knowledge: KnowledgeBrief | null;
  /** `{ error }` when the investigation failed. */
  result: InvestigationResult | { error: string };
  decision: ApprovalDecision | RejectionDecision | null;
  mekoCalls: number;
  events: StoredEvent[];
}

export interface Status {
  model: string;
  provider: string;
  datapackPrefix: string;
  datapacks: { knowledge: string; investigator: string };
  mekoConfigured: boolean;
}

export interface ApiError {
  error: string;
  code?: string;
  op?: string;
  source?: "meko" | "llm" | "app";
  /** Set when an approval stopped short of `approved`. */
  approvalStatus?: string;
}

export const isComplete = (i: Investigation): i is Investigation & { result: InvestigationResult } => "outcome" in i.result;
