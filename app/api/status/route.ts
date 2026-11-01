import { loadConfig } from "@/lib/config";
import { datapackNames } from "@/lib/meko/scopes";
import { getApp } from "../_server/opsmemory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Configuration the UI may show. Never includes keys. Does not open a Meko connection. */
export function GET() {
  const config = loadConfig();
  const app = getApp();
  return Response.json({
    model: app.llm.model,
    provider: app.llm.id,
    datapackPrefix: config.datapackPrefix,
    datapacks: datapackNames(config.datapackPrefix),
    mekoConfigured: Boolean(config.mekoApiKey),
  });
}
