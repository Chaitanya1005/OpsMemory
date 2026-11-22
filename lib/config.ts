/** Runtime configuration. Secrets are read from the environment and never logged. */
export interface AppConfig {
  mekoApiKey: string;
  /** Datapack names are `${prefix}-knowledge` and `${prefix}-investigator`. */
  datapackPrefix: string;
  dbPath: string;
  /** Create missing datapacks on first connect. Off by default so a mistyped prefix fails instead of silently starting empty. */
  createDatapacks: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    mekoApiKey: env.MEKO_API_KEY ?? "",
    datapackPrefix: env.MEKO_DATAPACK_PREFIX ?? "opsmemory",
    dbPath: env.OPSMEMORY_DB ?? "data/opsmemory.db",
    createDatapacks: env.MEKO_CREATE_DATAPACKS === "true",
  };
}

const THINKING_LEVELS = ["MINIMAL", "LOW", "MEDIUM", "HIGH"];

/** Problems that would make the server fail on its first real request. Names settings only, never values. */
export function configProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];
  if (!env.MEKO_API_KEY) problems.push("MEKO_API_KEY is not set (needed for Meko ON investigations)");
  const provider = env.LLM_PROVIDER ?? "gemini";
  if (provider !== "gemini") problems.push(`LLM_PROVIDER "${provider}" is not supported (only "gemini")`);
  else if (!env.GEMINI_API_KEY) problems.push("GEMINI_API_KEY is not set (needed for every investigation)");
  const level = (env.GEMINI_THINKING_LEVEL ?? "LOW").toUpperCase();
  if (!THINKING_LEVELS.includes(level)) problems.push(`GEMINI_THINKING_LEVEL "${level}" must be one of ${THINKING_LEVELS.join(", ")}`);
  const prefix = env.MEKO_DATAPACK_PREFIX ?? "opsmemory";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(prefix)) problems.push(`MEKO_DATAPACK_PREFIX "${prefix}" may only contain lowercase letters, digits and hyphens`);
  return problems;
}
