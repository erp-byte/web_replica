"use client";

import { useEffect, useState } from "react";
import { reopenInspection } from "@/lib/qc";

export function ReopenInspectionModal({
  inspectionId,
  onClose,
  onDone,
}: {
  inspectionId: number;
  onClose: () => void;
  onDone: () => void;
}): React.JSX.Element {
  const titleId = "reopen-inspection-modal-title";

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

  const canSubmit = reason.trim().length >= 3 && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    try {
      await reopenInspection(inspectionId, reason.trim());
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to reopen inspection");
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
        <h2 id={titleId} className="text-[15px] font-semibold text-[var(--text-primary)] mb-1">
          Reopen Inspection
        </h2>
        <p className="text-[13px] text-[var(--text-secondary)] mb-3">
          This will reopen the cancelled inspection and re-bind the intimation to
          in-progress status.
        </p>

        <label
          htmlFor="reopen-reason"
          className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1"
        >
          Reason <span className="text-[var(--aws-error)]">*</span>
        </label>
        <textarea
          id="reopen-reason"
          rows={4}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Explain why this inspection is being reopened…"
          className="w-full px-2 py-1.5 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] resize-y"
        />

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
            className="h-8 px-4 text-[13px] rounded-[2px] border border-[var(--aws-orange)] bg-[var(--aws-orange)] text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {busy ? (
              <span className="inline-block w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
            ) : null}
            Reopen
          </button>
        </div>
      </div>
    </div>
  );
}
