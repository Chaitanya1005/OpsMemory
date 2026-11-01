import { getApp } from "../_server/opsmemory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Recorded Meko events, optionally only those after `since` (ISO timestamp). Polled by the live timeline. */
export function GET(req: Request) {
  const since = new URL(req.url).searchParams.get("since");
  const events = getApp().store.events();
  return Response.json(since ? events.filter((e) => e.ts > since) : events.slice(-200));
}
