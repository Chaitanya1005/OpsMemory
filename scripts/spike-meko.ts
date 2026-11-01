/**
 * Meko integration spike: proves every Meko operation OpsMemory depends on
 * against the live service and captures real response shapes.
 *
 *   npm run spike:meko -- --schemas        # print live tool input schemas only
 *   npm run spike:meko -- [output.json]    # full round trip
 *
 * Promotion is one-way and promoted memories cannot be deleted through MCP,
 * so all writes go to a throwaway datapack (opsmemory-spike). The two runtime
 * datapacks are only ensured to exist and are left empty.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { MekoClient, MekoError } from "../lib/meko/client";
import { uploadKnowledgeDocument } from "../lib/meko/documents";

const RUNTIME_DATAPACKS = ["opsmemory-knowledge", "opsmemory-investigator"] as const;
const SPIKE_DATAPACK = "opsmemory-spike";
const KNOWLEDGE_AGENT = "opsmemory_knowledge_agent";
const INVESTIGATOR = "opsmemory_investigator";
const REQUIRED_TOOLS = [
  "datapack_search", "datapack_create", "conversation_create", "conversation_add_message", "conversation_get",
  "memory_add", "memory_get_by_id", "memory_search", "memory_get_all", "memory_promote", "memory_update",
  "memory_delete_by_id", "context_search", "knowledgebase_search",
];

type Outcome = { step: string; ok: boolean; note: string };
const outcomes: Outcome[] = [];
const captured: Record<string, unknown> = {};
const readTrace = randomUUID().replaceAll("-", "");
const marker = `spike-${Date.now().toString(36)}`;

async function step<T>(name: string, fn: () => Promise<T>, note: (r: T) => string = () => ""): Promise<T | undefined> {
  try {
    const r = await fn();
    captured[name] = r;
    const n = note(r);
    outcomes.push({ step: name, ok: true, note: n });
    console.log(`PASS  ${name}${n ? ` — ${n}` : ""}`);
    return r;
  } catch (err) {
    const msg = err instanceof MekoError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
    outcomes.push({ step: name, ok: false, note: msg });
    console.log(`FAIL  ${name} — ${msg}`);
    return undefined;
  }
}

/** Records a check whose result is expected to be a specific Meko error. */
async function expectError(name: string, expectedCode: string, fn: () => Promise<unknown>) {
  try {
    const r = await fn();
    captured[name] = r;
    outcomes.push({ step: name, ok: false, note: `expected ${expectedCode}, call succeeded` });
    console.log(`FAIL  ${name} — expected ${expectedCode}, call succeeded`);
  } catch (err) {
    const code = err instanceof MekoError ? err.code : "unknown";
    // "*" means any server-side rejection counts: the point is that the change was refused.
    const ok = expectedCode === "*" ? err instanceof MekoError : code === expectedCode || (err instanceof MekoError && err.message.includes(expectedCode));
    outcomes.push({ step: name, ok, note: `${code}: ${err instanceof Error ? err.message.slice(0, 160) : ""}` });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name} — got ${code}`);
  }
}

const ids = (r: unknown): string[] =>
  (((r as { results?: Array<{ id?: string }> })?.results ?? []) as Array<{ id?: string }>).map((x) => x.id ?? "").filter(Boolean);

const mentions = (r: unknown, needle: string) => JSON.stringify(r ?? "").includes(needle);

async function ensureDatapack(meko: MekoClient, name: string): Promise<string> {
  const found = await meko.call<{ datapacks: Array<{ datapack_id: string; grant: string }> }>(
    "system", "datapack_search", { name, conversation_id: readTrace },
  );
  const existing = found.datapacks[0];
  if (existing) return existing.datapack_id;
  const created = await meko.call<{ datapack_id: string }>("system", "datapack_create", { name, conversation_id: readTrace });
  return created.datapack_id;
}

async function main() {
  const apiKey = process.env.MEKO_API_KEY ?? "";
  const meko = await MekoClient.connect({ apiKey });

  if (process.argv.includes("--schemas")) {
    await printSchemas(meko);
    await meko.close();
    return;
  }

  // 1. Tool discovery
  await step("tools_available", async () => {
    const tools = await meko.listTools();
    const missing = REQUIRED_TOOLS.filter((t) => !tools.includes(t));
    if (missing.length) throw new Error(`missing tools: ${missing.join(", ")}`);
    return tools;
  }, (t) => `${t.length} tools, all ${REQUIRED_TOOLS.length} required present`);

  // 2. Datapacks as context scopes
  const runtime: Record<string, string> = {};
  for (const name of RUNTIME_DATAPACKS) {
    const id = await step(`datapack_ensure:${name}`, () => ensureDatapack(meko, name), (id) => id);
    if (id) runtime[name] = id;
  }
  const dp = await step(`datapack_ensure:${SPIKE_DATAPACK}`, () => ensureDatapack(meko, SPIKE_DATAPACK), (id) => id);
  if (!dp) throw new Error("cannot continue without the spike datapack");

  // 3. Conversation history (investigation trace)
  const conv = await step("conversation_create", () =>
    meko.call<Record<string, unknown>>("investigator", "conversation_create", {
      agent_id: INVESTIGATOR, datapack_id: dp, title: `Spike incident ${marker}`, metadata: JSON.stringify({ incident: marker }),
    }), (r) => `keys=${Object.keys(r).join(",")}`);
  const conversationId = String((conv as { conversation_id?: string; id?: string })?.conversation_id ?? (conv as { id?: string })?.id ?? "");

  if (conversationId) {
    await step("conversation_add_message", () =>
      meko.call("investigator", "conversation_add_message", {
        conversation_id: conversationId, agent_id: INVESTIGATOR, datapack_id: dp, seed: `${marker}-turn-1`,
        input: `Investigate incident ${marker}: checkout-api timing out acquiring DB connections (active=50 idle=0 max=50).`,
        output: "Finding: connection pool exhausted; evidence: repeated pool acquisition timeouts. Confidence 0.8.",
      }));
    await step("conversation_get", () =>
      meko.call("investigator", "conversation_get", {
        conversation_id: conversationId, agent_id: INVESTIGATOR, datapack_id: dp, include_messages: true,
      }), (r) => `mentions marker: ${mentions(r, marker)}`);
  }
  const writeConv = conversationId || readTrace;

  // 4. Memory write + read-back (unverified investigator finding)
  const finding = await step("memory_add:finding", () =>
    meko.call("investigator", "memory_add", {
      text: `Unverified finding for incident ${marker}: checkout-api connection pool exhausted at max=50 with idle=0.`,
      agent_id: INVESTIGATOR, conversation_id: writeConv, datapack_id: dp,
      metadata: JSON.stringify({ kind: "finding", status: "unverified", incident: marker }),
    }), (r) => `ids=${ids(r).join(",")}`);
  const findingId = ids(finding)[0];
  if (findingId) {
    await step("memory_get_by_id:finding", () =>
      meko.call("investigator", "memory_get_by_id", { memory_id: findingId, agent_id: INVESTIGATOR, conversation_id: readTrace, datapack_id: dp }),
      (r) => `metadata=${JSON.stringify((r as { metadata?: unknown }).metadata)}`);
  }

  // 5. Human-approved resolution → immediate promotion
  const resolution = await step("memory_add:resolution", () =>
    meko.call("engineer", "memory_add", {
      text: `Verified resolution for incident ${marker} (checkout-api DB connection exhaustion): raise pool max from 50 to 120 and set idle timeout to 30s; approved by on-call engineer.`,
      agent_id: KNOWLEDGE_AGENT, conversation_id: writeConv, datapack_id: dp,
      metadata: JSON.stringify({ kind: "resolution", status: "approved", incident: marker, approved_at: new Date().toISOString() }),
    }), (r) => `ids=${ids(r).join(",")}`);
  const resolutionId = ids(resolution)[0];
  if (resolutionId) {
    await step("memory_promote:immediate", () =>
      meko.call("engineer", "memory_promote", {
        conversation_id: writeConv, memory_ids: [resolutionId], agent_id: KNOWLEDGE_AGENT, datapack_id: dp,
      }), (r) => JSON.stringify(r).slice(0, 200));
  }

  // 6. Recall paths after promotion
  await step("memory_get_all:promoted", () =>
    meko.call("knowledge-agent", "memory_get_all", { conversation_id: readTrace, agent_id: KNOWLEDGE_AGENT, datapack_id: dp, promoted: true }),
    (r) => `contains resolution: ${mentions(r, marker)}`);
  await step("memory_get_all:private", () =>
    meko.call("knowledge-agent", "memory_get_all", { conversation_id: readTrace, agent_id: KNOWLEDGE_AGENT, datapack_id: dp }),
    (r) => `contains resolution: ${resolutionId ? mentions(r, resolutionId) : "n/a"}, contains finding: ${findingId ? mentions(r, findingId) : "n/a"}`);
  await step("memory_search", () =>
    meko.call("knowledge-agent", "memory_search", {
      query: `checkout-api database connection pool exhausted ${marker}`, agent_id: KNOWLEDGE_AGENT, conversation_id: readTrace, datapack_id: dp, limit: 10,
    }), (r) => `ids=${ids(r).join(",")}`);
  await step("knowledgebase_search", () =>
    meko.call("knowledge-agent", "knowledgebase_search", {
      query: `checkout-api connection pool exhaustion resolution ${marker}`, agent_id: KNOWLEDGE_AGENT, conversation_id: readTrace, datapack_id: dp, limit: 10,
    }), (r) => `contains resolution: ${mentions(r, marker)}`);
  await step("context_search", () =>
    meko.call("knowledge-agent", "context_search", {
      query: `checkout-api connection pool exhaustion ${marker}`, agent_id: KNOWLEDGE_AGENT, conversation_id: readTrace, datapack_id: dp, limit: 10,
    }), (r) => {
      const b = (r as { results?: Record<string, unknown> }).results ?? {};
      return Object.entries(b).map(([k, v]) => `${k}:${mentions(v, marker)}`).join(" ");
    });

  // 7. Correct / forget
  if (resolutionId) {
    // Docs say memory_is_promoted; run 1 got a server serialization error instead (FRICTION_LOG #11).
    await expectError("memory_update:promoted", "*", () =>
      meko.call("engineer", "memory_update", { memory_id: resolutionId, text: "edited", agent_id: KNOWLEDGE_AGENT, conversation_id: writeConv, datapack_id: dp }));
  }
  if (findingId) {
    await step("memory_update:finding", () =>
      meko.call("engineer", "memory_update", {
        memory_id: findingId, agent_id: INVESTIGATOR, conversation_id: writeConv, datapack_id: dp,
        text: `Corrected finding for incident ${marker}: pool exhausted at max=50; idle connections were held by a long-running report query.`,
      }));
    await step("memory_delete_by_id:finding", () =>
      meko.call("engineer", "memory_delete_by_id", { memory_id: findingId, agent_id: INVESTIGATOR, conversation_id: writeConv, datapack_id: dp }));
    await expectError("memory_get_by_id:deleted", "not_found", () =>
      meko.call("investigator", "memory_get_by_id", { memory_id: findingId, agent_id: INVESTIGATOR, conversation_id: readTrace, datapack_id: dp }));
  }

  // 8. Document runbook: MCP presigned upload → indexing → knowledgebase_search
  const runbook = `# Runbook: database connection exhaustion (${marker})\n\nSymptoms: pool acquisition timeouts, active connections at max, idle at 0.\nChecks: long-running queries, leaked connections, pool max vs DB max_connections.\nMitigation: kill long-running queries, cap statement_timeout, right-size pool.\n`;
  const doc = await step("kb_upload_and_index", () =>
    uploadKnowledgeDocument(meko, "system", { datapackId: dp, conversationId: readTrace, filename: `runbook-${marker}.md`, content: runbook }),
    (r) => `state=${r.state}`);
  if (doc?.state === "completed") {
    await step("knowledgebase_search:runbook", () =>
      meko.call("knowledge-agent", "knowledgebase_search", {
        query: `runbook database connection exhaustion ${marker}`, agent_id: KNOWLEDGE_AGENT, conversation_id: readTrace, datapack_id: dp, limit: 5,
      }), (r) => `contains runbook: ${mentions(r, "statement_timeout")}, contains promoted resolution: ${mentions(r, "pool max from 50 to 120")}`);
  }

  await meko.close();

  const events = meko.log.all();
  console.log(`\n${outcomes.filter((o) => o.ok).length}/${outcomes.length} steps passed; ${events.length} Meko calls logged (${events.filter((e) => !e.ok).length} failed).`);
  console.log(`runtime datapacks: ${JSON.stringify(runtime)}`);
  const out = process.argv[2];
  if (out && !out.startsWith("--")) {
    writeFileSync(out, JSON.stringify({ marker, outcomes, captured, events }, null, 2));
    console.log(`raw responses written to ${out}`);
  }
}

async function printSchemas(meko: MekoClient) {
  const want = new Set(REQUIRED_TOOLS);
  const res = await (meko as unknown as { mcp(): { listTools(): Promise<{ tools: Array<{ name: string; inputSchema: { properties?: Record<string, { type?: string; anyOf?: Array<{ type?: string }>; items?: { type?: string } }>; required?: string[] } }> }> } }).mcp().listTools();
  for (const t of res.tools.filter((x) => want.has(x.name))) {
    const props = Object.entries(t.inputSchema.properties ?? {}).map(([k, v]) => {
      const type = v.type ?? v.anyOf?.map((a) => a.type).join("|") ?? "?";
      return `${k}:${type}${v.items?.type ? `<${v.items.type}>` : ""}`;
    });
    console.log(`${t.name} required=[${(t.inputSchema.required ?? []).join(",")}] ${props.join(" ")}`);
  }
}

main().catch((err) => {
  console.error(`SPIKE ABORTED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
