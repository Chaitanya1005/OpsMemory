import { getScenario } from "@/data/scenarios";
import { errorResponse, getApp, serialized, toDto } from "../_server/opsmemory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  const app = getApp();
  return Response.json(app.store.listInvestigations(50).map((row) => toDto(app, row)));
}

/** Runs one investigation through the real workflow. Body: { scenarioId, mode: "on" | "off", incidentRef? } */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { scenarioId?: string; mode?: string; incidentRef?: string };
    if (body.mode !== "on" && body.mode !== "off") return Response.json({ error: "mode must be on or off" }, { status: 400 });
    const scenario = getScenario(body.scenarioId ?? "");
    const mode = body.mode;
    const rec = await serialized((app) => app.investigate(scenario, mode, { incidentRef: body.incidentRef || undefined }));
    const app = getApp();
    return Response.json(toDto(app, app.store.getInvestigation(rec.id)!));
  } catch (err) {
    return errorResponse(err);
  }
}
