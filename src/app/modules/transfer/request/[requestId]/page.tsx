"use client";

// Request Details (doc 06) — read-only view of a single transfer request:
// header (route/dates/status/reason), summary tiles (item count + net weight),
// and a per-line breakdown. No approve/reject/edit/delete here — those live on
// the dashboard. Backed by the existing GET /api/v1/transfer/requests/{id}.

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import { TransferChrome } from "../../_chrome";
import { TransferApi, type TransferRequest } from "@/lib/transfer";
import { getDisplayWarehouseName } from "@/lib/transferBuildSummary";

function statusBadge(status: string): { label: string; cls: string } {
  switch ((status || "").toLowerCase()) {
    case "pending": return { label: "Pending", cls: "bg-amber-100 text-amber-800" };
    case "approved":
    case "accept": return { label: "Approved", cls: "bg-emerald-100 text-emerald-800" };
    case "transferred": return { label: "Transferred", cls: "bg-blue-100 text-blue-800" };
    case "rejected": return { label: "Rejected", cls: "bg-rose-100 text-rose-800" };
    case "cancelled": return { label: "Cancelled", cls: "bg-slate-100 text-slate-700" };
    default: return { label: status || "—", cls: "bg-slate-100 text-slate-700" };
  }
}

function formatDate(d?: string | null): string {
  if (!d) return "N/A";
  if (/^\d{2}-\d{2}-\d{4}$/.test(d)) return d;   // already DD-MM-YYYY from backend
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? d : dt.toLocaleDateString("en-GB").replace(/\//g, "-");
}
function formatDateTime(d?: string | null): string {
  if (!d) return "N/A";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return d;
  return `${dt.toLocaleDateString("en-GB").replace(/\//g, "-")} ${dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}
const num = (v: unknown) => { const n = parseFloat(String(v ?? "")); return Number.isFinite(n) ? n : 0; };

export default function RequestViewPage() {
  const router = useRouter();
  const allowed = useRequireAuth(router.replace);
  const params = useParams<{ requestId: string }>();
  const requestId = params?.requestId;

  const [request, setRequest] = useState<TransferRequest | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!requestId) return;
    setLoading(true);
    try {
      const r = await TransferApi.getRequest(Number(requestId));
      setRequest(r);
    } catch {
      setRequest(null);
    } finally {
      setLoading(false);
    }
  }, [requestId]);

  useEffect(() => {
    if (!allowed) return;
    queueMicrotask(() => { load(); });
  }, [allowed, load]);

  // No `if (!allowed) return null` gate: useRequireAuth returns true on the server but
  // false on the client's first render, so gating the render on it causes a hydration
  // mismatch. The loading/error guards below already protect the body; effects are gated
  // on `allowed` and the hook redirects unauthenticated users.

  const back = (
    <button onClick={() => router.push("/modules/transfer")}
      className="text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] mb-3">← Back to Transfers</button>
  );

  if (loading) {
    return <TransferChrome title="Request Details">{back}
      <div className="py-16 text-center text-[13px] text-[var(--text-secondary)]">Loading request details…</div>
    </TransferChrome>;
  }
  if (!request) {
    return <TransferChrome title="Request Details">{back}
      <div className="max-w-md mx-auto mt-12 bg-white border border-[var(--aws-border)] rounded-lg p-8 text-center">
        <div className="text-[15px] font-semibold text-[var(--text-primary)]">Request not found</div>
        <button onClick={() => router.push("/modules/transfer")}
          className="mt-4 px-3 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md hover:border-[var(--aws-navy)]">Back to Transfers</button>
      </div>
    </TransferChrome>;
  }

  const lines = request.lines ?? [];
  const totalNet = lines.reduce((s, l) => s + num(l.net_weight), 0);
  const badge = statusBadge(request.status);

  return (
    <TransferChrome title="Request Details">
      {back}
      <div className="flex flex-wrap items-start justify-between gap-2 mb-4">
        <div>
          <h1 className="text-[20px] font-semibold text-[var(--text-primary)] leading-tight">Request Details</h1>
          <div className="text-[12px] text-[var(--text-secondary)] font-mono">{request.request_no}</div>
        </div>
        <span className={`px-2.5 py-1 rounded-full text-[12px] font-medium ${badge.cls}`}>{badge.label}</span>
      </div>

      <div className="space-y-4 max-w-4xl">
        {/* Request info */}
        <section className="bg-white border border-[var(--aws-border)] rounded-lg p-4">
          <h2 className="text-[13px] font-semibold text-[var(--text-primary)] mb-3">Request information</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <Info label="Request Number" value={request.request_no} />
            <Info label="Request Date" value={formatDate(request.request_date)} />
            <Info label="Status"><span className={`inline-block px-2 py-0.5 rounded-full text-[11px] ${badge.cls}`}>{badge.label}</span></Info>
            <Info label="From Warehouse" value={getDisplayWarehouseName(request.from_warehouse) || "—"} />
            <Info label="To Warehouse" value={getDisplayWarehouseName(request.to_warehouse) || "—"} />
            {request.created_by && <Info label="Created By" value={request.created_by} />}
            {request.created_ts && <Info label="Created At" value={formatDateTime(request.created_ts)} />}
            {request.reason_description && (
              <div className="sm:col-span-2 lg:col-span-3">
                <Info label="Reason" value={request.reason_description} />
              </div>
            )}
            {request.reject_reason && (
              <div className="sm:col-span-2 lg:col-span-3">
                <span className="block text-[11px] uppercase tracking-wide text-[var(--text-secondary)] mb-1">Reject Reason</span>
                <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-md px-3 py-2 text-[13px]">{request.reject_reason}</div>
              </div>
            )}
          </div>

          {/* Summary tiles */}
          <div className="grid grid-cols-2 gap-3 mt-4">
            <div className="bg-blue-50 border border-blue-200 rounded-md p-3 text-center">
              <div className="text-[20px] font-semibold text-blue-700">{lines.length}</div>
              <div className="text-[11px] text-[var(--text-secondary)]">Total Items</div>
            </div>
            <div className="bg-violet-50 border border-violet-200 rounded-md p-3 text-center">
              <div className="text-[20px] font-semibold text-violet-700">{totalNet.toFixed(2)} kg</div>
              <div className="text-[11px] text-[var(--text-secondary)]">Total Net Weight</div>
            </div>
          </div>
        </section>

        {/* Items */}
        {lines.length > 0 ? (
          <section className="space-y-3">
            <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">Items Details ({lines.length})</h2>
            {lines.map((l, idx) => (
              <div key={l.id} className="bg-white border border-[var(--aws-border)] rounded-lg overflow-hidden">
                <div className="px-3 py-2 bg-[var(--background)] border-b border-[var(--aws-border)] flex items-center gap-2">
                  <span className="px-1.5 py-0.5 rounded text-[11px] bg-blue-100 text-blue-800 font-medium">Item #{idx + 1}</span>
                  {l.material_type && <span className="px-1.5 py-0.5 rounded text-[11px] border border-[var(--aws-border)] text-[var(--text-secondary)]">{l.material_type}</span>}
                </div>
                <div className="p-3">
                  <div className="text-[13px] font-medium text-[var(--text-primary)] mb-3">{l.item_description || "—"}</div>
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                    <Info label="Material Type" value={l.material_type || "—"} />
                    <Info label="Category" value={l.item_category || "—"} />
                    <Info label="Sub Category" value={l.sub_category || "—"} />
                    <Info label="Quantity" value={l.quantity || "—"} />
                    <Info label="UOM" value={l.uom || "—"} />
                    <Info label="Case Pack / Box Wt (kg)" value={l.pack_size || "—"} />
                    {num(l.unit_pack_size) > 0 && <Info label="Unit Pack Size / Count" value={l.unit_pack_size ?? ""} />}
                    <Info label="Net Weight (Kg)" value={`${l.net_weight || "0"} kg`} />
                    {l.lot_number && <Info label="Lot Number" value={l.lot_number} />}
                  </div>
                </div>
              </div>
            ))}
          </section>
        ) : (
          <section className="bg-white border border-[var(--aws-border)] rounded-lg p-8 text-center text-[13px] text-[var(--text-secondary)]">
            No items recorded on this request.
          </section>
        )}
      </div>
    </TransferChrome>
  );
}

function Info({ label, value, children }: { label: string; value?: string; children?: React.ReactNode }) {
  return (
    <div>
      <span className="block text-[11px] uppercase tracking-wide text-[var(--text-secondary)] mb-0.5">{label}</span>
      {children ?? <span className="text-[13px] text-[var(--text-primary)] break-words">{value}</span>}
    </div>
  );
}
