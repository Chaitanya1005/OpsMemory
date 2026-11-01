# Frontend handoff: backend contract

The backend is frozen for the frontend phase. The UI should be a thin layer over `OpsMemory` in `lib/workflow.ts`. It must not call Meko or the LLM directly.

## Operations (wrap each in a Next.js route handler)

| UI action | Call | Returns |
|---|---|---|
| Submit incident | `app.investigate(incident, "on" \| "off", { incidentRef? })` | `InvestigationRecord` |
| Re-run same incident in the other mode | `investigate(sameIncident, otherMode, { incidentRef: rec.incidentRef })` | `InvestigationRecord` |
| Approve (optionally edit) | `app.approve(id, { rootCause?, fix?, notes? })` | `ApprovalDecision` (memory ids, promotion result, `retrievableAfterPromotion`) |
| Reject | `app.reject(id, reason)` | `RejectionDecision` |
| Activity feed | `app.store.events(id?)` | `StoredEvent[]`: real Meko calls only, with latency, datapack, ok/error |
| History list | `app.store.listInvestigations()` | `InvestigationRow[]` |

`approve` is refused for Meko OFF investigations. In ON mode a recall failure throws; show it, never fall back.

## What the dashboard must show (all fields already exist)

- **Recalled context:** `record.knowledge.retrieved[]`. Show `kind` as VERIFIED, RUNBOOK or UNVERIFIED; `source.datapack`, `source.tool` and `source.memoryId` as provenance; `knowledge.relevant[].why`; and `knowledge.rejected[].why` for items judged not applicable (added during the frontend phase, so older records may lack it).
- **Investigation:** `rootCause.statement` + `basis`, `evidence[]` (each cites S#, a timestamp or K#), `recommendedFix.configChanges[]` with source badges (`history:K1`, `current_evidence`, `assumption`), `unresolvedQuestions`, `confidence`.
- **Traceability:** `result.outcome.integrityWarnings`, plus `historicalContextUsed[].how` next to the recalled memory it cites.
- **Writes:** `result.mekoWrites` (conversation + unverified finding ids, or the error).
- **ON/OFF comparison:** two records sharing one `incidentRef`; compare `configChanges` sources, `unresolvedQuestions` and `mekoCalls`.

## Demo script (fresh `opsmemory-*` datapacks)

1. Investigate `db-pool-1`, Meko ON. Nothing verified exists yet.
2. Approve with the engineer edit (`approvalEdit` of `db-pool-1`: pool max 8, maxReplicas 10, pg-commerce-1 budget 80/200). It is promoted, and the UI shows `retrievableAfterPromotion`.
3. Investigate `db-pool-2`, Meko ON. K1 VERIFIED is recalled; config changes are sourced `history:K1`.
4. Same incident, Meko OFF. 0 Meko calls; values are `assumption`; the DB limit is listed as an unresolved question.

The demo datapacks can only be used once per promotion, because promoted memories can't be deleted via MCP. Rehearse with `MEKO_DATAPACK_PREFIX=opsmemory-e2e`.

## Known constraints

- An ON investigation takes ~20s: Meko `memory_search` alone is ~10.5s. Show per-step progress.
- Free-tier lifetime quotas: each ON investigation uses 2 quota-counted searches + 1 `conversation_add_message`.
- Strip `promoted_by_email` / `promoted_by_name` if promoted listings are ever shown (`memory_get_all promoted=true`).
