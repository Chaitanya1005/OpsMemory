import { createHash } from "node:crypto";
import { z } from "zod";
import { MekoError, type MekoClient } from "./client";
import type { MekoActor } from "./events";

const UploadTicket = z.object({
  key: z.string().optional(),
  url: z.string().optional(),
  fields: z.record(z.string(), z.string()).optional(),
  already_uploaded: z.boolean().optional(),
});

const DocumentStatus = z.object({ state: z.string() }).loose();

const TERMINAL = new Set(["completed", "failed", "abandoned", "oversized"]);

/**
 * Adds a document (e.g. a runbook) to a datapack's knowledge base via
 * Meko's documented presigned-upload flow, then waits for indexing.
 * The documented REST upload route returned 404 (see FRICTION_LOG #10).
 */
export async function uploadKnowledgeDocument(
  meko: MekoClient,
  actor: MekoActor,
  opts: { datapackId: string; conversationId: string; filename: string; content: string; timeoutMs?: number },
): Promise<{ documentKey: string; state: string; alreadyUploaded: boolean }> {
  const bytes = Buffer.from(opts.content, "utf8");
  const ticket = await meko.call(actor, "knowledgebase_upload_document", {
    filename: opts.filename,
    size: bytes.length,
    content_hash: createHash("sha256").update(bytes).digest("hex"),
    content_head_base64: bytes.subarray(0, 3072).toString("base64"),
    conversation_id: opts.conversationId,
    datapack_id: opts.datapackId,
  }, UploadTicket);

  const documentKey = ticket.key ?? "";
  if (ticket.already_uploaded) return { documentKey, state: "already_uploaded", alreadyUploaded: true };
  if (!ticket.url || !ticket.fields || !documentKey) {
    throw new MekoError("unexpected_response", "Upload ticket had no url/fields/key", "knowledgebase_upload_document");
  }

  // S3 presigned POST: every field in order, file bytes last.
  const form = new FormData();
  for (const [k, v] of Object.entries(ticket.fields)) form.append(k, v);
  form.append("file", new Blob([bytes]), opts.filename);
  const started = Date.now();
  const res = await fetch(ticket.url, { method: "POST", body: form });
  meko.log.record({
    actor, transport: "s3", op: "kb_presigned_upload", datapackId: opts.datapackId, ok: res.ok,
    latencyMs: Date.now() - started, attempts: 1, request: { filename: opts.filename, bytes: bytes.length },
    response: { status: res.status }, error: res.ok ? null : { code: `http_${res.status}`, message: (await res.text()).slice(0, 300) },
  });
  if (!res.ok) throw new MekoError(`s3_${res.status}`, "Presigned upload to S3 failed", "kb_presigned_upload");

  // Poll indexing status every 10s (Meko's guidance) until terminal or timeout.
  const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
  let state = "awaiting_upload";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10_000));
    const status = await meko.call(actor, "knowledgebase_document_status", {
      document_key: documentKey, conversation_id: opts.conversationId, datapack_id: opts.datapackId,
    }, DocumentStatus);
    state = status.state;
    if (TERMINAL.has(state)) break;
  }
  return { documentKey, state, alreadyUploaded: false };
}
