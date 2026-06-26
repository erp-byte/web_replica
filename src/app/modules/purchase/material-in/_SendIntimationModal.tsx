"use client";

// Send QC Intimation modal — opened from the Material In listing per-row Send button.
// POSTs to /api/v1/po/{transaction_no}/intimation and shows a result summary.

import { useEffect, useState } from "react";
import {
  sendQcIntimation,
  type QcIntimationResult,
} from "@/lib/po";

// ── Props ─────────────────────────────────────────────────────────────────────

export interface SendIntimationModalProps {
  transactionNo: string;
  poNumber: string;
  vendor: string;
  articles: { line_number: number; name: string }[];
  onClose: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function SendIntimationModal({
  transactionNo,
  poNumber,
  vendor,
  articles,
  onClose,
}: SendIntimationModalProps): React.JSX.Element {
  const titleId = "send-intimation-modal-title";

  // ── Form state ─────────────────────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(articles.map((a) => a.line_number)),
  );
  const [vehicleNo, setVehicleNo] = useState("");
  const [invoiceNo, setInvoiceNo] = useState("");

  // ── Submit state ────────────────────────────────────────────────────────────
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<QcIntimationResult | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  // ── Keyboard dismiss ────────────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // ── Select all / none ───────────────────────────────────────────────────────
  const allSelected = articles.length > 0 && articles.every((a) => selected.has(a.line_number));
  const noneSelected = selected.size === 0;

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(articles.map((a) => a.line_number)));
    }
  }

  function toggleLine(lineNumber: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(lineNumber)) next.delete(lineNumber);
      else next.add(lineNumber);
      return next;
    });
  }

  // ── Send ────────────────────────────────────────────────────────────────────
  const canSend = !sending && selected.size > 0 && vehicleNo.trim().length > 0 && invoiceNo.trim().length > 0;

  async function handleSend() {
    if (!canSend) return;
    setSending(true);
    setSendError(null);
    setResult(null);
    try {
      const res = await sendQcIntimation(transactionNo, {
        line_numbers: Array.from(selected),
        vehicle_number: vehicleNo.trim(),
        invoice_no: invoiceNo.trim(),
      });
      setResult(res);
    } catch (e) {
      setSendError(e instanceof Error ? e.message : "Failed to send intimation");
    } finally {
      setSending(false);
    }
  }

  // ── Result summary helpers ──────────────────────────────────────────────────
  function renderResult(r: QcIntimationResult) {
    const sentCount = r.recipients.filter((rec) => rec.status === "sent").length;
    const failedRecipients = r.recipients.filter((rec) => rec.status !== "sent");

    return (
      <div className="mt-4 space-y-2 text-[13px]">
        {/* Success banner */}
        <div className="flex items-start gap-2 rounded-[2px] border border-[#b6dbb1] bg-[#eaf6ed] px-3 py-2 text-[var(--text-success)]">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} className="mt-0.5 shrink-0">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span>
            {sentCount > 0
              ? `Sent to ${sentCount} recipient${sentCount === 1 ? "" : "s"}.`
              : "Request submitted."}
          </span>
        </div>

        {/* Failed recipients */}
        {failedRecipients.length > 0 ? (
          <div className="rounded-[2px] border border-[var(--aws-border)] bg-[var(--surface-subtle)] px-3 py-2">
            <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--text-muted)] mb-1">Delivery issues</p>
            {failedRecipients.map((rec, i) => (
              <p key={i} className="text-[var(--aws-error)] text-[12px]">
                {rec.role} ({rec.phone}): {rec.error ?? rec.status}
              </p>
            ))}
          </div>
        ) : null}

        {/* Skipped */}
        {r.skipped.length > 0 ? (
          <div className="rounded-[2px] border border-[var(--aws-border)] bg-[var(--surface-subtle)] px-3 py-2">
            <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--text-muted)] mb-1">Skipped</p>
            {r.skipped.map((s, i) => (
              <p key={i} className="text-[var(--text-secondary)] text-[12px]">
                {s.reason === "whatsapp_disabled"
                  ? "WhatsApp is disabled on the server."
                  : s.reason === "no_qc_recipients"
                  ? "No QC recipients found."
                  : `${s.role}: ${s.reason}`}
              </p>
            ))}
          </div>
        ) : null}

        {/* Top-level errors */}
        {r.errors.length > 0 ? (
          <div className="rounded-[2px] border border-[var(--aws-error)] bg-[#fdf0f0] px-3 py-2">
            {r.errors.map((err, i) => (
              <p key={i} className="text-[var(--aws-error)] text-[12px]">{err}</p>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-white rounded-md shadow-[0_8px_32px_rgba(0,28,36,0.28)] w-full max-w-md flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 pt-5 pb-3 border-b border-[var(--aws-border)]">
          <h2 id={titleId} className="text-[15px] font-semibold text-[var(--text-primary)]">
            Send QC Intimation
          </h2>
          <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">
            PO <span className="font-mono font-semibold">{poNumber || transactionNo}</span>
            {vendor ? <> &middot; {vendor}</> : null}
          </p>
        </div>

        {/* Scrollable body */}
        <div className="px-5 py-4 overflow-y-auto flex-1">
          {/* Articles */}
          <div className="mb-4">
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[11px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">
                Articles
              </label>
              <button
                type="button"
                onClick={toggleAll}
                className="text-[11px] text-[var(--aws-link)] hover:underline"
              >
                {allSelected ? "Deselect all" : "Select all"}
              </button>
            </div>
            <div className="max-h-[200px] overflow-y-auto rounded-[2px] border border-[var(--aws-border)] divide-y divide-[var(--aws-border)]">
              {articles.length === 0 ? (
                <p className="px-3 py-2 text-[12px] text-[var(--text-muted)] italic">No articles</p>
              ) : (
                articles.map((a) => (
                  <label
                    key={a.line_number}
                    className="flex items-center gap-2.5 px-3 py-2 text-[13px] cursor-pointer hover:bg-[var(--surface-subtle)] select-none"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(a.line_number)}
                      onChange={() => toggleLine(a.line_number)}
                      className="shrink-0"
                    />
                    <span className="truncate" title={a.name}>{a.name}</span>
                  </label>
                ))
              )}
            </div>
            {noneSelected && !result ? (
              <p className="mt-1 text-[11px] text-[var(--aws-error)]">Select at least one article.</p>
            ) : null}
          </div>

          {/* Vehicle No */}
          <div className="mb-3">
            <label
              htmlFor="sim-vehicle-no"
              className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1"
            >
              Vehicle No. <span className="text-[var(--aws-error)]">*</span>
            </label>
            <input
              id="sim-vehicle-no"
              type="text"
              value={vehicleNo}
              onChange={(e) => setVehicleNo(e.target.value)}
              placeholder="e.g. KA01AB1234"
              disabled={sending || !!result}
              className="w-full h-8 px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] disabled:opacity-60 disabled:bg-[var(--surface-disabled)]"
            />
          </div>

          {/* Invoice No */}
          <div className="mb-3">
            <label
              htmlFor="sim-invoice-no"
              className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1"
            >
              Invoice No. / Challan No. <span className="text-[var(--aws-error)]">*</span>
            </label>
            <input
              id="sim-invoice-no"
              type="text"
              value={invoiceNo}
              onChange={(e) => setInvoiceNo(e.target.value)}
              placeholder="e.g. INV-20250001"
              disabled={sending || !!result}
              className="w-full h-8 px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] disabled:opacity-60 disabled:bg-[var(--surface-disabled)]"
            />
          </div>

          {/* Inline error (thrown exception) */}
          {sendError ? (
            <div className="mt-2 rounded-[2px] border border-[var(--aws-error)] bg-[#fdf0f0] px-3 py-2 text-[13px] text-[var(--aws-error)]">
              {sendError}
            </div>
          ) : null}

          {/* Result summary */}
          {result ? renderResult(result) : null}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-[var(--aws-border)] flex justify-end gap-2 shrink-0">
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            className="h-8 px-4 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] disabled:opacity-50"
          >
            {result ? "Close" : "Cancel"}
          </button>
          {!result ? (
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={!canSend}
              className="h-8 px-4 text-[13px] rounded-[2px] border border-[var(--aws-navy)] bg-[var(--aws-navy)] text-white hover:bg-[#0e2847] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {sending ? (
                <span className="inline-block w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              ) : null}
              {sending ? "Sending…" : "Send"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
