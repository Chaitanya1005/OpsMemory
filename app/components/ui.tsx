import type { ReactNode } from "react";

export function Panel({ title, kicker, action, children, className = "" }: {
  title?: ReactNode; kicker?: ReactNode; action?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={`rounded-xl border border-line bg-surface ${className}`}>
      {(title || action) && (
        <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-3.5">
          <div className="min-w-0">
            {kicker && <div className="mb-0.5 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">{kicker}</div>}
            {title && <h2 className="text-[15px] font-semibold text-ink">{title}</h2>}
          </div>
          {action}
        </header>
      )}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

type Tone = "good" | "warning" | "serious" | "critical" | "memory" | "neutral";
const TONE: Record<Tone, string> = {
  good: "var(--good)", warning: "var(--warning)", serious: "var(--serious)", critical: "var(--critical)", memory: "var(--memory)", neutral: "var(--text-3)",
};

/** Status chip: icon + label, never colour alone. Text stays in ink tokens. */
export function Chip({ tone = "neutral", icon, children, title }: { tone?: Tone; icon?: ReactNode; children: ReactNode; title?: string }) {
  const c = TONE[tone];
  return (
    <span
      title={title}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-4 text-ink"
      style={{ borderColor: `color-mix(in srgb, ${c} 45%, transparent)`, background: `color-mix(in srgb, ${c} 12%, transparent)` }}
    >
      {icon && <span style={{ color: c }} aria-hidden>{icon}</span>}
      {children}
    </span>
  );
}

export const KIND = {
  verified_resolution: { tone: "good" as const, icon: "✓", label: "Verified" },
  runbook: { tone: "memory" as const, icon: "≡", label: "Runbook" },
  unverified_observation: { tone: "warning" as const, icon: "◌", label: "Unverified" },
};

export const SOURCE = {
  history: { tone: "good" as const, icon: "✓", label: "From verified memory" },
  current_evidence: { tone: "memory" as const, icon: "◆", label: "From current logs" },
  assumption: { tone: "serious" as const, icon: "?", label: "Assumption" },
};

export const ACTOR: Record<string, { color: string; label: string }> = {
  "knowledge-agent": { color: "var(--actor-knowledge)", label: "Knowledge Agent" },
  investigator: { color: "var(--actor-investigator)", label: "Investigator" },
  engineer: { color: "var(--actor-engineer)", label: "Engineer" },
  system: { color: "var(--actor-system)", label: "System" },
};

export function Mono({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono text-[12px] ${className}`}>{children}</span>;
}

export function Spinner({ className = "" }: { className?: string }) {
  return <span className={`inline-block size-3.5 animate-spin rounded-full border-2 border-ink-3 border-t-ink ${className}`} aria-hidden />;
}

export function ErrorBox({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div role="alert" className="rounded-lg border px-4 py-3 text-sm" style={{ borderColor: "color-mix(in srgb, var(--critical) 55%, transparent)", background: "color-mix(in srgb, var(--critical) 10%, transparent)" }}>
      <div className="flex items-center gap-2 font-semibold text-ink"><span style={{ color: "var(--critical)" }} aria-hidden>✕</span>{title}</div>
      <div className="mt-1 text-ink-2">{children}</div>
    </div>
  );
}

export const shortId = (id: string | null | undefined, n = 8) => (id ? id.replaceAll("-", "").slice(0, n) : "—");
export const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
