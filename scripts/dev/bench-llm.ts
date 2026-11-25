/**
 * Benchmarks candidate Gemini models with repeated JSON and plain-text calls.
 *   npm run bench:llm -- [runs] [model ...]
 * Uses GEMINI_API_KEY from .env.local; prints no secrets.
 */
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { z } from "zod";
import { GeminiProvider } from "../../lib/llm/gemini";

const DEFAULT_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-flash-lite-latest", "gemini-3.5-flash"];
const Schema = z.object({ rootCause: z.string(), confidence: z.number().min(0).max(1) });
const PROMPT = "Logs: pool timeout acquiring connection (active=50, idle=0, max=50); /v1/orders took 31244ms. Give the most likely root cause.";

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : NaN;
};

async function main() {
  const runs = Number(process.argv[2] ?? 5);
  const models = process.argv.slice(3).length ? process.argv.slice(3) : DEFAULT_MODELS;
  const key = process.env.GEMINI_API_KEY ?? "";
  const raw = new GoogleGenAI({ apiKey: key });

  for (const model of models) {
    const llm = new GeminiProvider(key, model, ThinkingLevel.LOW);
    const json: number[] = [];
    const text: number[] = [];
    const errors: string[] = [];
    for (let i = 0; i < runs; i++) {
      try {
        const r = await llm.generateJson({ system: "You are an SRE.", prompt: PROMPT, schema: Schema });
        json.push(r.latencyMs);
        if (r.attempts > 1) errors.push(`json needed ${r.attempts} attempts`);
      } catch (e) {
        errors.push(`json: ${(e as Error).message.slice(0, 80)}`);
      }
      const t0 = Date.now();
      try {
        const r = await raw.models.generateContent({
          model, contents: PROMPT, config: { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } },
        });
        if (!r.text) throw new Error("empty text");
        text.push(Date.now() - t0);
      } catch (e) {
        errors.push(`text: ${(e as Error).message.slice(0, 80)}`);
      }
    }
    const fmt = (xs: number[]) => (xs.length ? `median ${median(xs)}ms max ${Math.max(...xs)}ms (${xs.length}/${runs} ok)` : `0/${runs} ok`);
    console.log(`${model.padEnd(26)} json: ${fmt(json)} | text: ${fmt(text)}${errors.length ? ` | errors: ${[...new Set(errors)].join("; ")}` : ""}`);
  }
}

main().catch((e) => {
  console.error(`ABORTED: ${(e as Error).message}`);
  process.exit(1);
});
