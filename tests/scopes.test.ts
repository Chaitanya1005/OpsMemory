import assert from "node:assert/strict";
import { test } from "node:test";
import { MekoError } from "../lib/meko/client";
import { scopePolicy, type Datapacks } from "../lib/meko/scopes";

const dps: Datapacks = { knowledge: "dp-k", investigator: "dp-i" };
const authorize = scopePolicy(() => dps);
const blocked = (fn: () => void) => assert.throws(fn, (e: unknown) => e instanceof MekoError && e.code === "scope_violation");

test("the Knowledge Agent reads both datapacks and writes neither", () => {
  authorize("knowledge-agent", "knowledgebase_search", dps.knowledge);
  authorize("knowledge-agent", "memory_search", dps.investigator);
  blocked(() => authorize("knowledge-agent", "memory_add", dps.investigator));
  blocked(() => authorize("knowledge-agent", "memory_promote", dps.knowledge));
});

test("the Investigator writes only its own datapack and reads nothing", () => {
  authorize("investigator", "memory_add", dps.investigator);
  blocked(() => authorize("investigator", "memory_add", dps.knowledge));
  blocked(() => authorize("investigator", "memory_search", dps.investigator));
  blocked(() => authorize("investigator", "knowledgebase_search", dps.knowledge));
});

test("unknown datapacks and datapack-less calls are refused for agents", () => {
  blocked(() => authorize("engineer", "memory_add", "dp-someone-else"));
  blocked(() => authorize("engineer", "datapack_search", null));
  authorize("system", "datapack_search", null);
});
