"use client";

import { useEffect, useRef, useState } from "react";
import { type InspectionDetail, type CoaItem, replaceCoa } from "@/lib/qc";

const ACCEPTED_MIME = ["application/pdf", "image/jpeg", "image/png"];
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

function friendlyError(msg: string): string {
  if (msg.includes("file_too_large")) return "File exceeds the server's size limit.";
  if (msg.includes("unsupported_mime_type")) return "Unsupported file type. Upload a PDF, JPG, or PNG.";
  if (msg.includes("coa_not_active")) return "COA is no longer active and cannot be replaced.";
  if (msg.includes("only_uploader_can_replace")) return "Only the original uploader can replace this COA.";
  return msg;
}

export function ReplaceCoaModal({
  inspection,
  coa,
  onClose,
  onDone,
}: {
  inspection: InspectionDetail;
  coa: CoaItem;
  onClose: () => void;
  onDone: () => void;
}): React.JSX.Element {
  const titleId = "replace-coa-modal-title";
  const fileRef = useRef<HTMLInputElement>(null);

  // inspection is passed through for context but not used in the FormData for replace
  void inspection;

  const [file, setFile] = useState<File | null>(null);
  const [replacedReason, setReplacedReason] = useState("");
  const [vendorCoaDate, setVendorCoaDate] = useState(coa.vendor_coa_date ?? "");
  const [parsedParams, setParsedParams] = useState("");

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
    if (!file) { setErr("Please select a replacement file."); return; }
    if (!replacedReason.trim()) { setErr("Reason for replacement is required."); return; }
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
      fd.append("replaced_reason", replacedReason.trim());
      if (vendorCoaDate) fd.append("vendor_coa_date", vendorCoaDate);
      if (parsedParams.trim()) fd.append("parsed_params_json", parsedParams.trim());

      const res = await replaceCoa(coa.coa_id, fd);
      setSuccess(`COA replaced (#${res.old_coa_id} → #${res.new_coa_id})`);
    } catch (e) {
      setErr(friendlyError(e instanceof Error ? e.message : "COA replace failed"));
      setBusy(false);
      return;
    }
    setBusy(false);
  }

  const canSubmit = !busy && !success && file !== null && replacedReason.trim() !== "";

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
            Replace COA
          </h2>
          {coa.file_name ? (
            <p className="text-[12px] text-[var(--text-secondary)] mt-0.5 truncate">
              Replacing: <span className="font-medium">{coa.file_name}</span>
            </p>
          ) : null}
        </div>

        {/* Body */}
        <div className="px-5 py-4 overflow-y-auto flex-1 space-y-4">

          {/* New file */}
          <div>
            <label
              htmlFor="replace-coa-file"
              className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1"
            >
              New COA File <span className="text-[var(--aws-error)]">*</span>
            </label>
            <input
              id="replace-coa-file"
              ref={fileRef}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png"
              disabled={busy || !!success}
              onChange={handleFileChange}
              className="w-full text-[13px] text-[var(--text-primary)] file:mr-3 file:h-7 file:px-3 file:text-[12px] file:rounded-[2px] file:border file:border-[var(--aws-border-strong)] file:bg-white file:cursor-pointer hover:file:border-[var(--aws-navy)] disabled:opacity-50"
            />
            <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
              PDF, JPG, or PNG · max 10 MB
            </p>
          </div>

          {/* Reason (required) */}
          <div>
            <label
              htmlFor="replace-coa-reason"
              className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1"
            >
              Reason for Replacement <span className="text-[var(--aws-error)]">*</span>
            </label>
            <textarea
              id="replace-coa-reason"
              rows={3}
              value={replacedReason}
              onChange={(e) => setReplacedReason(e.target.value)}
              disabled={busy || !!success}
              placeholder="Why is this COA being replaced?"
              className="w-full px-2 py-1.5 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] resize-y disabled:opacity-50"
            />
          </div>

          {/* Vendor COA date */}
          <div>
            <label
              htmlFor="replace-coa-date"
              className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1"
            >
              Vendor COA Date <span className="text-[var(--text-muted)]">(optional)</span>
            </label>
            <input
              id="replace-coa-date"
              type="date"
              value={vendorCoaDate}
              onChange={(e) => setVendorCoaDate(e.target.value)}
              disabled={busy || !!success}
              className="w-full h-8 px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] disabled:opacity-50"
            />
          </div>

          {/* Parsed parameters */}
          <div>
            <label
              htmlFor="replace-coa-params"
              className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1"
            >
              Parsed Parameters <span className="text-[var(--text-muted)]">(optional JSON object)</span>
            </label>
            <textarea
              id="replace-coa-params"
              rows={3}
              value={parsedParams}
              onChange={(e) => setParsedParams(e.target.value)}
              disabled={busy || !!success}
              placeholder={'{"moisture": 5.2, "ash": 1.1}'}
              className="w-full px-2 py-1.5 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] resize-y disabled:opacity-50 font-mono"
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
              Replace COA
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
