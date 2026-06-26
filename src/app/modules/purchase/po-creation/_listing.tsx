"use client";

// Controlled PO listing component. Mirrors frontend_replica/src/shared/js/po-view.js
// columns, filters, sort, expand/articles, delete-with-reason, pagination, and export.
// The parent (Task 2.3) owns query/search/expanded state and passes them in as props.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type PoListItem,
  type PoLineOut,
  type PoListQuery,
  type PoListResponse,
  listPos,
  getPoLines,
  deletePo,
  fetchAllPosForExport,
  buildPoCsv,
  downloadBlob,
  fmtDate,
  fmtCur,
  fmtNum,
  PO_EXPORT_COLUMNS,
} from "@/lib/po";

// ── Public interface ─────────────────────────────────────────────────────────

export interface PoListingProps {
  query: PoListQuery;
  onQueryChange: (patch: Partial<PoListQuery>) => void;
  search: string;
  onSearch: (v: string) => void;
  expanded: Set<string>;
  onToggleExpand: (txn: string) => void;
  reloadKey: number;
}

export function PoListing(props: PoListingProps): React.JSX.Element {
  const { query, onQueryChange, search, onSearch, expanded, onToggleExpand, reloadKey } = props;

  // ── Local state ────────────────────────────────────────────────────────────
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<PoListResponse | null>(null);

  // Internal nonce to force-refetch after delete (separate from parent's reloadKey).
  const [refetchNonce, setRefetchNonce] = useState(0);

  // Per-txn lines cache — Map<txn, { lines?, loading, error? }>
  // Stored in state (not a plain ref) so the component re-renders when resolved.
  const [linesCache, setLinesCache] = useState<
    Map<string, { lines?: PoLineOut[]; loading: boolean; error?: string }>
  >(new Map());

  // ── Fetch fingerprint ──────────────────────────────────────────────────────
  // Stable scalar dep so the exhaustive-deps rule stays satisfied.
  const queryFp = JSON.stringify(
    Object.entries(query)
      .sort(([a], [b]) => a.localeCompare(b))
      .filter(([, v]) => v !== "" && v != null),
  );

  // ── Listing fetch ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;
    const controller = new AbortController();
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const resp = await listPos(query, controller.signal);
        if (controller.signal.aborted) return;
        setData(resp);
      } catch (e) {
        if (controller.signal.aborted) return;
        if (e instanceof Error && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Failed to load POs");
        setData(null);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
    // queryFp + reloadKey + refetchNonce are the stable fingerprints
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryFp, reloadKey, refetchNonce]);

  // ── Lazy line fetch ────────────────────────────────────────────────────────
  const fetchLines = useCallback(
    async (txn: string) => {
      // Yield first so no setState fires synchronously inside a useEffect body
      // (avoids react-hooks/set-state-in-effect).
      await Promise.resolve();
      setLinesCache((prev) => {
        const next = new Map(prev);
        next.set(txn, { loading: true });
        return next;
      });
      try {
        const r = await getPoLines(txn);
        setLinesCache((prev) => {
          const next = new Map(prev);
          next.set(txn, { lines: r.lines, loading: false });
          return next;
        });
      } catch (e: unknown) {
        setLinesCache((prev) => {
          const next = new Map(prev);
          next.set(txn, {
            loading: false,
            error: e instanceof Error ? e.message : "Failed to load articles",
          });
          return next;
        });
      }
    },
    [],
  );

  // When a row is expanded and we don't yet have its lines (or a previous fetch
  // errored), kick off the fetch so errors are retryable on re-expand.
  useEffect(() => {
    for (const txn of expanded) {
      const entry = linesCache.get(txn);
      if (!entry || (!entry.loading && entry.error && !entry.lines)) {
        void fetchLines(txn);
      }
    }
    // Only when expanded set membership changes; linesCache is derived output
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Array.from(expanded).sort().join(",")]);

  // ── Delete state ───────────────────────────────────────────────────────────
  const [deleteModal, setDeleteModal] = useState<{ txn: string; poNumber?: string | null } | null>(null);
  const [deleteMsg, setDeleteMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function handleDelete(txn: string, reason: string) {
    setDeleteMsg(null);
    try {
      const res = await deletePo(txn, reason);
      const label = res.po_number || txn;
      const boxes = res.dependent_records?.po_boxes ?? 0;
      const tail = boxes > 0 ? ` (${boxes} box${boxes === 1 ? "" : "es"} retained)` : "";
      setDeleteMsg({ kind: "ok", text: `Deleted ${label}${tail}` });
      // Close the modal only on success.
      setDeleteModal(null);
      // Clear cached lines for this txn and collapse it.
      setLinesCache((prev) => {
        const next = new Map(prev);
        next.delete(txn);
        return next;
      });
      // Collapse the row if it was expanded.
      if (expanded.has(txn)) onToggleExpand(txn);
      // Bump internal nonce to re-run the listing fetch.
      setRefetchNonce((n) => n + 1);
    } catch (e) {
      const text = e instanceof Error ? e.message : "Delete failed";
      setDeleteMsg({ kind: "err", text });
      // Re-throw so DeleteModal.submit can show the error inline and stay open.
      throw e;
    }
  }

  // ── Sort helper ────────────────────────────────────────────────────────────
  function currentSort(): { col: string; dir: "asc" | "desc" } {
    const s = query.sort ?? "po_date:desc";
    const [col, dir] = s.split(":");
    return { col: col ?? "po_date", dir: (dir as "asc" | "desc") ?? "desc" };
  }

  function handleSort(col: string) {
    if (!(SORTABLE_COLS as readonly string[]).includes(col)) return;
    const { col: activeCol, dir } = currentSort();
    const newDir = activeCol === col ? (dir === "asc" ? "desc" : "asc") : "asc";
    onQueryChange({ sort: `${col}:${newDir}`, page: 1 });
  }

  // ── Rows ───────────────────────────────────────────────────────────────────
  const rows = data?.items ?? [];

  return (
    <div>
      {/* Delete status message (inline, above toolbar) */}
      {deleteMsg ? (
        <div
          className={[
            "mb-3 px-3 py-2 text-[13px] rounded-[2px] border flex items-center justify-between",
            deleteMsg.kind === "ok"
              ? "bg-[#eaf6ed] border-[#b6dbb1] text-[var(--text-success)]"
              : "bg-[#fdf3f1] border-[#f0c7be] text-[#b1361e]",
          ].join(" ")}
        >
          <span>{deleteMsg.text}</span>
          <button
            type="button"
            onClick={() => setDeleteMsg(null)}
            className="ml-4 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      ) : null}

      <PoToolbar
        query={query}
        onQueryChange={onQueryChange}
        search={search}
        onSearch={onSearch}
        onRefresh={() => setRefetchNonce((n) => n + 1)}
      />

      {/* Desktop table */}
      <div className="hidden md:block bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[13px] border-collapse">
            <thead className="bg-[var(--surface-subtle)] text-[var(--text-primary)]">
              <tr className="border-b border-[var(--aws-border)]">
                {(() => { const sort = currentSort(); return (<>
                <Th width={32}>{null}</Th>
                <Th sortable col="po_number" sort={sort} onSort={handleSort}>PO Number</Th>
                <Th sortable col="po_date" sort={sort} onSort={handleSort}>Date</Th>
                <Th sortable col="vendor_supplier_name" sort={sort} onSort={handleSort}>Vendor</Th>
                <Th>Voucher</Th>
                <Th>Order Ref</Th>
                <Th>Entity</Th>
                <Th sortable col="gross_total" sort={sort} onSort={handleSort}>Amount</Th>
                <Th width={72}>{null}</Th>
                </>); })()}
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-3 py-10 text-center text-[var(--text-secondary)]">
                    <span className="inline-flex items-center gap-2">
                      <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
                      Loading Purchase Orders…
                    </span>
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-center text-[var(--aws-error)] text-[13px]">{error}</td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-3 py-12 text-center text-[var(--text-secondary)]">
                    <p className="font-semibold text-[14px] mb-1">No Purchase Orders</p>
                    <p className="text-[12px]">No POs match your current filters.</p>
                  </td>
                </tr>
              ) : (
                rows.map((row, i) => {
                  const txn = row.transaction_no;
                  const isOpen = expanded.has(txn);
                  return (
                    <PoTableRow
                      key={txn || `idx-${i}`}
                      row={row}
                      isOpen={isOpen}
                      onToggle={() => onToggleExpand(txn)}
                      onDelete={() => setDeleteModal({ txn, poNumber: row.po_number })}
                      linesState={linesCache.get(txn)}
                    />
                  );
                })
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
              Loading Purchase Orders…
            </span>
          </div>
        ) : error ? (
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-center text-[var(--aws-error)] text-[13px]">{error}</div>
        ) : rows.length === 0 ? (
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-8 text-center text-[var(--text-secondary)]">
            <p className="font-semibold text-[14px] mb-1">No Purchase Orders</p>
            <p className="text-[12px]">No POs match your current filters.</p>
          </div>
        ) : (
          rows.map((row, i) => {
            const txn = row.transaction_no;
            const isOpen = expanded.has(txn);
            return (
              <PoMobileCard
                key={txn || `m-${i}`}
                row={row}
                isOpen={isOpen}
                onToggle={() => onToggleExpand(txn)}
                onDelete={() => setDeleteModal({ txn, poNumber: row.po_number })}
                linesState={linesCache.get(txn)}
              />
            );
          })
        )}
      </div>

      {/* Pagination */}
      {data && data.total > 0 && data.total_pages > 1 ? (
        <PoPagination
          page={data.page}
          totalPages={data.total_pages}
          total={data.total}
          pageSize={data.page_size}
          onPage={(p) => onQueryChange({ page: p })}
          loading={loading}
        />
      ) : null}

      {/* Delete modal */}
      {deleteModal ? (
        <DeleteModal
          txn={deleteModal.txn}
          poNumber={deleteModal.poNumber}
          onConfirm={(reason) => handleDelete(deleteModal.txn, reason)}
          onCancel={() => setDeleteModal(null)}
        />
      ) : null}
    </div>
  );
}

// ── Toolbar ───────────────────────────────────────────────────────────────────

function PoToolbar({
  query, onQueryChange, search, onSearch, onRefresh,
}: {
  query: PoListQuery;
  onQueryChange: (patch: Partial<PoListQuery>) => void;
  search: string;
  onSearch: (v: string) => void;
  onRefresh: () => void;
}) {
  const [dateOpen, setDateOpen] = useState(false);
  const [advOpen, setAdvOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  const entity = query.entity ?? "";
  const dateActive = !!(query.po_date_from || query.po_date_to);
  const advCount = [
    query.vendor_supplier_name_contains,
    query.order_reference_no_contains,
    query.narration_contains,
    query.supplier_id,
    query.voucher_type,
  ].filter((v) => v && v.length > 0).length;

  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] mb-4 p-3 flex flex-wrap items-center gap-2">
      {/* Search box */}
      <div className="relative flex-1 min-w-[220px]">
        <svg viewBox="0 0 24 24" className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="search"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search PO number…"
          className="w-full h-8 pl-7 pr-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
        />
      </div>

      {/* Entity chips */}
      {(
        [
          { value: "", label: "All entities" },
          { value: "cfpl", label: "CFPL" },
          { value: "cdpl", label: "CDPL" },
        ] as const
      ).map((c) => (
        <button
          key={c.value}
          type="button"
          onClick={() => onQueryChange({ entity: c.value, page: 1 })}
          className={[
            "h-8 px-3 text-[12px] rounded-full border transition-colors",
            entity === c.value
              ? "bg-[var(--aws-navy)] text-white border-[var(--aws-navy)]"
              : "bg-white text-[var(--text-primary)] border-[var(--aws-border-strong)] hover:border-[var(--aws-navy)]",
          ].join(" ")}
        >
          {c.label}
        </button>
      ))}

      {/* Advanced filter */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setAdvOpen((v) => !v)}
          className={[
            "h-8 px-3 text-[12px] rounded-[2px] border flex items-center gap-1.5",
            advCount > 0
              ? "border-[var(--aws-orange)] text-[var(--aws-orange)] bg-[#fbeced]"
              : "border-[var(--aws-border-strong)] bg-white text-[var(--text-primary)] hover:border-[var(--aws-navy)]",
          ].join(" ")}
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
          </svg>
          Advanced
          {advCount > 0 ? (
            <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] rounded-full font-bold bg-[var(--aws-orange)] text-white">
              {advCount}
            </span>
          ) : null}
        </button>
        {advOpen ? (
          <AdvancedFilterPanel
            query={query}
            onApply={(patch) => { onQueryChange({ ...patch, page: 1 }); setAdvOpen(false); }}
            onClose={() => setAdvOpen(false)}
          />
        ) : null}
      </div>

      {/* Date filter */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setDateOpen((v) => !v)}
          className={[
            "h-8 px-3 text-[12px] rounded-[2px] border flex items-center gap-1.5",
            dateActive
              ? "border-[var(--aws-orange)] text-[var(--aws-orange)] bg-[#fbeced]"
              : "border-[var(--aws-border-strong)] bg-white text-[var(--text-primary)] hover:border-[var(--aws-navy)]",
          ].join(" ")}
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2}>
            <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
          </svg>
          {dateActive ? `${query.po_date_from || "…"} → ${query.po_date_to || "…"}` : "Date"}
        </button>
        {dateOpen ? (
          <DatePanel
            dateFrom={query.po_date_from ?? ""}
            dateTo={query.po_date_to ?? ""}
            onApply={(from, to) => { onQueryChange({ po_date_from: from, po_date_to: to, page: 1 }); setDateOpen(false); }}
            onClose={() => setDateOpen(false)}
          />
        ) : null}
      </div>

      {/* Export */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setExportOpen((v) => !v)}
          className="h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] flex items-center gap-1.5"
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Export
        </button>
        {exportOpen ? (
          <ExportMenu
            query={query}
            onClose={() => setExportOpen(false)}
          />
        ) : null}
      </div>

      {/* Refresh */}
      <button
        type="button"
        onClick={onRefresh}
        className="h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] flex items-center gap-1.5"
      >
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2}>
          <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
        Refresh
      </button>
    </div>
  );
}

// ── Advanced Filter Panel ─────────────────────────────────────────────────────

const SORTABLE_COLS = ["po_number", "po_date", "vendor_supplier_name", "gross_total"] as const;

const ADV_FIELDS: { key: keyof PoListQuery; label: string; placeholder: string }[] = [
  { key: "vendor_supplier_name_contains", label: "Vendor name contains", placeholder: "e.g. acme" },
  { key: "order_reference_no_contains",   label: "Order ref contains",   placeholder: "e.g. REF-9912" },
  { key: "narration_contains",            label: "Narration contains",   placeholder: "e.g. urgent" },
  { key: "supplier_id",                   label: "Supplier ID (exact)",  placeholder: "e.g. 4471" },
  { key: "voucher_type",                  label: "Voucher type (exact)", placeholder: "e.g. PURCH" },
];

function AdvancedFilterPanel({
  query, onApply, onClose,
}: {
  query: PoListQuery;
  onApply: (patch: Partial<PoListQuery>) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of ADV_FIELDS) init[f.key as string] = (query[f.key] as string | undefined) ?? "";
    return init;
  });

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  function apply() {
    const patch: Partial<PoListQuery> = {};
    for (const f of ADV_FIELDS) {
      (patch as Record<string, string>)[f.key as string] = draft[f.key as string] ?? "";
    }
    onApply(patch);
  }

  function clear() {
    const empty: Record<string, string> = {};
    for (const f of ADV_FIELDS) empty[f.key as string] = "";
    setDraft(empty);
    const patch: Partial<PoListQuery> = {};
    for (const f of ADV_FIELDS) {
      (patch as Record<string, string>)[f.key as string] = "";
    }
    onApply(patch);
  }

  const activeCount = Object.values(draft).filter((v) => v.length > 0).length;

  return (
    <div
      ref={ref}
      className="absolute right-0 z-20 mt-1 w-[min(320px,calc(100vw-1rem))] bg-white border border-[var(--aws-border)] rounded-md shadow-[0_4px_12px_rgba(0,28,36,0.18)] p-3"
    >
      <div className="text-[11px] uppercase tracking-wide font-bold text-[var(--text-muted)] mb-2">Advanced Filters</div>
      {ADV_FIELDS.map((f) => {
        const inputId = `adv-filter-${f.key as string}`;
        return (
          <div key={f.key as string} className="mb-2">
            <label htmlFor={inputId} className="block text-[11px] font-semibold text-[var(--text-primary)] mb-0.5">{f.label}</label>
            <input
              id={inputId}
              type="text"
              value={draft[f.key as string] ?? ""}
              placeholder={f.placeholder}
              onChange={(e) => setDraft((d) => ({ ...d, [f.key as string]: e.target.value }))}
              onKeyDown={(e) => { if (e.key === "Enter") apply(); }}
              className="w-full h-7 px-2 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
            />
          </div>
        );
      })}
      <div className="border-t border-[var(--aws-border)] pt-2 mt-1 flex items-center justify-between">
        <span className="text-[11px] text-[var(--text-muted)]">
          {activeCount > 0 ? `${activeCount} filter${activeCount === 1 ? "" : "s"} active` : "No filters active"}
        </span>
        <div className="flex gap-2">
          <button type="button" onClick={clear} disabled={activeCount === 0} className="h-7 px-2 text-[11px] text-[var(--aws-link)] hover:underline disabled:opacity-50 disabled:cursor-not-allowed">Clear</button>
          <button type="button" onClick={apply} className="h-7 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]">Apply</button>
        </div>
      </div>
    </div>
  );
}

// ── Date Panel ────────────────────────────────────────────────────────────────

function DatePanel({
  dateFrom, dateTo, onApply, onClose,
}: {
  dateFrom: string;
  dateTo: string;
  onApply: (from: string, to: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [from, setFrom] = useState(dateFrom);
  const [to, setTo] = useState(dateTo);
  const [rangeErr, setRangeErr] = useState("");

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  function apply() {
    if (from && to && from > to) {
      setRangeErr("From date must be on or before To date.");
      return;
    }
    setRangeErr("");
    onApply(from, to);
  }

  return (
    <div
      ref={ref}
      className="absolute right-0 z-10 mt-1 bg-white border border-[var(--aws-border)] rounded-md shadow-[0_4px_12px_rgba(0,28,36,0.18)] p-3 w-[260px]"
    >
      <label htmlFor="date-panel-from" className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">From</label>
      <input
        id="date-panel-from"
        type="date"
        value={from}
        onChange={(e) => { setFrom(e.target.value); setRangeErr(""); }}
        className="w-full h-8 px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] mb-2"
      />
      <label htmlFor="date-panel-to" className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">To</label>
      <input
        id="date-panel-to"
        type="date"
        value={to}
        onChange={(e) => { setTo(e.target.value); setRangeErr(""); }}
        className="w-full h-8 px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] mb-2"
      />
      {rangeErr ? <p className="text-[11px] text-[var(--aws-error)] mb-2">{rangeErr}</p> : null}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => { onApply("", ""); }} className="h-7 px-2 text-[12px] text-[var(--aws-link)] hover:underline">Clear</button>
        <button type="button" onClick={apply} className="h-7 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]">Apply</button>
      </div>
    </div>
  );
}

// ── Export Menu ───────────────────────────────────────────────────────────────

function ExportMenu({ query, onClose }: { query: PoListQuery; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"idle" | "selective">("idle");
  const [checkedCols, setCheckedCols] = useState<Set<string>>(
    () => new Set(PO_EXPORT_COLUMNS.map((c) => c.key as string)),
  );
  const [colSearch, setColSearch] = useState("");
  const [exportState, setExportState] = useState<{ kind: "loading" | "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  async function doExport(cols: typeof PO_EXPORT_COLUMNS) {
    setExportState({ kind: "loading", text: "Exporting…" });
    try {
      const items = await fetchAllPosForExport(query);
      if (items.length === 0) {
        setExportState({ kind: "err", text: "No data to export." });
        return;
      }
      const csv = buildPoCsv(items, cols);
      downloadBlob(
        new Blob([csv], { type: "text/csv;charset=utf-8;" }),
        `po-export-${new Date().toISOString().slice(0, 10)}.csv`,
      );
      setExportState({ kind: "ok", text: `Exported ${items.length} PO${items.length === 1 ? "" : "s"}.` });
    } catch (e) {
      setExportState({ kind: "err", text: e instanceof Error ? e.message : "Export failed" });
    }
  }

  const filteredCols = PO_EXPORT_COLUMNS.filter(
    (c) => !colSearch || c.label.toLowerCase().includes(colSearch.toLowerCase()),
  );

  const allChecked = PO_EXPORT_COLUMNS.every((c) => checkedCols.has(c.key as string));

  if (mode === "selective") {
    return (
      <div
        ref={ref}
        className="absolute right-0 z-20 mt-1 w-[260px] bg-white border border-[var(--aws-border)] rounded-md shadow-[0_4px_12px_rgba(0,28,36,0.18)] p-3"
      >
        <div className="text-[11px] uppercase tracking-wide font-bold text-[var(--text-muted)] mb-2">Select Columns</div>
        <input
          type="search"
          value={colSearch}
          onChange={(e) => setColSearch(e.target.value)}
          placeholder="Filter columns…"
          className="w-full h-7 px-2 mb-2 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e]"
        />
        <div className="mb-2">
          <label className="flex items-center gap-2 text-[12px] text-[var(--text-primary)] cursor-pointer hover:bg-[var(--surface-subtle)] px-1 py-0.5 rounded-sm">
            <input
              type="checkbox"
              checked={allChecked}
              onChange={(e) => {
                if (e.target.checked) setCheckedCols(new Set(PO_EXPORT_COLUMNS.map((c) => c.key as string)));
                else setCheckedCols(new Set());
              }}
            />
            Toggle All
          </label>
        </div>
        <div className="max-h-[200px] overflow-y-auto space-y-0.5 mb-2">
          {filteredCols.map((c) => (
            <label key={c.key as string} className="flex items-center gap-2 text-[12px] text-[var(--text-primary)] cursor-pointer hover:bg-[var(--surface-subtle)] px-1 py-0.5 rounded-sm">
              <input
                type="checkbox"
                checked={checkedCols.has(c.key as string)}
                onChange={(e) => {
                  setCheckedCols((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(c.key as string); else next.delete(c.key as string);
                    return next;
                  });
                }}
              />
              {c.label}
            </label>
          ))}
        </div>
        {exportState ? (
          <p className={["text-[11px] mb-2", exportState.kind === "ok" ? "text-[var(--text-success)]" : exportState.kind === "err" ? "text-[var(--aws-error)]" : "text-[var(--text-secondary)]"].join(" ")}>
            {exportState.text}
          </p>
        ) : null}
        <div className="flex gap-2 justify-end border-t border-[var(--aws-border)] pt-2">
          <button type="button" onClick={() => setMode("idle")} className="h-7 px-2 text-[12px] text-[var(--aws-link)] hover:underline">Back</button>
          <button
            type="button"
            disabled={checkedCols.size === 0 || exportState?.kind === "loading"}
            onClick={() => {
              const cols = PO_EXPORT_COLUMNS.filter((c) => checkedCols.has(c.key as string));
              void doExport(cols);
            }}
            className="h-7 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Export
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className="absolute right-0 z-10 mt-1 bg-white border border-[var(--aws-border)] rounded-md shadow-[0_4px_12px_rgba(0,28,36,0.18)] p-1 w-[210px]"
    >
      {exportState ? (
        <p className={["text-[11px] px-2 py-1", exportState.kind === "ok" ? "text-[var(--text-success)]" : exportState.kind === "err" ? "text-[var(--aws-error)]" : "text-[var(--text-secondary)]"].join(" ")}>
          {exportState.text}
        </p>
      ) : null}
      <button
        type="button"
        disabled={exportState?.kind === "loading"}
        onClick={() => void doExport(PO_EXPORT_COLUMNS)}
        className="w-full text-left px-2 py-1.5 text-[13px] hover:bg-[var(--surface-disabled)] rounded-sm disabled:opacity-50"
      >
        Direct — all columns
      </button>
      <button
        type="button"
        onClick={() => setMode("selective")}
        className="w-full text-left px-2 py-1.5 text-[13px] hover:bg-[var(--surface-disabled)] rounded-sm"
      >
        Selective — choose columns
      </button>
    </div>
  );
}

// ── Th ────────────────────────────────────────────────────────────────────────

function Th({
  children, sortable, col, sort, onSort, width,
}: {
  children: React.ReactNode;
  sortable?: boolean;
  col?: string;
  sort?: { col: string; dir: "asc" | "desc" };
  onSort?: (c: string) => void;
  width?: number;
}) {
  const active = sortable && col && sort && sort.col === col;
  return (
    <th
      style={width ? { width } : undefined}
      onClick={sortable && col && onSort ? () => onSort(col) : undefined}
      className={[
        "px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-[var(--text-secondary)] whitespace-nowrap",
        sortable ? "cursor-pointer select-none hover:text-[var(--text-primary)]" : "",
      ].join(" ")}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {active ? (
          <span className="text-[10px] text-[var(--aws-orange)]">{sort?.dir === "asc" ? "▲" : "▼"}</span>
        ) : null}
      </span>
    </th>
  );
}

// ── Entity pill ───────────────────────────────────────────────────────────────

function EntityPill({ entity }: { entity?: string | null }) {
  if (!entity) return <span className="text-[var(--text-muted)]">—</span>;
  const upper = entity.toUpperCase();
  const bg = upper === "CFPL" ? "#eaf6ed" : upper === "CDPL" ? "#eaf0fb" : "var(--surface-disabled)";
  const fg = upper === "CFPL" ? "var(--text-success)" : upper === "CDPL" ? "#2c5fa8" : "var(--text-secondary)";
  // Border must be a literal color — appending alpha to a var() (e.g.
  // `var(--text-success)22`) is invalid CSS and drops the border.
  const border = upper === "CFPL" ? "#b6dbb1" : upper === "CDPL" ? "#2c5fa822" : "var(--aws-border)";
  return (
    <span
      className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-sm"
      style={{ background: bg, color: fg, border: `1px solid ${border}` }}
    >
      {upper}
    </span>
  );
}

// ── Action buttons ────────────────────────────────────────────────────────────

function ActionBtns({ onToggle, onDelete, isOpen }: { onToggle: () => void; onDelete: () => void; isOpen: boolean }) {
  return (
    <div className="flex items-center gap-1">
      {/* Eye / view */}
      <button
        type="button"
        onClick={onToggle}
        title={isOpen ? "Collapse" : "Expand"}
        aria-label={isOpen ? "Collapse" : "Expand"}
        className="p-1 rounded hover:bg-[var(--surface-divider)] text-[var(--text-secondary)]"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2}>
          {isOpen
            ? <><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" /><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" /><line x1="1" y1="1" x2="23" y2="23" /></>
            : <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></>
          }
        </svg>
      </button>
      {/* Trash / delete */}
      <button
        type="button"
        onClick={onDelete}
        title="Delete PO"
        aria-label="Delete PO"
        className="p-1 rounded hover:bg-[#fdf3f1] text-[var(--text-secondary)] hover:text-[#b1361e]"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2}>
          <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4h6v2" />
        </svg>
      </button>
    </div>
  );
}

// ── Table Row + Detail ─────────────────────────────────────────────────────────

function PoTableRow({
  row, isOpen, onToggle, onDelete, linesState,
}: {
  row: PoListItem;
  isOpen: boolean;
  onToggle: () => void;
  onDelete: () => void;
  linesState?: { lines?: PoLineOut[]; loading: boolean; error?: string };
}) {
  return (
    <>
      <tr
        className="border-b border-[var(--aws-border)] hover:bg-[var(--surface-subtle)] cursor-pointer"
        onClick={onToggle}
      >
        <td className="px-3 py-2 align-middle">
          <span className={["text-[10px] text-[var(--text-muted)] transition-transform inline-block", isOpen ? "rotate-90" : ""].join(" ")} aria-hidden>▸</span>
        </td>
        <td className="px-3 py-2 font-mono text-[12px] text-[var(--aws-link)] whitespace-nowrap">
          {row.po_number || row.transaction_no || "—"}
        </td>
        <td className="px-3 py-2 whitespace-nowrap">{fmtDate(row.po_date)}</td>
        <td className="px-3 py-2 max-w-[220px] truncate" title={row.vendor_supplier_name ?? ""}>
          {row.vendor_supplier_name || "—"}
        </td>
        <td className="px-3 py-2 whitespace-nowrap">{row.voucher_type || "—"}</td>
        <td className="px-3 py-2 max-w-[160px] truncate whitespace-nowrap" title={row.order_reference_no ?? ""}>
          {row.order_reference_no || "—"}
        </td>
        <td className="px-3 py-2 whitespace-nowrap"><EntityPill entity={row.entity} /></td>
        <td className="px-3 py-2 whitespace-nowrap font-mono text-[12px]">{fmtCur(row.gross_total)}</td>
        <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
          <ActionBtns onToggle={onToggle} onDelete={onDelete} isOpen={isOpen} />
        </td>
      </tr>
      {isOpen ? (
        <tr className="border-b border-[var(--aws-border)] bg-[var(--surface-subtle)]">
          <td colSpan={9} className="px-3 py-3" style={{ borderLeft: "3px solid var(--aws-orange)" }}>
            <PoDetailPanel key={row.transaction_no} row={row} linesState={linesState} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

// ── Mobile Card ───────────────────────────────────────────────────────────────

function PoMobileCard({
  row, isOpen, onToggle, onDelete, linesState,
}: {
  row: PoListItem;
  isOpen: boolean;
  onToggle: () => void;
  onDelete: () => void;
  linesState?: { lines?: PoLineOut[]; loading: boolean; error?: string };
}) {
  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] overflow-hidden">
      <div className="p-3 flex items-start gap-2">
        <button
          type="button"
          onClick={onToggle}
          className="w-6 h-6 mt-0.5 rounded-sm border border-[var(--aws-border-strong)] text-[var(--text-secondary)] flex items-center justify-center hover:border-[var(--aws-navy)] shrink-0"
          aria-label={isOpen ? "Collapse" : "Expand"}
        >
          {isOpen ? "−" : "+"}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="font-mono text-[12px] font-semibold text-[var(--aws-link)] truncate">
              {row.po_number || row.transaction_no || "—"}
            </span>
            <span className="text-[11px] text-[var(--text-muted)] shrink-0">{fmtDate(row.po_date)}</span>
          </div>
          <p className="text-[13px] text-[var(--text-primary)] truncate" title={row.vendor_supplier_name ?? ""}>
            {row.vendor_supplier_name || "—"}
          </p>
          <div className="flex items-center justify-between gap-2 mt-1">
            <span className="text-[11px] text-[var(--text-muted)]">
              {row.voucher_type || "—"} · <EntityPill entity={row.entity} />
            </span>
            <span className="text-[12px] font-mono tabular-nums shrink-0">{fmtCur(row.gross_total)}</span>
          </div>
        </div>
        <div className="shrink-0">
          <ActionBtns onToggle={onToggle} onDelete={onDelete} isOpen={isOpen} />
        </div>
      </div>
      {isOpen ? (
        <div className="border-t border-[var(--aws-border)] p-3 bg-[var(--surface-subtle)]">
          <PoDetailPanel key={row.transaction_no} row={row} linesState={linesState} />
        </div>
      ) : null}
    </div>
  );
}

// ── Detail Panel ──────────────────────────────────────────────────────────────

function PoDetailPanel({
  row, linesState,
}: {
  row: PoListItem;
  linesState?: { lines?: PoLineOut[]; loading: boolean; error?: string };
}) {
  const [lineFilter, setLineFilter] = useState("");

  // Header info grid
  const headerFields: { label: string; value: string }[] = [
    { label: "Transaction No",  value: row.transaction_no || "—" },
    { label: "Entity",          value: (row.entity || "—").toUpperCase() },
    { label: "PO Number",       value: row.po_number || "—" },
    { label: "PO Date",         value: fmtDate(row.po_date) },
    { label: "Voucher Type",    value: row.voucher_type || "—" },
    { label: "Order Ref",       value: row.order_reference_no || "—" },
    { label: "Vendor",          value: row.vendor_supplier_name || "—" },
    { label: "Supplier ID",     value: row.supplier_id || "—" },
  ];

  // Money grid
  const moneyFields: { label: string; value: string; accent?: boolean }[] = [
    { label: "Gross Total",          value: fmtCur(row.gross_total),                    accent: true },
    { label: "Total Amount",         value: fmtCur(row.total_amount) },
    { label: "SGST",                 value: fmtCur(row.sgst_amount) },
    { label: "CGST",                 value: fmtCur(row.cgst_amount) },
    { label: "IGST",                 value: fmtCur(row.igst_amount) },
    { label: "Round Off",            value: fmtCur(row.round_off) },
    { label: "Freight (Local)",      value: fmtCur(row.freight_transport_local) },
    { label: "Freight Charges",      value: fmtCur(row.freight_transport_charges) },
    { label: "APMC Tax",             value: fmtCur(row.apmc_tax) },
    { label: "Packing",              value: fmtCur(row.packing_charges) },
    { label: "Loading/Unloading",    value: fmtCur(row.loading_unloading_charges) },
    { label: "Other Non-GST",        value: fmtCur(row.other_charges_non_gst) },
  ];

  // Filter lines by SKU name or UOM
  const allLines = linesState?.lines ?? [];
  const lcFilter = lineFilter.trim().toLowerCase();
  const filteredLines = lcFilter
    ? allLines.filter(
        (l) =>
          (l.sku_name || l.particulars || "").toLowerCase().includes(lcFilter) ||
          (l.uom || "").toLowerCase().includes(lcFilter),
      )
    : allLines;

  return (
    <div className="space-y-3 text-[12px]">
      {/* Header info */}
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2">
        {headerFields.map((f) => (
          <div key={f.label} className="min-w-0">
            <dt className="uppercase tracking-wide font-semibold text-[var(--text-muted)] text-[10px]">{f.label}</dt>
            <dd className="text-[12px] text-[var(--text-primary)] truncate" title={f.value}>{f.value}</dd>
          </div>
        ))}
      </dl>

      {/* Money grid */}
      <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-4 gap-y-2 border-t border-[var(--aws-border)] pt-2">
        {moneyFields.map((f) => (
          <div key={f.label} className="min-w-0">
            <dt className="uppercase tracking-wide font-semibold text-[var(--text-muted)] text-[10px]">{f.label}</dt>
            <dd
              className={["text-[12px] font-mono truncate", f.accent ? "text-[var(--aws-orange)] font-bold" : "text-[var(--text-primary)]"].join(" ")}
              title={f.value}
            >
              {f.value}
            </dd>
          </div>
        ))}
      </dl>

      {/* Narration */}
      {row.narration ? (
        <div className="border-t border-[var(--aws-border)] pt-2">
          <div className="uppercase tracking-wide font-semibold text-[var(--text-muted)] text-[10px] mb-0.5">Narration</div>
          <p className="text-[12px] text-[var(--text-secondary)]">{row.narration}</p>
        </div>
      ) : null}

      {/* Articles */}
      <div className="border-t border-[var(--aws-border)] pt-2">
        <div className="flex items-center gap-2 mb-2">
          <div className="text-[11px] uppercase tracking-wide font-bold text-[var(--text-muted)]">Articles</div>
          <div className="flex-1" />
          <input
            type="search"
            value={lineFilter}
            onChange={(e) => setLineFilter(e.target.value)}
            placeholder="Filter by SKU or UOM…"
            className="h-6 px-2 text-[11px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] w-[180px]"
          />
        </div>

        {linesState?.loading ? (
          <div className="py-3 text-center text-[var(--text-secondary)] flex items-center justify-center gap-2">
            <span className="inline-block w-3 h-3 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
            Loading articles…
          </div>
        ) : linesState?.error ? (
          <p className="text-[var(--aws-error)] text-[12px] py-2">{linesState.error}</p>
        ) : !linesState ? (
          <p className="text-[var(--text-muted)] italic text-[12px] py-2">Articles will appear here once loaded.</p>
        ) : filteredLines.length === 0 ? (
          <p className="text-[var(--text-muted)] italic text-[12px] py-2">
            {lcFilter ? "No articles match the filter." : "No articles."}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto rounded-[2px] border border-[var(--aws-border)]">
              <table className="w-full text-[12px] border-collapse">
                <thead className="bg-[var(--surface-subtle)]">
                  <tr className="border-b border-[var(--aws-border)]">
                    <th className="px-2 py-1 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)] w-8">#</th>
                    <th className="px-2 py-1 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">Article</th>
                    <th className="px-2 py-1 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">UOM</th>
                    <th className="px-2 py-1 text-right text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">Pack</th>
                    <th className="px-2 py-1 text-right text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">Weight</th>
                    <th className="px-2 py-1 text-right text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">Rate</th>
                    <th className="px-2 py-1 text-right text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">Amount</th>
                    <th className="px-2 py-1 text-right text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">GST</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLines.map((l, i) => {
                    const gstPct =
                      l.gst_rate != null
                        ? Number(l.gst_rate).toFixed(2) + "%"
                        : "—";
                    return (
                      <tr key={l.line_number ?? i} className="border-b border-[var(--aws-border)] last:border-b-0 hover:bg-[var(--surface-subtle)]">
                        <td className="px-2 py-1 text-[var(--text-muted)]">{l.line_number ?? i + 1}</td>
                        <td className="px-2 py-1 max-w-[200px] truncate" title={l.sku_name || l.particulars || ""}>{l.sku_name || l.particulars || "—"}</td>
                        <td className="px-2 py-1 font-mono">{l.uom || "—"}</td>
                        <td className="px-2 py-1 text-right font-mono tabular-nums">{fmtNum(l.pack_count)}</td>
                        <td className="px-2 py-1 text-right font-mono tabular-nums">{fmtNum(l.po_weight)}</td>
                        <td className="px-2 py-1 text-right font-mono tabular-nums">{fmtCur(l.rate)}</td>
                        <td className="px-2 py-1 text-right font-mono tabular-nums">{fmtCur(l.amount)}</td>
                        <td className="px-2 py-1 text-right font-mono tabular-nums">{gstPct}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-[10px] text-[var(--text-muted)] mt-1">
              {filteredLines.length} of {allLines.length} article{allLines.length === 1 ? "" : "s"}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

// ── Delete Modal ──────────────────────────────────────────────────────────────

function DeleteModal({
  txn, poNumber, onConfirm, onCancel,
}: {
  txn: string;
  poNumber?: string | null;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const label = poNumber || txn;
  const titleId = "delete-modal-title";
  const reasonId = "delete-modal-reason";

  // Dismiss on Escape key
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  async function submit() {
    if (!reason.trim()) return;
    setConfirming(true);
    setErr(null);
    try {
      await onConfirm(reason.trim());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setConfirming(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-white rounded-md shadow-[0_8px_32px_rgba(0,28,36,0.28)] w-full max-w-[420px] p-5"
      >
        <h2 id={titleId} className="text-[15px] font-semibold text-[var(--text-primary)] mb-1">Delete PO</h2>
        <p className="text-[13px] text-[var(--text-secondary)] mb-3">
          Delete <span className="font-mono font-semibold">{label}</span>? This action cannot be undone.
        </p>
        <label htmlFor={reasonId} className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">
          Reason <span className="text-[var(--aws-error)]">*</span>
        </label>
        <textarea
          id={reasonId}
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Explain why this PO is being deleted…"
          className="w-full px-2 py-1.5 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] resize-y"
        />
        {err ? <p className="text-[12px] text-[var(--aws-error)] mt-1">{err}</p> : null}
        <div className="flex justify-end gap-2 mt-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={confirming}
            className="h-8 px-4 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!reason.trim() || confirming}
            onClick={() => void submit()}
            className="h-8 px-4 text-[13px] rounded-[2px] border border-[#b1361e] bg-[#b1361e] text-white hover:bg-[#9a1717] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {confirming ? (
              <span className="inline-block w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
            ) : null}
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Pagination ────────────────────────────────────────────────────────────────

function PageBtn({
  p, label, active, disabled, onPage, loading,
}: {
  p: number; label: React.ReactNode; active?: boolean; disabled?: boolean;
  onPage: (p: number) => void; loading: boolean;
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

function PoPagination({
  page, totalPages, total, pageSize, onPage, loading,
}: {
  page: number; totalPages: number; total: number; pageSize: number;
  onPage: (p: number) => void; loading: boolean;
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
        Showing {start}–{end} of {total} PO{total === 1 ? "" : "s"}
      </span>
      <div className="flex items-center gap-1">
        <PageBtn p={page - 1} label="‹" disabled={page <= 1} onPage={onPage} loading={loading} />
        {from > 1 ? <PageBtn p={1} label={1} onPage={onPage} loading={loading} /> : null}
        {from > 2 ? <span className="px-1 text-[var(--text-muted)]">…</span> : null}
        {pages.map((p) => <PageBtn key={p} p={p} label={p} active={p === page} onPage={onPage} loading={loading} />)}
        {to < totalPages - 1 ? <span className="px-1 text-[var(--text-muted)]">…</span> : null}
        {to < totalPages ? <PageBtn p={totalPages} label={totalPages} onPage={onPage} loading={loading} /> : null}
        <PageBtn p={page + 1} label="›" disabled={page >= totalPages} onPage={onPage} loading={loading} />
      </div>
    </div>
  );
}
