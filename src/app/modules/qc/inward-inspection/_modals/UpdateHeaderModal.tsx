"use client";

import { useEffect, useState } from "react";
import { type InspectionDetail, type HeaderUpdateBody, updateInspectionHeader } from "@/lib/qc";

export function UpdateHeaderModal({
  inspection,
  onClose,
  onDone,
}: {
  inspection: InspectionDetail;
  onClose: () => void;
  onDone: () => void;
}): React.JSX.Element {
  const titleId = "update-header-modal-title";

  const [sampleSize, setSampleSize] = useState("");
  const [method, setMethod] = useState("");
  const [inspectorId, setInspectorId] = useState("");
  const [remarks, setRemarks] = useState(inspection.remarks ?? "");

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
    setBusy(true);
    setErr(null);

    // Build body — only include fields that were actually changed/filled
    const body: HeaderUpdateBody = {};
    if (sampleSize.trim() !== "") body.sample_size = Number(sampleSize);
    if (method !== "") body.inspection_method = method;
    if (inspectorId.trim() !== "") body.inspector_user_id = Number(inspectorId);
    // Remarks: send if different from prefill (including cleared)
    if (remarks !== (inspection.remarks ?? "")) body.remarks = remarks.trim() || null;

    try {
      await updateInspectionHeader(inspection.inspection_id, body);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to update inspection");
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
        className="bg-white rounded-md shadow-[0_8px_32px_rgba(0,28,36,0.28)] w-full max-w-md flex flex-col max-h-[90vh]"
      >
        {/* Header */}
        <div className="px-5 pt-5 pb-3 border-b border-[var(--aws-border)] shrink-0">
          <h2 id={titleId} className="text-[15px] font-semibold text-[var(--text-primary)]">
            Update Inspection Header
          </h2>
          <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
            Empty fields are skipped — only filled fields are updated.
          </p>
        </div>

        {/* Body */}
        <div className="px-5 py-4 overflow-y-auto flex-1 space-y-3">

          {/* Sample Size */}
          <div>
            <label className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">
              Sample Size
              {inspection.sample_size != null ? (
                <span className="ml-1 font-normal text-[var(--text-muted)]">
                  (current: {inspection.sample_size})
                </span>
              ) : null}
            </label>
            <input
              type="number"
              min={1}
              value={sampleSize}
              onChange={(e) => setSampleSize(e.target.value)}
              placeholder="Leave blank to keep current"
              className="w-full h-8 px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
            />
          </div>

          {/* Inspection Method */}
          <div>
            <label className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">
              Inspection Method
              {inspection.inspection_method ? (
                <span className="ml-1 font-normal text-[var(--text-muted)]">
                  (current: {inspection.inspection_method})
                </span>
              ) : null}
            </label>
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              className="w-full h-8 px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white outline-none focus:border-[#9a393e]"
            >
              <option value="">— keep —</option>
              <option value="combined">Combined</option>
              <option value="visual">Visual</option>
              <option value="lab_test">Lab Test</option>
            </select>
          </div>

          {/* Reassign Inspector */}
          <div>
            <label className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">
              Reassign Inspector User ID
              {inspection.inspector_user_id != null ? (
                <span className="ml-1 font-normal text-[var(--text-muted)]">
                  (current: {inspection.inspector_user_id})
                </span>
              ) : null}
            </label>
            <input
              type="number"
              min={1}
              value={inspectorId}
              onChange={(e) => setInspectorId(e.target.value)}
              placeholder="Leave blank to keep current"
              className="w-full h-8 px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
            />
          </div>

          {/* Remarks */}
          <div>
            <label className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">
              Remarks
            </label>
            <textarea
              rows={3}
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              placeholder="Optional notes…"
              className="w-full px-2 py-1.5 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] resize-y"
            />
          </div>

          {err ? <p className="text-[12px] text-[var(--aws-error)]">{err}</p> : null}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-[var(--aws-border)] flex justify-end gap-2 shrink-0">
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
            disabled={busy}
            onClick={() => void submit()}
            className="h-8 px-4 text-[13px] rounded-[2px] border border-[var(--aws-orange)] bg-[var(--aws-orange)] text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {busy ? (
              <span className="inline-block w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
            ) : null}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
