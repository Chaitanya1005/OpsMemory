import { getApp, toDto } from "../../_server/opsmemory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const app = getApp();
  const row = app.store.getInvestigation(id);
  return row ? Response.json(toDto(app, row)) : Response.json({ error: `No investigation ${id}` }, { status: 404 });
}
