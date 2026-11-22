import { loadConfig } from "@/lib/config";
import { llmSettings } from "@/lib/llm";
import { datapackNames } from "@/lib/meko/scopes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Configuration the UI may show. Never includes keys. Opens no Meko connection and needs no LLM key. */
export function GET() {
  const config = loadConfig();
  const llm = llmSettings();
  return Response.json({
    model: llm.model,
    provider: llm.provider,
    llmConfigured: llm.configured,
    datapackPrefix: config.datapackPrefix,
    datapacks: datapackNames(config.datapackPrefix),
    mekoConfigured: Boolean(config.mekoApiKey),
  });
}
