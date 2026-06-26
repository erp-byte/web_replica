"use client";

// Inter-Unit Transfer dashboard — replica of the production 5-tab transfer
// dashboard (server_replica/data/transfer-module-docs/01-transfer-dashboard.md).
// Phase 1: lists + stat cards + per-tab search/warehouse filter + pagination +
// delete actions + navigation. The ChallanHoverCard and PendingTransfersModal
// are layered in by P6 (this file exposes the `pendingOpen` state they hook).

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useRequireAuth, useMe, useUserScope } from "@/lib/user";
import { TransferChrome } from "./_chrome";
import {
  TransferApi,
  type TransferRequest,
  type TransferListItem,
  type TransferInRecord,
  type InnerColdChallan,
} from "@/lib/transfer";
import { ChallanHoverCard, type HoverLine } from "./_ChallanHoverCard";
import { PendingTransfersModal } from "./_PendingTransfersModal";
import { transferHoverData, transferInHoverData } from "./_hoverData";

const PER_PAGE = 15;
const FILTER_FETCH_SIZE = 500;
// Transfer Out / Transfer In are filtered (status/date/warehouse) client-side, so
// we pull the full server-scoped set up to the endpoint cap (le=1000).
const LIST_FETCH_SIZE = 1000;

const WAREHOUSE_CODES = [
  "W202", "A185", "A101", "A68", "F53", "Savla D-39", "Savla D-514", "Rishi", "Supreme",
];

function displayWarehouse(code: string): string {
  return code === "Supreme" ? "Supreme Cold" : code;
}
function normWh(s: string | null | undefined): string {
  return (s || "").trim().toLowerCase();
}
// Does `filter` match any candidate value? Splits comma-lists (a cold transfer
// may carry "Rishi, Savla D-39") and compares normalized.
function whHit(filter: string, ...vals: (string | null | undefined)[]): boolean {
  const f = normWh(filter);
  return vals.some((v) => (v || "").split(",").some((part) => normWh(part) === f));
}
// Direction-aware warehouse match: "from" checks only the source column(s),
// "to" only the destination, "all" either. "all" filter matches everything.
type WhDir = "all" | "from" | "to";
function warehouseMatchesDir(
  filter: string, dir: WhDir,
  fromVals: (string | null | undefined)[], toVals: (string | null | undefined)[],
): boolean {
  if (filter === "all") return true;
  if (dir === "from") return whHit(filter, ...fromVals);
  if (dir === "to") return whHit(filter, ...toVals);
  return whHit(filter, ...fromVals) || whHit(filter, ...toVals);
}
function searchMatch(query: string, fields: (string | null | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => (f || "").toLowerCase().includes(q));
}

// ── Date helpers for client-side range filtering ──
// stock_trf_date / request_date come back "DD-MM-YYYY"; grn_date is an ISO
// datetime. Both normalize to "YYYY-MM-DD" so lexicographic compare = chronological.
function dmyToISO(d?: string | null): string {
  const p = (d || "").split("-");
  return p.length === 3 ? `${p[2]}-${p[1]}-${p[0]}` : "";
}
function isoDay(d?: string | null): string {
  const s = String(d || "");
  return s.length >= 10 ? s.slice(0, 10) : "";
}
function inDateRange(day: string, from: string, to: string): boolean {
  if (!from && !to) return true;
  if (!day) return false;
  return (!from || day >= from) && (!to || day <= to);
}
// Display formatter for transfer dates: pass through DD-MM-YYYY (the backend's
// strftime format), reformat anything else, 'N/A' for empty. Mirrors the
// reference dashboard's formatDate.
function formatDate(d?: string | null): string {
  const s = (d || "").trim();
  if (!s) return "N/A";
  if (/^\d{2}-\d{2}-\d{4}$/.test(s)) return s;
  const dt = new Date(s);
  return isNaN(dt.getTime()) ? s : dt.toLocaleDateString("en-GB").replace(/\//g, "-");
}

type TabKey = "request" | "transferout" | "transferin" | "innercold" | "details";

const TABS: { key: TabKey; label: string; short: string }[] = [
  { key: "request", label: "Requests", short: "Req" },
  { key: "transferout", label: "Transfer Out", short: "Out" },
  { key: "transferin", label: "Transfer In", short: "In" },
  { key: "innercold", label: "Inner Cold", short: "Cold" },
  { key: "details", label: "All Transfers", short: "All" },
];

// ── Small presentational helpers ──────────────────────────────────────────
function StatCard({ label, value, tone, onClick }: {
  label: string; value: number | string; tone: string; onClick?: () => void;
}) {
  const clickable = !!onClick;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!clickable}
      className={`text-left bg-white border border-[var(--aws-border)] rounded-md p-3 shadow-[0_1px_1px_rgba(0,28,36,0.12)] ${clickable ? "hover:border-[var(--aws-navy)] cursor-pointer" : "cursor-default"}`}
    >
      <div className="text-[11px] uppercase tracking-wide text-[var(--text-secondary)]">{label}</div>
      <div className={`text-[20px] font-semibold ${tone}`}>{value}</div>
    </button>
  );
}

function PaginationBar({ page, totalPages, total, onPage }: {
  page: number; totalPages: number; total: number; onPage: (p: number) => void;
}) {
  if (totalPages <= 1) return null;
  const from = (page - 1) * PER_PAGE + 1;
  const to = Math.min(page * PER_PAGE, total);
  return (
    <div className="flex items-center justify-between mt-3 text-[12px] text-[var(--text-secondary)]">
      <span>Showing {from}-{to} of {total}</span>
      <div className="flex items-center gap-2">
        <button onClick={() => onPage(page - 1)} disabled={page <= 1}
          className="px-2 py-1 border border-[var(--aws-border)] rounded disabled:opacity-40">Prev</button>
        <span>{page}/{totalPages}</span>
        <button onClick={() => onPage(page + 1)} disabled={page >= totalPages}
          className="px-2 py-1 border border-[var(--aws-border)] rounded disabled:opacity-40">Next</button>
      </div>
    </div>
  );
}

function EmptyState({ msg }: { msg: string }) {
  return <div className="py-10 text-center text-[13px] text-[var(--text-secondary)]">{msg}</div>;
}
function LoadingSkeleton() {
  return (
    <div className="py-6 space-y-2 animate-pulse">
      {[0, 1, 2, 3].map((i) => <div key={i} className="h-8 bg-[var(--aws-border)]/40 rounded" />)}
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  Pending: "bg-amber-100 text-amber-800",
  Dispatch: "bg-sky-100 text-sky-800",
  Partial: "bg-orange-100 text-orange-800",
  Received: "bg-emerald-100 text-emerald-800",
  Completed: "bg-emerald-100 text-emerald-800",
  Rejected: "bg-rose-100 text-rose-800",
};
function StatusBadge({ status }: { status?: string | null }) {
  const s = status || "—";
  const tone = STATUS_TONE[s] || "bg-slate-100 text-slate-700";
  return <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium ${tone}`}>{s}</span>;
}

export default function TransferDashboardPage() {
  const router = useRouter();
  const allowed = useRequireAuth(router.replace);
  const me = useMe();
  const email = (me?.email || "").toLowerCase();
  const canDelete = email === "yash@candorfoods.in";
  const canDeleteInnerCold = email === "yash@candorfoods.in" || email === "hrithik@candorfoods.in";
  const canCancel = me?.is_admin === true || email === "yash@candorfoods.in" || email === "b.hrithik@candorfoods.in";

  // Warehouse dropdown: admins filter across all sites; a scoped user only sees
  // its own warehouse(s) (and the filter is hidden entirely when there's nothing
  // to choose between — its data is already scoped server-side).
  const { isAdmin, warehouses: userWarehouses } = useUserScope();
  const warehouseOptions = isAdmin ? WAREHOUSE_CODES : userWarehouses;
  const showWarehouseFilter = isAdmin || userWarehouses.length > 1;

  // Hydration-safe: render a cache-free shell on the server/first paint, then
  // flip `mounted` so client-only data effects run (avoids SSR mismatch).
  const [mounted, setMounted] = useState(false);
  // Defer the flip past the synchronous effect body (react-hooks/set-state-in-effect),
  // matching the pattern in lib/user.ts::useRequireAuth.
  useEffect(() => { queueMicrotask(() => setMounted(true)); }, []);

  const [activeTab, setActiveTab] = useState<TabKey>("request");
  const [warehouseFilter, setWarehouseFilter] = useState("all");
  // Which column the warehouse filter applies to: From, To, or both.
  const [warehouseDir, setWarehouseDir] = useState<WhDir>("all");
  // Requests status filter — defaults to Pending; "Transferred" = accepted/done.
  const [requestStatus, setRequestStatus] = useState<"Pending" | "Transferred" | "All">("Pending");
  // Transfer-Out has 3 statuses; Transfer-In has 2. Each is an individual filter
  // (+ "all"), plus a date range. Default "all".
  const [transferStatus, setTransferStatus] = useState<"all" | "Dispatch" | "Partial" | "Received">("all");
  const [transferInStatus, setTransferInStatus] = useState<"all" | "Pending" | "Received">("all");
  const [transferDateFrom, setTransferDateFrom] = useState("");
  const [transferDateTo, setTransferDateTo] = useState("");
  const [transferInDateFrom, setTransferInDateFrom] = useState("");
  const [transferInDateTo, setTransferInDateTo] = useState("");

  // Per-tab data
  const [requests, setRequests] = useState<TransferRequest[]>([]);
  const [requestsTotal, setRequestsTotal] = useState(0);
  const [transfers, setTransfers] = useState<TransferListItem[]>([]);
  const [transfersTotal, setTransfersTotal] = useState(0);
  const [transferIns, setTransferIns] = useState<TransferInRecord[]>([]);
  const [transferInsTotal, setTransferInsTotal] = useState(0);
  const [innerCold, setInnerCold] = useState<InnerColdChallan[]>([]);
  const [inTransitCount, setInTransitCount] = useState(0);

  // Per-tab pagination (Transfer-Out & All share `transfersPage`). Requests are
  // small + fully loaded, so they're filtered + paginated client-side.
  const [requestsPage, setRequestsPage] = useState(1);
  const [transfersPage, setTransfersPage] = useState(1);
  const [transferInsPage, setTransferInsPage] = useState(1);
  const [innerColdPage, setInnerColdPage] = useState(1);
  const [innerColdTP, setInnerColdTP] = useState(1);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingOpen, setPendingOpen] = useState(false);

  // Search boxes
  const [requestSearch, setRequestSearch] = useState("");
  const [transferOutSearch, setTransferOutSearch] = useState("");
  const [transferInSearch, setTransferInSearch] = useState("");

  const fail = (e: unknown, fallback: string) =>
    setError(e instanceof Error ? e.message : fallback);

  // Requests are few — fetch the whole (server-scoped) set once and do status /
  // warehouse / search filtering + pagination client-side. This keeps the stat
  // cards (total + pending) stable regardless of the active status filter.
  const loadRequests = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await TransferApi.getRequests({ page: 1, per_page: FILTER_FETCH_SIZE });
      setRequests(r.records); setRequestsTotal(r.total);
    } catch (e) { fail(e, "Failed to load requests."); }
    finally { setLoading(false); }
  }, []);

  // Like requests: fetch the whole (server-scoped) set once, then filter
  // (status / warehouse / search) + paginate client-side so the stat cards stay
  // stable regardless of the active status filter.
  const loadTransfers = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await TransferApi.getTransfers({ page: 1, per_page: LIST_FETCH_SIZE });
      setTransfers(r.records); setTransfersTotal(r.total);
    } catch (e) { fail(e, "Failed to load transfers."); }
    finally { setLoading(false); }
  }, []);

  const loadTransferIns = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await TransferApi.getTransferIns({ page: 1, per_page: LIST_FETCH_SIZE });
      setTransferIns(r.records); setTransferInsTotal(r.total);
    } catch (e) { fail(e, "Failed to load transfer INs."); }
    finally { setLoading(false); }
  }, []);

  const loadInnerCold = useCallback(async (page: number) => {
    setLoading(true); setError(null);
    try {
      const r = await TransferApi.getInnerColdList({ page, per_page: PER_PAGE });
      setInnerCold(r.records); setInnerColdTP(r.total_pages); setInnerColdPage(page);
    } catch (e) { fail(e, "Failed to load inner cold transfers."); }
    finally { setLoading(false); }
  }, []);

  const loadInTransitCount = useCallback(async () => {
    try {
      const r = await TransferApi.getPendingStock();
      setInTransitCount(r.total);
    } catch { /* keep prior count on error */ }
  }, []);

  // Populate the lists + stat cards once on mount. All status/warehouse/search
  // filtering + pagination is client-side over these (server-scoped) sets, so no
  // refetch is needed when a filter changes.
  useEffect(() => {
    if (!mounted || !allowed || !isAdmin) return;
    queueMicrotask(() => {
      loadTransfers();
      loadRequests();
      loadTransferIns();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, allowed, isAdmin]);

  // In-transit count once on mount (P6 also refreshes it on pending-modal close).
  useEffect(() => {
    if (!mounted || !allowed || !isAdmin) return;
    queueMicrotask(() => loadInTransitCount());
  }, [mounted, allowed, isAdmin, loadInTransitCount]);

  // Lazy-load Inner Cold the first time its tab opens.
  useEffect(() => {
    if (!mounted || !allowed || !isAdmin) return;
    if (activeTab === "innercold" && innerCold.length === 0) queueMicrotask(() => loadInnerCold(1));
  }, [activeTab, mounted, allowed, isAdmin, innerCold.length, loadInnerCold]);

  // ── Client-side filtered views ──
  const filteredRequests = useMemo(() => requests.filter((r) =>
    (requestStatus === "All" || r.status === requestStatus) &&
    warehouseMatchesDir(warehouseFilter, warehouseDir, [r.from_warehouse], [r.to_warehouse]) &&
    searchMatch(requestSearch, [r.request_no, r.from_warehouse, r.to_warehouse, r.request_date, r.status])
  ), [requests, requestStatus, warehouseFilter, warehouseDir, requestSearch]);

  // Client-side pagination for the Requests tab (clamped so reducing the filter
  // never strands you on an empty page).
  const requestsTP = Math.max(1, Math.ceil(filteredRequests.length / PER_PAGE));
  const reqPage = Math.min(requestsPage, requestsTP);
  const pagedRequests = filteredRequests.slice((reqPage - 1) * PER_PAGE, reqPage * PER_PAGE);

  const filteredTransfers = useMemo(() => transfers.filter((t) =>
    (transferStatus === "all" || t.status === transferStatus) &&
    inDateRange(dmyToISO(t.stock_trf_date), transferDateFrom, transferDateTo) &&
    warehouseMatchesDir(warehouseFilter, warehouseDir, [t.from_warehouse, t.from_cold_unit], [t.to_warehouse]) &&
    searchMatch(transferOutSearch, [
      t.challan_no, t.from_warehouse, t.to_warehouse, t.from_cold_unit,
      t.stock_trf_date, t.status, t.vehicle_no, t.lot_numbers_text,
    ])
  ), [transfers, transferStatus, transferDateFrom, transferDateTo, warehouseFilter, warehouseDir, transferOutSearch]);

  const filteredTransferIns = useMemo(() => transferIns.filter((ti) =>
    (transferInStatus === "all" || ti.status === transferInStatus) &&
    inDateRange(isoDay(ti.grn_date), transferInDateFrom, transferInDateTo) &&
    warehouseMatchesDir(warehouseFilter, warehouseDir, [ti.from_warehouse], [ti.receiving_warehouse]) &&
    searchMatch(transferInSearch, [
      ti.grn_number, ti.transfer_out_no, ti.receiving_warehouse, ti.from_warehouse,
      ti.received_by, ti.status, ti.grn_date,
    ])
  ), [transferIns, transferInStatus, transferInDateFrom, transferInDateTo, warehouseFilter, warehouseDir, transferInSearch]);

  // ── Incoming Material: dispatched transfer-OUTs that have no GRN started yet.
  //    A created transfer-out shows here automatically; once receiving begins it
  //    moves to the GRN list below (Resume), and once finalized it shows there as
  //    Received. "Material In" opens the interactive receive page for that transfer.
  const grnOutIds = useMemo(
    () => new Set(transferIns.map((ti) => ti.transfer_out_id)), [transferIns]);
  const filteredIncoming = useMemo(() => transfers.filter((t) => {
    const s = (t.status || "").toLowerCase();
    return s !== "received" && s !== "completed" && !grnOutIds.has(t.id) &&
      inDateRange(dmyToISO(t.stock_trf_date), transferInDateFrom, transferInDateTo) &&
      warehouseMatchesDir(warehouseFilter, warehouseDir, [t.from_warehouse, t.from_cold_unit], [t.to_warehouse]) &&
      searchMatch(transferInSearch, [
        t.challan_no, t.from_warehouse, t.to_warehouse, t.from_cold_unit, t.stock_trf_date, t.vehicle_no,
      ]);
  }), [transfers, grnOutIds, transferInDateFrom, transferInDateTo, warehouseFilter, warehouseDir, transferInSearch]);

  const pendingRequests = useMemo(
    () => requests.filter((r) => r.status === "Pending").length, [requests]);

  // Client-side pagination for the filtered Transfer-Out / Transfer-In tabs and
  // the (unfiltered) All-Transfers tab. Pages are clamped so a shrinking filter
  // never strands you on an empty page.
  const transfersTP = Math.max(1, Math.ceil(filteredTransfers.length / PER_PAGE));
  const toPage = Math.min(transfersPage, transfersTP);
  const pagedTransfers = filteredTransfers.slice((toPage - 1) * PER_PAGE, toPage * PER_PAGE);

  const allTransfersTP = Math.max(1, Math.ceil(transfers.length / PER_PAGE));
  const allPage = Math.min(transfersPage, allTransfersTP);
  const pagedAllTransfers = transfers.slice((allPage - 1) * PER_PAGE, allPage * PER_PAGE);

  const transferInsTP = Math.max(1, Math.ceil(filteredTransferIns.length / PER_PAGE));
  const tiPage = Math.min(transferInsPage, transferInsTP);
  const pagedTransferIns = filteredTransferIns.slice((tiPage - 1) * PER_PAGE, tiPage * PER_PAGE);

  // ── Delete handlers ──
  const confirmDelete = (msg: string) => typeof window !== "undefined" && window.confirm(msg);

  const onDeleteRequest = async (id: number) => {
    if (!confirmDelete("Delete this request?")) return;
    try { await TransferApi.deleteRequest(id); await loadRequests(); }
    catch (e) { fail(e, "Failed to delete request."); }
  };
  const onDeleteTransfer = async (id: number) => {
    if (!confirmDelete("Delete this transfer?")) return;
    try { await TransferApi.deleteTransfer(id); await loadTransfers(); await loadInTransitCount(); }
    catch (e) { fail(e, "Failed to delete transfer."); }
  };
  const onDeleteTransferIn = async (id: number) => {
    if (!confirmDelete("Delete this transfer-in?")) return;
    try { await TransferApi.deleteTransferIn(id); await loadTransferIns(); }
    catch (e) { fail(e, "Failed to delete transfer-in."); }
  };
  const onDeleteInnerCold = async (challanNo: string) => {
    if (!confirmDelete("Delete this inner-cold transfer?")) return;
    try { await TransferApi.deleteInnerCold(challanNo); await loadInnerCold(innerColdPage); }
    catch (e) { fail(e, "Failed to delete inner cold transfer."); }
  };

  const go = (path: string) => router.push(`/modules/transfer${path}`);

  // No `if (!allowed) return null` gate: useRequireAuth returns true on the server but
  // false on the client's first render, so gating the render on it causes a hydration
  // mismatch. The `isAdmin` guard below already protects the body; effects are gated on
  // `allowed` and the hook redirects unauthenticated users.

  if (!isAdmin) {
    return (
      <TransferChrome title="Inter-Unit Transfer">
        <h1 className="text-[20px] font-semibold text-[var(--text-primary)] mb-3">Inter-Unit Transfer</h1>
        <section className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-[13px] text-[var(--text-secondary)]">
          You don&rsquo;t have access to the Inter-Unit Transfer module. Ask an administrator to grant you access, or switch to a different account.
        </section>
      </TransferChrome>
    );
  }

  const resetListPages = () => { setRequestsPage(1); setTransfersPage(1); setTransferInsPage(1); };

  const WarehouseSelect = !showWarehouseFilter ? null : (
    <>
      <select
        value={warehouseFilter}
        onChange={(e) => { setWarehouseFilter(e.target.value); resetListPages(); }}
        className="border border-[var(--aws-border)] rounded px-2 py-1 text-[12px] bg-white"
      >
        <option value="all">All warehouses</option>
        {warehouseOptions.map((c) => <option key={c} value={c}>{displayWarehouse(c)}</option>)}
      </select>
      <select
        value={warehouseDir}
        disabled={warehouseFilter === "all"}
        onChange={(e) => { setWarehouseDir(e.target.value as WhDir); resetListPages(); }}
        title="Match the selected warehouse against the From column, the To column, or both"
        className="border border-[var(--aws-border)] rounded px-2 py-1 text-[12px] bg-white disabled:opacity-50"
      >
        <option value="all">From & To</option>
        <option value="from">From</option>
        <option value="to">To</option>
      </select>
    </>
  );

  const segBtn = (active: boolean) =>
    `px-3 py-1 text-[12px] rounded border ${active ? "bg-[var(--aws-navy)] text-white border-[var(--aws-navy)]" : "border-[var(--aws-border)] hover:border-[var(--aws-navy)]"}`;

  const RequestStatusFilter = (
    <div className="flex gap-1">
      {(["Pending", "Transferred", "All"] as const).map((s) => (
        <button key={s} onClick={() => { setRequestStatus(s); setRequestsPage(1); }} className={segBtn(requestStatus === s)}>
          {s}
        </button>
      ))}
    </div>
  );

  const TransferStatusFilter = (
    <div className="flex gap-1">
      {([["all", "All"], ["Dispatch", "Dispatch"], ["Partial", "Partial"], ["Received", "Received"]] as const).map(([v, label]) => (
        <button key={v} onClick={() => { setTransferStatus(v); setTransfersPage(1); }} className={segBtn(transferStatus === v)}>
          {label}
        </button>
      ))}
    </div>
  );

  const TransferInStatusFilter = (
    <div className="flex gap-1">
      {([["all", "All"], ["Pending", "Pending"], ["Received", "Received"]] as const).map(([v, label]) => (
        <button key={v} onClick={() => { setTransferInStatus(v); setTransferInsPage(1); }} className={segBtn(transferInStatus === v)}>
          {label}
        </button>
      ))}
    </div>
  );

  // Reusable From–To date range. resetPage runs on change so pagination resets.
  const DateRange = (
    from: string, setFrom: (v: string) => void,
    to: string, setTo: (v: string) => void, resetPage: () => void,
  ) => (
    <div className="flex items-center gap-1">
      <input type="date" value={from} aria-label="From date"
        onChange={(e) => { setFrom(e.target.value); resetPage(); }}
        className="border border-[var(--aws-border)] rounded px-1.5 py-1 text-[12px]" />
      <span className="text-[var(--text-secondary)] text-[12px]">–</span>
      <input type="date" value={to} aria-label="To date"
        onChange={(e) => { setTo(e.target.value); resetPage(); }}
        className="border border-[var(--aws-border)] rounded px-1.5 py-1 text-[12px]" />
      {(from || to) && (
        <button onClick={() => { setFrom(""); setTo(""); resetPage(); }}
          className="text-[11px] text-[var(--text-secondary)] underline ml-0.5">clear</button>
      )}
    </div>
  );

  const SearchBox = (value: string, setValue: (v: string) => void, placeholder: string) => (
    <div className="relative">
      <input
        value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder}
        className="border border-[var(--aws-border)] rounded px-2 py-1 text-[12px] w-full sm:w-64"
      />
      {value && (
        <button onClick={() => setValue("")} aria-label="Clear search"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--text-secondary)]">×</button>
      )}
    </div>
  );

  return (
    <TransferChrome title="Inter-Unit Transfer">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h1 className="text-[20px] font-semibold text-[var(--text-primary)]">Inter-Unit Transfer</h1>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setPendingOpen(true)}
            className="px-3 py-1.5 text-[12px] border border-[var(--aws-border)] rounded hover:border-[var(--aws-navy)]">Pending Transfers</button>
          <button onClick={() => go("/dashboard")}
            className="px-3 py-1.5 text-[12px] border border-[var(--aws-border)] rounded hover:border-[var(--aws-navy)]">View Summary</button>
          <button onClick={() => go("/request")}
            className="px-3 py-1.5 text-[12px] rounded bg-[var(--aws-navy)] text-white hover:opacity-90">New Request</button>
        </div>
      </div>

      {error && (
        <div className="mb-3 text-[12px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-3 py-2">{error}</div>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 mb-4">
        <StatCard label="Requests" value={requestsTotal} tone="text-[var(--text-primary)]" />
        <StatCard label="Pending" value={pendingRequests} tone="text-amber-600" />
        <StatCard label="Transfers Out" value={transfersTotal} tone="text-violet-700" />
        <StatCard label="Transfers In" value={transferInsTotal} tone="text-teal-700" />
        <StatCard label="In Transit" value={inTransitCount} tone="text-orange-600" onClick={() => setPendingOpen(true)} />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[var(--aws-border)] overflow-x-auto mb-3">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setActiveTab(t.key)}
            className={`px-3 py-2 text-[12px] whitespace-nowrap border-b-2 -mb-px ${activeTab === t.key ? "border-[var(--aws-navy)] text-[var(--text-primary)] font-semibold" : "border-transparent text-[var(--text-secondary)]"}`}>
            <span className="hidden sm:inline">{t.label}</span>
            <span className="sm:hidden">{t.short}</span>
          </button>
        ))}
      </div>

      {loading ? <LoadingSkeleton /> : (
        <>
          {/* Requests */}
          {activeTab === "request" && (
            <Section
              filterBar={<>{RequestStatusFilter}{SearchBox(requestSearch, setRequestSearch, "Search requests…")}{WarehouseSelect}</>}
              empty={filteredRequests.length === 0}
              emptyMsg="No requests found."
              pagination={<PaginationBar page={reqPage} totalPages={requestsTP} total={filteredRequests.length} onPage={setRequestsPage} />}
            >
              <table className="hidden md:table w-full text-[12px]">
                <thead><tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]">
                  <th className="py-2">Request No</th><th>From</th><th>To</th><th>Date</th><th>Status</th><th></th>
                </tr></thead>
                <tbody>
                  {pagedRequests.map((r) => (
                    <tr key={r.id} className="border-b border-[var(--aws-border)]/50">
                      <td className="py-2 font-medium">
                        <ChallanHoverCard label={r.request_no} from={r.from_warehouse} to={r.to_warehouse}
                          reason={r.status} lines={requestHoverLines(r)} />
                      </td>
                      <td>{r.from_warehouse}</td><td>{r.to_warehouse}</td>
                      <td>{r.request_date}</td><td><StatusBadge status={r.status} /></td>
                      <td className="text-right whitespace-nowrap">
                        <RowBtn onClick={() => go(`/request/${r.id}`)}>View</RowBtn>
                        <RowBtn disabled={r.status?.toLowerCase() !== "pending"}
                          onClick={() => go(`/transferform?requestId=${r.id}`)}>Accept</RowBtn>
                        {canDelete && <RowBtn danger onClick={() => onDeleteRequest(r.id)}>Delete</RowBtn>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="md:hidden space-y-2">
                {pagedRequests.map((r) => (
                  <Card key={r.id}>
                    <CardHead title={r.request_no} status={r.status} />
                    <CardRow>{r.from_warehouse} → {r.to_warehouse} · {r.request_date}</CardRow>
                    <CardActions>
                      <RowBtn onClick={() => go(`/request/${r.id}`)}>View</RowBtn>
                      <RowBtn disabled={r.status?.toLowerCase() !== "pending"} onClick={() => go(`/transferform?requestId=${r.id}`)}>Accept</RowBtn>
                      {canDelete && <RowBtn danger onClick={() => onDeleteRequest(r.id)}>Delete</RowBtn>}
                    </CardActions>
                  </Card>
                ))}
              </div>
            </Section>
          )}

          {/* Transfer Out */}
          {activeTab === "transferout" && (
            <Section
              filterBar={<>{TransferStatusFilter}
                {DateRange(transferDateFrom, setTransferDateFrom, transferDateTo, setTransferDateTo, () => setTransfersPage(1))}
                {SearchBox(transferOutSearch, setTransferOutSearch, "Search transfers…")}{WarehouseSelect}
                <button onClick={() => go("/directtransferform")}
                  className="px-3 py-1 text-[12px] rounded bg-[var(--aws-navy)] text-white">Direct Transfer Out</button></>}
              empty={filteredTransfers.length === 0}
              emptyMsg="No transfers found."
              pagination={<PaginationBar page={toPage} totalPages={transfersTP} total={filteredTransfers.length} onPage={setTransfersPage} />}
            >
              <TransferTable rows={pagedTransfers} go={go} canDelete={canDelete} onDelete={onDeleteTransfer} showActions />
              <TransferCards rows={pagedTransfers} go={go} canDelete={canDelete} onDelete={onDeleteTransfer} showActions />
            </Section>
          )}

          {/* Transfer In */}
          {activeTab === "transferin" && (
            <>
            {/* Filters / search / actions stay at the top of the tab. Search, date and
                warehouse filter BOTH lists below; the All/Pending/Received segment
                applies to the GRN records. */}
            <div className="flex flex-wrap items-center gap-2 mb-3">
              {TransferInStatusFilter}
              {DateRange(transferInDateFrom, setTransferInDateFrom, transferInDateTo, setTransferInDateTo, () => setTransferInsPage(1))}
              {SearchBox(transferInSearch, setTransferInSearch, "Search…")}{WarehouseSelect}
            </div>

            <IncomingMaterial rows={filteredIncoming} go={go} />

            <div className="bg-white border border-[var(--aws-border)] rounded-md">
              <div className="px-4 py-3 border-b border-[var(--aws-border)] text-[13px] font-semibold text-[var(--text-primary)]">
                Transfer-In Records ({filteredTransferIns.length})
              </div>
              <div className="p-3">
            <Section
              empty={filteredTransferIns.length === 0}
              emptyMsg="No transfer-ins found."
              pagination={<PaginationBar page={tiPage} totalPages={transferInsTP} total={filteredTransferIns.length} onPage={setTransferInsPage} />}
            >
              <table className="hidden md:table w-full text-[12px]">
                <thead><tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]">
                  <th className="py-2">GRN</th><th>Transfer Out</th><th>From</th><th>Receiving</th><th>Boxes</th><th>Status</th><th></th>
                </tr></thead>
                <tbody>
                  {pagedTransferIns.map((ti) => (
                    <tr key={ti.id} className="border-b border-[var(--aws-border)]/50">
                      <td className="py-2 font-medium">
                        <ChallanHoverCard label={ti.grn_number} from={ti.from_warehouse} to={ti.receiving_warehouse}
                          fetchLines={() => TransferApi.getTransferIn(ti.id).then(transferInHoverData)} />
                      </td>
                      <td>{ti.transfer_out_no}</td><td>{ti.from_warehouse || "—"}</td>
                      <td>{ti.receiving_warehouse}</td><td>{ti.total_boxes_scanned}</td>
                      <td><StatusBadge status={ti.status} /></td>
                      <td className="text-right whitespace-nowrap">
                        {ti.status?.toLowerCase() === "pending" &&
                          <RowBtn onClick={() => go(`/transferIn?resume=${encodeURIComponent(ti.transfer_out_no)}`)}>Resume</RowBtn>}
                        <RowBtn onClick={() => go(`/transferIn/${ti.id}`)}>View</RowBtn>
                        {canDelete && <RowBtn danger onClick={() => onDeleteTransferIn(ti.id)}>Delete</RowBtn>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="md:hidden space-y-2">
                {pagedTransferIns.map((ti) => (
                  <Card key={ti.id}>
                    <CardHead title={ti.grn_number} status={ti.status} />
                    <CardRow>{ti.transfer_out_no} · {ti.receiving_warehouse} · {ti.total_boxes_scanned} boxes</CardRow>
                    <CardActions>
                      <RowBtn onClick={() => go(`/transferIn/${ti.id}`)}>View</RowBtn>
                      {canDelete && <RowBtn danger onClick={() => onDeleteTransferIn(ti.id)}>Delete</RowBtn>}
                    </CardActions>
                  </Card>
                ))}
              </div>
            </Section>
              </div>
            </div>
            </>
          )}

          {/* Inner Cold */}
          {activeTab === "innercold" && (
            <Section
              filterBar={<button onClick={() => go("/innercoldtransfer")}
                className="px-3 py-1 text-[12px] rounded bg-[var(--aws-navy)] text-white">New Transfer</button>}
              empty={innerCold.length === 0}
              emptyMsg="No inner cold transfers found."
              pagination={<PaginationBar page={innerColdPage} totalPages={innerColdTP} total={innerCold.length} onPage={loadInnerCold} />}
            >
              <table className="hidden md:table w-full text-[12px]">
                <thead><tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]">
                  <th className="py-2">Challan</th><th>Date</th><th>From</th><th>Lines</th><th>Boxes</th><th>Status</th><th></th>
                </tr></thead>
                <tbody>
                  {innerCold.map((c) => (
                    <tr key={c.challan_no} className="border-b border-[var(--aws-border)]/50">
                      <td className="py-2 font-medium">
                        <ChallanHoverCard label={c.challan_no || "—"} from={c.from_warehouse} to={c.from_warehouse}
                          reason={c.reason_code} lines={innerColdHoverLines(c)} />
                      </td>
                      <td>{c.transfer_date}</td><td>{c.from_warehouse}</td>
                      <td>{c.line_count}</td><td>{c.total_boxes ?? "—"}</td>
                      <td><StatusBadge status={c.status} /></td>
                      <td className="text-right whitespace-nowrap">
                        <RowBtn onClick={() => go(`/innercoldtransfer?editChallan=${encodeURIComponent(c.challan_no || "")}`)}>Edit</RowBtn>
                        {canDeleteInnerCold && c.challan_no &&
                          <RowBtn danger onClick={() => onDeleteInnerCold(c.challan_no!)}>Delete</RowBtn>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="md:hidden space-y-2">
                {innerCold.map((c) => (
                  <Card key={c.challan_no}>
                    <CardHead title={c.challan_no || "—"} status={c.status} />
                    <CardRow>{c.from_warehouse} · {c.line_count} lines · {c.total_boxes ?? "—"} boxes</CardRow>
                    <CardActions>
                      <RowBtn onClick={() => go(`/innercoldtransfer?editChallan=${encodeURIComponent(c.challan_no || "")}`)}>Edit</RowBtn>
                      {canDeleteInnerCold && c.challan_no &&
                        <RowBtn danger onClick={() => onDeleteInnerCold(c.challan_no!)}>Delete</RowBtn>}
                    </CardActions>
                  </Card>
                ))}
              </div>
            </Section>
          )}

          {/* All Transfers (shares `transfers`, unfiltered) */}
          {activeTab === "details" && (
            <Section empty={transfers.length === 0} emptyMsg="No transfers found."
              pagination={<PaginationBar page={allPage} totalPages={allTransfersTP} total={transfers.length} onPage={setTransfersPage} />}>
              <TransferTable rows={pagedAllTransfers} go={go} canDelete={false} onDelete={onDeleteTransfer} showActions={false} />
              <TransferCards rows={pagedAllTransfers} go={go} canDelete={false} onDelete={onDeleteTransfer} showActions={false} />
            </Section>
          )}
        </>
      )}

      <PendingTransfersModal
        open={pendingOpen}
        onClose={() => { setPendingOpen(false); loadInTransitCount(); }}
        canCancel={canCancel}
      />
    </TransferChrome>
  );
}

// Map a request's article lines to hover-card lines.
function requestHoverLines(r: TransferRequest): HoverLine[] {
  return r.lines.map((l) => ({
    name: l.item_description, qty: l.quantity, weightKg: l.net_weight, lot: l.lot_number,
  }));
}
// Map an inner-cold challan's relabel lines to hover-card lines.
function innerColdHoverLines(c: InnerColdChallan): HoverLine[] {
  return c.lines.map((l) => ({
    name: l.item_description || "—", qty: l.quantity,
    weightKg: l.net_weight_kg, lotFrom: l.old_lot_number, lotTo: l.new_lot_number,
    sourceUnit: l.new_storage_location,
  }));
}

// ── Row/section building blocks ──────────────────────────────────────────
function RowBtn({ children, onClick, disabled, danger, primary }: {
  children: React.ReactNode; onClick?: () => void; disabled?: boolean; danger?: boolean; primary?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={`ml-1 px-2 py-0.5 text-[11px] border rounded disabled:opacity-40 ${
        danger ? "border-rose-300 text-rose-700 hover:bg-rose-50"
          : primary ? "border-[var(--aws-navy)] bg-[var(--aws-navy)] text-white hover:opacity-90"
            : "border-[var(--aws-border)] hover:border-[var(--aws-navy)]"}`}>
      {children}
    </button>
  );
}

function Section({ filterBar, children, empty, emptyMsg, pagination }: {
  filterBar?: React.ReactNode; children: React.ReactNode; empty: boolean; emptyMsg: string; pagination?: React.ReactNode;
}) {
  return (
    <div>
      {filterBar && <div className="flex flex-wrap items-center gap-2 mb-3">{filterBar}</div>}
      {empty ? <EmptyState msg={emptyMsg} /> : children}
      {!empty && pagination}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="border border-[var(--aws-border)] rounded-md p-3 bg-white">{children}</div>;
}
function CardHead({ title, status }: { title: string; status?: string | null }) {
  return <div className="flex items-center justify-between mb-1"><span className="font-medium text-[13px]">{title}</span><StatusBadge status={status} /></div>;
}
function CardRow({ children }: { children: React.ReactNode }) {
  return <div className="text-[12px] text-[var(--text-secondary)]">{children}</div>;
}
function CardActions({ children }: { children: React.ReactNode }) {
  return <div className="mt-2 flex flex-wrap gap-1">{children}</div>;
}
// Items + total-qty badge pair shown in the Transfer-Out "Items/Boxes" column,
// mirroring the reference dashboard.
function ItemsBadges({ items, qty }: { items: number; qty: number }) {
  return (
    <span className="inline-flex items-center gap-1 flex-wrap">
      <span className="px-1.5 py-0.5 rounded text-[11px] bg-blue-50 text-blue-700 border border-blue-200">
        {items} Item{items !== 1 ? "s" : ""}
      </span>
      <span className="px-1.5 py-0.5 rounded text-[11px] bg-amber-50 text-amber-700 border border-amber-200">
        Qty: {qty || 0}
      </span>
    </span>
  );
}

function TransferTable({ rows, go, canDelete, onDelete, showActions }: {
  rows: TransferListItem[]; go: (p: string) => void; canDelete: boolean; onDelete: (id: number) => void; showActions: boolean;
}) {
  return (
    <table className="hidden md:table w-full text-[12px]">
      <thead><tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]">
        <th className="py-2">Challan</th><th>Status</th><th>Route</th><th>Date</th><th>Vehicle</th><th>Items/Boxes</th><th></th>
      </tr></thead>
      <tbody>
        {rows.map((t) => (
          <tr key={t.id} className="border-b border-[var(--aws-border)]/50">
            <td className="py-2 font-medium">
              <ChallanHoverCard label={t.challan_no} from={displayWarehouse(t.from_warehouse)} to={displayWarehouse(t.to_warehouse)}
                fetchLines={() => TransferApi.getTransfer(t.id).then(transferHoverData)} />
            </td>
            <td><StatusBadge status={t.status} /></td>
            <td className="whitespace-nowrap">{displayWarehouse(t.from_warehouse)} → {displayWarehouse(t.to_warehouse)}</td>
            <td>{formatDate(t.stock_trf_date)}</td>
            <td>
              {t.vehicle_no || "—"}
              {t.driver_name && <span className="block text-[11px] text-[var(--text-secondary)]">{t.driver_name}</span>}
            </td>
            <td><ItemsBadges items={t.items_count} qty={t.total_qty} /></td>
            <td className="text-right whitespace-nowrap">
              <RowBtn onClick={() => go(`/view/${t.id}`)}>View</RowBtn>
              {showActions && <RowBtn disabled={["received", "completed"].includes((t.status || "").toLowerCase())}
                onClick={() => go(`/directtransferform?editId=${t.id}`)}>Edit</RowBtn>}
              <RowBtn onClick={() => go(`/dc/${t.id}`)}>DC</RowBtn>
              {showActions && canDelete && <RowBtn danger onClick={() => onDelete(t.id)}>Delete</RowBtn>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Incoming Material — dispatched transfer-OUTs awaiting receipt. "Material In"
// opens the interactive receive page (/transferIn?resume=<challan>) pre-loaded
// with that transfer-out's details.
function IncomingMaterial({ rows, go }: { rows: TransferListItem[]; go: (p: string) => void }) {
  if (rows.length === 0) return null;
  const receive = (t: TransferListItem) => go(`/transferIn?resume=${encodeURIComponent(t.challan_no)}`);
  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md mb-4">
      <div className="px-4 py-3 border-b border-[var(--aws-border)] flex items-center justify-between">
        <span className="text-[13px] font-semibold text-[var(--text-primary)]">Incoming Material ({rows.length})</span>
        <span className="text-[11px] text-[var(--text-secondary)]">Dispatched transfers awaiting receipt</span>
      </div>
      <table className="hidden md:table w-full text-[12px]">
        <thead><tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]">
          <th className="px-4 py-2">Challan</th><th>Route</th><th>Date</th><th>Vehicle</th><th>Items/Boxes</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} className="border-b border-[var(--aws-border)]/50">
              <td className="px-4 py-2 font-mono font-medium">{t.challan_no}</td>
              <td className="whitespace-nowrap">{displayWarehouse(t.from_warehouse)} → {displayWarehouse(t.to_warehouse)}</td>
              <td>{formatDate(t.stock_trf_date)}</td>
              <td>{t.vehicle_no || "—"}</td>
              <td><ItemsBadges items={t.items_count} qty={t.total_qty} /></td>
              <td><StatusBadge status={t.status} /></td>
              <td className="text-right whitespace-nowrap">
                <RowBtn onClick={() => go(`/view/${t.id}`)}>View</RowBtn>
                <RowBtn primary onClick={() => receive(t)}>Transfer In</RowBtn>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="md:hidden p-3 space-y-2">
        {rows.map((t) => (
          <div key={t.id} className="border border-[var(--aws-border)] rounded-md p-2">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[12px] font-medium">{t.challan_no}</span>
              <StatusBadge status={t.status} />
            </div>
            <div className="text-[11px] text-[var(--text-secondary)]">
              {displayWarehouse(t.from_warehouse)} → {displayWarehouse(t.to_warehouse)} · {formatDate(t.stock_trf_date)}
            </div>
            <div className="mt-1"><ItemsBadges items={t.items_count} qty={t.total_qty} /></div>
            <div className="mt-2 flex flex-wrap gap-1">
              <RowBtn onClick={() => go(`/view/${t.id}`)}>View</RowBtn>
              <RowBtn primary onClick={() => receive(t)}>Transfer In</RowBtn>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TransferCards({ rows, go, canDelete, onDelete, showActions }: {
  rows: TransferListItem[]; go: (p: string) => void; canDelete: boolean; onDelete: (id: number) => void; showActions: boolean;
}) {
  return (
    <div className="md:hidden space-y-2">
      {rows.map((t) => (
        <Card key={t.id}>
          <CardHead title={t.challan_no} status={t.status} />
          <CardRow>{displayWarehouse(t.from_warehouse)} → {displayWarehouse(t.to_warehouse)} · {formatDate(t.stock_trf_date)}{t.vehicle_no ? ` · ${t.vehicle_no}` : ""}</CardRow>
          <div className="mt-1"><ItemsBadges items={t.items_count} qty={t.total_qty} /></div>
          <CardActions>
            <RowBtn onClick={() => go(`/view/${t.id}`)}>View</RowBtn>
            {showActions && <RowBtn disabled={["received", "completed"].includes((t.status || "").toLowerCase())}
              onClick={() => go(`/directtransferform?editId=${t.id}`)}>Edit</RowBtn>}
            <RowBtn onClick={() => go(`/dc/${t.id}`)}>DC</RowBtn>
            {showActions && canDelete && <RowBtn danger onClick={() => onDelete(t.id)}>Delete</RowBtn>}
          </CardActions>
        </Card>
      ))}
    </div>
  );
}
