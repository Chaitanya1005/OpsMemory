"use client";

import type { Investigation } from "./types";
import { Chip, Mono, Panel } from "./ui";

const STATUS = {
  proposed: { tone: "warning" as const, icon: "◌", label: "Awaiting review" },
  approving: { tone: "warning" as const, icon: "◌", label: "Approving" },
  approved: { tone: "good" as const, icon: "✓", label: "Approved · verified" },
  approval_failed: { tone: "critical" as const, icon: "!", label: "Approval failed" },
  promotion_unverified: { tone: "critical" as const, icon: "!", label: "Promoted · unverified" },
  needs_reconciliation: { tone: "critical" as const, icon: "?", label: "Needs reconciliation" },
  rejected: { tone: "neutral" as const, icon: "✕", label: "Rejected" },
  failed: { tone: "critical" as const, icon: "!", label: "Failed" },
};

export function RunHistory({ investigations, selectedId, onSelect }: {
  investigations: Investigation[]; selectedId: string | null; onSelect: (id: string) => void;
}) {
  return (
    <Panel kicker="Runs" title="Investigation history">
      {investigations.length === 0 ? (
        <p className="text-[13px] text-ink-3">No investigations yet.</p>
      ) : (
        <ul className="scrollbar-thin -mx-2 max-h-80 space-y-1 overflow-auto">
          {investigations.map((i) => {
            // Rows approved before read-back was required may lack a successful read-back.
            const legacyUnverified = i.status === "approved" && i.decision?.status === "approved" && !i.decision.retrievableAfterPromotion;
            const st = legacyUnverified ? STATUS.promotion_unverified : STATUS[i.status];
            return (
              <li key={i.id}>
                <button type="button"
                  onClick={() => onSelect(i.id)}
                  className={`w-full rounded-md px-2 py-2 text-left transition-colors ${i.id === selectedId ? "bg-surface-3" : "hover:bg-surface-2"}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <Mono className="text-ink">{i.incidentRef}</Mono>
                    <span className="flex gap-1.5">
                      <Chip tone={i.mode === "on" ? "memory" : "neutral"} icon={i.mode === "on" ? "●" : "○"}>Meko {i.mode.toUpperCase()}</Chip>
                      <Chip tone={st.tone} icon={st.icon}>{st.label}</Chip>
                    </span>
                  </div>
                  <div className="mt-1 flex justify-between gap-2 text-[12px] text-ink-3">
                    <span className="truncate">{i.incident.service} · {i.incident.title}</span>
                    <span className="shrink-0">{new Date(i.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
