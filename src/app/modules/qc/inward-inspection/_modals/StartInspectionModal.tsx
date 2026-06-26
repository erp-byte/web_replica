"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  type IntimationItem,
  listIntimations,
  startInspection,
} from "@/lib/qc";

// ── Grouping helper ────────────────────────────────────────────────────────
// Preserves the backend order (sorted by transaction_no, created_at).
// Uses insertion order of Map keys so the first time we see a transaction_no
// determines its position in the output.
function groupByTransaction(
  items: IntimationItem[],
): Array<{ txnKey: string; arrivals: IntimationItem[] }> {
  const map = new Map<string, IntimationItem[]>();
  for (const item of items) {
    const key = item.transaction_no ?? `__no_txn_${item.qc_intimation_id}`;
    const bucket = map.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      map.set(key, [item]);
    }
  }
  return Array.from(map.entries()).map(([txnKey, arrivals]) => ({
    txnKey,
    arrivals,
  }));
}

export function StartInspectionModal({
  onClose,
  onStarted,
}: {
  onClose: () => void;
  onStarted: (inspectionId: number) => void;
}): React.JSX.Element {
  const titleId = "start-inspection-modal-title";

  // ── Intimation picker state ────────────────────────────────────────────────
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<IntimationItem[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [selected, setSelected] = useState<IntimationItem | null>(null);

  // ── Collapsed transaction groups (empty set = all expanded) ────────────────
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  function toggleGroup(txnKey: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(txnKey)) next.delete(txnKey);
      else next.add(txnKey);
      return next;
    });
  }

  // ── Form fields ────────────────────────────────────────────────────────────
  const [sampleSize, setSampleSize] = useState("");
  const [method, setMethod] = useState<"combined" | "visual" | "lab_test">("combined");
  const [remarks, setRemarks] = useState("");

  // ── Submit state ───────────────────────────────────────────────────────────
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // ── Grouped results (derived; no extra state) ──────────────────────────────
  const grouped = useMemo(() => groupByTransaction(results), [results]);

  // ── Debounced picker search ────────────────────────────────────────────────
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Initial load of intimations on open
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      // Defer setState out of the synchronous effect body
      // (react-hooks/set-state-in-effect).
      await Promise.resolve();
      if (cancelled) return;
      setPickerLoading(true);
      setPickerError(null);
      try {
        const res = await listIntimations(undefined, 50, controller.signal);
        if (cancelled) return;
        setResults(res.items);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof Error && e.name === "AbortError") return;
        setPickerError(e instanceof Error ? e.message : "Failed to load intimations");
      } finally {
        if (!cancelled) setPickerLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  // Debounced search
  useEffect(() => {
    if (timerRef.current != null) clearTimeout(timerRef.current);
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    const q = search.trim();
    timerRef.current = setTimeout(() => {
      const controller = new AbortController();
      abortRef.current = controller;
      setPickerLoading(true);
      setPickerError(null);
      void (async () => {
        try {
          const res = await listIntimations(q || undefined, 50, controller.signal);
          if (controller.signal.aborted) return;
          setResults(res.items);
        } catch (e) {
          if (controller.signal.aborted) return;
          if (e instanceof Error && e.name === "AbortError") return;
          setPickerError(e instanceof Error ? e.message : "Failed to load intimations");
        } finally {
          if (!controller.signal.aborted) setPickerLoading(false);
        }
      })();
    }, 250);
    return () => {
      if (timerRef.current != null) clearTimeout(timerRef.current);
    };
    // search is the only dep; effect is intentionally separated from initial load
  }, [search]);

  // Keyboard dismiss
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // ── Submit ─────────────────────────────────────────────────────────────────
  async function submit() {
    if (!selected || !sampleSize.trim() || Number(sampleSize) < 1) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await startInspection({
        qc_intimation_id: selected.qc_intimation_id,
        sample_size: Number(sampleSize),
        inspection_method: method,
        remarks: remarks.trim() || undefined,
      });
      onStarted(res.inspection_id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to start inspection");
      setBusy(false);
    }
  }

  const canSubmit = selected != null && sampleSize.trim() !== "" && Number(sampleSize) >= 1 && !busy;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-white rounded-md shadow-[0_8px_32px_rgba(0,28,36,0.28)] w-full max-w-lg flex flex-col max-h-[90vh]"
      >
        {/* Header */}
        <div className="px-5 pt-5 pb-3 border-b border-[var(--aws-border)] shrink-0">
          <h2 id={titleId} className="text-[15px] font-semibold text-[var(--text-primary)]">
            Start Inspection
          </h2>
        </div>

        {/* Scrollable body */}
        <div className="px-5 py-4 overflow-y-auto flex-1 space-y-4">

          {/* Intimation picker */}
          <div>
            <label className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">
              Select Intimation <span className="text-[var(--aws-error)]">*</span>
            </label>

            {selected ? (
              /* ── Selected arrival chip ─────────────────────────────────── */
              <div className="flex items-start justify-between gap-2 bg-[#eaf6ed] border border-[#b6dbb1] rounded-[2px] px-3 py-2 text-[13px]">
                <div className="min-w-0">
                  <p className="font-semibold text-[var(--text-primary)] truncate">
                    {selected.sku_name ?? selected.sku_name_raw ?? `Intimation #${selected.qc_intimation_id}`}
                  </p>
                  <p className="text-[11px] text-[var(--text-secondary)]">
                    {selected.transaction_no ? (
                      <span className="font-mono">{selected.transaction_no}</span>
                    ) : null}
                    {selected.po_number ? ` · PO ${selected.po_number}` : ""}
                    {selected.lot_number ? ` · Lot ${selected.lot_number}` : ""}
                    {selected.coa_received ? (
                      <span className="ml-1.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-sm border bg-[#eaf6ed] border-[#b6dbb1] text-(--text-success)">
                        COA
                      </span>
                    ) : null}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  className="shrink-0 text-[11px] text-[var(--aws-link)] underline hover:no-underline"
                >
                  Change
                </button>
              </div>
            ) : (
              /* ── Picker: search + grouped scrollable list ──────────────── */
              <>
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by SKU, transaction, supplier…"
                  className="w-full h-8 px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] mb-1"
                />
                <div className="border border-[var(--aws-border)] rounded-[2px] max-h-[40vh] overflow-y-auto bg-white">
                  {pickerLoading ? (
                    <div className="px-3 py-4 text-center text-[12px] text-[var(--text-secondary)]">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="inline-block w-3 h-3 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
                        Loading…
                      </span>
                    </div>
                  ) : pickerError ? (
                    <p className="px-3 py-3 text-[12px] text-[var(--aws-error)]">{pickerError}</p>
                  ) : grouped.length === 0 ? (
                    <p className="px-3 py-3 text-[12px] text-(--text-muted)">No pending arrivals.</p>
                  ) : (
                    grouped.map(({ txnKey, arrivals }) => {
                      // All arrivals in a group share the same transaction metadata
                      const first = arrivals[0];
                      const displayTxn = first?.transaction_no ?? null;
                      const displayPo = first?.po_number ?? null;
                      const displaySupplier = first?.supplier_name ?? null;
                      const isCollapsed = collapsed.has(txnKey);
                      return (
                        <div key={txnKey} className="border-b border-(--aws-border) last:border-b-0">
                          {/* Group header — click to collapse/expand the arrival rows */}
                          <button
                            type="button"
                            onClick={() => toggleGroup(txnKey)}
                            aria-expanded={!isCollapsed}
                            className="sticky top-0 z-10 w-full text-left px-3 py-1.5 bg-(--surface-subtle) border-b border-(--aws-border) flex items-center gap-1.5 flex-wrap hover:bg-(--surface-divider)"
                          >
                            <span
                              className={[
                                "text-[10px] text-(--text-muted) transition-transform shrink-0",
                                isCollapsed ? "" : "rotate-90",
                              ].join(" ")}
                              aria-hidden
                            >
                              ▸
                            </span>
                            {displayTxn ? (
                              <span className="font-mono text-[12px] font-semibold text-(--text-primary)">
                                {displayTxn}
                              </span>
                            ) : (
                              <span className="text-[12px] font-semibold text-(--text-muted) italic">
                                No transaction
                              </span>
                            )}
                            {displayPo ? (
                              <span className="text-[11px] text-(--text-secondary)">
                                · PO {displayPo}
                              </span>
                            ) : null}
                            {displaySupplier ? (
                              <span className="text-[11px] text-(--text-secondary) truncate max-w-35 sm:max-w-none">
                                · {displaySupplier}
                              </span>
                            ) : null}
                            <span className="ml-auto shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-(--surface-divider) text-(--text-secondary)">
                              {arrivals.length}
                            </span>
                          </button>
                          {/* Arrival rows — every row, no deduplication */}
                          {!isCollapsed && arrivals.map((item) => (
                            <button
                              key={item.qc_intimation_id}
                              type="button"
                              onClick={() => setSelected(item)}
                              className="w-full text-left px-4 py-2 hover:bg-(--surface-subtle) border-b border-(--aws-border) last:border-b-0"
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="text-[13px] font-medium text-(--text-primary) truncate flex-1">
                                  {item.sku_name ?? item.sku_name_raw ?? "—"}
                                </span>
                                {item.coa_received ? (
                                  <span className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-sm border bg-[#eaf6ed] border-[#b6dbb1] text-(--text-success)">
                                    COA
                                  </span>
                                ) : null}
                              </div>
                              {item.lot_number ? (
                                <p className="text-[11px] text-(--text-muted) mt-0.5">
                                  Lot {item.lot_number}
                                </p>
                              ) : null}
                            </button>
                          ))}
                        </div>
                      );
                    })
                  )}
                </div>
              </>
            )}
          </div>

          {/* Sample Size */}
          <div>
            <label className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">
              Sample Size <span className="text-[var(--aws-error)]">*</span>
            </label>
            <input
              type="number"
              min={1}
              value={sampleSize}
              onChange={(e) => setSampleSize(e.target.value)}
              placeholder="e.g. 5"
              className="w-full h-8 px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
            />
          </div>

          {/* Inspection Method */}
          <div>
            <label className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">
              Inspection Method
            </label>
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value as "combined" | "visual" | "lab_test")}
              className="w-full h-8 px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white outline-none focus:border-[#9a393e]"
            >
              <option value="combined">Combined</option>
              <option value="visual">Visual</option>
              <option value="lab_test">Lab Test</option>
            </select>
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

          {/* Inline error */}
          {err ? (
            <p className="text-[12px] text-[var(--aws-error)]">{err}</p>
          ) : null}
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
            disabled={!canSubmit}
            onClick={() => void submit()}
            className="h-8 px-4 text-[13px] rounded-[2px] border border-[var(--aws-orange)] bg-[var(--aws-orange)] text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {busy ? (
              <span className="inline-block w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
            ) : null}
            Start Inspection
          </button>
        </div>
      </div>
    </div>
  );
}
