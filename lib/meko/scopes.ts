import { randomUUID } from "node:crypto";
import { z } from "zod";
import { MekoError, type MekoClient } from "./client";
import type { MekoActor } from "./events";

/**
 * Datapack roles:
 *  - knowledge:    shared institutional knowledge (promoted, human-approved resolutions; runbooks)
 *  - investigator: the Investigator's working context (per-incident conversations, unverified findings)
 */
export type DatapackRole = "knowledge" | "investigator";
export type Datapacks = Record<DatapackRole, string>;

/**
 * Which agent may touch which datapack. Meko scopes by datapack + user, and the
 * whole app runs under one API key, so `agent_id` alone cannot isolate agents
 * (FRICTION_LOG #1). This policy enforces the boundaries before any call is made.
 */
export const ACCESS: Record<MekoActor, { read: DatapackRole[]; write: DatapackRole[] }> = {
  // Reads verified knowledge and the Investigator's prior (unverified) observations. Never writes.
  "knowledge-agent": { read: ["knowledge", "investigator"], write: [] },
  // Writes only its own working context. Receives history only via the Knowledge Agent's brief.
  investigator: { read: [], write: ["investigator"] },
  // Human approval: writes and promotes into shared knowledge; records rejections as observations.
  engineer: { read: ["knowledge"], write: ["knowledge", "investigator"] },
  system: { read: ["knowledge", "investigator"], write: ["knowledge", "investigator"] },
};

const WRITE_OPS = new Set([
  "conversation_create", "conversation_add_message", "conversation_update", "conversation_delete",
  "memory_add", "memory_update", "memory_delete_by_id", "memory_delete_all", "memory_promote",
  "knowledgebase_upload_document", "knowledgebase_delete_document", "artifact_put", "datapack_create",
]);

export function datapackNames(prefix: string): Record<DatapackRole, string> {
  return { knowledge: `${prefix}-knowledge`, investigator: `${prefix}-investigator` };
}

/** Builds the authorize hook for MekoClient from resolved datapack ids. */
export function scopePolicy(getDatapacks: () => Datapacks | null) {
  return (actor: MekoActor, op: string, datapackId: string | null) => {
    const dps = getDatapacks();
    // Datapack discovery happens before ids are known; only the system actor may do it.
    if (!dps || datapackId === null) {
      if (actor === "system") return;
      throw new MekoError("scope_violation", `${actor} may not call ${op} without a datapack`, op);
    }
    const role = (Object.keys(dps) as DatapackRole[]).find((r) => dps[r] === datapackId);
    if (!role) throw new MekoError("scope_violation", `${actor} may not use unknown datapack ${datapackId}`, op);
    const allowed = WRITE_OPS.has(op) ? ACCESS[actor].write : ACCESS[actor].read;
    if (!allowed.includes(role)) {
      throw new MekoError("scope_violation", `${actor} may not ${WRITE_OPS.has(op) ? "write to" : "read from"} the ${role} datapack (${op})`, op);
    }
  };
}

const SearchResult = z.object({ datapacks: z.array(z.object({ datapack_id: z.string(), grant: z.string() })) });
const Created = z.object({ datapack_id: z.string() });

/** Looks up both runtime datapacks by exact name, creating any that are missing. */
export async function resolveDatapacks(meko: MekoClient, prefix: string): Promise<Datapacks> {
  const trace = randomUUID().replaceAll("-", "");
  const names = datapackNames(prefix);
  const out = {} as Datapacks;
  for (const role of Object.keys(names) as DatapackRole[]) {
    const found = await meko.call("system", "datapack_search", { name: names[role], conversation_id: trace }, SearchResult);
    const existing = found.datapacks[0];
    if (existing) {
      if (existing.grant !== "owner" && existing.grant !== "maintainer") {
        throw new MekoError("insufficient_role", `${names[role]} grant is ${existing.grant}; promotion needs owner or maintainer`, "datapack_search");
      }
      out[role] = existing.datapack_id;
    } else {
      out[role] = (await meko.call("system", "datapack_create", { name: names[role], conversation_id: trace }, Created)).datapack_id;
    }
  }
  return out;
}
