/**
 * Deterministic log analysis (an ordinary function, not an agent).
 * Groups lines into error signatures so the Investigator reasons over
 * patterns with exact counts and timestamps instead of raw text alone.
 */
export interface LogSignature {
  level: string;
  component: string;
  pattern: string;
  count: number;
  first: string;
  last: string;
  sample: string;
}

export interface LogAnalysis {
  totalLines: number;
  byLevel: Record<string, number>;
  window: { start: string; end: string } | null;
  signatures: LogSignature[];
}

// e.g. "2026-09-14T02:10:07Z ERROR checkout-api pool: timeout acquiring connection ..."
const LINE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s+(ERROR|WARN|INFO|DEBUG|FATAL)\s+(\S+)\s+(.*)$/;

export function analyzeLogs(logs: string): LogAnalysis {
  const lines = logs.split("\n").map((l) => l.trim()).filter(Boolean);
  const byLevel: Record<string, number> = {};
  const sigs = new Map<string, LogSignature>();
  const timestamps: string[] = [];

  for (const line of lines) {
    const m = LINE.exec(line);
    if (!m) {
      byLevel.UNPARSED = (byLevel.UNPARSED ?? 0) + 1;
      continue;
    }
    const [, ts, level, component, message] = m as unknown as [string, string, string, string, string];
    timestamps.push(ts);
    byLevel[level] = (byLevel[level] ?? 0) + 1;
    const pattern = normalize(message);
    const key = `${level}|${component}|${pattern}`;
    const sig = sigs.get(key);
    if (sig) {
      sig.count++;
      sig.last = ts;
    } else {
      sigs.set(key, { level, component, pattern, count: 1, first: ts, last: ts, sample: line });
    }
  }

  const severity: Record<string, number> = { FATAL: 0, ERROR: 1, WARN: 2, INFO: 3, DEBUG: 4 };
  const signatures = [...sigs.values()].sort((a, b) => (severity[a.level] ?? 9) - (severity[b.level] ?? 9) || b.count - a.count);
  timestamps.sort();
  return {
    totalLines: lines.length,
    byLevel,
    window: timestamps.length ? { start: timestamps[0]!, end: timestamps[timestamps.length - 1]! } : null,
    signatures,
  };
}

/** Replaces volatile tokens (ids, numbers, durations) so repeated errors group together. */
function normalize(message: string): string {
  return message
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27}\b/gi, "<id>")
    .replace(/\b(req|trace|txn)[-_][\w-]+/gi, "<$1>")
    .replace(/\d+(\.\d+)?/g, "N");
}

/** Compact text form for prompts. */
export function formatAnalysis(a: LogAnalysis, maxSignatures = 12): string {
  const levels = Object.entries(a.byLevel).map(([k, v]) => `${k}=${v}`).join(" ");
  const window = a.window ? `${a.window.start} → ${a.window.end}` : "unknown";
  const sigs = a.signatures.slice(0, maxSignatures).map(
    (s, i) => `S${i + 1}. [${s.level}] ${s.component} ×${s.count} (${s.first} → ${s.last}): ${s.sample}`,
  );
  return `Lines: ${a.totalLines} (${levels}); window: ${window}\n${sigs.join("\n")}`;
}
