"use client";

import { useEffect, useState } from "react";
import { requestCoaFromVendor } from "@/lib/qc";

/** Returns today + offsetDays as a YYYY-MM-DD string. */
function offsetDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

export function RequestCoaModal({
  qcIntimationId,
  onClose,
  onDone,
}: {
  qcIntimationId: number;
  onClose: () => void;
  onDone: () => void;
}): React.JSX.Element {
  const titleId = "request-coa-modal-title";

  const [deadlineDate, setDeadlineDate] = useState(offsetDate(2));
  const [customMessage, setCustomMessage] = useState("");

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

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
    try {
      await requestCoaFromVendor({
        qc_intimation_id: qcIntimationId,
        deadline_date: deadlineDate || null,
        custom_message: customMessage.trim() || null,
      });
      setSuccess("Request sent");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to request COA from vendor";
      if (
        msg.includes("isn't available on this backend yet") ||
        msg.includes("not implemented") ||
        msg.includes("HTTP 404") ||
        msg.includes("HTTP 501")
      ) {
        setErr("COA request isn't available on this server yet.");
      } else {
        setErr(msg);
      }
      setBusy(false);
      return;
    }
    setBusy(false);
  }

  const canSubmit = !busy && !success;

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
            Request COA from Vendor
          </h2>
        </div>

        {/* Body */}
        <div className="px-5 py-4 overflow-y-auto flex-1 space-y-4">

          <p className="text-[12px] text-[var(--text-secondary)]">
            Sends email + WhatsApp to the vendor SPOC.
          </p>

          {/* Deadline date */}
          <div>
            <label
              htmlFor="request-coa-deadline"
              className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1"
            >
              Deadline Date <span className="text-[var(--text-muted)]">(optional)</span>
            </label>
            <input
              id="request-coa-deadline"
              type="date"
              value={deadlineDate}
              onChange={(e) => setDeadlineDate(e.target.value)}
              disabled={busy || !!success}
              className="w-full h-8 px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] disabled:opacity-50"
            />
          </div>

          {/* Custom message */}
          <div>
            <label
              htmlFor="request-coa-message"
              className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1"
            >
              Custom Message <span className="text-[var(--text-muted)]">(optional)</span>
            </label>
            <textarea
              id="request-coa-message"
              rows={4}
              value={customMessage}
              onChange={(e) => setCustomMessage(e.target.value)}
              disabled={busy || !!success}
              placeholder="Additional instructions for the vendor…"
              className="w-full px-2 py-1.5 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] resize-y disabled:opacity-50"
            />
          </div>

          {/* Inline messages */}
          {err ? (
            <p className="text-[12px] text-[var(--aws-error)]">{err}</p>
          ) : null}
          {success ? (
            <p className="text-[12px] text-[var(--text-success)] font-semibold">{success}</p>
          ) : null}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-[var(--aws-border)] flex justify-end gap-2 shrink-0">
          <button
            type="button"
            onClick={success ? onDone : onClose}
            disabled={busy}
            className="h-8 px-4 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] disabled:opacity-50"
          >
            {success ? "Close" : "Cancel"}
          </button>
          {!success ? (
            <button
              type="button"
              disabled={!canSubmit}
              onClick={() => void submit()}
              className="h-8 px-4 text-[13px] rounded-[2px] border border-[var(--aws-orange)] bg-[var(--aws-orange)] text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {busy ? (
                <span className="inline-block w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              ) : null}
              Send Request
            </button>
          ) : (
            <button
              type="button"
              onClick={onDone}
              className="h-8 px-4 text-[13px] rounded-[2px] border border-[var(--aws-orange)] bg-[var(--aws-orange)] text-white hover:opacity-90"
            >
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
