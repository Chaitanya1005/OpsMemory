import { GoogleGenAI, ThinkingLevel, type GenerateContentResponse } from "@google/genai";
import { z } from "zod";
import {
  LlmError,
  type JsonRequest,
  type LlmProvider,
  type LlmResult,
  type LlmUsage,
  type ToolCall,
  type ToolRequest,
} from "./types";

const MAX_ATTEMPTS = 3;
const PROVIDER = "gemini";

export class GeminiProvider implements LlmProvider {
  readonly id = PROVIDER;
  private readonly client: GoogleGenAI;

  constructor(
    apiKey: string,
    readonly model: string,
    /** Thinking models are slow at the default level; agents only need LOW. */
    private readonly thinkingLevel: ThinkingLevel = ThinkingLevel.LOW,
  ) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async generateJson<T>(req: JsonRequest<T>): Promise<LlmResult<T>> {
    const jsonSchema = z.toJSONSchema(req.schema);
    let lastProblem = "";

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const started = Date.now();
      // On a validation retry, tell the model exactly what was wrong.
      const prompt = lastProblem
        ? `${req.prompt}\n\nYour previous reply was rejected: ${lastProblem}\nReturn JSON that matches the schema exactly.`
        : req.prompt;

      const res = await this.send(attempt, () =>
        this.client.models.generateContent({
          model: this.model,
          contents: prompt,
          config: {
            systemInstruction: req.system,
            temperature: req.temperature ?? 0.2,
            thinkingConfig: { thinkingLevel: this.thinkingLevel },
            responseMimeType: "application/json",
            responseJsonSchema: jsonSchema,
          },
        }),
      );
      if (!res) continue;

      const parsed = parseJson(res.text);
      if (!parsed.ok) {
        lastProblem = parsed.problem;
        continue;
      }
      const checked = req.schema.safeParse(parsed.value);
      if (!checked.success) {
        lastProblem = z.prettifyError(checked.error);
        continue;
      }
      return this.result(checked.data, res, started, attempt);
    }
    throw new LlmError("invalid_output", `No schema-valid JSON after ${MAX_ATTEMPTS} attempts: ${lastProblem}`, PROVIDER);
  }

  async callTools(req: ToolRequest): Promise<LlmResult<ToolCall[]>> {
    const started = Date.now();
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const res = await this.send(attempt, () =>
        this.client.models.generateContent({
          model: this.model,
          contents: req.prompt,
          config: {
            systemInstruction: req.system,
            temperature: 0,
            thinkingConfig: { thinkingLevel: this.thinkingLevel },
            tools: [
              {
                functionDeclarations: req.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  parametersJsonSchema: t.parameters,
                })),
              },
            ],
          },
        }),
      );
      if (!res) continue;
      const calls = (res.functionCalls ?? []).map((c) => ({ name: c.name ?? "", args: c.args ?? {} }));
      return this.result(calls, res, started, attempt);
    }
    throw new LlmError("unavailable", `Gemini did not respond after ${MAX_ATTEMPTS} attempts`, PROVIDER);
  }

  /** Returns null when the attempt failed transiently and should be retried. */
  private async send(
    attempt: number,
    fn: () => Promise<GenerateContentResponse>,
  ): Promise<GenerateContentResponse | null> {
    try {
      return await fn();
    } catch (err) {
      const status = statusOf(err);
      const transient = status === 429 || status === 500 || status === 503 || status === null;
      if (!transient) throw new LlmError("request", `Gemini request failed (${status}): ${messageOf(err)}`, PROVIDER);
      if (attempt === MAX_ATTEMPTS) {
        const kind = status === 429 ? "rate_limited" : "unavailable";
        throw new LlmError(kind, `Gemini failed after ${MAX_ATTEMPTS} attempts (${status ?? "network"}): ${messageOf(err)}`, PROVIDER);
      }
      await sleep(1000 * 2 ** attempt);
      return null;
    }
  }

  private result<T>(data: T, res: GenerateContentResponse, started: number, attempts: number): LlmResult<T> {
    const usage: LlmUsage = {
      inputTokens: res.usageMetadata?.promptTokenCount ?? null,
      outputTokens: res.usageMetadata?.candidatesTokenCount ?? null,
    };
    return { data, provider: PROVIDER, model: this.model, latencyMs: Date.now() - started, usage, attempts };
  }
}

function parseJson(text: string | undefined): { ok: true; value: unknown } | { ok: false; problem: string } {
  if (!text) return { ok: false, problem: "empty response" };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, problem: "response was not valid JSON" };
  }
}

function statusOf(err: unknown): number | null {
  const s = (err as { status?: unknown })?.status;
  return typeof s === "number" ? s : null;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
