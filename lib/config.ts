/** Runtime configuration. Secrets are read from the environment and never logged. */
export interface AppConfig {
  mekoApiKey: string;
  /** Datapack names are `${prefix}-knowledge` and `${prefix}-investigator`. */
  datapackPrefix: string;
  dbPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    mekoApiKey: env.MEKO_API_KEY ?? "",
    datapackPrefix: env.MEKO_DATAPACK_PREFIX ?? "opsmemory",
    dbPath: env.OPSMEMORY_DB ?? "data/opsmemory.db",
  };
}
