/**
 * End-to-end test of the OpsMemory workflow against live Meko and Gemini.
 *
 *   npm run e2e                 # 3 ON and 3 OFF runs of the second incident
 *   E2E_RUNS=5 npm run e2e
 *
 * Uses dedicated datapacks (opsmemory-e2e-*) and a separate SQLite file, because
 * promoted memories cannot be deleted through MCP and would pollute the demo datapacks.
 */
import { randomUUID } from "node:crypto";
import { getScenario } from "../data/scenarios";
import { buildInvestigatorPrompt } from "../lib/agents/investigator";
import { analyzeLogs } from "../lib/analysis/logs";
import { loadConfig } from "../lib/config";
import { OpsMemory, type ApprovalDecision, type InvestigationRecord } from "../lib/workflow";
import { printEvents, printInvestigation, truncate } from "./format";

const RUNS = Number(process.env.E2E_RUNS ?? 3);
const results: Array<{ step: string; status: "PASS" | "FAIL" | "WARN"; detail: string }> = [];
const record = (step: string, ok: boolean | "warn", detail: string) => {
  const status = ok === "warn" ? "WARN" : ok ? "PASS" : "FAIL";
  results.push({ step, status, detail });
  console.log(`\n${status}  ${step} — ${detail}`);
};

/** Per-run measurements. Constraint facts (200 max_connections, 80 per-service budget) exist only in the promoted memory. */
interface RunMetrics {
  mode: "on" | "off";
  mekoCalls: number;
  recalledPromoted: boolean;
  citedPromoted: boolean;
  historyConfigChanges: number;
  assumptionConfigChanges: number;
  mentionsVerifiedConstraint: boolean;
  acknowledgesUnknownLimit: boolean;
  confidence: number;
  integrityWarnings: number;
  rootCause: string;
  configChanges: string[];
}

function measure(rec: InvestigationRecord, decision: ApprovalDecision): RunMetrics {
  const inv = rec.result.outcome.investigation;
  const promoted = rec.knowledge?.retrieved.find((i) => i.kind === "verified_resolution" && i.source.memoryId && decision.memoryIds.includes(i.source.memoryId));
  const fixText = [...inv.recommendedFix.immediate, ...inv.recommendedFix.longTerm, ...inv.recommendedFix.configChanges.map((c) => `${c.setting} ${c.value} ${c.rationale}`)].join(" ");
  return {
    mode: rec.mode,
    mekoCalls: rec.mekoCalls,
    recalledPromoted: Boolean(promoted),
    citedPromoted: Boolean(promoted && inv.historicalContextUsed.some((h) => h.ref === promoted.ref)),
    historyConfigChanges: inv.recommendedFix.configChanges.filter((c) => c.source === "history" && (!promoted || c.ref === promoted.ref)).length,
    assumptionConfigChanges: inv.recommendedFix.configChanges.filter((c) => c.source === "assumption").length,
    mentionsVerifiedConstraint: /(?<![\w.])(80|200)(?![\w.])/.test(fixText),
    acknowledgesUnknownLimit: inv.unresolvedQuestions.some((q) => /max_connections|connection limit|maximum (number of )?connections|database (connection )?(limit|capacity)|connection budget|safe (pool|value)/i.test(q)),
    confidence: inv.confidence,
    integrityWarnings: rec.result.outcome.integrityWarnings.length,
    rootCause: inv.rootCause.statement,
    configChanges: inv.recommendedFix.configChanges.map((c) => `${c.setting}=${c.value} [${c.source}${c.ref ? `:${c.ref}` : ""}]`),
  };
}

async function main() {
  const config = { ...loadConfig(), datapackPrefix: process.env.MEKO_DATAPACK_PREFIX ?? "opsmemory-e2e", dbPath: process.env.OPSMEMORY_DB ?? "data/e2e.db" };
  const app = new OpsMemory(config);
  console.log(`datapack prefix: ${config.datapackPrefix} | model: ${app.llm.id}/${app.llm.model} | runs per mode: ${RUNS}`);

  try {
    const { meko, datapacks } = await app.meko();
    const before = await meko.call<{ total?: number }>("system", "memory_get_all", {
      conversation_id: randomUUID().replaceAll("-", ""), datapack_id: datapacks.knowledge, promoted: true,
    });
    const priorVerified = before.total ?? 0;
    console.log(`knowledge datapack ${datapacks.knowledge} holds ${priorVerified} promoted resolution(s) before this run`);

    // 1. First incident, Meko ON.
    const scenario1 = getScenario("db-pool-1");
    const first = await app.investigate(scenario1, "on");
    printInvestigation(first);
    const firstVerified = first.knowledge?.retrieved.filter((i) => i.kind === "verified_resolution") ?? [];
    record("1. First incident investigated (Meko ON)", priorVerified === 0 ? firstVerified.length === 0 : "warn",
      priorVerified === 0 ? `no verified knowledge existed; ${first.mekoCalls} Meko calls` : `${priorVerified} promoted resolution(s) from earlier test runs already in the datapack; ${firstVerified.length} retrieved`);

    // 2–3. Engineer approves with the DBA-validated constraint, then it is promoted.
    const decision = await app.approve(first.id, scenario1.approvalEdit);
    record("2. Engineer-edited resolution stored in Meko", decision.memoryIds.length > 0 && decision.edited, `memory ${decision.memoryIds.join(",")}`);
    console.log(`   stored text (verbatim from memory_add): ${decision.storedText.join(" | ")}`);
    record("3. Promoted and retrievable", decision.promotion.inserted.length > 0 && decision.retrievableAfterPromotion,
      `inserted=${decision.promotion.inserted.length} not_found=${decision.promotion.notFound.length} retrievable=${decision.retrievableAfterPromotion}`);
    printEvents(app.store.events(first.id).filter((e) => e.actor === "engineer"));

    // 4–5. Second incident, repeated in both modes with the same incident ref.
    const scenario2 = getScenario("db-pool-2");
    const runs: Array<{ rec: InvestigationRecord; m: RunMetrics }> = [];
    let incidentRef: string | undefined;
    for (let i = 0; i < RUNS; i++) {
      for (const mode of ["on", "off"] as const) {
        const rec = await app.investigate(scenario2, mode, { incidentRef });
        incidentRef ??= rec.incidentRef;
        runs.push({ rec, m: measure(rec, decision) });
        if (i === 0) printInvestigation(rec);
      }
    }
    const on = runs.filter((r) => r.m.mode === "on");
    const off = runs.filter((r) => r.m.mode === "off");

    // Exact recalled memory and how it influenced each ON run.
    console.log("\n================ RECALLED MEMORY AND ITS INFLUENCE (Meko ON) ================");
    on.forEach(({ rec }, i) => {
      const item = rec.knowledge?.retrieved.find((x) => x.source.memoryId && decision.memoryIds.includes(x.source.memoryId));
      if (!item) return console.log(`run ${i + 1}: promoted memory NOT retrieved`);
      if (i === 0) console.log(`memory ${item.source.memoryId} (${item.source.datapack}/${item.source.tool}):\n  "${item.text}"`);
      const used = rec.result.outcome.investigation.historicalContextUsed.find((h) => h.ref === item.ref);
      console.log(`run ${i + 1}: ${item.ref} judged relevant=${rec.knowledge!.relevant.some((r) => r.ref === item.ref)}; how used: ${used ? used.how : "not cited"}`);
    });

    const all = (xs: typeof runs, f: (m: RunMetrics) => boolean) => xs.filter((r) => f(r.m)).length;
    record("4a. ON recalled the promoted memory every run", all(on, (m) => m.recalledPromoted) === RUNS, `${all(on, (m) => m.recalledPromoted)}/${RUNS}`);
    record("4b. ON cited it every run", all(on, (m) => m.citedPromoted) === RUNS, `${all(on, (m) => m.citedPromoted)}/${RUNS}`);
    record("4c. ON took config values from it every run", all(on, (m) => m.historyConfigChanges > 0) === RUNS, `${all(on, (m) => m.historyConfigChanges > 0)}/${RUNS} runs had config changes sourced to the memory`);
    record("5a. OFF made zero Meko calls", all(off, (m) => m.mekoCalls === 0) === RUNS, `${all(off, (m) => m.mekoCalls === 0)}/${RUNS}`);
    record("5b. OFF cited no history", off.every((r) => r.rec.result.outcome.investigation.historicalContextUsed.length === 0), "");
    const offUncertain = all(off, (m) => m.acknowledgesUnknownLimit || m.assumptionConfigChanges > 0);
    record("5c. OFF acknowledged uncertainty about the safe limit", offUncertain === RUNS ? true : offUncertain > 0 ? "warn" : false,
      `${offUncertain}/${RUNS} runs flagged the unknown limit or marked values as assumptions`);
    const diff = all(on, (m) => m.mentionsVerifiedConstraint) === RUNS && all(off, (m) => m.mentionsVerifiedConstraint) === 0;
    record("6a. Meaningful difference: verified constraint (200 / 80) applied only with Meko",
      diff, `ON ${all(on, (m) => m.mentionsVerifiedConstraint)}/${RUNS}, OFF ${all(off, (m) => m.mentionsVerifiedConstraint)}/${RUNS}`);

    const analysis = analyzeLogs(scenario2.logs);
    const pOn = buildInvestigatorPrompt(scenario2, analysis, on[0]?.rec.knowledge?.relevant ?? []);
    const pOff = buildInvestigatorPrompt(scenario2, analysis, []);
    const models = new Set(runs.map((r) => r.rec.result.outcome.llm.model));
    record("6b. Same incident, instructions and model", pOn.split("HISTORICAL CONTEXT")[0] === pOff.split("HISTORICAL CONTEXT")[0] && models.size === 1,
      `prompts identical before HISTORICAL CONTEXT; models=${[...models].join(",")}`);

    table(runs);
  } catch (err) {
    record("aborted", false, err instanceof Error ? err.message : String(err));
  } finally {
    await app.close();
  }

  console.log("\n================ E2E SUMMARY ================");
  for (const r of results) console.log(`${r.status.padEnd(5)} ${r.step}${r.detail ? ` — ${truncate(r.detail, 90)}` : ""}`);
  const failed = results.filter((r) => r.status === "FAIL").length;
  console.log(failed ? `${failed} step(s) FAILED` : "all required steps passed");
  process.exit(failed ? 1 : 0);
}

function table(runs: Array<{ m: RunMetrics }>) {
  console.log("\n================ SECOND INCIDENT: PER-RUN COMPARISON ================");
  console.log("run mode meko recalled cited cfg(hist/assume) constraint unknown-limit conf  warnings");
  runs.forEach(({ m }, i) => {
    console.log(`${String(Math.floor(i / 2) + 1).padEnd(3)} ${m.mode.padEnd(4)} ${String(m.mekoCalls).padEnd(4)} ${String(m.recalledPromoted).padEnd(8)} ${String(m.citedPromoted).padEnd(5)} ${`${m.historyConfigChanges}/${m.assumptionConfigChanges}`.padEnd(16)} ${String(m.mentionsVerifiedConstraint).padEnd(10)} ${String(m.acknowledgesUnknownLimit).padEnd(13)} ${m.confidence.toFixed(2)}  ${m.integrityWarnings}`);
  });
  console.log("\nRoot cause and config changes per run:");
  runs.forEach(({ m }, i) => {
    console.log(`  ${m.mode.toUpperCase()} #${Math.floor(i / 2) + 1}: ${truncate(m.rootCause, 150)}`);
    console.log(`         ${m.configChanges.join("; ") || "no concrete config values"}`);
  });
}

main();
