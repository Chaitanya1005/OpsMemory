import { getApp } from "../_server/opsmemory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Recorded Meko events: the newest 200, or those at or after `since` (ISO timestamp). Polled by the live timeline. */
export function GET(req: Request) {
  const since = new URL(req.url).searchParams.get("since") ?? undefined;
  return Response.json(getApp().store.eventFeed({ since, limit: since ? 500 : 200 }));
}
