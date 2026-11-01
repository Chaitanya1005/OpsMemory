# Meko feature proposal: Verified Promotion

**One sentence:** make `memory_promote` a safe, auditable and reversible act of *verification*. Add an idempotency key, approval provenance that survives promotion, and `supersede` / `retract` operations for promoted knowledge.

*From building OpsMemory, the HackCBS 9.0 Track A entry: an incident investigator whose agents recall engineer-approved fixes from Meko. Evidence: the `opsmemory-build` datapack, `docs/FRICTION_LOG.md` (entries #5, #6, #11, #14, #17) and the code paths cited below.*

---

## 1. The friction

In OpsMemory, promotion is the moment an engineer says "this fix is true". `memory_promote` moves the resolution out of private memory into the datapack's knowledge base, and every future investigation recalls it. Promotion is the product's whole point, and it was the hardest part to make trustworthy.

| What we couldn't do | What happened | Our workaround |
|---|---|---|
| **Retry a promotion safely** [#17] | Meko's MCP connection intermittently reset (`ECONNRESET`, `fetch failed`, seen several times). After a dropped `memory_add` or `memory_promote`, the client can't know whether it was applied. Our first client retried, which risked a duplicate verified fix. | About 150 lines in `lib/workflow.ts`: persist every confirmed step, refuse to resend writes, and reconcile by listing `memory_get_all` (personal and `promoted=true`) and matching `conversation_id`. |
| **Keep who approved it and when** [#6] | `metadata` is dropped on promotion. The KB chunk keeps only `source`, `agent_id` and `memory_id`. | We write "approved by the on-call engineer at <timestamp>" *into the memory text* (`resolutionText` in `lib/workflow.ts`). |
| **Correct or withdraw a wrong verified fix** [#5, #11, #14] | `memory_update` on a promoted memory fails with a server error (`Object of type UUID is not JSON serializable`). `knowledgebase_delete_document` on the chunk's `document_id` returns `NOT_FOUND`. | Portal only. The UI warns that promotion is permanent. Tests run in separate `opsmemory-e2e-*` datapacks, which now hold **9 near-identical promoted resolutions** that no test can clean up. Our last e2e run cited an *older* duplicate instead of the one it had just promoted. |

## 2. The feature, in Meko's terms

**Verified Promotion** turns promotion from a one-way move into a versioned lifecycle for shared knowledge in a datapack:

- **Idempotent promotion.** `memory_promote` accepts an `idempotency_key`. The same key always returns the original result and never promotes twice. This also applies to `memory_add`, so the write before promotion is safe too.
- **Provenance that survives sharing.** A `provenance` object (who approved, their role, when, why, and the source conversation) is stored on the promoted memory. It is returned by `knowledgebase_search`, so every agent that recalls shared knowledge also sees why it is trusted.
- **Supersede.** Promote a corrected memory *in place of* an older one. The old chunk stays for audit but stops being returned by default.
- **Retract.** Withdraw a promoted memory from the knowledge base with a reason. It leaves recall but stays auditable.

The knowledge base gains a status per promoted memory: `active` | `superseded` | `retracted`.

## 3. The interface

**Promote, idempotently, with provenance**

```json
// call
memory_promote({
  "conversation_id": "a1f0…",
  "datapack_id": "63aa8d4d-…",
  "memory_ids": ["0ae5425a-…"],
  "idempotency_key": "approval:inv_87b9ec17",
  "provenance": { "approved_by_role": "on-call SRE", "reason": "DBA confirmed 200-connection limit", "source_ref": "INC-20261101-3A9F" },
  "supersedes": ["bbdd4af0-…"]          // optional
})

// response
{
  "promoted": [{ "memory_id": "0ae5425a-…", "status": "active", "kb_document_id": "a1f0…" }],
  "superseded": ["bbdd4af0-…"],
  "idempotent_replay": false            // true when this key was already applied
}
```

**Retract**

```json
memory_retract({ "datapack_id": "63aa8d4d-…", "memory_id": "0ae5425a-…", "reason": "Fix caused replica lag; see INC-…", "idempotency_key": "retract:0ae5425a" })
→ { "memory_id": "0ae5425a-…", "status": "retracted", "retracted_at": "2026-11-01T10:12:00Z" }
```

**Search returns lifecycle and provenance** (new optional parameter `include_status`, default `["active"]`)

```json
knowledgebase_search({ "query": "orders-api pool exhaustion", "datapack_id": "63aa8d4d-…" })
→ { "results": [{ "content": "…", "metadata_filters": { "source": "memory", "memory_id": "0ae5425a-…",
      "status": "active", "provenance": { "approved_by_role": "on-call SRE", "approved_at": "…", "reason": "…" } } }] }
```

## 4. Scenario: before and after

**Persona.** Priya, the on-call SRE, approves the fix for a checkout-api outage: pool max 8, maxReplicas 10, within an 80-connection budget on a 200-connection database.

| | Today | With Verified Promotion |
|---|---|---|
| Network drops during approval | Priya can't tell if the fix was saved. A retry may create a second verified copy. We built reconciliation code to guess. | She clicks approve again. The same `idempotency_key` returns `idempotent_replay: true`, with no duplicate. |
| A week later, an agent recalls the fix | The agent sees text that *claims* it was approved. | The agent sees structured `provenance`: role, time, reason and incident. |
| The DBA raises the limit to 300 | The old "80 of 200" fix keeps being recalled forever. Only a portal admin can remove it. | Priya promotes the corrected fix with `supersedes`. Agents now get only the new one; the old one is kept for audit. |
| The fix turns out to be wrong | Every future investigation keeps citing it. | `memory_retract` with a reason. It leaves recall immediately, and the audit trail remains. |

## 5. Why it's new

- **Today's context layers don't model verification.** Memory layers and vector stores treat a stored fact as an embedding plus metadata. They have no notion of "a human verified this", "this replaced that" or "this was withdrawn".
- **Meko already has the key primitive.** Promotion is a deliberate move from private memory into shared knowledge. This proposal makes that move *transactional* (idempotent), *accountable* (provenance) and *correctable* (supersede and retract).
- **Shared knowledge becomes a versioned source of truth.** Agents can trust it, and humans can fix it without a portal admin. That's what any team-wide memory needs before it can be relied on: incident runbooks, support fixes, class-wide misconceptions.

## 6. Risks and limits

| Risk | Mitigation |
|---|---|
| **Privacy.** Provenance could leak identities. Today's promoted listings already return `promoted_by_email` (#13). | Provenance stores a *role* and an optional reference, never an email by default. Personal fields are opt-in per datapack and redacted from `knowledgebase_search`. |
| **Abuse.** Any agent retracts or supersedes team knowledge. | Retract and supersede require a datapack permission separate from promote (for example, write-capable humans only). Every lifecycle change is logged and attributed. |
| **Cost and storage.** Superseded and retracted chunks are kept. | They are excluded from the search index by default (`include_status`). A retention policy per datapack can purge them after N days. |
| **Idempotency store growth.** | Keys expire, for example after 24 hours, and are scoped per datapack. |
| **Feasibility.** | The pieces exist: promotion already writes a KB chunk with `memory_id`, and `memory_get_all(promoted=true)` already lists promotion records. The proposal adds a status field, a key table and two operations around them. |

---

*What this is not.* The underlying bugs (#11's serialization error, #14's `NOT_FOUND`) are reported separately in `docs/FRICTION_LOG.md`. Fixing them alone would still leave promotion non-idempotent, unaccountable and irreversible.
