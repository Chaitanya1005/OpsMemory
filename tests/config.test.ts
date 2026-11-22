import assert from "node:assert/strict";
import { test } from "node:test";
import { configProblems, loadConfig } from "../lib/config";
import { llmSettings } from "../lib/llm";

test("a complete configuration has no problems", () => {
  assert.deepEqual(configProblems({ MEKO_API_KEY: "k", GEMINI_API_KEY: "g" }), []);
});

test("missing keys and bad values are reported by name, never by value", () => {
  const problems = configProblems({ GEMINI_THINKING_LEVEL: "extreme", MEKO_DATAPACK_PREFIX: "Ops Memory", LLM_PROVIDER: "gemini" });
  assert.equal(problems.length, 4);
  assert.match(problems.join("\n"), /MEKO_API_KEY is not set/);
  assert.match(problems.join("\n"), /GEMINI_API_KEY is not set/);
});

test("defaults: demo datapacks, local database, no datapack creation, the fast model", () => {
  const c = loadConfig({});
  assert.equal(c.datapackPrefix, "opsmemory");
  assert.equal(c.dbPath, "data/opsmemory.db");
  assert.equal(c.createDatapacks, false);
  assert.equal(llmSettings({}).model, "gemini-3.5-flash-lite");
  assert.equal(llmSettings({}).configured, false);
});
