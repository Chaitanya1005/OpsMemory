import { errorResponse, getApp, serialized, toDto } from "../../../_server/opsmemory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX = { rootCause: 2000, fix: 2000, notes: 2000, approvedBy: 80 } as const;

/** Human approval: stores and promotes the resolution in Meko. Body: { rootCause?, fix?, notes?, approvedBy? } */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const body = (await req.json()) as Partial<Record<keyof typeof MAX, string>>;
    const edits: Partial<Record<keyof typeof MAX, string>> = {};
    for (const key of Object.keys(MAX) as Array<keyof typeof MAX>) {
      const value = typeof body[key] === "string" ? body[key].trim() : "";
      if (value.length > MAX[key]) return Response.json({ error: `${key} is limited to ${MAX[key]} characters` }, { status: 400 });
      if (value) edits[key] = value;
    }
    const decision = await serialized((app) => app.approve(id, edits));
    const app = getApp();
    return Response.json({ decision, investigation: toDto(app, app.store.getInvestigation(id)!) });
  } catch (err) {
    return errorResponse(err);
  }
}
