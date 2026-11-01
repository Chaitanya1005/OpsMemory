import { SCENARIOS } from "@/data/scenarios";

export const dynamic = "force-dynamic";

/** The demo incidents (the database pool scenarios), including the scripted engineer edit for approval. */
export function GET() {
  return Response.json(SCENARIOS.filter((s) => s.id.startsWith("db-pool")));
}
