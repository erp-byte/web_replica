"use client";

import { useEffect, useState } from "react";
import { overrideVerdict } from "@/lib/qc";

export function OverrideVerdictModal({
  inspectionId,
  currentVerdict,
  onClose,
  onDone,
}: {
  inspectionId: number;
  currentVerdict: string | null;
  onClose: () => void;
  onDone: () => void;
}): React.JSX.Element {
  const titleId = "override-verdict-modal-title";

  const newVerdict: "passed" | "failed" =
    currentVerdict === "passed" ? "failed" : "passed";

  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const canSubmit = reason.trim().length >= 10 && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    try {
      await overrideVerdict(inspectionId, { new_verdict: newVerdict, reason: reason.trim() });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to override verdict");
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-white rounded-md shadow-[0_8px_32px_rgba(0,28,36,0.28)] w-full max-w-md p-5"
      >
        {/* Danger header stripe */}
        <div className="flex items-center gap-2 mb-3">
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-[#fdf3f1] border border-[#f0c7be] text-[#b1361e] text-[13px] font-bold shrink-0">!</span>
          <h2 id={titleId} className="text-[15px] font-semibold text-[var(--text-primary)]">
            Override Verdict
          </h2>
        </div>

        {/* Current / new verdict (read-only) */}
        <div className="grid grid-cols-2 gap-2 mb-4">
          <div className="bg-[var(--surface-subtle)] rounded-[2px] px-3 py-2">
            <p className="text-[10px] font-semibold uppercase text-[var(--text-muted)] mb-0.5">Current</p>
            <p className="text-[13px] font-semibold text-[var(--text-primary)] capitalize">
              {currentVerdict ?? "—"}
            </p>
          </div>
          <div className="bg-[var(--surface-subtle)] rounded-[2px] px-3 py-2">
            <p className="text-[10px] font-semibold uppercase text-[var(--text-muted)] mb-0.5">New verdict</p>
            <p className={[
              "text-[13px] font-semibold capitalize",
              newVerdict === "passed" ? "text-[#1a7e2e]" : "text-[#b1361e]",
            ].join(" ")}>
              {newVerdict}
            </p>
          </div>
        </div>

        {/* Reason */}
        <label
          htmlFor="override-reason"
          className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1"
        >
          Reason <span className="text-[var(--aws-error)]">*</span>{" "}
          <span className="text-[var(--text-muted)] font-normal">(min 10 characters)</span>
        </label>
        <textarea
          id="override-reason"
          rows={4}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Explain why this verdict is being overridden…"
          className="w-full px-2 py-1.5 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] resize-y"
        />
        <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
          {reason.trim().length} / 10 characters minimum
        </p>

        {err ? (
          <p className="text-[12px] text-[var(--aws-error)] mt-1">{err}</p>
        ) : null}

        <div className="flex justify-end gap-2 mt-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="h-8 px-4 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => void submit()}
            className="h-8 px-4 text-[13px] rounded-[2px] border border-[#b1361e] bg-[#b1361e] text-white hover:bg-[#9a1717] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {busy ? (
              <span className="inline-block w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
            ) : null}
            Override
          </button>
        </div>
      </div>
    </div>
  );
}
