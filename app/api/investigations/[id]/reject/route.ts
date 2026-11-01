import { errorResponse, getApp, serialized, toDto } from "../../../_server/opsmemory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Human rejection. Body: { reason } */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { reason } = (await req.json()) as { reason?: string };
    if (!reason?.trim()) return Response.json({ error: "A rejection reason is required" }, { status: 400 });
    const decision = await serialized((app) => app.reject(id, reason.trim()));
    const app = getApp();
    return Response.json({ decision, investigation: toDto(app, app.store.getInvestigation(id)!) });
  } catch (err) {
    return errorResponse(err);
  }
}
