"use client";

// Transfer Summary — clean, admin-only analytics dashboard (doc 04).
// Loads a recent date window by default (fast) and widens on demand. KPIs,
// filters and a single-level group→transfers rollup are computed client-side
// over the loaded window. Stale-while-revalidate cache (per window) paints
// instantly on return.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useRequireAuth, useUserScope } from "@/lib/user";
import { TransferChrome } from "../_chrome";
import {
  TransferDashboardApi,
  readTransferCache,
  writeTransferCache,
  type TransferRecord,
} from "@/lib/transferDashboard";
import {
  buildGroups,
  computeKpis,
  normalizeWarehouseName,
  canonicalizeCategory,
  getDisplayWarehouseName,
  DIM_LABELS,
  type GroupDim,
  type SortBy,
  type SummaryGroup,
} from "@/lib/transferBuildSummary";
import { useSessionCache } from "@/lib/session-state";

const GROUP_DIMS: GroupDim[] = [
  "route", "from_warehouse", "to_warehouse", "status", "item_category", "material_type", "transfer_month", "received_status",
];

type WindowKey = "month" | "lastmonth" | "3m" | "fy" | "all" | "custom";
const WINDOW_LABELS: Record<WindowKey, string> = {
  month: "This month", lastmonth: "Last month", "3m": "Last 3 months",
  fy: "This financial year", all: "All time", custom: "Custom range",
};

const SEARCH_FIELDS: (keyof TransferRecord)[] = [
  "challan_no", "from_warehouse", "to_warehouse", "vehicle_no", "driver_name",
  "status", "created_by", "remark", "item_description", "item_category",
  "sub_category", "material_type", "lot_number", "received_status", "issue_items",
];

const STATUS_TONE: Record<string, string> = {
  dispatch: "bg-blue-50 text-blue-700",
  received: "bg-emerald-50 text-emerald-700",
  pending: "bg-amber-50 text-amber-700",
  partial: "bg-orange-50 text-orange-700",
};
const statusTone = (s: string) => STATUS_TONE[(s || "").toLowerCase()] || "bg-slate-100 text-slate-600";

const fmtN = (n: number) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 }).format(n || 0);
// compact weight: kg under 1000, else tonnes
function fmtWt(kg: number): string {
  if (kg >= 1000) return `${fmtN(kg / 1000)} t`;
  return `${fmtN(kg)} kg`;
}

function pad(n: number) { return String(n).padStart(2, "0"); }
function iso(d: Date) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

// Pure: window key → { cacheKey, from?, to? } using the current date.
function computeWindow(key: WindowKey, customFrom: string, customTo: string): { cacheKey: string; from?: string; to?: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (key) {
    case "month": return { cacheKey: "month", from: iso(new Date(y, m, 1)) };
    case "lastmonth": return { cacheKey: "lastmonth", from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) };
    case "3m": return { cacheKey: "3m", from: iso(new Date(y, m - 2, 1)) };
    case "fy": {
      const fyStart = m >= 3 ? new Date(y, 3, 1) : new Date(y - 1, 3, 1);
      return { cacheKey: "fy", from: iso(fyStart) };
    }
    case "all": return { cacheKey: "all" };
    case "custom": return { cacheKey: `custom:${customFrom}:${customTo}`, from: customFrom || undefined, to: customTo || undefined };
  }
}

function makeSearch(query: string): (r: TransferRecord) => boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return () => true;
  return (r) => {
    const hay = SEARCH_FIELDS.map((f) => String(r[f] ?? "")).join(" ").toLowerCase();
    return terms.every((t) => hay.includes(t));
  };
}

function normalizeRecord(r: TransferRecord): TransferRecord {
  return {
    ...r,
    from_warehouse: normalizeWarehouseName(r.from_warehouse),
    to_warehouse: normalizeWarehouseName(r.to_warehouse),
    item_category: canonicalizeCategory(r.item_category),
    sub_category: canonicalizeCategory(r.sub_category),
  };
}

export default function TransferDashboardPage() {
  const router = useRouter();
  const allowed = useRequireAuth(router.replace);
  const { isAdmin } = useUserScope();
  const hasAccess = isAdmin;   // Transfer Summary dashboard is admin-only.

  // data
  const [records, setRecords] = useState<TransferRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  // window (persisted)
  const [windowKey, setWindowKey] = useSessionCache<WindowKey>("transfer-dash:window", "month");
  const [customFrom, setCustomFrom] = useSessionCache<string>("transfer-dash:customFrom", "");
  const [customTo, setCustomTo] = useSessionCache<string>("transfer-dash:customTo", "");

  // filters/view (persisted)
  const [selFrom, setSelFrom] = useSessionCache<string[]>("transfer-dash:selFrom", []);
  const [selTo, setSelTo] = useSessionCache<string[]>("transfer-dash:selTo", []);
  const [selStatus, setSelStatus] = useSessionCache<string[]>("transfer-dash:selStatus", []);
  const [selCategory, setSelCategory] = useSessionCache<string[]>("transfer-dash:selCategory", []);
  const [selMaterial, setSelMaterial] = useSessionCache<string[]>("transfer-dash:selMaterial", []);
  const [issuesOnly, setIssuesOnly] = useSessionCache<boolean>("transfer-dash:issuesOnly", false);
  const [groupBy, setGroupBy] = useSessionCache<GroupDim>("transfer-dash:groupBy", "route");
  const [sortBy, setSortBy] = useSessionCache<SortBy>("transfer-dash:sortBy", "weight");

  // filters panel open by default so filtering is visible/discoverable
  const [filtersOpen, setFiltersOpen] = useSessionCache<boolean>("transfer-dash:filtersOpen", true);

  // ephemeral
  const [searchQuery, setSearchQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  // Tracks the window the user is currently looking at, so a slow response for
  // a window they've since navigated away from can't clobber the live data.
  const activeKey = useRef("");

  const loadWindow = useCallback(async (cacheKey: string, from?: string, to?: string) => {
    activeKey.current = cacheKey;
    const cached = readTransferCache(cacheKey);
    if (cached) {
      setRecords(cached.records.map(normalizeRecord));
      setLastUpdated(cached.cachedAt);
      setLoading(false);
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    try {
      const res = await TransferDashboardApi.getAllData(from, to);
      if (activeKey.current !== cacheKey) return;   // stale — a newer window won
      setRecords(res.records.map(normalizeRecord));
      const ts = Date.now();
      setLastUpdated(ts);
      writeTransferCache(cacheKey, res.records, ts);
      setError(null);
    } catch (e) {
      if (!cached && activeKey.current === cacheKey) setError(e instanceof Error ? e.message : "Failed to load dashboard.");
    } finally {
      if (activeKey.current === cacheKey) { setLoading(false); setRefreshing(false); }
    }
  }, []);

  useEffect(() => {
    if (!allowed || !hasAccess) return;
    const { cacheKey, from, to } = computeWindow(windowKey, customFrom, customTo);
    queueMicrotask(() => { loadWindow(cacheKey, from, to); });
  }, [allowed, hasAccess, windowKey, customFrom, customTo, loadWindow]);

  const refresh = useCallback(() => {
    const { cacheKey, from, to } = computeWindow(windowKey, customFrom, customTo);
    setRefreshing(true);
    loadWindow(cacheKey, from, to);
  }, [windowKey, customFrom, customTo, loadWindow]);

  // cascading filter options (each chip group ignores its own active filter)
  const passesExcept = useCallback((r: TransferRecord, exclude: string): boolean => {
    if (exclude !== "from" && selFrom.length && !selFrom.includes(r.from_warehouse)) return false;
    if (exclude !== "to" && selTo.length && !selTo.includes(r.to_warehouse)) return false;
    if (exclude !== "status" && selStatus.length && !selStatus.includes(r.status)) return false;
    if (exclude !== "category" && selCategory.length && !selCategory.includes(r.item_category)) return false;
    if (exclude !== "material" && selMaterial.length && !selMaterial.includes(r.material_type)) return false;
    if (exclude !== "issues" && issuesOnly && !r.has_issue) return false;
    return true;
  }, [selFrom, selTo, selStatus, selCategory, selMaterial, issuesOnly]);

  const opts = useMemo(() => {
    const distinct = (key: keyof TransferRecord, exclude: string) => {
      const set = new Set<string>();
      for (const r of records) {
        if (!passesExcept(r, exclude)) continue;
        const v = String(r[key] ?? "").trim();
        if (v) set.add(v);
      }
      return [...set].sort((a, b) => a.localeCompare(b));
    };
    return {
      from: distinct("from_warehouse", "from"),
      to: distinct("to_warehouse", "to"),
      status: distinct("status", "status"),
      category: distinct("item_category", "category"),
      material: distinct("material_type", "material"),
    };
  }, [records, passesExcept]);

  const search = useMemo(() => makeSearch(searchQuery), [searchQuery]);
  const filtered = useMemo(() => records.filter((r) =>
    passesExcept(r, "") && search(r)
  ), [records, passesExcept, search]);

  const kpis = useMemo(() => computeKpis(filtered), [filtered]);
  const groups = useMemo(() => buildGroups(filtered, groupBy, sortBy), [filtered, groupBy, sortBy]);

  const isSearching = searchQuery.trim().length > 0;
  const isOpen = useCallback((k: string) => isSearching || expanded.has(k), [isSearching, expanded]);
  const toggle = useCallback((k: string) => setExpanded((p) => {
    const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n;
  }), []);

  const activeFilters =
    selFrom.length + selTo.length + selStatus.length + selCategory.length + selMaterial.length + (issuesOnly ? 1 : 0);
  const clearFilters = () => {
    setSelFrom([]); setSelTo([]); setSelStatus([]); setSelCategory([]); setSelMaterial([]); setIssuesOnly(false); setSearchQuery("");
  };

  const handleCopy = useCallback(async () => {
    const lines = [
      `Transfer Summary (${WINDOW_LABELS[windowKey]})`,
      `${kpis.total_transfers} transfers · ${fmtWt(kpis.total_weight)} · ${kpis.pending_count} pending · ${kpis.issue_transfers} with issues`,
      "",
      ...groups.map((g) => `${g.label}: ${g.tx_count} TRs · ${fmtWt(g.net_weight || g.total_weight)}`),
    ];
    try { await navigator.clipboard.writeText(lines.join("\n")); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* blocked */ }
  }, [windowKey, kpis, groups]);

  const handleExport = useCallback(() => {
    const head = ["Challan", "Date", "From", "To", "Item", "Category", "Material", "Qty", "Net Weight", "Total Weight", "Boxes", "Status", "Received"];
    const esc = (v: unknown) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const rows = filtered.map((r) => [
      r.challan_no, r.transfer_date, r.from_warehouse, r.to_warehouse, r.item_description,
      r.item_category, r.material_type, r.qty, r.net_weight, r.total_weight, r.box_count, r.status, r.received_status,
    ].map(esc).join(","));
    const blob = new Blob([[head.join(","), ...rows].join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `Transfer_Summary_${iso(new Date())}.csv`; a.click();
    URL.revokeObjectURL(url);
  }, [filtered]);

  // No `if (!allowed) return null` gate: useRequireAuth returns true on the server but
  // false on the client's first render, so gating the render on it causes a hydration
  // mismatch. The `hasAccess` guard below already protects the body; effects are gated on
  // `allowed` and the hook redirects unauthenticated users.

  if (!hasAccess) {
    return (
      <TransferChrome title="Transfer Summary">
        <div className="max-w-md mx-auto mt-16 bg-white border border-[var(--aws-border)] rounded-lg p-8 text-center">
          <div className="text-[15px] font-semibold text-[var(--text-primary)]">Access restricted</div>
          <div className="text-[13px] text-[var(--text-secondary)] mt-2">The Transfer Summary dashboard is available to administrators only.</div>
        </div>
      </TransferChrome>
    );
  }

  return (
    <TransferChrome title="Transfer Summary">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
        <div>
          <button onClick={() => router.push("/modules/transfer")}
            className="text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">← Transfer</button>
          <h1 className="text-[20px] font-semibold text-[var(--text-primary)] leading-tight">Transfer Summary</h1>
          <div className="text-[12px] text-[var(--text-secondary)] flex items-center gap-2 mt-0.5">
            <span>{WINDOW_LABELS[windowKey]}</span>
            {lastUpdated && <span>· updated {new Date(lastUpdated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>}
            {refreshing && <span className="text-blue-600">· refreshing…</span>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select value={windowKey} onChange={(e) => setWindowKey(e.target.value as WindowKey)}
            className="px-2.5 py-1.5 text-[12px] border border-[var(--aws-border)] rounded-md bg-white">
            {(Object.keys(WINDOW_LABELS) as WindowKey[]).map((k) => <option key={k} value={k}>{WINDOW_LABELS[k]}</option>)}
          </select>
          <IconBtn onClick={refresh} disabled={loading || refreshing} label="Refresh" />
          <IconBtn onClick={handleCopy} label={copied ? "Copied" : "Copy"} />
          <IconBtn onClick={handleExport} label="Export" />
        </div>
      </div>

      {windowKey === "custom" && (
        <div className="flex items-center gap-2 mb-4 text-[12px]">
          <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)}
            className="px-2 py-1 border border-[var(--aws-border)] rounded-md" />
          <span className="text-[var(--text-secondary)]">to</span>
          <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)}
            className="px-2 py-1 border border-[var(--aws-border)] rounded-md" />
        </div>
      )}

      {error && <div className="mb-4 bg-rose-50 border border-rose-200 text-rose-700 rounded-md p-3 text-[13px]">{error}</div>}

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <Kpi label="Transfers" value={fmtN(kpis.total_transfers)} sub={`${fmtN(kpis.total_boxes)} boxes`} />
        <Kpi label="Net Weight" value={fmtWt(kpis.total_net_weight || kpis.total_gross_weight)}
          sub={kpis.total_gross_weight > 0 && kpis.total_gross_weight !== kpis.total_net_weight ? `gross ${fmtWt(kpis.total_gross_weight)}` : undefined} />
        <Kpi label="Pending / Transit" value={fmtN(kpis.pending_count)} tone={kpis.pending_count ? "amber" : undefined}
          sub={`${fmtN(kpis.not_received)} not received`} />
        <Kpi label="Issues" value={fmtN(kpis.issue_transfers)} tone={kpis.issue_transfers ? "rose" : undefined}
          sub={`${fmtN(kpis.issue_items)} items`} />
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Search…"
            className="w-full pl-3 pr-7 py-1.5 text-[12px] border border-[var(--aws-border)] rounded-md" />
          {searchQuery && <button onClick={() => setSearchQuery("")} className="absolute right-2 top-1.5 text-[var(--text-secondary)]">✕</button>}
        </div>
        <label className="text-[12px] text-[var(--text-secondary)] flex items-center gap-1.5">
          Group
          <select value={groupBy} onChange={(e) => { setGroupBy(e.target.value as GroupDim); setExpanded(new Set()); }}
            className="px-2 py-1.5 text-[12px] border border-[var(--aws-border)] rounded-md bg-white">
            {GROUP_DIMS.map((d) => <option key={d} value={d}>{DIM_LABELS[d]}</option>)}
          </select>
        </label>
        <label className="text-[12px] text-[var(--text-secondary)] flex items-center gap-1.5">
          Sort
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)}
            className="px-2 py-1.5 text-[12px] border border-[var(--aws-border)] rounded-md bg-white">
            <option value="weight">Weight</option>
            <option value="count">Count</option>
            <option value="name">Name</option>
          </select>
        </label>
        <button onClick={() => setFiltersOpen((v) => !v)}
          className={`px-2.5 py-1.5 text-[12px] rounded-md border ${activeFilters ? "border-[var(--aws-navy)] text-[var(--aws-navy)] font-medium" : "border-[var(--aws-border)] text-[var(--text-secondary)]"}`}>
          Filters{activeFilters ? ` (${activeFilters})` : ""} {filtersOpen ? "▴" : "▾"}
        </button>
      </div>

      {/* Collapsible filters */}
      {filtersOpen && (
        <div className="bg-white border border-[var(--aws-border)] rounded-md p-3 mb-3 space-y-2">
          <ChipRow label="From" options={opts.from} selected={selFrom} display={getDisplayWarehouseName}
            onToggle={(v) => { const add = !selFrom.includes(v); setSelFrom(add ? [...selFrom, v] : selFrom.filter((x) => x !== v)); if (add) setSelTo(selTo.filter((x) => x !== v)); }} />
          <ChipRow label="To" options={opts.to} selected={selTo} display={getDisplayWarehouseName} disabledValues={selFrom}
            onToggle={(v) => setSelTo(selTo.includes(v) ? selTo.filter((x) => x !== v) : [...selTo, v])} />
          <ChipRow label="Status" options={opts.status} selected={selStatus}
            onToggle={(v) => setSelStatus(selStatus.includes(v) ? selStatus.filter((x) => x !== v) : [...selStatus, v])} />
          <ChipRow label="Category" options={opts.category} selected={selCategory}
            onToggle={(v) => setSelCategory(selCategory.includes(v) ? selCategory.filter((x) => x !== v) : [...selCategory, v])} />
          <ChipRow label="Material" options={opts.material} selected={selMaterial}
            onToggle={(v) => setSelMaterial(selMaterial.includes(v) ? selMaterial.filter((x) => x !== v) : [...selMaterial, v])} />
          <div className="flex items-center justify-between pt-1">
            <label className="flex items-center gap-1.5 text-[12px] text-rose-700">
              <input type="checkbox" checked={issuesOnly} onChange={(e) => setIssuesOnly(e.target.checked)} /> Issues only
            </label>
            {activeFilters > 0 && <button onClick={clearFilters} className="text-[12px] text-rose-600 hover:underline">Clear all</button>}
          </div>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-10 bg-white border border-[var(--aws-border)] rounded-md animate-pulse" />)}
        </div>
      ) : (
        <div className="bg-white border border-[var(--aws-border)] rounded-md overflow-hidden">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)] bg-[var(--background)]">
                <th className="px-3 py-2 font-medium">{DIM_LABELS[groupBy]}</th>
                <th className="px-2 py-2 font-medium text-right w-16">TRs</th>
                <th className="px-3 py-2 font-medium text-right w-28">Weight</th>
                <th className="px-2 py-2 font-medium text-right w-20">Pending</th>
              </tr>
            </thead>
            <tbody>
              {groups.length === 0 ? (
                <tr><td colSpan={4} className="px-3 py-12 text-center text-[var(--text-secondary)]">
                  No transfers in this view.{activeFilters > 0 && <button onClick={clearFilters} className="ml-2 text-rose-600 hover:underline">Clear filters</button>}
                </td></tr>
              ) : groups.map((g) => (
                <GroupRows key={g.key} group={g} groupBy={groupBy} open={isOpen(g.key)} onToggle={() => toggle(g.key)} onSelect={setSelected} />
              ))}
            </tbody>
            {groups.length > 0 && (
              <tfoot>
                <tr className="bg-[var(--background)] font-semibold text-[var(--text-primary)] border-t border-[var(--aws-border)]">
                  <td className="px-3 py-2">Total</td>
                  <td className="px-2 py-2 text-right">{fmtN(kpis.total_transfers)}</td>
                  <td className="px-3 py-2 text-right">{fmtWt(kpis.total_weight)}</td>
                  <td className="px-2 py-2 text-right">{kpis.pending_count || ""}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      {selected != null && (
        <DetailPopup records={records.filter((r) => r.transfer_id === selected)} onClose={() => setSelected(null)} />
      )}
    </TransferChrome>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────
function IconBtn({ onClick, label, disabled }: { onClick: () => void; label: string; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="px-2.5 py-1.5 text-[12px] border border-[var(--aws-border)] rounded-md bg-white hover:border-[var(--aws-navy)] disabled:opacity-50">
      {label}
    </button>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "amber" | "rose" }) {
  const vt = tone === "amber" ? "text-amber-600" : tone === "rose" ? "text-rose-600" : "text-[var(--text-primary)]";
  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-lg px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-[var(--text-secondary)]">{label}</div>
      <div className={`text-[22px] font-semibold leading-tight mt-1 ${vt}`}>{value}</div>
      {sub && <div className="text-[11px] text-[var(--text-secondary)] mt-0.5">{sub}</div>}
    </div>
  );
}

function ChipRow({ label, options, selected, onToggle, display, disabledValues }: {
  label: string; options: string[]; selected: string[]; onToggle: (v: string) => void;
  display?: (v: string) => string; disabledValues?: string[];
}) {
  if (!options.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-[var(--text-secondary)] w-16 shrink-0">{label}</span>
      {options.map((o) => {
        const off = disabledValues?.includes(o);
        const on = selected.includes(o);
        return (
          <button key={o} disabled={off} onClick={() => onToggle(o)} title={off ? "Selected as From" : undefined}
            className={`px-2 py-0.5 text-[11px] rounded-full border ${on ? "bg-[var(--aws-navy)] text-white border-[var(--aws-navy)]" : "border-[var(--aws-border)] text-[var(--text-secondary)] hover:border-[var(--aws-navy)]"} ${off ? "opacity-40 cursor-not-allowed" : ""}`}>
            {display ? display(o) : o}
          </button>
        );
      })}
    </div>
  );
}

function GroupRows({ group, groupBy, open, onToggle, onSelect }: {
  group: SummaryGroup; groupBy: GroupDim; open: boolean; onToggle: () => void; onSelect: (id: number) => void;
}) {
  return (
    <>
      <tr className="cursor-pointer hover:bg-[var(--background)] border-b border-[var(--aws-border)]" onClick={onToggle}>
        <td className="px-3 py-2">
          <span className="inline-block w-4 text-[var(--text-secondary)]">{open ? "▾" : "▸"}</span>
          <span className="font-medium text-[var(--text-primary)]">{group.label}</span>
          {group.pending_count > 0 && <span className="ml-2 px-1.5 py-0.5 rounded-full text-[10px] bg-amber-50 text-amber-700">{group.pending_count} pending</span>}
        </td>
        <td className="px-2 py-2 text-right text-[var(--text-secondary)]">{group.tx_count}</td>
        <td className="px-3 py-2 text-right font-medium">{fmtWt(group.net_weight || group.total_weight)}</td>
        <td className="px-2 py-2 text-right text-[var(--text-secondary)]">{group.pending_count || ""}</td>
      </tr>
      {open && group.transfers.map((t) => (
        <tr key={t.transfer_id} className="bg-[var(--background)]/40 border-b border-[var(--aws-border)]/40">
          <td className="px-3 py-1.5" colSpan={4}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-6">
              <button onClick={(e) => { e.stopPropagation(); onSelect(t.transfer_id); }}
                className="font-mono text-[12px] text-blue-700 hover:underline">{t.challan_no || `#${t.transfer_id}`}</button>
              <span className={`px-1.5 py-0.5 rounded-full text-[10px] ${statusTone(t.status)}`}>{t.status || "—"}</span>
              {t.received_status && t.received_status !== "Not Received" && <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-slate-100 text-slate-600">{t.received_status}</span>}
              {t.has_issue && <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-rose-50 text-rose-700">{t.issue_count} issue{t.issue_count > 1 ? "s" : ""}</span>}
              <span className="text-[var(--text-secondary)]">{t.transfer_date}</span>
              {groupBy !== "route" && <span className="text-[var(--text-secondary)]">{getDisplayWarehouseName(t.from_warehouse)} → {getDisplayWarehouseName(t.to_warehouse)}</span>}
              <span className="text-[var(--text-secondary)]">{t.line_count} item{t.line_count > 1 ? "s" : ""}</span>
              <span className="text-[var(--text-secondary)] ml-auto">{fmtWt(t.net_weight || t.total_weight)}</span>
            </div>
          </td>
        </tr>
      ))}
    </>
  );
}

function DetailPopup({ records, onClose }: { records: TransferRecord[]; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const hdr = records[0];
  const issues = hdr?.issue_details ?? [];
  const totalNet = records.reduce((s, r) => s + (r.net_weight || 0), 0);
  const totalGross = records.reduce((s, r) => s + (r.total_weight || 0), 0);
  if (!hdr) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-lg w-full max-w-2xl my-8 max-h-[85vh] overflow-y-auto shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3.5 border-b border-[var(--aws-border)] flex items-center justify-between sticky top-0 bg-white">
          <div>
            <div className="text-[15px] font-semibold text-[var(--text-primary)]">{hdr.challan_no || `Transfer #${hdr.transfer_id}`}</div>
            <div className="text-[12px] text-[var(--text-secondary)]">{getDisplayWarehouseName(hdr.from_warehouse)} → {getDisplayWarehouseName(hdr.to_warehouse)} · {hdr.transfer_date}</div>
          </div>
          <button onClick={onClose} className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] text-[18px]">✕</button>
        </div>

        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-[12px]">
            <Info label="Status" value={hdr.status || "—"} />
            <Info label="Received" value={hdr.received_status} />
            <Info label="Vehicle" value={hdr.vehicle_no || "—"} />
            <Info label="Driver" value={hdr.driver_name || "—"} />
            <Info label="Created by" value={hdr.created_by || "—"} />
            <Info label="Boxes" value={String(hdr.box_count)} />
            <Info label="Lines" value={String(records.length)} />
            <Info label="Remark" value={hdr.remark || "—"} />
          </div>

          <div className="border border-[var(--aws-border)] rounded-md overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-[var(--text-secondary)] bg-[var(--background)] border-b border-[var(--aws-border)]">
                  <th className="px-3 py-1.5">Item</th><th>Category</th><th>Lot</th>
                  <th className="text-right">Qty</th><th className="text-right">Net</th><th className="text-right pr-3">Gross</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r, i) => (
                  <tr key={i} className="border-b border-[var(--aws-border)]/40">
                    <td className="px-3 py-1.5">{r.item_description || "—"}{r.material_type && <span className="ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] bg-orange-50 text-orange-700">{r.material_type}</span>}</td>
                    <td>{[r.item_category, r.sub_category].filter(Boolean).join(" / ") || "—"}</td>
                    <td>{r.lot_number || "—"}</td>
                    <td className="text-right">{fmtN(r.qty)}</td>
                    <td className="text-right">{fmtN(r.net_weight)}</td>
                    <td className="text-right pr-3">{fmtN(r.total_weight)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-[var(--background)] font-medium border-t border-[var(--aws-border)]">
                  <td colSpan={4} className="px-3 py-1.5 text-right">Total</td>
                  <td className="text-right">{fmtN(totalNet)}</td>
                  <td className="text-right pr-3">{fmtN(totalGross)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          {hdr.has_issue && issues.length > 0 && (
            <div className="border border-rose-200 rounded-md overflow-x-auto">
              <div className="px-3 py-2 bg-rose-50 text-rose-700 text-[12px] font-medium">Issues ({issues.length})</div>
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]">
                    <th className="px-3 py-1.5">Article</th><th>Remarks</th><th className="text-right pr-3">Actual Wt</th>
                  </tr>
                </thead>
                <tbody>
                  {issues.map((iss, i) => (
                    <tr key={i} className="border-b border-[var(--aws-border)]/40">
                      <td className="px-3 py-1.5">{iss.article || "—"}</td>
                      <td>{iss.remarks || "—"}</td>
                      <td className="text-right pr-3">{iss.actual_total_weight || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">{label}</div>
      <div className="text-[12px] text-[var(--text-primary)] mt-0.5 break-words">{value}</div>
    </div>
  );
}
