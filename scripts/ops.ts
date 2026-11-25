/**
 * OpsMemory command-line workflow (backend only, no UI yet).
 *
 *   npm run ops -- scenarios
 *   npm run ops -- investigate <scenario> [--meko on|off] [--ref INC-...]
 *   npm run ops -- approve <investigation-id> [--notes "..."] [--root-cause "..."] [--fix "..."] [--scenario-edit db-pool-1]
 *   npm run ops -- reject <investigation-id> --reason "..."
 *   npm run ops -- list
 *   npm run ops -- events [investigation-id]
 */
import { SCENARIOS, getScenario } from "../data/scenarios";
import { loadConfig } from "../lib/config";
import { OpsMemory, type InvestigationRecord } from "../lib/workflow";
import { printEvents, printInvestigation } from "./format";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "scenarios") {
    for (const s of SCENARIOS) console.log(`${s.id.padEnd(16)} ${s.service.padEnd(20)} ${s.summary}`);
    return;
  }

  const app = new OpsMemory(loadConfig());
  try {
    switch (cmd) {
      case "investigate": {
        const scenario = getScenario(args[0] ?? "");
        const mode = (flag(args, "meko") ?? "on") as "on" | "off";
        if (mode !== "on" && mode !== "off") throw new Error("--meko must be on or off");
        const rec = await app.investigate(scenario, mode, { incidentRef: flag(args, "ref"), sampleId: scenario.id });
        printInvestigation(rec);
        console.log("\n   Meko calls for this investigation:");
        printEvents(app.store.events(rec.id));
        if (mode === "on") console.log(`\n   Next: npm run ops -- approve ${rec.id}   or   npm run ops -- reject ${rec.id} --reason "..."`);
        break;
      }
      case "approve": {
        // --scenario-edit <id> applies that scenario's scripted engineer edit (demo convenience).
        const edit = flag(args, "scenario-edit") ? getScenario(flag(args, "scenario-edit")!).approvalEdit : undefined;
        const d = await app.approve(args[0] ?? "", {
          notes: flag(args, "notes") ?? edit?.notes, rootCause: flag(args, "root-cause"), fix: flag(args, "fix") ?? edit?.fix,
        });
        console.log(`Approved at ${d.approvedAt}${d.edited ? " (edited by engineer)" : ""}`);
        console.log(`Stored in Meko as: ${d.storedText.join(" | ")}`);
        console.log(`Memory ids: ${d.memoryIds.join(", ")}`);
        console.log(`Promotion: inserted=${d.promotion.inserted.length} updated=${d.promotion.updated.length} not_found=${d.promotion.notFound.length}`);
        console.log(`Retrievable via knowledgebase_search after promotion: ${d.retrievableAfterPromotion ? "YES" : "NO"}`);
        printEvents(app.store.events(args[0]).filter((e) => e.actor === "engineer"));
        break;
      }
      case "reject": {
        const reason = flag(args, "reason");
        if (!reason) throw new Error("--reason is required");
        const d = await app.reject(args[0] ?? "", reason);
        console.log(`Rejected at ${d.rejectedAt}. Observation memories: ${d.observationMemoryIds.join(", ") || "none (Meko OFF)"}`);
        break;
      }
      case "list": {
        for (const r of app.store.listInvestigations()) {
          const inc = r.incident as { service: string; title: string };
          console.log(`${r.id}  ${r.createdAt.slice(0, 19)}  ${r.incidentRef}  Meko ${r.mode.toUpperCase().padEnd(3)}  ${r.status.padEnd(8)}  ${inc.service} — ${inc.title}`);
        }
        break;
      }
      case "events":
        printEvents(app.store.events(args[0]));
        break;
      case "show": {
        const r = app.store.getInvestigation(args[0] ?? "");
        if (!r) throw new Error(`No investigation ${args[0]}`);
        if (r.status === "failed") {
          // A failed run has no outcome to print, only the error it stopped with.
          console.log(`${r.id}  ${r.incidentRef}  Meko ${r.mode.toUpperCase()}  failed: ${(r.result as { error?: string } | null)?.error ?? "unknown error"}`);
          break;
        }
        printInvestigation({ ...(r as unknown as InvestigationRecord), mekoCalls: app.store.events(r.id).length });
        console.log(`\n   Decision: ${r.decision ? JSON.stringify(r.decision, null, 2) : "pending"}`);
        break;
      }
      default:
        throw new Error(`Unknown command "${cmd}"`);
    }
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
