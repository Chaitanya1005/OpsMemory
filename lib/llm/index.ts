import { ThinkingLevel } from "@google/genai";
import { GeminiProvider } from "./gemini";
import { LlmError, type LlmProvider } from "./types";

export * from "./types";

/**
 * Selects the provider from LLM_PROVIDER (default "gemini").
 * Both Meko ON and OFF runs go through the same instance, so the
 * model configuration never differs between modes.
 */
export function getLlm(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const provider = env.LLM_PROVIDER ?? "gemini";
  switch (provider) {
    case "gemini": {
      const key = env.GEMINI_API_KEY;
      if (!key) throw new LlmError("config", "GEMINI_API_KEY is not set", provider);
      const level = (env.GEMINI_THINKING_LEVEL ?? "LOW").toUpperCase();
      if (!Object.values(ThinkingLevel).includes(level as ThinkingLevel)) {
        throw new LlmError("config", `Invalid GEMINI_THINKING_LEVEL "${level}"`, provider);
      }
      return new GeminiProvider(key, env.GEMINI_MODEL ?? "gemini-3.8-flash", level as ThinkingLevel);
    }
    default:
      throw new LlmError("config", `Unknown LLM_PROVIDER "${provider}"`, provider);
  }
}
