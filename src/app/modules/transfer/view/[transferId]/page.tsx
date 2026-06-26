"use client";

// Transfer-OUT View — read-only detail of one interunit dispatch (doc 09). Header info,
// consolidated item cards (lines deduped by desc+category+pack_size), and per-box cards
// with weight rollups. Pure display — no edit/print/actions. Backed by the existing
// GET /api/v1/transfer/transfers/{id}. (The rebuild returns canonical field names, so no
// dual-key fallbacks; from_cold_unit + per-box source_unit ARE shown — the reference omitted
// them, but the data is in the payload and useful here.)

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import { TransferChrome } from "../../_chrome";
import { TransferApi, type TransferDetail, type TransferLine } from "@/lib/transfer";
import { getDisplayWarehouseName } from "@/lib/transferBuildSummary";

function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

function formatDate(d?: string | null): string {
  if (!d) return "N/A";
  if (/^\d{2}-\d{2}-\d{4}$/.test(d)) return d;   // backend already emits DD-MM-YYYY
  try {
    return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" }).replace(/\//g, "-");
  } catch {
    return d;
  }
}

function statusTone(status?: string | null): string {
  switch ((status || "").toLowerCase()) {
    case "pending": return "bg-amber-100 text-amber-800";
    case "approved": case "accept": return "bg-emerald-100 text-emerald-800";
    case "in transit": return "bg-sky-100 text-sky-800";
    case "partially transferred": case "partiallytransferred": case "partial": return "bg-orange-100 text-orange-800";
    case "completed": case "dispatch": return "bg-sky-100 text-sky-800";
    default: return "bg-gray-100 text-gray-700";
  }
}

type ConsolidatedLine = TransferLine & { _box_count: number };

function InfoCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md p-3">
      <div className="text-[11px] uppercase tracking-wide text-[var(--text-secondary)]">{label}</div>
      <div className="text-[13px] font-medium text-[var(--text-primary)] mt-0.5 break-words">{children}</div>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="text-center">
      <div className="text-[18px] font-semibold text-[var(--text-primary)]">{value}</div>
      <div className="text-[11px] text-[var(--text-secondary)]">{label}</div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] text-[var(--text-secondary)]">{label}</div>
      <div className="text-[12px] text-[var(--text-primary)]">{value}</div>
    </div>
  );
}

export default function TransferViewPage() {
  const router = useRouter();
  const allowed = useRequireAuth(router.replace);
  const params = useParams<{ transferId: string }>();
  const transferId = params?.transferId;

  const [transfer, setTransfer] = useState<TransferDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!transferId) return;
    setLoading(true);
    setError(null);
    try {
      const r = await TransferApi.getTransfer(Number(transferId));
      setTransfer(r);
    } catch (e) {
      setTransfer(null);
      setError(e instanceof Error ? e.message : "Failed to load transfer");
    } finally {
      setLoading(false);
    }
  }, [transferId]);

  useEffect(() => {
    if (!allowed) return;
    queueMicrotask(() => { load(); });
  }, [allowed, load]);

  // Consolidate lines by description + category + pack_size (sum qty / net / total).
  const consolidatedLines = useMemo<ConsolidatedLine[]>(() => {
    const map = new Map<string, ConsolidatedLine>();
    for (const l of transfer?.lines ?? []) {
      const key = `${(l.item_description || "").trim().toUpperCase()}__${(l.item_category || "").trim().toUpperCase()}__${l.pack_size || "0"}`;
      const existing = map.get(key);
      if (existing) {
        existing.quantity = String(num(existing.quantity) + num(l.quantity));
        existing.net_weight = (num(existing.net_weight) + num(l.net_weight)).toFixed(3);
        existing.total_weight = (num(existing.total_weight) + num(l.total_weight)).toFixed(3);
        existing._box_count += 1;
      } else {
        map.set(key, { ...l, _box_count: 1 });
      }
    }
    return Array.from(map.values());
  }, [transfer?.lines]);

  // No `if (!allowed) return null` gate: useRequireAuth returns true on the server but
  // false on the client's first render, so gating the render on it causes a hydration
  // mismatch. The loading/error guards below already protect the body; effects are gated
  // on `allowed` and the hook redirects unauthenticated users.

  const boxes = transfer?.boxes ?? [];
  const grns = transfer?.grn_records ?? [];
  const totalNet = boxes.reduce((s, b) => s + num(b.net_weight), 0);
  const totalGross = boxes.reduce((s, b) => s + num(b.gross_weight), 0);
  const packaging = totalGross - totalNet;
  const receivedBoxes = grns.reduce((s, g) => s + (g.received_boxes || 0), 0);
  // Per-lot rollup across boxes (origin = per-lot cold unit when known).
  const lotSummary = Object.values(
    boxes.reduce<Record<string, { lot: string; origin: string; count: number; net: number }>>((acc, b) => {
      const lot = b.lot_number || "—";
      if (!acc[lot]) acc[lot] = { lot, origin: b.lot_origin_unit || b.source_unit || "", count: 0, net: 0 };
      acc[lot].count += 1;
      acc[lot].net += num(b.net_weight);
      return acc;
    }, {}),
  );

  return (
    <TransferChrome title="Transfer-Out View">
      <button onClick={() => router.push("/modules/transfer")}
        className="text-[12px] text-[var(--text-secondary)] hover:underline mb-3">← Back to Transfer dashboard</button>

      {loading ? (
        <div className="py-16 flex items-center justify-center gap-2 text-[13px] text-[var(--text-secondary)]">
          <div className="h-5 w-5 rounded-full border-2 border-[var(--aws-border)] border-t-[var(--aws-navy)] animate-spin" />
          Loading transfer details…
        </div>
      ) : error ? (
        <div className="bg-white border border-rose-200 rounded-md py-10 text-center">
          <div className="text-[13px] text-rose-700">Error: {error}</div>
          <button onClick={() => load()}
            className="mt-3 border border-[var(--aws-border)] bg-white text-[12px] px-3 py-1.5 rounded hover:border-[var(--aws-navy)]">Retry</button>
        </div>
      ) : !transfer ? (
        <div className="bg-white border border-[var(--aws-border)] rounded-md py-10 text-center">
          <div className="text-[13px] text-[var(--text-secondary)]">Transfer not found.</div>
          <button onClick={() => router.push("/modules/transfer")}
            className="mt-3 border border-[var(--aws-border)] bg-white text-[12px] px-3 py-1.5 rounded hover:border-[var(--aws-navy)]">Back to Transfer dashboard</button>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Header */}
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h1 className="text-[18px] font-semibold text-[var(--text-primary)]">{transfer.challan_no}</h1>
              <div className="text-[12px] text-[var(--text-secondary)]">Transfer OUT{transfer.request_no ? ` — from request ${transfer.request_no}` : ""}</div>
              <div className="text-[13px] font-medium text-[var(--text-primary)] mt-1">
                {getDisplayWarehouseName(transfer.from_warehouse) || "N/A"} <span className="text-[var(--text-secondary)]">→</span> {getDisplayWarehouseName(transfer.to_warehouse) || "N/A"}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${statusTone(transfer.status)}`}>{transfer.status}</span>
              {grns.length === 0 && <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-gray-100 text-gray-600">Not yet received</span>}
              <button onClick={() => router.push(`/modules/transfer/dc/${transferId}`)}
                className="border border-[var(--aws-border)] bg-white text-[12px] px-3 py-1.5 rounded hover:border-[var(--aws-navy)]">Delivery Challan</button>
              <button onClick={() => window.print()}
                className="border border-[var(--aws-border)] bg-white text-[12px] px-3 py-1.5 rounded hover:border-[var(--aws-navy)]">Print</button>
            </div>
          </div>

          {transfer.has_variance && (
            <div className="text-[12px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">
              ⚠ Weight / box-count variance flagged on this transfer.
            </div>
          )}

          {/* Transfer information */}
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-4 space-y-4">
            <div className="text-[13px] font-semibold text-[var(--text-primary)]">Transfer information</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <InfoCard label="Transfer Date">{formatDate(transfer.stock_trf_date)}</InfoCard>
              <InfoCard label="From">{getDisplayWarehouseName(transfer.from_warehouse) || "N/A"}</InfoCard>
              <InfoCard label="To">{getDisplayWarehouseName(transfer.to_warehouse) || "N/A"}</InfoCard>
              {transfer.from_cold_unit && <InfoCard label="Cold Unit">{getDisplayWarehouseName(transfer.from_cold_unit) || transfer.from_cold_unit}</InfoCard>}
              {transfer.request_no && <InfoCard label="Request No">{transfer.request_no}</InfoCard>}
              <InfoCard label="Vehicle">{transfer.vehicle_no || "N/A"}</InfoCard>
              {transfer.driver_name && <InfoCard label="Driver">{transfer.driver_name}</InfoCard>}
              {transfer.approved_by && <InfoCard label="Approval Authority">{transfer.approved_by}</InfoCard>}
              {transfer.created_by && <InfoCard label="Created By">{transfer.created_by}</InfoCard>}
              {transfer.created_ts && <InfoCard label="Created">{formatDate(transfer.created_ts)}</InfoCard>}
              {transfer.approved_ts && <InfoCard label="Approved">{formatDate(transfer.approved_ts)}</InfoCard>}
              {transfer.reason_code && <InfoCard label="Reason">{transfer.reason_code}</InfoCard>}
              {transfer.remark && <InfoCard label="Remark">{transfer.remark}</InfoCard>}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 max-w-md">
              <div className="bg-sky-50 border border-sky-100 rounded-md p-3 text-center">
                <div className="text-[18px] font-semibold text-sky-700">{consolidatedLines.length}</div>
                <div className="text-[11px] text-[var(--text-secondary)]">Items</div>
              </div>
              <div className="bg-emerald-50 border border-emerald-100 rounded-md p-3 text-center">
                <div className="text-[18px] font-semibold text-emerald-700">{boxes.length}</div>
                <div className="text-[11px] text-[var(--text-secondary)]">Boxes Scanned</div>
              </div>
              <div className="bg-teal-50 border border-teal-100 rounded-md p-3 text-center">
                <div className="text-[18px] font-semibold text-teal-700">{receivedBoxes} / {boxes.length}</div>
                <div className="text-[11px] text-[var(--text-secondary)]">Boxes Received</div>
              </div>
            </div>
          </div>

          {/* Receipts (Transfer-IN) */}
          {grns.length > 0 && (
            <div className="bg-white border border-[var(--aws-border)] rounded-md">
              <div className="px-4 py-3 border-b border-[var(--aws-border)] text-[13px] font-semibold text-[var(--text-primary)]">
                Receipts — Transfer IN ({grns.length})
              </div>
              <div className="p-3 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {grns.map((g) => (
                  <div key={g.id} className="border border-[var(--aws-border)] rounded-md p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[12px] font-semibold text-[var(--text-primary)] font-mono">{g.grn_number}</span>
                      <span className={`text-[11px] px-1.5 rounded ${statusTone(g.status)}`}>{g.status}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                      <Detail label="Received By" value={g.received_by || "—"} />
                      <Detail label="Received At" value={formatDate(g.received_at)} />
                      <Detail label="Boxes Received" value={`${g.received_boxes} / ${boxes.length}`} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Items details */}
          {consolidatedLines.length > 0 && (
            <div className="bg-white border border-[var(--aws-border)] rounded-md">
              <div className="px-4 py-3 border-b border-[var(--aws-border)] text-[13px] font-semibold text-[var(--text-primary)]">
                Items Details ({consolidatedLines.length})
              </div>
              <div className="p-3 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {consolidatedLines.map((l, i) => {
                  const isFG = (l.material_type || "").toUpperCase() === "FG";
                  return (
                    <div key={i} className="border border-[var(--aws-border)] rounded-md p-3 space-y-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[11px] px-1.5 rounded bg-[var(--background)] text-[var(--text-secondary)]">Item #{i + 1}</span>
                        <span className="text-[11px] px-1.5 rounded border border-[var(--aws-border)] text-[var(--text-secondary)]">{l.material_type || "—"}</span>
                        {l._box_count > 1 && <span className="text-[11px] px-1.5 rounded bg-amber-100 text-amber-800">{l._box_count} boxes</span>}
                      </div>
                      <div className="text-[13px] font-medium text-[var(--text-primary)]">{l.item_description}</div>
                      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                        <Detail label="Category" value={l.item_category || "—"} />
                        <Detail label="Sub Category" value={l.sub_category || "—"} />
                        <Detail label="Quantity" value={l.quantity || "0"} />
                        <Detail label="UOM" value={l.uom || "—"} />
                        <Detail label={`Pack Size (${isFG ? "gm" : "Kg"})`} value={l.pack_size || "0"} />
                        {l.unit_pack_size && l.unit_pack_size !== "0" && <Detail label="Unit Pack Size/Count" value={l.unit_pack_size} />}
                        <Detail label="Net Weight" value={`${l.net_weight || "0"} kg`} />
                        <Detail label="Total Weight" value={`${l.total_weight || "0"} kg`} />
                        {l.batch_number && <Detail label="Batch Number" value={l.batch_number} />}
                        {l.lot_number && <Detail label="Lot Number" value={l.lot_number} />}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Scanned boxes */}
          {boxes.length > 0 ? (
            <div className="bg-white border border-[var(--aws-border)] rounded-md">
              <div className="px-4 py-3 border-b border-[var(--aws-border)] text-[13px] font-semibold text-[var(--text-primary)]">
                Scanned Boxes Details ({boxes.length})
              </div>
              <div className="p-3 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {boxes.map((b) => (
                  <div key={b.id} className="border border-[var(--aws-border)] rounded-md p-3 space-y-2 hover:shadow-md transition-shadow">
                    <div className="flex items-center justify-between">
                      <span className="text-[12px] font-semibold text-[var(--text-primary)]">Box #{b.box_number}</span>
                      <span className="text-[11px] px-1.5 rounded bg-emerald-100 text-emerald-800">Scanned</span>
                    </div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                      <Detail label="Article" value={b.article || "N/A"} />
                      <Detail label="Lot Number" value={b.lot_number || "N/A"} />
                      <Detail label="Box ID" value={<span className="font-mono">{b.box_id || "N/A"}</span>} />
                      <Detail label="Batch Number" value={b.batch_number || "N/A"} />
                      <Detail label="Transaction No" value={<span className="font-mono">{b.transaction_no || "N/A"}</span>} />
                      {b.source_unit && <Detail label="From (cold)" value={getDisplayWarehouseName(b.source_unit) || b.source_unit} />}
                    </div>
                    <div className="grid grid-cols-2 gap-2 pt-1">
                      <div className="bg-sky-50 rounded p-1.5 text-center"><div className="text-[13px] font-semibold text-sky-700">{b.net_weight} kg</div><div className="text-[10px] text-[var(--text-secondary)]">Net</div></div>
                      <div className="bg-violet-50 rounded p-1.5 text-center"><div className="text-[13px] font-semibold text-violet-700">{b.gross_weight} kg</div><div className="text-[10px] text-[var(--text-secondary)]">Gross</div></div>
                    </div>
                    {b.created_at && <div className="text-[10px] text-[var(--text-secondary)] pt-1 border-t border-[var(--aws-border)]">Scanned: {formatDate(b.created_at)}</div>}
                  </div>
                ))}
              </div>
              {/* Boxes summary */}
              <div className="px-4 py-3 border-t border-[var(--aws-border)] grid grid-cols-2 md:grid-cols-5 gap-3">
                <Tile label="Total Boxes" value={boxes.length} />
                <Tile label="Total Net Weight" value={`${totalNet.toFixed(2)} kg`} />
                <Tile label="Total Gross Weight" value={`${totalGross.toFixed(2)} kg`} />
                <Tile label="Packaging (Gross−Net)" value={`${packaging.toFixed(2)} kg`} />
                <Tile label="Avg Weight/Box" value={`${(boxes.length ? totalNet / boxes.length : 0).toFixed(2)} kg`} />
              </div>
            </div>
          ) : (
            <div className="bg-white border border-[var(--aws-border)] rounded-md py-10 text-center text-[13px] text-[var(--text-secondary)]">
              No boxes scanned for this transfer.
            </div>
          )}

          {/* Lot summary */}
          {lotSummary.length > 0 && (
            <div className="bg-white border border-[var(--aws-border)] rounded-md">
              <div className="px-4 py-3 border-b border-[var(--aws-border)] text-[13px] font-semibold text-[var(--text-primary)]">
                Lot Summary ({lotSummary.length})
              </div>
              <div className="p-3 overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead><tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]">
                    <th className="py-1.5">Lot</th><th>Origin (cold)</th><th className="text-right">Boxes</th><th className="text-right">Net Weight</th>
                  </tr></thead>
                  <tbody>
                    {lotSummary.map((r) => (
                      <tr key={r.lot} className="border-b border-[var(--aws-border)]/50">
                        <td className="py-1.5 font-mono">{r.lot}</td>
                        <td>{r.origin ? (getDisplayWarehouseName(r.origin) || r.origin) : "—"}</td>
                        <td className="text-right">{r.count}</td>
                        <td className="text-right">{r.net.toFixed(2)} kg</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </TransferChrome>
  );
}
