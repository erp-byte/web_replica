"use client";

import { useEffect, useState } from "react";
import { setVerdict } from "@/lib/qc";

export function SetVerdictModal({
  inspectionId,
  onClose,
  onDone,
}: {
  inspectionId: number;
  onClose: () => void;
  onDone: () => void;
}): React.JSX.Element {
  const titleId = "set-verdict-modal-title";

  const [verdict, setVerdictVal] = useState<"passed" | "failed">("passed");
  const [acceptedQty, setAcceptedQty] = useState("");
  const [rejectedQty, setRejectedQty] = useState("");
  const [summaryRemarks, setSummaryRemarks] = useState("");

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

  function isOosError(msg: string) {
    return msg.includes("out_of_spec") || msg.includes("out-of-spec");
  }

  async function submit() {
    if (verdict === "passed" && acceptedQty.trim() === "") return;
    if (verdict === "failed" && rejectedQty.trim() === "") return;
    setBusy(true);
    setErr(null);
    try {
      const res = await setVerdict(inspectionId, {
        verdict,
        accepted_qty: verdict === "passed" ? Number(acceptedQty) : null,
        rejected_qty: verdict === "failed" ? Number(rejectedQty) : null,
        summary_remarks: summaryRemarks.trim() || null,
      });
      setSuccess(`Verdict ${res.verdict}${res.next_step ? ` · ${res.next_step}` : ""}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to set verdict";
      if (isOosError(msg)) {
        setErr("Cannot pass — out-of-spec readings present. Use Override.");
      } else {
        setErr(msg);
      }
      setBusy(false);
      return;
    }
    setBusy(false);
  }

  const canSubmit =
    !busy &&
    !success &&
    (verdict === "passed" ? acceptedQty.trim() !== "" : rejectedQty.trim() !== "");

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
            Set Verdict
          </h2>
        </div>

        {/* Body */}
        <div className="px-5 py-4 overflow-y-auto flex-1 space-y-4">

          {/* Pass / Fail toggle */}
          <div>
            <label className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">
              Verdict <span className="text-[var(--aws-error)]">*</span>
            </label>
            <div className="flex gap-2">
              {(["passed", "failed"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setVerdictVal(v)}
                  className={[
                    "h-8 px-4 text-[13px] rounded-[2px] border font-semibold transition-colors",
                    verdict === v
                      ? v === "passed"
                        ? "bg-[#eaf6ed] border-[#4caf50] text-[#1a7e2e]"
                        : "bg-[#fdf3f1] border-[#b1361e] text-[#b1361e]"
                      : "bg-white border-[var(--aws-border-strong)] text-[var(--text-primary)] hover:border-[var(--aws-navy)]",
                  ].join(" ")}
                >
                  {v === "passed" ? "Pass" : "Fail"}
                </button>
              ))}
            </div>
          </div>

          {/* Qty field — conditional */}
          {verdict === "passed" ? (
            <div>
              <label className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">
                Accepted Qty <span className="text-[var(--aws-error)]">*</span>
              </label>
              <input
                type="number"
                min={0}
                step="any"
                value={acceptedQty}
                onChange={(e) => setAcceptedQty(e.target.value)}
                placeholder="0"
                className="w-full h-8 px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
              />
            </div>
          ) : (
            <div>
              <label className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">
                Rejected Qty <span className="text-[var(--aws-error)]">*</span>
              </label>
              <input
                type="number"
                min={0}
                step="any"
                value={rejectedQty}
                onChange={(e) => setRejectedQty(e.target.value)}
                placeholder="0"
                className="w-full h-8 px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
              />
            </div>
          )}

          {/* Summary remarks */}
          <div>
            <label className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">
              Summary Remarks
            </label>
            <textarea
              rows={3}
              value={summaryRemarks}
              onChange={(e) => setSummaryRemarks(e.target.value)}
              placeholder="Optional summary…"
              className="w-full px-2 py-1.5 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] resize-y"
            />
          </div>

          {/* Helper text */}
          <p className="text-[11px] text-[var(--text-muted)]">
            Pass requires zero out-of-spec readings. Failing automatically creates an NCR.
          </p>

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
              Submit Verdict
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
