/**
 * Best-effort removal of secrets and personal data from text a visitor submits,
 * before it reaches the model, Meko or the local database. Patterns favour
 * precision: a log line that merely looks unusual is left alone, and numbers
 * that matter for diagnosis (counts, sizes, ports, durations) are kept.
 */

export type RedactionKind = "private_key" | "jwt" | "api_key" | "bearer_token" | "secret_value" | "url_credentials" | "email" | "ip" | "card_number";

export interface Redacted {
  text: string;
  /** How many values of each kind were replaced. */
  counts: Partial<Record<RedactionKind, number>>;
}

interface Rule {
  kind: RedactionKind;
  pattern: RegExp;
  replace: (match: string, ...groups: string[]) => string;
  /** Optional extra check on the match (e.g. Luhn for card numbers). */
  accept?: (match: string) => boolean;
}

// Order matters: whole blocks and tokens first, so later rules don't redact fragments of them.
const RULES: Rule[] = [
  {
    kind: "private_key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => "[redacted private key]",
  },
  { kind: "jwt", pattern: /\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}/g, replace: () => "[redacted jwt]" },
  {
    kind: "api_key",
    // AWS access keys, GitHub, Google, Slack, Stripe, OpenAI/Anthropic-style keys.
    pattern: /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{40,}|AIza[\w-]{35}|xox[abposr]-[\w-]{10,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,})\b/g,
    replace: () => "[redacted api key]",
  },
  { kind: "bearer_token", pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g, replace: (_m, scheme) => `${scheme} [redacted token]` },
  {
    kind: "url_credentials",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@/]+)@/gi,
    replace: (_m, scheme, user) => `${scheme}${user}:[redacted]@`,
  },
  {
    kind: "secret_value",
    // key=value / key: value / "key": "value" where the key names a secret. A value starting with "["
    // is a placeholder an earlier rule already wrote, so it is not redacted twice.
    pattern: /\b((?:password|passwd|pwd|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|auth[_-]?token|session[_-]?id)"?\s*[:=]\s*"?)([^\s",;&}[][^\s",;&}]{3,})/gi,
    replace: (_m, key) => `${key}[redacted]`,
  },
  { kind: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replace: () => "[email]" },
  {
    kind: "ip",
    // IPv4 with valid octets; not part of a longer dotted number (versions like 1.2.3.4.5) and not a timestamp.
    pattern: /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.])/g,
    replace: () => "[ip]",
    // Keep loopback and unspecified addresses: they carry diagnostic meaning and identify no one.
    accept: (m) => !m.startsWith("127.") && m !== "0.0.0.0",
  },
  {
    kind: "card_number",
    // Grouped 4-4-4-x, or an ungrouped number with a card-network prefix. A bare digit run is not enough:
    // order ids and epoch-millisecond timestamps pass the Luhn check about one time in ten.
    pattern: /(?<![\d-])(?:\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,7}|4\d{15}|5[1-5]\d{14}|3[47]\d{13}|6011\d{12})(?![\d-])/g,
    replace: () => "[card number]",
    accept: (m) => luhn(m.replace(/[ -]/g, "")),
  },
];

export function redact(text: string): Redacted {
  const counts: Redacted["counts"] = {};
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
      if (rule.accept && !rule.accept(match)) return match;
      counts[rule.kind] = (counts[rule.kind] ?? 0) + 1;
      const groups = rest.filter((g): g is string => typeof g === "string");
      return rule.replace(match, ...groups);
    });
  }
  return { text: out, counts };
}

/** Redacts every string field of an object and sums the counts. */
export function redactFields<T extends object>(obj: T): { value: T; counts: Redacted["counts"] } {
  const counts: Redacted["counts"] = {};
  const value = { ...obj };
  for (const [key, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v !== "string") continue;
    const r = redact(v);
    (value as Record<string, unknown>)[key] = r.text;
    for (const [kind, n] of Object.entries(r.counts) as Array<[RedactionKind, number]>) counts[kind] = (counts[kind] ?? 0) + n;
  }
  return { value, counts };
}

function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}
