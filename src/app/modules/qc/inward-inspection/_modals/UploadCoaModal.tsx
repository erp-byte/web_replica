"use client";

import { useEffect, useRef, useState } from "react";
import { type InspectionDetail, uploadCoa } from "@/lib/qc";

const ACCEPTED_MIME = ["application/pdf", "image/jpeg", "image/png"];
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

function friendlyError(msg: string): string {
  if (msg.includes("file_too_large")) return "File exceeds the server's size limit.";
  if (msg.includes("unsupported_mime_type")) return "Unsupported file type. Upload a PDF, JPG, or PNG.";
  if (msg.includes("coa_not_active")) return "COA is no longer active.";
  return msg;
}

export function UploadCoaModal({
  inspection,
  onClose,
  onDone,
}: {
  inspection: InspectionDetail;
  onClose: () => void;
  onDone: () => void;
}): React.JSX.Element {
  const titleId = "upload-coa-modal-title";
  const fileRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [vendorCoaDate, setVendorCoaDate] = useState("");
  const [lotNumber, setLotNumber] = useState(inspection.lot_number ?? "");
  const [parsedParams, setParsedParams] = useState("");
  const [remarks, setRemarks] = useState("");

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const today = new Date().toISOString().slice(0, 10);
  const noIntimation = inspection.qc_intimation_id == null;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0] ?? null;
    setErr(null);
    if (!picked) { setFile(null); return; }
    if (!ACCEPTED_MIME.includes(picked.type)) {
      setErr("Unsupported file type. Upload a PDF, JPG, or PNG.");
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    if (picked.size > MAX_BYTES) {
      setErr("File exceeds 10 MB limit.");
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    setFile(picked);
  }

  async function submit() {
    if (!file) { setErr("Please select a file."); return; }
    if (parsedParams.trim()) {
      try {
        const parsed: unknown = JSON.parse(parsedParams.trim());
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          setErr("Parsed params must be a JSON object (e.g. {\"moisture\": 5.2}).");
          return;
        }
      } catch {
        setErr("Parsed params must be a JSON object (e.g. {\"moisture\": 5.2}).");
        return;
      }
    }

    setBusy(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("qc_intimation_id", String(inspection.qc_intimation_id!));
      fd.append("transaction_no", inspection.transaction_no ?? "");
      fd.append("sku_id", String(inspection.sku_id ?? ""));
      fd.append("sku_name_raw", inspection.sku_name_raw ?? inspection.sku_name ?? "");
      fd.append("supplier_id", String(inspection.supplier_id ?? ""));
      if (lotNumber.trim()) fd.append("lot_number", lotNumber.trim());
      if (vendorCoaDate) fd.append("vendor_coa_date", vendorCoaDate);
      if (parsedParams.trim()) fd.append("parsed_params_json", parsedParams.trim());
      if (remarks.trim()) fd.append("remarks", remarks.trim());

      await uploadCoa(fd);
      setSuccess("COA uploaded");
    } catch (e) {
      setErr(friendlyError(e instanceof Error ? e.message : "COA upload failed"));
      setBusy(false);
      return;
    }
    setBusy(false);
  }

  const canSubmit = !busy && !success && !noIntimation && file !== null;

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
            Upload COA
          </h2>
        </div>

        {/* Body */}
        <div className="px-5 py-4 overflow-y-auto flex-1 space-y-4">

          {noIntimation && (
            <p className="text-[12px] text-[var(--aws-error)] bg-[#fdf3f1] border border-[#f5c6bc] rounded px-3 py-2">
              No intimation linked to this inspection — upload is disabled.
            </p>
          )}

          {/* File input */}
          <div>
            <label
              htmlFor="upload-coa-file"
              className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1"
            >
              COA File <span className="text-[var(--aws-error)]">*</span>
            </label>
            <input
              id="upload-coa-file"
              ref={fileRef}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png"
              disabled={noIntimation || busy || !!success}
              onChange={handleFileChange}
              className="w-full text-[13px] text-[var(--text-primary)] file:mr-3 file:h-7 file:px-3 file:text-[12px] file:rounded-[2px] file:border file:border-[var(--aws-border-strong)] file:bg-white file:cursor-pointer hover:file:border-[var(--aws-navy)] disabled:opacity-50"
            />
            <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
              PDF, JPG, or PNG · max 10 MB
            </p>
          </div>

          {/* Vendor COA date */}
          <div>
            <label
              htmlFor="upload-coa-date"
              className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1"
            >
              Vendor COA Date <span className="text-[var(--text-muted)]">(optional)</span>
            </label>
            <input
              id="upload-coa-date"
              type="date"
              max={today}
              value={vendorCoaDate}
              onChange={(e) => setVendorCoaDate(e.target.value)}
              disabled={busy || !!success}
              className="w-full h-8 px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] disabled:opacity-50"
            />
          </div>

          {/* Lot number */}
          <div>
            <label
              htmlFor="upload-coa-lot"
              className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1"
            >
              Lot Number <span className="text-[var(--text-muted)]">(optional)</span>
            </label>
            <input
              id="upload-coa-lot"
              type="text"
              value={lotNumber}
              onChange={(e) => setLotNumber(e.target.value)}
              disabled={busy || !!success}
              placeholder="e.g. LOT-2024-001"
              className="w-full h-8 px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] disabled:opacity-50"
            />
          </div>

          {/* Parsed parameters */}
          <div>
            <label
              htmlFor="upload-coa-params"
              className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1"
            >
              Parsed Parameters <span className="text-[var(--text-muted)]">(optional JSON object)</span>
            </label>
            <textarea
              id="upload-coa-params"
              rows={3}
              value={parsedParams}
              onChange={(e) => setParsedParams(e.target.value)}
              disabled={busy || !!success}
              placeholder={'{"moisture": 5.2, "ash": 1.1}'}
              className="w-full px-2 py-1.5 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] resize-y disabled:opacity-50 font-mono"
            />
          </div>

          {/* Remarks */}
          <div>
            <label
              htmlFor="upload-coa-remarks"
              className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1"
            >
              Remarks <span className="text-[var(--text-muted)]">(optional)</span>
            </label>
            <textarea
              id="upload-coa-remarks"
              rows={2}
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              disabled={busy || !!success}
              placeholder="Any notes about this COA…"
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
              Upload COA
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
