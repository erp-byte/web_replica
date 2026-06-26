"use client";

// In-transit ("Pending Stock") modal. Mirrors components/transfer/
// PendingTransfersModal.tsx: portal to <body>, ESC + backdrop close, auto-sync
// on open (gracefully tolerates a failed backfill — banners + still loads the
// list), totals bar, warehouse chips, and a gated Cancel action per row.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  TransferApi, type PendingTransferRecord, type PendingStockResponse,
} from "@/lib/transfer";
import { ChallanHoverCard } from "./_ChallanHoverCard";
import { transferHoverData } from "./_hoverData";

function fmtDate(s?: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString();
}

export function PendingTransfersModal({
  open, onClose, canCancel,
}: {
  open: boolean;
  onClose: () => void;
  canCancel: boolean;
}) {
  const [data, setData] = useState<PendingStockResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [fromChip, setFromChip] = useState<string | null>(null);
  const [toChip, setToChip] = useState<string | null>(null);
  const justOpened = useRef(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const r = await TransferApi.getPendingStock();
      setData(r);
    } catch {
      setBanner("Could not load pending stock.");
    } finally {
      setLoading(false);
    }
  }, []);

  // On open: auto-sync (backfill) then always reload. A failed sync is
  // non-fatal — banner it and load the list anyway (doc §12).
  useEffect(() => {
    if (!open || justOpened.current) return;
    justOpened.current = true;
    queueMicrotask(async () => {
      if (canCancel) {
        try {
          await TransferApi.backfillPendingStock();
          setBanner(null);
        } catch {
          setBanner("Sync failed — refreshing data anyway…");
        }
      }
      await loadData();
    });
  }, [open, canCancel, loadData]);

  // Reset the one-shot sync guard when the modal closes.
  useEffect(() => { if (!open) justOpened.current = false; }, [open]);

  // ESC to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const onCancelTransfer = async (rec: PendingTransferRecord) => {
    if (typeof window !== "undefined" && !window.confirm(`Cancel transfer ${rec.transfer_out_challan_no}? Boxes return to source.`)) return;
    try {
      await TransferApi.deleteTransfer(rec.transfer_out_id);
      await loadData();
    } catch (e) {
      setBanner(e instanceof Error ? e.message : "Cancel failed.");
    }
  };

  if (!open || typeof document === "undefined") return null;

  const records = (data?.records ?? []).filter((r) =>
    (!search || r.transfer_out_challan_no.toLowerCase().includes(search.toLowerCase())) &&
    (!fromChip || r.from_site === fromChip) &&
    (!toChip || r.to_site === toChip)
  );
  const totalBoxes = records.reduce((s, r) => s + (r.total_boxes || 0), 0);
  const totalKg = records.reduce((s, r) => s + (r.total_kg || 0), 0);
  const fromChips = data?.filter_options.from_sites ?? [];
  const toChips = data?.filter_options.to_sites ?? [];

  return createPortal(
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/40 p-4 overflow-auto"
      onClick={onClose}>
      <div className="bg-white rounded-md shadow-xl w-full max-w-5xl mt-8" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--aws-border)]">
          <h2 className="text-[15px] font-semibold">Pending Transfers (In Transit)</h2>
          <button onClick={onClose} aria-label="Close" className="text-[var(--text-secondary)] text-[18px]">×</button>
        </div>

        {banner && <div className="mx-4 mt-3 text-[12px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">{banner}</div>}

        {/* Filters */}
        <div className="px-4 py-3 flex flex-wrap items-center gap-2">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search challan…"
            className="border border-[var(--aws-border)] rounded px-2 py-1 text-[12px] w-full sm:w-56" />
          <ChipRow label="From" chips={fromChips} active={fromChip} onPick={setFromChip} />
          <ChipRow label="To" chips={toChips} active={toChip} onPick={setToChip} />
          {(search || fromChip || toChip) && (
            <button onClick={() => { setSearch(""); setFromChip(null); setToChip(null); }}
              className="text-[11px] underline text-[var(--text-secondary)]">Clear filters</button>
          )}
        </div>

        {/* Totals */}
        <div className="px-4 pb-2 flex gap-4 text-[12px] text-[var(--text-secondary)]">
          <span><b className="text-[var(--text-primary)]">{records.length}</b> transfers</span>
          <span><b className="text-[var(--text-primary)]">{totalBoxes}</b> boxes</span>
          <span><b className="text-[var(--text-primary)]">{totalKg.toFixed(1)}</b> kg</span>
        </div>

        <div className="px-4 pb-4 overflow-auto max-h-[60vh]">
          {loading ? (
            <div className="py-8 text-center text-[13px] text-[var(--text-secondary)]">Loading…</div>
          ) : records.length === 0 ? (
            <div className="py-8 text-center text-[13px] text-[var(--text-secondary)]">No in-transit transfers.</div>
          ) : (
            <table className="w-full text-[12px]">
              <thead><tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]">
                <th className="py-2">Date</th><th>Challan</th><th>From → To</th><th>Boxes</th><th>Cartons</th><th>Weight</th><th>Dispatched By</th><th>Status</th><th></th>
              </tr></thead>
              <tbody>
                {records.map((r, idx) => (
                  // One transfer_out can yield multiple pending rows (the backend
                  // groups by the full site/company/storage-type tuple), so the
                  // id alone isn't unique — compose with the route + index.
                  <tr key={`${r.transfer_out_id}-${r.from_site ?? ""}-${r.to_site ?? ""}-${idx}`}
                    className="border-b border-[var(--aws-border)]/50 align-top">
                    <td className="py-2">{fmtDate(r.dispatched_at)}</td>
                    <td>
                      <ChallanHoverCard
                        label={r.transfer_out_challan_no}
                        from={r.from_site} to={r.to_site}
                        fetchLines={() => TransferApi.getTransfer(r.transfer_out_id).then(transferHoverData)}
                      />
                    </td>
                    <td>{r.from_site} → {r.to_site}
                      <div className="text-[10px] text-[var(--text-secondary)]">{r.from_storage_type} → {r.to_storage_type}</div>
                    </td>
                    <td>{r.total_boxes}{r.unallocated_boxes ? <span className="ml-1 text-rose-600">({r.unallocated_boxes} short)</span> : null}</td>
                    <td>{r.total_cartons}</td>
                    <td>{r.total_kg.toFixed(1)}</td>
                    <td>{r.dispatched_by}</td>
                    <td>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] ${r.header_status === "Partial" ? "bg-amber-100 text-amber-800" : "bg-sky-100 text-sky-800"}`}>
                        {r.header_status === "Partial" ? "Partial (GRN raised)" : r.status}
                      </span>
                      {r.updated_ts && <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] bg-violet-100 text-violet-800">Edited</span>}
                    </td>
                    <td className="text-right">
                      {canCancel && (
                        <button onClick={() => onCancelTransfer(r)}
                          className="px-2 py-0.5 text-[11px] border border-rose-300 text-rose-700 rounded hover:bg-rose-50">Cancel</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ChipRow({ label, chips, active, onPick }: {
  label: string; chips: string[]; active: string | null; onPick: (v: string | null) => void;
}) {
  if (chips.length === 0) return null;
  return (
    <div className="flex items-center gap-1 flex-wrap">
      <span className="text-[10px] uppercase text-[var(--text-secondary)]">{label}</span>
      {chips.map((c) => (
        <button key={c} onClick={() => onPick(active === c ? null : c)}
          className={`px-1.5 py-0.5 rounded text-[11px] border ${active === c ? "bg-[var(--aws-navy)] text-white border-[var(--aws-navy)]" : "border-[var(--aws-border)]"}`}>
          {c}
        </button>
      ))}
    </div>
  );
}
