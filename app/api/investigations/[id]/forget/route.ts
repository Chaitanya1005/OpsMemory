import { errorResponse, getApp, serialized, toDto } from "../../../_server/opsmemory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Forget an unverified observation from Meko (investigator datapack only). Body: { memoryId } */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { memoryId } = (await req.json()) as { memoryId?: string };
    if (!memoryId) return Response.json({ error: "memoryId is required" }, { status: 400 });
    const result = await serialized((app) => app.forget(id, memoryId));
    const app = getApp();
    return Response.json({ result, investigation: toDto(app, app.store.getInvestigation(id)!) });
  } catch (err) {
    return errorResponse(err);
  }
}
