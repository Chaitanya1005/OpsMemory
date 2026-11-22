import { errorResponse, getApp, serialized, toDto } from "../../../_server/opsmemory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Human approval: stores and promotes the resolution in Meko. Body: { rootCause?, fix?, notes? } */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const body = (await req.json()) as { rootCause?: string; fix?: string; notes?: string };
    const clean = (v?: string) => (v?.trim() ? v.trim() : undefined);
    const decision = await serialized((app) => app.approve(id, { rootCause: clean(body.rootCause), fix: clean(body.fix), notes: clean(body.notes) }));
    const app = getApp();
    return Response.json({ decision, investigation: toDto(app, app.store.getInvestigation(id)!) });
  } catch (err) {
    return errorResponse(err);
  }
}
