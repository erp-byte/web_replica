"use client";

import { useEffect, useState } from "react";
import { type Reading, type ReadingUpdateBody, updateReading } from "@/lib/qc";

export function EditReadingModal({
  inspectionId,
  reading,
  onClose,
  onDone,
}: {
  inspectionId: number;
  reading: Reading;
  onClose: () => void;
  onDone: () => void;
}): React.JSX.Element {
  const titleId = "edit-reading-modal-title";

  const [numVal, setNumVal] = useState(
    reading.observed_value_num != null ? String(reading.observed_value_num) : "",
  );
  const [textVal, setTextVal] = useState(reading.observed_value_text ?? "");
  const [method, setMethod] = useState(reading.method ?? "");
  const [instrument, setInstrument] = useState(reading.instrument ?? "");
  const [notes, setNotes] = useState(reading.notes ?? "");

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
    const body: ReadingUpdateBody = {
      observed_value_num: numVal.trim() !== "" ? Number(numVal) : null,
      observed_value_text: textVal.trim() || null,
      method: method.trim() || null,
      instrument: instrument.trim() || null,
      notes: notes.trim() || null,
    };
    try {
      await updateReading(inspectionId, reading.reading_id, body);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to update reading");
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
            Edit Reading
          </h2>
          {reading.parameter_name ? (
            <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">
              Parameter: <span className="font-semibold">{reading.parameter_name}</span>
              {reading.parameter_unit ? ` (${reading.parameter_unit})` : ""}
            </p>
          ) : null}
        </div>

        {/* Body */}
        <div className="px-5 py-4 overflow-y-auto flex-1 space-y-3">

          {/* Spec info (read-only) */}
          {(reading.spec_min != null || reading.spec_max != null || reading.spec_target != null) ? (
            <div className="text-[11px] text-[var(--text-muted)] bg-[var(--surface-subtle)] rounded-[2px] px-2 py-1.5">
              Spec:
              {reading.spec_min != null ? ` min ${reading.spec_min}` : ""}
              {reading.spec_max != null ? ` max ${reading.spec_max}` : ""}
              {reading.spec_target != null ? ` target ${reading.spec_target}` : ""}
            </div>
          ) : null}

          {/* Numeric value */}
          <div>
            <label className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">
              Numeric Value
            </label>
            <input
              type="number"
              step="any"
              value={numVal}
              onChange={(e) => setNumVal(e.target.value)}
              placeholder="e.g. 12.5"
              className="w-full h-8 px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
            />
          </div>

          {/* Text value */}
          <div>
            <label className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">
              Text Value
            </label>
            <input
              type="text"
              value={textVal}
              onChange={(e) => setTextVal(e.target.value)}
              placeholder="e.g. Satisfactory"
              className="w-full h-8 px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
            />
          </div>

          {/* Method */}
          <div>
            <label className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">
              Method
            </label>
            <input
              type="text"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              placeholder="e.g. Visual"
              className="w-full h-8 px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
            />
          </div>

          {/* Instrument */}
          <div>
            <label className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">
              Instrument
            </label>
            <input
              type="text"
              value={instrument}
              onChange={(e) => setInstrument(e.target.value)}
              placeholder="e.g. Vernier caliper"
              className="w-full h-8 px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
            />
          </div>

          {/* Notes */}
          <div>
            <label className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">
              Notes
            </label>
            <textarea
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
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
