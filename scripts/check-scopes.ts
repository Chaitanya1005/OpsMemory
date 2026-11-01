/**
 * Proves datapack isolation and the promoted-knowledge retrieval path
 * against live Meko. Writes only short-lived markers, deleted at the end.
 *
 *   npm run check:scopes
 */
import { randomUUID } from "node:crypto";
import { MekoClient, MekoError } from "../lib/meko/client";

const NAMES = { knowledge: "opsmemory-knowledge", investigator: "opsmemory-investigator", spike: "opsmemory-spike" } as const;
const SPIKE_EXTRACTED_ID = "5d941418-f989-469b-b8e4-327950e1b5c0";
const SPIKE_RUN1_PROMOTED = { memoryId: "768e803a-ffb4-49e2-8405-db332f3ee35c", documentId: "86114543-4663-433a-b1a9-66a8911074d4" };

const trace = randomUUID().replaceAll("-", "");
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const memIds = (r: unknown) => ((r as { results?: Array<{ id: string }> }).results ?? []).map((x) => x.id);
const kbMemoryIds = (r: unknown) =>
  ((r as { results?: Array<{ metadata_filters?: { memory_id?: string } }> }).results ?? []).map((x) => x.metadata_filters?.memory_id).filter(Boolean);

async function main() {
  const meko = await MekoClient.connect({ apiKey: process.env.MEKO_API_KEY ?? "" });
  const dp: Record<keyof typeof NAMES, string> = { knowledge: "", investigator: "", spike: "" };
  for (const [k, name] of Object.entries(NAMES) as Array<[keyof typeof NAMES, string]>) {
    const r = await meko.call<{ datapacks: Array<{ datapack_id: string }> }>("system", "datapack_search", { name, conversation_id: trace });
    dp[k] = r.datapacks[0]?.datapack_id ?? "";
    check(`datapack exists: ${name}`, Boolean(dp[k]), dp[k]);
  }

  // 1. The auto-extracted spike memory is visible only in the spike datapack.
  const q = "checkout-api timing out acquiring database connections pool saturation spike-mvwu7wbe";
  for (const k of ["spike", "knowledge", "investigator"] as const) {
    const r = await meko.call("system", "memory_search", { query: q, conversation_id: trace, datapack_id: dp[k], limit: 10 });
    const found = memIds(r).includes(SPIKE_EXTRACTED_ID);
    check(`extracted spike memory ${k === "spike" ? "visible in" : "absent from"} ${NAMES[k]}`, k === "spike" ? found : !found, `${memIds(r).length} results`);
  }

  // 2. A marker written to the investigator datapack does not leak into the knowledge datapack.
  const conv = await meko.call<{ id: string }>("investigator", "conversation_create", {
    agent_id: "opsmemory_investigator", datapack_id: dp.investigator, title: "scope check",
  });
  const marker = `scope-marker-${Date.now().toString(36)}`;
  const added = await meko.call("investigator", "memory_add", {
    text: `Isolation marker ${marker}: orders-api replica lag observed during scope check.`,
    agent_id: "opsmemory_investigator", conversation_id: conv.id, datapack_id: dp.investigator,
    metadata: JSON.stringify({ kind: "scope-check" }),
  });
  const markerIds = memIds(added);
  check("marker written to investigator datapack", markerIds.length > 0, markerIds.join(","));
  const inInv = await meko.call("system", "memory_search", { query: `isolation marker ${marker} replica lag`, conversation_id: trace, datapack_id: dp.investigator });
  const inKnow = await meko.call("system", "memory_search", { query: `isolation marker ${marker} replica lag`, conversation_id: trace, datapack_id: dp.knowledge });
  check("marker found in investigator datapack", memIds(inInv).some((id) => markerIds.includes(id)));
  check("marker absent from knowledge datapack", !memIds(inKnow).some((id) => markerIds.includes(id)), `${memIds(inKnow).length} results`);

  // 3. Promoted knowledge in the spike datapack is invisible to the runtime knowledge datapack's KB.
  const kbQ = "verified resolution checkout-api DB connection exhaustion raise pool max";
  const kbSpike = await meko.call("knowledge-agent", "knowledgebase_search", { query: kbQ, conversation_id: trace, datapack_id: dp.spike, limit: 10 });
  const kbKnow = await meko.call("knowledge-agent", "knowledgebase_search", { query: kbQ, conversation_id: trace, datapack_id: dp.knowledge, limit: 10 });
  check("spike promoted resolutions visible via knowledgebase_search in spike", kbMemoryIds(kbSpike).length > 0, `memory_ids=${kbMemoryIds(kbSpike).join(",")}`);
  check("spike promoted resolutions absent from opsmemory-knowledge KB", kbMemoryIds(kbKnow).length === 0, `${((kbKnow as { results?: unknown[] }).results ?? []).length} results`);

  // 4. Forgetting verified knowledge: a promoted memory's KB document_id is its conversation id.
  try {
    const del = await meko.call("engineer", "knowledgebase_delete_document", {
      document_id: SPIKE_RUN1_PROMOTED.documentId, conversation_id: trace, datapack_id: dp.spike,
    });
    console.log(`      delete response: ${JSON.stringify(del).slice(0, 200)}`);
    const after = await meko.call("knowledge-agent", "knowledgebase_search", { query: kbQ, conversation_id: trace, datapack_id: dp.spike, limit: 10 });
    check("deleted promoted resolution no longer retrievable", !kbMemoryIds(after).includes(SPIKE_RUN1_PROMOTED.memoryId), `remaining=${kbMemoryIds(after).join(",")}`);
  } catch (err) {
    // Known limitation (FRICTION_LOG #14): promoted memories are not KB documents, so MCP cannot forget them.
    const notFound = err instanceof MekoError && err.code === "NOT_FOUND";
    if (!notFound) check("knowledgebase_delete_document on promoted memory", false, String(err));
    else console.log("LIMIT promoted memory cannot be deleted via knowledgebase_delete_document (NOT_FOUND) — portal only");
  }

  // Cleanup the isolation marker.
  for (const id of markerIds) {
    await meko.call("system", "memory_delete_by_id", { memory_id: id, agent_id: "opsmemory_investigator", conversation_id: conv.id, datapack_id: dp.investigator });
  }
  await meko.call("system", "conversation_delete", { conversation_id: conv.id, agent_id: "opsmemory_investigator", datapack_id: dp.investigator });
  console.log(`cleanup: removed ${markerIds.length} marker memories and the scope-check conversation`);

  await meko.close();
  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}; ${meko.log.all().length} Meko calls (${meko.log.all().filter((e) => !e.ok).length} errors)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`ABORTED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
