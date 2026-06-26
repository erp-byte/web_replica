"use client";

// Confirm dialog to raise an NCR from a failed inspection.
// Mirrors CancelInspectionModal's idiom (warning glyph + busy spinner +
// inline error). On confirm, calls createNcr({ from_inspection_id }) so the
// backend prefills failed parameters from the out-of-spec readings, then
// hands the new ncr_id back to the caller via onDone.

import { useEffect, useState } from "react";
import { createNcr } from "@/lib/qc";

export function RaiseNcrModal({
  inspectionId,
  onClose,
  onDone,
}: {
  inspectionId: number;
  onClose: () => void;
  onDone: (ncrId: number) => void;
}): React.JSX.Element {
  const titleId = "raise-ncr-modal-title";

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await createNcr({ from_inspection_id: inspectionId });
      onDone(res.ncr_id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to raise NCR");
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
        <div className="flex items-center gap-2 mb-3">
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-[#fdf3f1] border border-[#f0c7be] text-[#b1361e] text-[13px] font-bold shrink-0">!</span>
          <h2 id={titleId} className="text-[15px] font-semibold text-(--text-primary)">
            Raise NCR
          </h2>
        </div>

        <p className="text-[13px] text-(--text-secondary) mb-3">
          Raise an NCR from this inspection? Failed parameters will be prefilled from the out-of-spec readings.
        </p>

        {err ? (
          <p className="text-[12px] text-(--aws-error) mt-1">{err}</p>
        ) : null}

        <div className="flex justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="h-8 px-4 text-[13px] rounded-[2px] border border-(--aws-border-strong) bg-white hover:border-(--aws-navy) disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            className="h-8 px-4 text-[13px] rounded-[2px] border border-(--aws-orange) bg-(--aws-orange) text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {busy ? (
              <span className="inline-block w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
            ) : null}
            Raise NCR
          </button>
        </div>
      </div>
    </div>
  );
}
