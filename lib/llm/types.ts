import type { z } from "zod";

/**
 * Provider-agnostic LLM contract. Agents depend only on this interface,
 * so adding a provider (e.g. Groq as a fallback) means adding one file.
 */
export interface LlmProvider {
  readonly id: string;
  readonly model: string;
  generateJson<T>(req: JsonRequest<T>): Promise<LlmResult<T>>;
  callTools(req: ToolRequest): Promise<LlmResult<ToolCall[]>>;
}

export interface JsonRequest<T> {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  /** Lower is more deterministic; agents default to 0.2. */
  temperature?: number;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema object describing the arguments. */
  parameters: Record<string, unknown>;
}

export interface ToolRequest {
  system: string;
  prompt: string;
  tools: ToolSpec[];
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface LlmUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface LlmResult<T> {
  data: T;
  provider: string;
  model: string;
  latencyMs: number;
  usage: LlmUsage;
  attempts: number;
}

export type LlmErrorKind = "config" | "rate_limited" | "unavailable" | "invalid_output" | "request";

export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly provider: string,
  ) {
    super(message);
    this.name = "LlmError";
  }
}
