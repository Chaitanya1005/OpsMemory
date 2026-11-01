# Meko in OpsMemory: build-time vs runtime

OpsMemory uses Meko in two separate ways. They share a vendor and nothing else: credentials, datapacks, agents and purpose are all different.

> **Build-time Meko** is persistent memory for the developer's coding agent (Claude Code).
> **Runtime Meko** is persistent institutional memory for OpsMemory's application agents.

| | Build-time | Runtime |
|---|---|---|
| Who calls Meko | Claude Code, during development | The OpsMemory server (`lib/meko/client.ts`) |
| Credentials | Claude Code's MCP configuration (user-level, outside this repo) | `MEKO_API_KEY` in `.env.local`, a key dedicated to this app |
| Datapack | `opsmemory-build` | `opsmemory-knowledge`, `opsmemory-investigator` (and `opsmemory-e2e-*` for tests) |
| `agent_id` | `claude_code` | `opsmemory_knowledge_agent`, `opsmemory_investigator`, `opsmemory_approvals` |
| Contents | Architecture decisions, constraints, lessons, conventions | Verified incident resolutions and unverified observations |
| Read by the app? | **Never** | Yes |

Neither side reads or writes the other's datapacks, and the application never uses Claude Code's credentials.

## A. Build-time: Claude Code's project memory

**Connection.** Claude Code connects to Meko's MCP server (`https://mcp.mekodata.ai/mcp`) through a user-level MCP server entry named `meko` and the `meko-agent-skills` plugin. The bearer credential lives in the user's Claude Code configuration, not in this repository, and must never be copied into it.

**Capture.** The plugin's session hooks create a Meko conversation per session and capture the transcript. Meko extracts durable memories from it automatically.

**Explicit decisions.** Decisions that exist only in the agent's own output are recorded with `memory_add` into `opsmemory-build`, passing that datapack's id explicitly. Examples: "promotion moves a memory into the KB", "e2e must use `opsmemory-e2e-*`", "use gemini-3.5-flash-lite".

**Recall.** Before significant work, Claude Code searches `opsmemory-build` (`context_search` / `memory_search` with its `datapack_id`). The rules are in [`CLAUDE.md`](../CLAUDE.md):
- recall before significant work;
- record decisions and lessons after meaningful work;
- use only `opsmemory-build`;
- never put build context, secrets or personal data into runtime datapacks.

## B. Runtime: OpsMemory's institutional memory

The access policy is enforced in code (`lib/meko/scopes.ts` `ACCESS`) before any call reaches Meko:

| Actor | Reads | Writes |
|---|---|---|
| Knowledge Agent | `knowledge` (`knowledgebase_search`), `investigator` (`memory_search`) | nothing |
| Investigator | nothing (gets history only through the Knowledge Agent's brief) | `investigator` |
| Engineer (approve/reject) | `knowledge` (read-back, reconciliation listings) | `knowledge` (approve), `investigator` (reject) |

**Historical knowledge is retrieved** by the Knowledge Agent:
- `knowledgebase_search` (limit 8) on `knowledge`, which returns promoted resolutions tagged `source=memory` with their `memory_id`;
- `memory_search` (limit 6) on `investigator`, which returns earlier unverified findings.

Gemini then judges which items apply, and only those reach the Investigator, as `K1`, `K2` and so on.

**New observations are recorded** by `recordInvestigation` (`lib/agents/investigator.ts`), which writes into `investigator`:
- `conversation_create`;
- `conversation_add_message`;
- `memory_add`, with the finding marked unverified.

**Engineer-approved resolutions are promoted** by `OpsMemory.approve` (`lib/workflow.ts`), which writes into `knowledge`:
1. `conversation_create`
2. `memory_add`, with the approval facts in the text, because metadata is dropped on promotion
3. `memory_promote`
4. a read-back with `knowledgebase_search`

The investigation becomes `approved` only if step 4 returns the memory id. Failure states and reconciliation are described in the README, under "Approval reliability".

**Promoted resolutions are reused** by the next Meko ON investigation, whose Knowledge Agent finds them with `knowledgebase_search`. The UI shows the promoted memory id as provenance, and the lifecycle "Reuse" stage lists later incidents that retrieved it.

**With Meko OFF**, the Knowledge Agent does not run, no Meko connection is opened, and nothing is written (0 Meko calls). The Investigator gets an explicit "no historical context" block. OFF runs cannot be approved.

**On failure**, a Meko ON investigation that cannot recall fails visibly (HTTP 502, `source=meko`). There is no local fallback.
