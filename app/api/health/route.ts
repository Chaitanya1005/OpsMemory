import { configProblems } from "@/lib/config";
import { getApp } from "../_server/opsmemory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Deploy health check: configuration is complete and the database opens and answers.
 * A missing key or an unwritable volume fails the deploy instead of a visitor's first click.
 * Opens no Meko connection and makes no model call.
 */
export function GET() {
  const problems = configProblems();
  if (problems.length) return Response.json({ ok: false, problems }, { status: 503 });
  try {
    getApp().store.listInvestigations(1);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ ok: false, problems: [`database: ${err instanceof Error ? err.message : String(err)}`] }, { status: 503 });
  }
}
