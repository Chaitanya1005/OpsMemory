# Meko feature proposal: from building OpsMemory

OpsMemory uses Meko as the only long-term memory for a two-agent incident-investigation app, with a human-gated "promote to verified knowledge" step. Each item below comes from friction we hit in that integration. The evidence is in `docs/FRICTION_LOG.md` (entry numbers in brackets) and in the code paths cited.

## Confirmed implementation friction

### 1. Write operations have no idempotency key [#17]
- **Friction.** `memory_add`, `memory_promote`, `conversation_create` and `conversation_add_message` take no client-supplied operation id. We saw intermittent `ECONNRESET` / `fetch failed` on MCP connections [#9]. After a transport error, the client cannot tell whether the write was applied.
- **Where.** `lib/meko/client.ts` originally retried every transport error, so a retried `memory_add` could create a duplicate. We now refuse to retry these ops (`NON_IDEMPOTENT_OPS`, error `uncertain_outcome`). `lib/workflow.ts` `approve` persists every confirmed step and reconciles before writing again.
- **Why it matters.** Without a key, every integrator must choose between duplicate memories and lost writes. A duplicated *promoted* resolution is worse, because it can't be removed via the API (#3 below).
- **Proposal.** Accept an optional `idempotency_key` on all write tools. A repeat with the same key would return the original result instead of writing again.
- **Benefit.** Safe automatic retries; exactly-once semantics for approval flows without app-side reconciliation code.

### 2. No direct way to look up "what did this operation write?" [#18]
- **Friction.** To reconcile an uncertain write, we have to list memories with `memory_get_all` and match on `conversation_id`. The listing returns one page of about 20 rows plus a `total`, and pagination arguments are rejected. The personal listing has no `metadata`, so our `incident_ref` can't be matched. Promoted memories appear only in a separate `promoted=true` listing.
- **Where.** `OpsMemory.findApprovalMemories` in `lib/workflow.ts`. If either listing exceeds one page, the approval stays `needs_reconciliation`.
- **Proposal.** Either paginate `memory_get_all` with a `conversation_id` filter, or offer an exact lookup by operation key.
- **Benefit.** Deterministic reconciliation regardless of datapack size.

### 3. Promoted knowledge can't be corrected or retracted through the API [#5, #11, #14]
- **Friction.** `memory_update` on a promoted memory fails with a server serialization error (`Object of type UUID is not JSON serializable`) instead of a clear refusal. `knowledgebase_delete_document` on the promoted chunk's `document_id` returns `NOT_FOUND`. Correction is portal-only.
- **Where.** The approval UI has to warn that promotion is permanent (`app/components/ApprovalPanel.tsx`). Tests need separate `opsmemory-e2e-*` datapacks so test promotions never pollute the demo, and the demo datapacks can only be used once.
- **Proposal.** Add a `memory_demote` / `knowledge_retract` tool, plus a clear `memory_is_promoted` error from `memory_update`.
- **Benefit.** A wrong "verified" fix can be withdrawn by the same agent workflow that promoted it, and tests can clean up after themselves.

### 4. Promotion drops metadata and has no approval provenance [#6]
- **Friction.** The knowledge-base chunk created by promotion carries only `source`, `agent_id` and `memory_id`. Our `metadata` (incident ref, approval time, status) is lost.
- **Where.** `resolutionText` in `lib/workflow.ts` writes approval facts into the memory text so they survive.
- **Proposal.** Carry memory metadata through promotion, and record first-class `promoted_at` and `promoted_by_role` on the chunk.
- **Benefit.** Auditable verified knowledge without encoding structure in prose.

### 5. `agent_id` doesn't scope reads [#1]
- **Friction.** `memory_search` and `memory_get_all` ignore `agent_id`, so two agents in one datapack see each other's memories.
- **Where.** We use one datapack per role and an app-side policy (`lib/meko/scopes.ts`).
- **Proposal.** An opt-in read filter by `agent_id`, or per-agent scoped keys.
- **Benefit.** Multi-agent apps don't need a datapack per agent.

### 6. Retrieval relevance signal and recall consistency [#12, #16]
- **Friction.**
  - `rerank_score` was ≥0.98 for every knowledge-base hit, including a resolution for a different incident, so it can't serve as a threshold.
  - `context_search`'s knowledge-base bucket was empty, twice, for a query on which `knowledgebase_search` returned the promoted resolution.
- **Where.**
  - `lib/agents/knowledge.ts` calls `knowledgebase_search` directly.
  - It also needs an extra LLM call to judge applicability.
- **Proposal.** Calibrate or document scores, and make `context_search` include promoted knowledge consistently.
- **Benefit.** One recall call, and cheaper, deterministic filtering.

### 7. `memory_search` latency [#15]
- **Friction.** About 10.5s per call even on an empty datapack, against about 1s for `knowledgebase_search`, `memory_add` and `memory_promote`.
- **Where.** It dominates a Meko ON investigation, so the UI needs a running state.
- **Proposal.** Investigate the latency floor, or publish expected latency.
- **Benefit.** Recall becomes usable on an interactive request path.

### 8. Response shapes are undocumented [#3, #10]
- **Friction.** The MCP reference has no response schemas, the documented REST knowledge-base upload route returns 404, and `memory_get_all` key names differ by mode (`memories` vs `promoted_memories`).
- **Where.** Every zod schema in `lib/workflow.ts` and `lib/agents/*` was written from captured live responses.
- **Proposal.** Publish output schemas for each MCP tool.
- **Benefit.** Fewer integration surprises; type-safe clients.

### 9. Listings include personal data [#13]
- **Friction.** `memory_get_all` returns `promoted_by_email` / `promoted_by_name` (and `user_email` on personal rows).
- **Where.** `lib/meko/events.ts` redacts these fields before anything is logged or shown.
- **Proposal.** Omit personal fields by default, behind an explicit flag.
- **Benefit.** Safer defaults for apps that surface knowledge to viewers.

## Suggestions that still need validation

- **Lifecycle visibility.** A per-datapack operation feed (writes, promotions, extraction jobs) would replace our own event log. Not validated: we didn't check whether the portal already exposes this.
- **Promotion read-after-write.** Our read-back always found a promoted memory immediately, but we have only a handful of samples. A documented consistency guarantee would let integrators drop the read-back.
- **Auto-extraction visibility.** `conversation_add_message` extraction created a memory id we didn't recognise during the spike. A way to tell extracted memories from explicit writes would help reconciliation. Seen once; not reproduced systematically.
- **Free-tier quotas.** Lifetime caps of 1,000 per search type [#8] make repeated e2e testing expensive. A test/sandbox quota tier might help; this is a product question, not a defect.
