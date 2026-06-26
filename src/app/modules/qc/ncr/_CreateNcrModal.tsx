"use client";

// Manual NCR create form. Mirrors StartInspectionModal / UpdateHeaderModal
// chrome (centred dialog, navy/orange footer buttons, Escape-to-close). On
// success it routes to the freshly created detail page.

import { useEffect, useState } from "react";
import {
  type NcrCreateBody,
  type NcrDisposition,
  createNcr,
} from "@/lib/qc";

const DISPOSITIONS: { value: NcrDisposition; label: string }[] = [
  { value: "rejected", label: "Rejected" },
  { value: "returned", label: "Returned" },
  { value: "accepted_dispensation", label: "Accepted (dispensation)" },
];

export function CreateNcrModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (ncrId: number) => void;
}): React.JSX.Element {
  const titleId = "create-ncr-modal-title";

  const [supplierName, setSupplierName] = useState("");
  const [transactionNo, setTransactionNo] = useState("");
  const [productDescription, setProductDescription] = useState("");
  const [reason, setReason] = useState("");
  const [quantity, setQuantity] = useState("");
  const [foodSafety, setFoodSafety] = useState(false);
  const [disposition, setDisposition] = useState<"" | NcrDisposition>("");

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
    if (reason.trim() === "") return;
    setBusy(true);
    setErr(null);

    const body: NcrCreateBody = {
      supplier_name: supplierName.trim() || null,
      transaction_no: transactionNo.trim() || null,
      product_description: productDescription.trim() || null,
      reason_nonconformity: reason.trim(),
      quantity: quantity.trim() !== "" ? Number(quantity) : null,
      food_safety_flag: foodSafety,
      disposition: disposition !== "" ? disposition : null,
    };

    try {
      const res = await createNcr(body);
      onCreated(res.ncr_id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to create NCR");
      setBusy(false);
    }
  }

  const canSubmit = !busy && reason.trim() !== "";

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
        <div className="px-5 pt-5 pb-3 border-b border-(--aws-border) shrink-0">
          <h2 id={titleId} className="text-[15px] font-semibold text-(--text-primary)">
            Raise NCR
          </h2>
          <p className="text-[11px] text-(--text-muted) mt-0.5">
            Document a non-conformance manually. You can fill in the full lifecycle once it&apos;s created.
          </p>
        </div>

        {/* Body */}
        <div className="px-5 py-4 overflow-y-auto flex-1 space-y-3">
          {/* Supplier name */}
          <div>
            <label className="block text-[11px] font-semibold text-(--text-primary) mb-1">
              Supplier Name
            </label>
            <input
              type="text"
              value={supplierName}
              onChange={(e) => setSupplierName(e.target.value)}
              placeholder="e.g. Acme Foods Pvt Ltd"
              className="w-full h-8 px-2 text-[13px] rounded-[2px] border border-(--aws-border-strong) outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
            />
          </div>

          {/* Transaction no */}
          <div>
            <label className="block text-[11px] font-semibold text-(--text-primary) mb-1">
              Transaction No
            </label>
            <input
              type="text"
              value={transactionNo}
              onChange={(e) => setTransactionNo(e.target.value)}
              placeholder="e.g. TXN-00123"
              className="w-full h-8 px-2 text-[13px] rounded-[2px] border border-(--aws-border-strong) outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
            />
          </div>

          {/* Product description */}
          <div>
            <label className="block text-[11px] font-semibold text-(--text-primary) mb-1">
              Product Description
            </label>
            <input
              type="text"
              value={productDescription}
              onChange={(e) => setProductDescription(e.target.value)}
              placeholder="Material / article name"
              className="w-full h-8 px-2 text-[13px] rounded-[2px] border border-(--aws-border-strong) outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
            />
          </div>

          {/* Reason */}
          <div>
            <label className="block text-[11px] font-semibold text-(--text-primary) mb-1">
              Reason for Non-conformity <span className="text-(--aws-error)">*</span>
            </label>
            <textarea
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Describe what went wrong…"
              className="w-full px-2 py-1.5 text-[13px] rounded-[2px] border border-(--aws-border-strong) outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] resize-y"
            />
          </div>

          {/* Quantity */}
          <div>
            <label className="block text-[11px] font-semibold text-(--text-primary) mb-1">
              Quantity
            </label>
            <input
              type="number"
              min={0}
              step="any"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="0"
              className="w-full h-8 px-2 text-[13px] rounded-[2px] border border-(--aws-border-strong) outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
            />
          </div>

          {/* Disposition */}
          <div>
            <label className="block text-[11px] font-semibold text-(--text-primary) mb-1">
              Disposition
            </label>
            <select
              value={disposition}
              onChange={(e) => setDisposition(e.target.value as "" | NcrDisposition)}
              className="w-full h-8 px-2 text-[13px] rounded-[2px] border border-(--aws-border-strong) bg-white outline-none focus:border-[#9a393e]"
            >
              <option value="">— none —</option>
              {DISPOSITIONS.map((d) => (
                <option key={d.value} value={d.value}>{d.label}</option>
              ))}
            </select>
          </div>

          {/* Food safety flag */}
          <label className="flex items-center gap-2 text-[13px] text-(--text-primary) cursor-pointer">
            <input
              type="checkbox"
              checked={foodSafety}
              onChange={(e) => setFoodSafety(e.target.checked)}
              className="w-4 h-4 accent-[#b1361e]"
            />
            Food-safety related
          </label>

          {err ? <p className="text-[12px] text-(--aws-error)">{err}</p> : null}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-(--aws-border) flex justify-end gap-2 shrink-0">
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
            disabled={!canSubmit}
            onClick={() => void submit()}
            className="h-8 px-4 text-[13px] rounded-[2px] border border-(--aws-orange) bg-(--aws-orange) text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {busy ? (
              <span className="inline-block w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
            ) : null}
            Create NCR
          </button>
        </div>
      </div>
    </div>
  );
}
