import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { z } from "zod";
import { MekoEventLog, truncateForLog, type MekoActor } from "./events";

export const MEKO_MCP_URL = "https://mcp.mekodata.ai/mcp";
const USER_AGENT = "opsmemory/0.1";
const MAX_ATTEMPTS = 3;

/**
 * Non-idempotent Meko operations. A transport failure on one of these is
 * ambiguous (the server may already have applied it), so it is never retried
 * automatically: the caller gets `uncertain_outcome` and must reconcile.
 */
export const NON_IDEMPOTENT_OPS = new Set([
  "conversation_create", "conversation_add_message", "memory_add", "memory_promote",
  "knowledgebase_upload_document", "artifact_put", "datapack_create",
]);

/** A Meko call that reached the server and was rejected, or could not be completed. */
export class MekoError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly op: string,
  ) {
    super(message);
    this.name = "MekoError";
  }
}

export interface MekoClientOptions {
  apiKey: string;
  url?: string;
  log?: MekoEventLog;
  /** Called before every tool call; throws to block an agent from a datapack it may not use. */
  authorize?: (actor: MekoActor, op: string, datapackId: string | null) => void;
}

/**
 * Thin client over Meko's MCP server. Every call is validated and recorded
 * in the event log, success or failure — the UI shows only these events.
 * There is deliberately no local fallback: if Meko fails, the caller sees it.
 */
export class MekoClient {
  readonly log: MekoEventLog;
  private client: Client | null = null;

  private constructor(private readonly opts: MekoClientOptions) {
    this.log = opts.log ?? new MekoEventLog();
  }

  static async connect(opts: MekoClientOptions): Promise<MekoClient> {
    if (!opts.apiKey) throw new MekoError("config", "MEKO_API_KEY is not set", "connect");
    const c = new MekoClient(opts);
    for (let attempt = 1; ; attempt++) {
      try {
        await c.reconnect();
        return c;
      } catch (err) {
        // A rejected key will not start working on retry.
        if (isAuthError(err)) throw new MekoError("auth", `Meko rejected the API key (check MEKO_API_KEY): ${messageOf(err)}`, "connect");
        // Meko intermittently resets fresh connections; retry a bounded number of times.
        if (attempt >= MAX_ATTEMPTS) throw new MekoError("transport", `Could not connect to Meko MCP: ${messageOf(err)}`, "connect");
        await sleep(1000 * attempt);
      }
    }
  }

  async listTools(): Promise<string[]> {
    const res = await this.mcp().listTools();
    return res.tools.map((t) => t.name);
  }

  /**
   * Calls a Meko MCP tool and returns its parsed JSON payload.
   * Retries only transport failures of idempotent operations; server-side
   * rejections surface immediately, and an ambiguous write fails as `uncertain_outcome`.
   */
  async call<T = unknown>(
    actor: MekoActor,
    op: string,
    args: Record<string, unknown>,
    schema?: z.ZodType<T>,
  ): Promise<T> {
    const started = Date.now();
    const datapackId = typeof args.datapack_id === "string" ? args.datapack_id : null;
    // A blocked call never reaches Meko, so it is not recorded as a Meko event.
    this.opts.authorize?.(actor, op, datapackId);
    let attempts = 0;

    const fail = (code: string, message: string): never => {
      this.log.record({
        actor, transport: "mcp", op, datapackId, ok: false, latencyMs: Date.now() - started, attempts,
        request: truncateForLog(args) as Record<string, unknown>, response: null, error: { code, message },
      });
      throw new MekoError(code, message, op);
    };

    let payload: unknown;
    for (;;) {
      attempts++;
      try {
        const res = await this.mcp().callTool({ name: op, arguments: args });
        payload = parseToolResult(res);
        if (res.isError) fail("tool_error", describe(payload));
        break;
      } catch (err) {
        if (err instanceof MekoError) throw err;
        if (isAuthError(err)) fail("auth", `Meko rejected the API key (check MEKO_API_KEY): ${messageOf(err)}`);
        if (NON_IDEMPOTENT_OPS.has(op)) {
          // Reconnect for the next call, but never resend: the write may already have been applied.
          await this.reconnect().catch(() => undefined);
          fail("uncertain_outcome", `${messageOf(err)}; ${op} may or may not have been applied by Meko`);
        }
        if (attempts >= MAX_ATTEMPTS) fail("transport", `${messageOf(err)} (after ${attempts} attempts)`);
        await sleep(750 * attempts);
        await this.reconnect().catch(() => undefined);
      }
    }

    // Meko reports many failures as a 200 with an `error` field in the body.
    const errorField = errorOf(payload);
    if (errorField) fail(errorField.code, errorField.message);

    let data = payload as T;
    if (schema) {
      const checked = schema.safeParse(payload);
      if (!checked.success) fail("unexpected_response", `Response did not match the expected shape for ${op}: ${checked.error.message.slice(0, 300)}`);
      else data = checked.data;
    }

    this.log.record({
      actor, transport: "mcp", op, datapackId, ok: true, latencyMs: Date.now() - started, attempts,
      request: truncateForLog(args) as Record<string, unknown>, response: truncateForLog(payload), error: null,
    });
    return data;
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => undefined);
    this.client = null;
  }

  private mcp(): Client {
    if (!this.client) throw new MekoError("not_connected", "Meko MCP client is not connected", "call");
    return this.client;
  }

  private async reconnect(): Promise<void> {
    await this.close();
    const transport = new StreamableHTTPClientTransport(new URL(this.opts.url ?? MEKO_MCP_URL), {
      requestInit: {
        headers: { Authorization: `Bearer ${this.opts.apiKey}`, "User-Agent": USER_AGENT },
      },
    });
    const client = new Client({ name: "opsmemory", version: "0.1.0" });
    await client.connect(transport);
    this.client = client;
  }
}

/** Meko returns JSON as text content (sometimes wrapped as {"result": "<json>"}). */
function parseToolResult(res: unknown): unknown {
  const r = res as { structuredContent?: unknown; content?: Array<{ type: string; text?: string }> };
  const structured = r.structuredContent as { result?: unknown } | undefined;
  if (structured && typeof structured.result === "string") return parseMaybeJson(structured.result);
  if (structured && structured.result !== undefined) return structured.result;
  const text = r.content?.find((c) => c.type === "text")?.text;
  if (text === undefined) return null;
  const parsed = parseMaybeJson(text);
  // Unwrap {"result": "<json string>"} if the server double-encodes.
  if (parsed && typeof parsed === "object" && "result" in parsed && typeof (parsed as { result: unknown }).result === "string") {
    return parseMaybeJson((parsed as { result: string }).result);
  }
  return parsed;
}

function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorOf(payload: unknown): { code: string; message: string } | null {
  if (typeof payload === "string" && /^(error|\[errno)/i.test(payload.trim())) return { code: "tool_error", message: payload.slice(0, 300) };
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as { error?: unknown; detail?: unknown; code?: unknown };
  if (p.error === undefined || p.error === null) return null;
  const code = typeof p.error === "string" ? p.error : typeof p.code === "string" ? p.code : "error";
  const detail = typeof p.detail === "string" ? p.detail : JSON.stringify(p.error).slice(0, 300);
  return { code, message: detail };
}

function describe(payload: unknown): string {
  return typeof payload === "string" ? payload.slice(0, 300) : JSON.stringify(payload).slice(0, 300);
}

/** 401/403 from the MCP endpoint: a bad or revoked key, never a transient failure. */
function isAuthError(err: unknown): boolean {
  if (err instanceof UnauthorizedError) return true;
  const code = (err as { code?: unknown }).code;
  return code === 401 || code === 403 || /\b(401|403)\b|unauthori[sz]ed|forbidden/i.test(err instanceof Error ? err.message : String(err));
}

function messageOf(err: unknown): string {
  if (!(err instanceof Error)) return String(err).slice(0, 300);
  // Node's fetch hides the real reason (ECONNRESET, ENOTFOUND, …) in `cause`.
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  const detail = cause?.code ?? cause?.message;
  return (detail ? `${err.message} (${detail})` : err.message).slice(0, 300);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
