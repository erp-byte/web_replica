"use client";

// Controlled Inward Inspection listing.
// Mirrors the _listing.tsx (PO creation) pattern: AbortController fetch with a
// stable query fingerprint + reloadKey dep, status pills, inline filter toolbar,
// sortless table, 7-window pagination, desktop table + md:hidden mobile cards.

import { useEffect, useRef, useState } from "react";
import {
  type InspectionListItem,
  type InspectionListQuery,
  type InspectionListResponse,
  listInspections,
  generateRmReport,
  generateNcrReport,
} from "@/lib/qc";
import { StartInspectionModal } from "./_modals/StartInspectionModal";

// ── Public interface ─────────────────────────────────────────────────────────

export interface InwardInspectionListProps {
  query: InspectionListQuery;
  onQueryChange: (patch: Partial<InspectionListQuery>) => void;
  search: string;
  onSearch: (v: string) => void;
  reloadKey: number;
  onView: (id: number) => void;
}

export function InwardInspectionList(props: InwardInspectionListProps): React.JSX.Element {
  const { query, onQueryChange, search, onSearch, reloadKey, onView } = props;

  // ── Local state ─────────────────────────────────────────────────────────────
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<InspectionListResponse | null>(null);

  // Start inspection modal
  const [startOpen, setStartOpen] = useState(false);

  // Toast banner for report actions
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // ── Fetch fingerprint ────────────────────────────────────────────────────────
  const queryFp = JSON.stringify(
    Object.entries(query)
      .sort(([a], [b]) => a.localeCompare(b))
      .filter(([, v]) => v !== "" && v != null),
  );

  // ── Listing fetch ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;
    const controller = new AbortController();
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const resp = await listInspections(query, controller.signal);
        if (controller.signal.aborted) return;
        setData(resp);
      } catch (e) {
        if (controller.signal.aborted) return;
        if (e instanceof Error && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Failed to load inspections");
        setData(null);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
    // queryFp + reloadKey are stable fingerprints
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryFp, reloadKey]);

  // ── Report actions ───────────────────────────────────────────────────────────
  const [reportBusy, setReportBusy] = useState<number | null>(null);

  async function handleRmReport(id: number) {
    if (reportBusy != null) return;
    setReportBusy(id);
    setToast(null);
    try {
      const res = await generateRmReport(id);
      if (res.download_url) {
        window.open(res.download_url, "_blank", "noopener,noreferrer");
      } else {
        setToast({ kind: "ok", text: "RM report queued. Check back shortly." });
      }
    } catch (e) {
      setToast({ kind: "err", text: e instanceof Error ? e.message : "Failed to generate RM report" });
    } finally {
      setReportBusy(null);
    }
  }

  async function handleNcrReport(id: number) {
    if (reportBusy != null) return;
    setReportBusy(id);
    setToast(null);
    try {
      const res = await generateNcrReport(id);
      if (res.download_url) {
        window.open(res.download_url, "_blank", "noopener,noreferrer");
      } else {
        setToast({ kind: "ok", text: "NCR report queued. Check back shortly." });
      }
    } catch (e) {
      setToast({ kind: "err", text: e instanceof Error ? e.message : "Failed to generate NCR report" });
    } finally {
      setReportBusy(null);
    }
  }

  const rows = data?.items ?? [];

  return (
    <div>
      {/* Toast banner */}
      {toast ? (
        <div
          className={[
            "mb-3 px-3 py-2 text-[13px] rounded-[2px] border flex items-center justify-between",
            toast.kind === "ok"
              ? "bg-[#eaf6ed] border-[#b6dbb1] text-[var(--text-success)]"
              : "bg-[#fdf3f1] border-[#f0c7be] text-[#b1361e]",
          ].join(" ")}
        >
          <span>{toast.text}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            className="ml-4 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      ) : null}

      {/* Header actions */}
      <div className="flex justify-end mb-3">
        <button
          type="button"
          onClick={() => setStartOpen(true)}
          className="h-8 px-3 text-[12px] rounded-[2px] bg-[var(--aws-navy)] text-white hover:bg-[var(--aws-navy-hover,#0d2535)] flex items-center gap-1.5"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
          Start inspection
        </button>
      </div>

      {/* Status pills */}
      <StatusPills status={query.status ?? ""} onStatus={(s) => onQueryChange({ status: s, page: 1 })} />

      {/* Filter toolbar */}
      <InspectionToolbar
        query={query}
        onQueryChange={onQueryChange}
        search={search}
        onSearch={onSearch}
      />

      {/* Desktop table */}
      <div className="hidden md:block bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[13px] border-collapse">
            <thead className="bg-[var(--surface-subtle)] text-[var(--text-primary)]">
              <tr className="border-b border-[var(--aws-border)]">
                <Th>Transaction No</Th>
                <Th>Article</Th>
                <Th>Vehicle</Th>
                <Th>Warehouse</Th>
                <Th>Status</Th>
                <Th width={140}>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-10 text-center text-[var(--text-secondary)]">
                    <span className="inline-flex items-center gap-2">
                      <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
                      Loading inspections…
                    </span>
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-[var(--aws-error)] text-[13px]">{error}</td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-12 text-center text-[var(--text-secondary)]">
                    <p className="font-semibold text-[14px] mb-1">No Inspections</p>
                    <p className="text-[12px]">No inspections match your current filters.</p>
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <InspectionTableRow
                    key={row.inspection_id}
                    row={row}
                    onView={onView}
                    onRm={() => void handleRmReport(row.inspection_id)}
                    onNcr={() => void handleNcrReport(row.inspection_id)}
                    reportBusy={reportBusy}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden space-y-2">
        {loading && rows.length === 0 ? (
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-8 text-center text-[var(--text-secondary)]">
            <span className="inline-flex items-center gap-2 text-[13px]">
              <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
              Loading inspections…
            </span>
          </div>
        ) : error ? (
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-center text-[var(--aws-error)] text-[13px]">{error}</div>
        ) : rows.length === 0 ? (
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-8 text-center text-[var(--text-secondary)]">
            <p className="font-semibold text-[14px] mb-1">No Inspections</p>
            <p className="text-[12px]">No inspections match your current filters.</p>
          </div>
        ) : (
          rows.map((row) => (
            <InspectionMobileCard
              key={row.inspection_id}
              row={row}
              onView={onView}
              onRm={() => void handleRmReport(row.inspection_id)}
              onNcr={() => void handleNcrReport(row.inspection_id)}
              reportBusy={reportBusy}
            />
          ))
        )}
      </div>

      {/* Pagination */}
      {data && data.total > 0 && data.total_pages > 1 ? (
        <InspectionPagination
          page={data.page}
          totalPages={data.total_pages}
          total={data.total}
          pageSize={data.page_size}
          onPage={(p) => onQueryChange({ page: p })}
          loading={loading}
        />
      ) : null}

      {/* Start inspection modal */}
      {startOpen ? (
        <StartInspectionModal
          onClose={() => setStartOpen(false)}
          onStarted={(id) => { setStartOpen(false); onView(id); }}
        />
      ) : null}
    </div>
  );
}

// ── Status Pills ─────────────────────────────────────────────────────────────

const STATUS_PILLS: { value: string; label: string }[] = [
  { value: "", label: "All" },
  { value: "in_progress", label: "In Progress" },
  { value: "readings_submitted", label: "Readings Submitted" },
  { value: "verdict_passed", label: "Passed" },
  { value: "verdict_failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
];

function StatusPills({ status, onStatus }: { status: string; onStatus: (s: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5 mb-3">
      {STATUS_PILLS.map((p) => (
        <button
          key={p.value}
          type="button"
          onClick={() => onStatus(p.value)}
          className={[
            "h-7 px-3 text-[12px] rounded-full border transition-colors",
            status === p.value
              ? "bg-[var(--aws-navy)] text-white border-[var(--aws-navy)]"
              : "bg-white text-[var(--text-primary)] border-[var(--aws-border-strong)] hover:border-[var(--aws-navy)]",
          ].join(" ")}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

// ── Filter Toolbar ───────────────────────────────────────────────────────────

function InspectionToolbar({
  query,
  onQueryChange,
  search,
  onSearch,
}: {
  query: InspectionListQuery;
  onQueryChange: (patch: Partial<InspectionListQuery>) => void;
  search: string;
  onSearch: (v: string) => void;
}) {
  // Local draft state — committed on Apply
  const [draftSupplier, setDraftSupplier] = useState(
    query.supplier_id != null ? String(query.supplier_id) : "",
  );
  const [draftSku, setDraftSku] = useState(
    query.sku_id != null ? String(query.sku_id) : "",
  );
  const [draftVerdict, setDraftVerdict] = useState(query.verdict ?? "");
  const [draftFrom, setDraftFrom] = useState(query.from_date ?? "");
  const [draftTo, setDraftTo] = useState(query.to_date ?? "");

  // Sync drafts when query is externally cleared
  const prevFp = useRef(JSON.stringify(query));
  useEffect(() => {
    const fp = JSON.stringify(query);
    if (fp === prevFp.current) return;
    prevFp.current = fp;
    setDraftSupplier(query.supplier_id != null ? String(query.supplier_id) : "");
    setDraftSku(query.sku_id != null ? String(query.sku_id) : "");
    setDraftVerdict(query.verdict ?? "");
    setDraftFrom(query.from_date ?? "");
    setDraftTo(query.to_date ?? "");
  }, [query]);

  function handleApply() {
    onQueryChange({
      supplier_id: draftSupplier.trim() ? Number(draftSupplier.trim()) : undefined,
      sku_id: draftSku.trim() ? Number(draftSku.trim()) : undefined,
      verdict: draftVerdict || undefined,
      from_date: draftFrom || undefined,
      to_date: draftTo || undefined,
      page: 1,
    });
  }

  function handleClear() {
    setDraftSupplier("");
    setDraftSku("");
    setDraftVerdict("");
    setDraftFrom("");
    setDraftTo("");
    onQueryChange({
      supplier_id: undefined,
      sku_id: undefined,
      verdict: undefined,
      from_date: undefined,
      to_date: undefined,
      page: 1,
    });
    onSearch("");
  }

  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] mb-4 p-3">
      {/* Row 1: search + verdict + refresh */}
      <div className="flex flex-wrap items-center gap-2 mb-2">
        {/* Search */}
        <div className="relative flex-1 min-w-[220px]">
          <svg
            viewBox="0 0 24 24"
            className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="search"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search transaction no…"
            className="w-full h-8 pl-7 pr-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
          />
        </div>

        {/* Verdict */}
        <select
          value={draftVerdict}
          onChange={(e) => setDraftVerdict(e.target.value)}
          className="h-8 px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white outline-none focus:border-[#9a393e] min-w-[110px]"
        >
          <option value="">Any verdict</option>
          <option value="passed">Passed</option>
          <option value="failed">Failed</option>
        </select>

        {/* Supplier ID */}
        <input
          type="number"
          value={draftSupplier}
          onChange={(e) => setDraftSupplier(e.target.value)}
          placeholder="Supplier ID"
          className="h-8 px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white outline-none focus:border-[#9a393e] w-[120px]"
        />

        {/* SKU ID */}
        <input
          type="number"
          value={draftSku}
          onChange={(e) => setDraftSku(e.target.value)}
          placeholder="SKU ID"
          className="h-8 px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white outline-none focus:border-[#9a393e] w-[100px]"
        />
      </div>

      {/* Row 2: date range + action buttons */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-[11px] font-semibold text-[var(--text-muted)] shrink-0">From</label>
        <input
          type="date"
          value={draftFrom}
          onChange={(e) => setDraftFrom(e.target.value)}
          className="h-8 px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white outline-none focus:border-[#9a393e]"
        />
        <label className="text-[11px] font-semibold text-[var(--text-muted)] shrink-0">To</label>
        <input
          type="date"
          value={draftTo}
          onChange={(e) => setDraftTo(e.target.value)}
          className="h-8 px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white outline-none focus:border-[#9a393e]"
        />
        <div className="flex-1" />
        <button
          type="button"
          onClick={handleClear}
          className="h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] text-[var(--aws-link)]"
        >
          Clear
        </button>
        <button
          type="button"
          onClick={handleApply}
          className="h-8 px-4 text-[12px] rounded-[2px] border border-[var(--aws-orange)] bg-[var(--aws-orange)] text-white hover:opacity-90"
        >
          Apply
        </button>
      </div>
    </div>
  );
}

// ── Status Badge ─────────────────────────────────────────────────────────────

function StatusBadge({ row }: { row: InspectionListItem }) {
  const decision = row.decision ?? "";
  const bgCls =
    decision === "approved"
      ? "bg-[#eaf6ed] border-[#b6dbb1] text-[var(--text-success)]"
      : decision === "rejected"
      ? "bg-[#fdf3f1] border-[#f0c7be] text-[#b1361e]"
      : decision === "hold"
      ? "bg-[#fef9ea] border-[#f5d76e] text-[#7d6014]"
      : "bg-[var(--surface-subtle)] border-[var(--aws-border)] text-[var(--text-secondary)]";

  const decisionLabel =
    decision === "approved"
      ? "Approved"
      : decision === "rejected"
      ? "Rejected"
      : decision === "hold"
      ? "Hold"
      : decision
      ? decision
      : null;

  return (
    <div className="flex flex-col gap-0.5">
      {decisionLabel ? (
        <span
          className={[
            "inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded-sm border w-fit",
            bgCls,
          ].join(" ")}
        >
          {decisionLabel}
        </span>
      ) : null}
      {row.status ? (
        <span className="text-[11px] text-[var(--text-secondary)]">
          {row.status.replace(/_/g, " ")}
        </span>
      ) : null}
    </div>
  );
}

// ── Row action buttons ────────────────────────────────────────────────────────

function RowActions({
  row,
  onView,
  onRm,
  onNcr,
  reportBusy,
}: {
  row: InspectionListItem;
  onView: (id: number) => void;
  onRm: () => void;
  onNcr: () => void;
  reportBusy: number | null;
}) {
  const canRm = row.decision === "approved";
  const canNcr = row.decision === "rejected";
  const busy = reportBusy === row.inspection_id;

  return (
    <div className="flex items-center gap-1">
      {/* View */}
      <button
        type="button"
        onClick={() => onView(row.inspection_id)}
        title="View inspection"
        aria-label="View inspection"
        className="p-1 rounded hover:bg-[var(--surface-divider)] text-[var(--text-secondary)]"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
      {/* Edit (opens detail where header-edit lives) */}
      <button
        type="button"
        onClick={() => onView(row.inspection_id)}
        title="Edit inspection"
        aria-label="Edit inspection"
        className="p-1 rounded hover:bg-[var(--surface-divider)] text-[var(--text-secondary)]"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
      </button>
      {/* RM report */}
      <button
        type="button"
        onClick={canRm && !busy ? onRm : undefined}
        disabled={!canRm || busy}
        title={canRm ? "Generate RM report" : "RM report only available when approved"}
        aria-label="Generate RM report"
        className={[
          "h-6 px-1.5 text-[10px] rounded-[2px] border font-semibold",
          canRm && !busy
            ? "border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] text-[var(--text-primary)]"
            : "border-[var(--aws-border)] bg-[var(--surface-subtle)] text-[var(--text-muted)] cursor-not-allowed opacity-60",
        ].join(" ")}
      >
        {busy ? "…" : "RM"}
      </button>
      {/* NCR report */}
      <button
        type="button"
        onClick={canNcr && !busy ? onNcr : undefined}
        disabled={!canNcr || busy}
        title={canNcr ? "Generate NCR report" : "NCR report only available when rejected"}
        aria-label="Generate NCR report"
        className={[
          "h-6 px-1.5 text-[10px] rounded-[2px] border font-semibold",
          canNcr && !busy
            ? "border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] text-[var(--text-primary)]"
            : "border-[var(--aws-border)] bg-[var(--surface-subtle)] text-[var(--text-muted)] cursor-not-allowed opacity-60",
        ].join(" ")}
      >
        {busy ? "…" : "NCR"}
      </button>
    </div>
  );
}

// ── Table Th ─────────────────────────────────────────────────────────────────

function Th({ children, width }: { children: React.ReactNode; width?: number }) {
  return (
    <th
      style={width ? { width } : undefined}
      className="px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-[var(--text-secondary)] whitespace-nowrap"
    >
      {children}
    </th>
  );
}

// ── Desktop Table Row ─────────────────────────────────────────────────────────

function InspectionTableRow({
  row,
  onView,
  onRm,
  onNcr,
  reportBusy,
}: {
  row: InspectionListItem;
  onView: (id: number) => void;
  onRm: () => void;
  onNcr: () => void;
  reportBusy: number | null;
}) {
  const article = row.sku_name ?? row.sku_name_raw ?? "—";

  return (
    <tr
      className="border-b border-[var(--aws-border)] hover:bg-[var(--surface-subtle)] cursor-pointer"
      onClick={() => onView(row.inspection_id)}
    >
      {/* Transaction No */}
      <td className="px-3 py-2 whitespace-nowrap">
        <span className="font-mono text-[12px] text-[var(--aws-link)]">
          {row.transaction_no ?? "—"}
        </span>
        {row.po_number ? (
          <div className="text-[11px] text-[var(--text-muted)]">{row.po_number}</div>
        ) : null}
      </td>
      {/* Article */}
      <td className="px-3 py-2 max-w-[200px]">
        <span className="block truncate" title={article}>{article}</span>
        {row.sku_id != null ? (
          <span className="text-[11px] text-[var(--text-muted)]">SKU {row.sku_id}</span>
        ) : null}
      </td>
      {/* Vehicle */}
      <td className="px-3 py-2 whitespace-nowrap text-[12px]">{row.vehicle_no ?? "—"}</td>
      {/* Warehouse */}
      <td className="px-3 py-2 whitespace-nowrap text-[12px]">{row.warehouse ?? "—"}</td>
      {/* Status */}
      <td className="px-3 py-2">
        <StatusBadge row={row} />
      </td>
      {/* Actions */}
      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
        <RowActions row={row} onView={onView} onRm={onRm} onNcr={onNcr} reportBusy={reportBusy} />
      </td>
    </tr>
  );
}

// ── Mobile Card ───────────────────────────────────────────────────────────────

function InspectionMobileCard({
  row,
  onView,
  onRm,
  onNcr,
  reportBusy,
}: {
  row: InspectionListItem;
  onView: (id: number) => void;
  onRm: () => void;
  onNcr: () => void;
  reportBusy: number | null;
}) {
  const article = row.sku_name ?? row.sku_name_raw ?? "—";

  return (
    <div
      className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] overflow-hidden"
      onClick={() => onView(row.inspection_id)}
    >
      <div className="p-3 flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="font-mono text-[12px] font-semibold text-[var(--aws-link)] truncate">
              {row.transaction_no ?? "—"}
            </span>
            {row.po_number ? (
              <span className="text-[11px] text-[var(--text-muted)] shrink-0">{row.po_number}</span>
            ) : null}
          </div>
          <p className="text-[13px] text-[var(--text-primary)] truncate" title={article}>
            {article}
          </p>
          {row.sku_id != null ? (
            <p className="text-[11px] text-[var(--text-muted)]">SKU {row.sku_id}</p>
          ) : null}
          <div className="mt-1.5">
            <StatusBadge row={row} />
          </div>
        </div>
        <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
          <RowActions row={row} onView={onView} onRm={onRm} onNcr={onNcr} reportBusy={reportBusy} />
        </div>
      </div>
    </div>
  );
}

// ── Pagination ────────────────────────────────────────────────────────────────

function PageBtn({
  p,
  label,
  active,
  disabled,
  onPage,
  loading,
}: {
  p: number;
  label: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  onPage: (p: number) => void;
  loading: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onPage(p)}
      disabled={!!disabled || loading}
      className={[
        "min-w-[28px] h-7 px-2 text-[12px] rounded-sm border",
        active
          ? "bg-[var(--aws-navy)] text-white border-[var(--aws-navy)]"
          : "bg-white text-[var(--text-primary)] border-[var(--aws-border-strong)] hover:border-[var(--aws-navy)]",
        disabled ? "opacity-50 cursor-not-allowed" : "",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

function InspectionPagination({
  page,
  totalPages,
  total,
  pageSize,
  onPage,
  loading,
}: {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onPage: (p: number) => void;
  loading: boolean;
}) {
  if (total === 0 || totalPages <= 1) return null;
  const start = total ? (page - 1) * pageSize + 1 : 0;
  const end = Math.min(page * pageSize, total);
  const max = 7;
  let from = Math.max(1, page - Math.floor(max / 2));
  const to = Math.min(totalPages, from + max - 1);
  if (to - from + 1 < max) from = Math.max(1, to - max + 1);
  const pages: number[] = [];
  for (let i = from; i <= to; i++) pages.push(i);

  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
      <span className="text-[12px] text-[var(--text-secondary)]">
        Showing {start}–{end} of {total} inspection{total === 1 ? "" : "s"}
      </span>
      <div className="flex items-center gap-1">
        <PageBtn p={page - 1} label="‹" disabled={page <= 1} onPage={onPage} loading={loading} />
        {from > 1 ? <PageBtn p={1} label={1} onPage={onPage} loading={loading} /> : null}
        {from > 2 ? <span className="px-1 text-[var(--text-muted)]">…</span> : null}
        {pages.map((p) => (
          <PageBtn key={p} p={p} label={p} active={p === page} onPage={onPage} loading={loading} />
        ))}
        {to < totalPages - 1 ? <span className="px-1 text-[var(--text-muted)]">…</span> : null}
        {to < totalPages ? (
          <PageBtn p={totalPages} label={totalPages} onPage={onPage} loading={loading} />
        ) : null}
        <PageBtn p={page + 1} label="›" disabled={page >= totalPages} onPage={onPage} loading={loading} />
      </div>
    </div>
  );
}
