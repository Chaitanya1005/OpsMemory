import { getScenario, type IncidentInput } from "@/data/scenarios";
import { parseIncident } from "@/lib/incident";
import { errorResponse, getApp, serialized, toDto } from "../_server/opsmemory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  const app = getApp();
  return Response.json(app.store.listInvestigations(50).map((row) => toDto(app, row)));
}

/**
 * Runs one investigation through the real workflow. Body: { mode: "on" | "off" } plus one of
 *   { sampleId }  a built-in sample incident
 *   { incident }  an incident the user typed or pasted (validated)
 *   { rerunOf }   the same incident as an earlier investigation, in the other mode, under the same incident ref
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { mode?: string; sampleId?: string; incident?: unknown; rerunOf?: string };
    if (body.mode !== "on" && body.mode !== "off") return Response.json({ error: "mode must be on or off" }, { status: 400 });
    const mode = body.mode;

    let incident: IncidentInput;
    let sampleId: string | null = null;
    let incidentRef: string | undefined;
    if (body.rerunOf) {
      const prior = getApp().store.getInvestigation(body.rerunOf);
      if (!prior) return Response.json({ error: `No investigation ${body.rerunOf}` }, { status: 404 });
      incident = prior.incident as IncidentInput;
      sampleId = prior.sampleId ?? null;
      incidentRef = prior.incidentRef;
    } else if (body.sampleId) {
      incident = getScenario(body.sampleId);
      sampleId = body.sampleId;
    } else {
      incident = parseIncident(body.incident);
    }

    const rec = await serialized((app) => app.investigate(incident, mode, { incidentRef, sampleId }));
    const app = getApp();
    return Response.json(toDto(app, app.store.getInvestigation(rec.id)!));
  } catch (err) {
    return errorResponse(err);
  }
}
