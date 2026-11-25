/**
 * Verifies the configured LLM provider: connectivity and schema-valid JSON
 * output. Prints no secrets.
 */
import { z } from "zod";
import { getLlm } from "../../lib/llm";

const Finding = z.object({
  finding: z.string(),
  evidence: z.array(z.object({ source: z.string(), detail: z.string() })).min(1),
  confidence: z.number().min(0).max(1),
  nextStep: z.string(),
});

const LOGS = `2026-10-12T09:14:02Z ERROR checkout-api pool: timeout acquiring connection after 30000ms (active=50, idle=0, max=50)
2026-10-12T09:14:05Z WARN  checkout-api request /v1/orders took 31244ms
2026-10-12T09:14:09Z ERROR checkout-api pool: timeout acquiring connection after 30000ms (active=50, idle=0, max=50)`;

async function main() {
  const llm = getLlm();
  console.log(`provider=${llm.id} model=${llm.model}`);

  const json = await llm.generateJson({
    system: "You are an SRE log analyst. Only state what the evidence supports.",
    prompt: `Analyse these logs and return one finding.\n\n${LOGS}`,
    schema: Finding,
  });
  console.log(`JSON OK  attempts=${json.attempts} latency=${json.latencyMs}ms tokens=${json.usage.inputTokens}/${json.usage.outputTokens}`);
  console.log(JSON.stringify(json.data, null, 2));

}

main().catch((err) => {
  console.error(`FAILED: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  process.exit(1);
});
