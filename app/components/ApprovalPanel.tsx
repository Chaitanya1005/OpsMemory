"use client";

import { useEffect, useState } from "react";
import { isComplete, type ApprovalDecision, type Investigation, type RejectionDecision, type Scenario } from "./types";
import { Chip, Mono, Panel, Spinner } from "./ui";

export function ApprovalPanel({ investigation, scenario, busy, onApprove, onReject }: {
  investigation: Investigation;
  scenario: Scenario | null;
  busy: "approve" | "reject" | null;
  onApprove: (body: Record<string, string>) => void;
  onReject: (reason: string) => void;
}) {
  const inv = isComplete(investigation) ? investigation.result.outcome.investigation : null;
  const proposedFix = inv?.recommendedFix.immediate.join("; ") ?? "";
  const [rootCause, setRootCause] = useState("");
  const [fix, setFix] = useState("");
  const [notes, setNotes] = useState("");
  const [reason, setReason] = useState("");

  // Reset the form whenever a different investigation is selected.
  useEffect(() => {
    setRootCause(inv?.rootCause.statement ?? "");
    setFix(proposedFix);
    setNotes("");
    setReason("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [investigation.id]);

  if (!inv) return null;
  const d = investigation.decision;

  if (d?.status === "approved") return <Approved d={d as ApprovalDecision} />;
  if (d?.status === "rejected") return <Rejected d={d as RejectionDecision} />;
  if (d) return <Incomplete d={d as ApprovalDecision} busy={busy === "approve"} onRetry={() => onApprove({})} />;

  if (investigation.mode === "off") {
    return (
      <Panel kicker="4 · Engineer review" title="Approval">
        <p className="text-[13px] text-ink-2">This investigation ran with Meko OFF, so its resolution cannot be promoted into Meko. Use it for comparison only.</p>
      </Panel>
    );
  }

  const edit = scenario?.approvalEdit;
  const disabled = busy !== null;
  // Only send fields the engineer changed, so "edited" reflects a real human edit.
  const submit = () => onApprove({
    ...(rootCause.trim() !== inv.rootCause.statement ? { rootCause } : {}),
    ...(fix.trim() !== proposedFix ? { fix } : {}),
    ...(notes.trim() ? { notes } : {}),
  });

  return (
    <Panel kicker="4 · Engineer review" title="Approve to make this verified knowledge" action={<Chip tone="warning" icon="◌">Unverified until approved</Chip>}>
      <p className="text-[13px] leading-relaxed text-ink-2">
        Approving stores the resolution in the <Mono>knowledge</Mono> datapack and promotes it into Meko&apos;s shared knowledge, where future investigations can recall it. Promotion cannot be undone through the API.
      </p>
      {edit && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface-2 px-3.5 py-2.5">
          <span className="text-[12.5px] text-ink-2">This scenario includes the on-call engineer&apos;s DBA-validated correction.</span>
          <button
            onClick={() => { setFix(edit.fix); setNotes(edit.notes); }}
            disabled={disabled}
            className="rounded-md border border-line-strong px-3 py-1.5 text-[12.5px] font-medium text-ink hover:bg-surface-3 disabled:opacity-50"
          >
            Apply engineer edit
          </button>
        </div>
      )}
      <div className="mt-4 grid gap-4">
        <Field label="Root cause" value={rootCause} onChange={setRootCause} rows={3} disabled={disabled} />
        <Field label="Verified fix" value={fix} onChange={setFix} rows={3} disabled={disabled} />
        <Field label="Resolution notes" value={notes} onChange={setNotes} rows={3} disabled={disabled} placeholder="Constraints, conditions and context future responders need" />
      </div>
      <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-end">
        <button
          onClick={submit}
          disabled={disabled}
          className="flex items-center justify-center gap-2 rounded-lg bg-ink px-4 py-2.5 text-[13.5px] font-semibold text-bg hover:opacity-90 disabled:opacity-60"
        >
          {busy === "approve" ? <><Spinner className="border-bg/40 border-t-bg" /> Storing and promoting…</> : "Approve & promote to Meko"}
        </button>
        <div className="flex flex-1 gap-2">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={disabled}
            placeholder="Reason for rejection"
            className="min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-[13px] text-ink placeholder:text-ink-3 focus:border-line-strong focus:outline-none"
          />
          <button
            onClick={() => onReject(reason)}
            disabled={disabled || !reason.trim()}
            className="flex items-center gap-2 rounded-lg border border-line-strong px-4 py-2.5 text-[13.5px] font-medium text-ink hover:bg-surface-3 disabled:opacity-50"
          >
            {busy === "reject" && <Spinner />} Reject
          </button>
        </div>
      </div>
    </Panel>
  );
}

function Field({ label, value, onChange, rows, disabled, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; rows: number; disabled: boolean; placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-ink-2">{label}</span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        disabled={disabled}
        placeholder={placeholder}
        className="w-full resize-y rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] leading-relaxed text-ink placeholder:text-ink-3 focus:border-line-strong focus:outline-none"
      />
    </label>
  );
}

function Approved({ d }: { d: ApprovalDecision }) {
  const promoted = d.promotion.inserted.length + d.promotion.updated.length > 0;
  return (
    <Panel
      kicker="4–5 · Review and promotion"
      title={d.retrievableAfterPromotion ? "Approved, promoted and verified" : "Approved (recorded before read-back was required)"}
      action={<Chip tone={d.retrievableAfterPromotion ? "good" : "critical"} icon={d.retrievableAfterPromotion ? "✓" : "!"}>{d.retrievableAfterPromotion ? "Verified knowledge in Meko" : "Not found on read-back"}</Chip>}
    >
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-[auto_1fr]">
        <dt className="text-ink-3">Approved</dt><dd className="text-ink-2">{new Date(d.approvedAt).toLocaleString()}{d.edited ? " · with engineer edits" : ""}</dd>
        <dt className="text-ink-3">Memory ID</dt><dd className="break-all text-ink-2"><Mono>{d.memoryIds.join(", ")}</Mono></dd>
        <dt className="text-ink-3">Promotion</dt>
        <dd className="flex flex-wrap gap-1.5">
          <Chip tone={promoted ? "good" : "critical"} icon={promoted ? "✓" : "✕"}>inserted {d.promotion.inserted.length}</Chip>
          <Chip>updated {d.promotion.updated.length}</Chip>
          <Chip tone={d.promotion.notFound.length ? "critical" : "neutral"}>not found {d.promotion.notFound.length}</Chip>
        </dd>
        <dt className="text-ink-3">Stored text</dt>
        <dd className="rounded-md border border-line bg-surface-2 px-3 py-2 leading-relaxed text-ink">{d.storedText.join(" ")}</dd>
      </dl>
      <p className="mt-3 text-[12px] text-ink-3">Text exactly as returned by Meko&apos;s memory_add. It can only be corrected or removed in the Meko portal once promoted.</p>
    </Panel>
  );
}

const INCOMPLETE: Record<string, { title: string; tone: "critical" | "warning"; explain: string }> = {
  approving: { title: "Approval in progress", tone: "warning", explain: "The backend has started this approval and has not reported an outcome yet." },
  approval_failed: { title: "Approval failed", tone: "critical", explain: "A Meko step failed. Nothing after that step was attempted. Retrying resumes after the last step Meko confirmed." },
  promotion_unverified: { title: "Promoted, but not verified", tone: "critical", explain: "Meko acknowledged the promotion, but knowledgebase_search did not return it. It is not counted as verified knowledge. Retrying repeats only the read-back." },
  needs_reconciliation: { title: "Outcome uncertain: needs reconciliation", tone: "critical", explain: "A Meko write may or may not have been applied. Retrying first checks Meko's listings for what the earlier attempt left, and writes again only if nothing is there." },
};

/** Any approval that has not reached a verified `approved` state. Shows exactly which steps Meko confirmed. */
function Incomplete({ d, busy, onRetry }: { d: ApprovalDecision; busy: boolean; onRetry: () => void }) {
  const info = INCOMPLETE[d.status] ?? INCOMPLETE.approval_failed!;
  const steps: Array<[string, boolean]> = [
    ["Approval conversation", Boolean(d.conversationId)],
    ["Resolution written (memory_add)", d.memoryIds.length > 0],
    ["Promotion acknowledged", d.promotionConfirmed],
    ["Read back from knowledge datapack", d.retrievableAfterPromotion],
  ];
  return (
    <Panel kicker="4–5 · Review and promotion" title={info.title} action={<Chip tone={info.tone} icon="!">Not verified knowledge</Chip>}>
      <p className="text-[13px] leading-relaxed text-ink-2">{info.explain}</p>
      {d.failure && (
        <p className="mt-3 rounded-md border border-line bg-surface-2 px-3 py-2 text-[12.5px] text-ink">
          Stopped at <Mono>{d.failure.stage}</Mono> · <Mono>{d.failure.code}</Mono>{d.failure.uncertain ? " · outcome unknown" : ""}: {d.failure.message}
        </p>
      )}
      <ul className="mt-3 space-y-1 text-[12.5px]">
        {steps.map(([label, ok]) => (
          <li key={label} className="flex items-center gap-2 text-ink-2">
            <span style={{ color: ok ? "var(--good)" : "var(--text-3)" }} aria-hidden>{ok ? "✓" : "○"}</span>{label}{ok ? "" : " — not confirmed"}
          </li>
        ))}
      </ul>
      {d.memoryIds.length > 0 && <p className="mt-2 text-[12px] text-ink-3">Memory ID <Mono>{d.memoryIds.join(", ")}</Mono> · attempt {d.attempts}</p>}
      {d.status !== "approving" && (
        <button
          onClick={onRetry}
          disabled={busy}
          className="mt-4 flex items-center gap-2 rounded-lg border border-line-strong px-4 py-2 text-[13px] font-medium text-ink hover:bg-surface-3 disabled:opacity-50"
        >
          {busy ? <><Spinner /> Retrying…</> : "Retry approval"}
        </button>
      )}
    </Panel>
  );
}

function Rejected({ d }: { d: RejectionDecision }) {
  return (
    <Panel kicker="4 · Engineer review" title="Rejected">
      <p className="text-[13px] text-ink-2">{d.reason}</p>
      <p className="mt-2 text-[12px] text-ink-3">
        {d.observationMemoryIds.length ? <>Kept as an unverified observation <Mono>{d.observationMemoryIds.join(", ")}</Mono>; nothing was promoted.</> : "Nothing was stored in Meko."}
      </p>
    </Panel>
  );
}
