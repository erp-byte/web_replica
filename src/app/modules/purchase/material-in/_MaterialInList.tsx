"use client";

// Material In listing component.
// Adapted from po-creation/_listing.tsx — same UI chrome (toolbar, entity chips,
// advanced filter, date, export, sort, 7-window pagination, desktop table +
// mobile cards), but with a trimmed column set, an Articles column that lazily
// fetches per-row PO lines (mirroring send-intimation.js's articles cell), no
// delete action, and a Send button placeholder per row.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type PoListItem,
  type PoLineOut,
  type PoListQuery,
  type PoListResponse,
  listPos,
  getPoLines,
  fetchAllPosForExport,
  buildPoCsv,
  downloadBlob,
  fmtNum,
  PO_EXPORT_COLUMNS,
} from "@/lib/po";
import {
  type ArrivalItem,
  type ArrivalSummaryItem,
  type QcArrivalState,
  type QcTxnStatus,
  listArrivals,
  arrivalsSummary,
} from "@/lib/qc";
import { SendIntimationModal } from "./_SendIntimationModal";

// ── QC status helpers ─────────────────────────────────────────────────────────

// Per-transaction status filter values (mirrors QcTxnStatus + an "all" sentinel).
type QcFilter = "all" | QcTxnStatus;

const QC_FILTER_CHIPS: { value: QcFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "pending_arrival", label: "Pending arrival" },
  { value: "arrived", label: "Arrived" },
  { value: "completed", label: "Completed" },
];

// Resolve a row's per-transaction status from the summary map. A txn ABSENT
// from the summary result means nothing has been sent yet → "pending_arrival".
function txnStatus(
  txn: string,
  summary: Map<string, ArrivalSummaryItem>,
): QcTxnStatus {
  const s = summary.get(txn);
  if (!s) return "pending_arrival";
  return s.status; // "arrived" | "completed"
}

// Map a single arrival qc_state to its display label.
const QC_STATE_LABEL: Record<QcArrivalState, string> = {
  arrived: "Arrived",
  in_qc: "In QC",
  accepted: "Accepted",
  rejected: "Rejected",
};

// "Least-done" ordering used to summarise a line that has multiple arrivals
// in differing states — we surface the least-progressed state plus a count.
const QC_STATE_RANK: Record<QcArrivalState, number> = {
  arrived: 0,
  in_qc: 1,
  rejected: 2,
  accepted: 3,
};

// ── Public interface ─────────────────────────────────────────────────────────

export interface MaterialInListProps {
  query: PoListQuery;
  onQueryChange: (patch: Partial<PoListQuery>) => void;
  search: string;
  onSearch: (v: string) => void;
  expanded: Set<string>;
  onToggleExpand: (txn: string) => void;
}

// Columns sortable in the backend whitelist that are shown in this view.
const SORTABLE_COLS = ["po_number", "vendor_supplier_name", "transaction_no"] as const;

export function MaterialInList(props: MaterialInListProps): React.JSX.Element {
  const { query, onQueryChange, search, onSearch, expanded, onToggleExpand } = props;

  // ── Local state ────────────────────────────────────────────────────────────
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<PoListResponse | null>(null);
  const [refetchNonce, setRefetchNonce] = useState(0);

  // ── Send intimation modal ──────────────────────────────────────────────────
  const [sendTxn, setSendTxn] = useState<string | null>(null);

  // Per-txn lines cache — shared between the Articles column summary AND the
  // expanded detail panel. Map<txn, {lines?, loading, error?}>
  // Stored in state (not a plain ref) so the component re-renders when resolved.
  const [linesCache, setLinesCache] = useState<
    Map<string, { lines?: PoLineOut[]; loading: boolean; error?: string }>
  >(new Map());

  // ── QC status: per-transaction summary (badge + filter) ────────────────────
  // Map<txn, ArrivalSummaryItem>. A txn ABSENT from this map = "pending_arrival".
  const [qcSummary, setQcSummary] = useState<Map<string, ArrivalSummaryItem>>(new Map());

  // ── QC status: per-txn arrivals cache (expansion per-article status) ───────
  // Mirrors linesCache. Map<txn, {arrivals?, loading, error?}>
  const [arrivalsCache, setArrivalsCache] = useState<
    Map<string, { arrivals?: ArrivalItem[]; loading: boolean; error?: string }>
  >(new Map());

  // ── QC status filter chip (client-side, over the current page only) ────────
  const [qcFilter, setQcFilter] = useState<QcFilter>("all");

  // ── Fetch fingerprint ──────────────────────────────────────────────────────
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryFp, refetchNonce]);

  // ── Lazy line fetch ────────────────────────────────────────────────────────
  const fetchLines = useCallback(async (txn: string) => {
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
  }, []);

  // ── Lazy arrivals fetch (per-txn QC arrivals for the expansion) ───────────
  const fetchArrivals = useCallback(async (txn: string) => {
    // Same yield trick as fetchLines — defer so no setState fires synchronously
    // inside a useEffect body (avoids react-hooks/set-state-in-effect).
    await Promise.resolve();
    setArrivalsCache((prev) => {
      const next = new Map(prev);
      next.set(txn, { loading: true });
      return next;
    });
    try {
      const arrivals = await listArrivals(txn);
      setArrivalsCache((prev) => {
        const next = new Map(prev);
        next.set(txn, { arrivals, loading: false });
        return next;
      });
    } catch (e: unknown) {
      setArrivalsCache((prev) => {
        const next = new Map(prev);
        next.set(txn, {
          loading: false,
          error: e instanceof Error ? e.message : "Failed to load QC status",
        });
        return next;
      });
    }
  }, []);

  // ── Fetch articles for visible rows (Articles column) ─────────────────────
  // After data loads, kick off article fetches for every currently-visible row
  // that hasn't been fetched yet. This populates the Articles summary column.
  const rows = data?.items ?? [];
  const rowKeysFp = rows.map((r) => r.transaction_no).join(",");

  // ── Per-transaction QC summary fetch (badge + filter) ─────────────────────
  // After the listing loads, fetch the QC rollup for ALL visible txns in one
  // call (mirrors the post-load linesCache effect). AbortController guards
  // setState; we defer with Promise.resolve() to dodge set-state-in-effect.
  useEffect(() => {
    if (rows.length === 0) return;
    const txns = rows.map((r) => r.transaction_no).filter((t): t is string => !!t);
    if (txns.length === 0) return;
    const controller = new AbortController();
    void (async () => {
      await Promise.resolve();
      try {
        const items = await arrivalsSummary(txns, controller.signal);
        if (controller.signal.aborted) return;
        setQcSummary(new Map(items.map((it) => [it.transaction_no, it])));
      } catch (e) {
        if (controller.signal.aborted) return;
        if (e instanceof Error && e.name === "AbortError") return;
        // Non-fatal: leave the prior summary in place; rows fall back to
        // "pending_arrival" when a txn is absent. No surfaced error here.
      }
    })();
    return () => controller.abort();
    // rowKeysFp changes when the page/filters change; qcSummary is derived output
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowKeysFp, refetchNonce]);
  useEffect(() => {
    if (rows.length === 0) return;
    for (const row of rows) {
      const txn = row.transaction_no;
      if (!txn) continue;
      const entry = linesCache.get(txn);
      // Fetch if not started yet; retry if previously errored and row is re-visible
      if (!entry) {
        void fetchLines(txn);
      }
    }
    // rowKeysFp changes when the page/filters change; linesCache is derived output
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowKeysFp]);

  // ── Fetch articles for expanded rows (expansion panel) ────────────────────
  // When a row is expanded and we don't yet have its lines (or a previous fetch
  // errored), kick off the fetch so errors are retryable on re-expand.
  useEffect(() => {
    for (const txn of expanded) {
      const entry = linesCache.get(txn);
      if (!entry || (!entry.loading && entry.error && !entry.lines)) {
        void fetchLines(txn);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Array.from(expanded).sort().join(",")]);

  // ── Fetch QC arrivals for expanded rows (per-article QC status) ───────────
  // Same retry-on-re-expand semantics as the lines effect above.
  useEffect(() => {
    for (const txn of expanded) {
      const entry = arrivalsCache.get(txn);
      if (!entry || (!entry.loading && entry.error && !entry.arrivals)) {
        void fetchArrivals(txn);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Array.from(expanded).sort().join(",")]);

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

  // ── Open send intimation modal for a row ───────────────────────────────────
  // Ensures lines are loaded before opening; if not yet fetched, triggers fetch.
  function handleSendClick(txn: string) {
    const entry = linesCache.get(txn);
    if (!entry) {
      void fetchLines(txn);
    }
    setSendTxn(txn);
  }

  // Compute modal props when sendTxn is set
  const sendRow = sendTxn ? (data?.items.find((r) => r.transaction_no === sendTxn) ?? null) : null;
  const sendLinesState = sendTxn ? linesCache.get(sendTxn) : undefined;

  // ── Apply QC status filter (client-side over the CURRENT page) ────────────
  // NOTE: this filters only the currently-loaded page; it is NOT a server-side
  // filter, so counts/pagination reflect the page, not the whole result set.
  const visibleRows =
    qcFilter === "all"
      ? rows
      : rows.filter((r) => txnStatus(r.transaction_no, qcSummary) === qcFilter);

  return (
    <div>
      <MaterialInToolbar
        query={query}
        onQueryChange={onQueryChange}
        search={search}
        onSearch={onSearch}
        onRefresh={() => setRefetchNonce((n) => n + 1)}
        qcFilter={qcFilter}
        onQcFilterChange={setQcFilter}
      />

      {/* Desktop table */}
      <div className="hidden md:block bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[13px] border-collapse">
            <thead className="bg-[var(--surface-subtle)] text-[var(--text-primary)]">
              <tr className="border-b border-[var(--aws-border)]">
                {(() => {
                  const sort = currentSort();
                  return (
                    <>
                      <Th width={32}>{null}</Th>
                      <Th sortable col="transaction_no" sort={sort} onSort={handleSort}>Transaction No</Th>
                      <Th>Entity</Th>
                      <Th sortable col="po_number" sort={sort} onSort={handleSort}>PO Number</Th>
                      <Th sortable col="vendor_supplier_name" sort={sort} onSort={handleSort}>Vendor</Th>
                      <Th>Articles</Th>
                      <Th>QC Status</Th>
                      <Th width={72}>{null}</Th>
                    </>
                  );
                })()}
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-10 text-center text-[var(--text-secondary)]">
                    <span className="inline-flex items-center gap-2">
                      <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
                      Loading Purchase Orders…
                    </span>
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-[var(--aws-error)] text-[13px]">{error}</td>
                </tr>
              ) : visibleRows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-12 text-center text-[var(--text-secondary)]">
                    <p className="font-semibold text-[14px] mb-1">No Purchase Orders</p>
                    <p className="text-[12px]">
                      {rows.length > 0 && qcFilter !== "all"
                        ? "No POs on this page match the selected QC status."
                        : "No POs match your current filters."}
                    </p>
                  </td>
                </tr>
              ) : (
                visibleRows.map((row, i) => {
                  const txn = row.transaction_no;
                  const isOpen = expanded.has(txn);
                  return (
                    <MaterialInTableRow
                      key={txn || `idx-${i}`}
                      row={row}
                      isOpen={isOpen}
                      onToggle={() => onToggleExpand(txn)}
                      onSend={() => handleSendClick(txn)}
                      linesState={linesCache.get(txn)}
                      qcSummaryItem={qcSummary.get(txn)}
                      arrivalsState={arrivalsCache.get(txn)}
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
        ) : visibleRows.length === 0 ? (
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-8 text-center text-[var(--text-secondary)]">
            <p className="font-semibold text-[14px] mb-1">No Purchase Orders</p>
            <p className="text-[12px]">
              {rows.length > 0 && qcFilter !== "all"
                ? "No POs on this page match the selected QC status."
                : "No POs match your current filters."}
            </p>
          </div>
        ) : (
          visibleRows.map((row, i) => {
            const txn = row.transaction_no;
            const isOpen = expanded.has(txn);
            return (
              <MaterialInMobileCard
                key={txn || `m-${i}`}
                row={row}
                isOpen={isOpen}
                onToggle={() => onToggleExpand(txn)}
                onSend={() => handleSendClick(txn)}
                linesState={linesCache.get(txn)}
                qcSummaryItem={qcSummary.get(txn)}
                arrivalsState={arrivalsCache.get(txn)}
              />
            );
          })
        )}
      </div>

      {/* Pagination */}
      {data && data.total > 0 && data.total_pages > 1 ? (
        <MiPagination
          page={data.page}
          totalPages={data.total_pages}
          total={data.total}
          pageSize={data.page_size}
          onPage={(p) => onQueryChange({ page: p })}
          loading={loading}
        />
      ) : null}

      {/* Send intimation modal */}
      {sendTxn && sendRow ? (
        sendLinesState?.loading ? (
          /* Lines still fetching — show a lightweight inline loader in the modal position */
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="bg-white rounded-md shadow-[0_8px_32px_rgba(0,28,36,0.28)] w-full max-w-md p-8 text-center text-[var(--text-secondary)]">
              <span className="inline-flex items-center gap-2 text-[13px]">
                <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
                Loading articles…
              </span>
            </div>
          </div>
        ) : sendLinesState?.error || (sendLinesState?.lines?.length ?? 0) === 0 ? (
          /* Lines failed to load (or none) — don't open an empty send form */
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setSendTxn(null)}>
            <div className="bg-white rounded-md shadow-[0_8px_32px_rgba(0,28,36,0.28)] w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
              <p className="text-[13px] text-[var(--aws-error)] mb-4">
                {sendLinesState?.error ?? "No articles on this PO — nothing to send."}
              </p>
              <div className="flex justify-end gap-2">
                {sendLinesState?.error ? (
                  <button type="button" onClick={() => fetchLines(sendTxn)} className="h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]">Retry</button>
                ) : null}
                <button type="button" onClick={() => setSendTxn(null)} className="h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]">Close</button>
              </div>
            </div>
          </div>
        ) : (
          <SendIntimationModal
            transactionNo={sendTxn}
            poNumber={sendRow.po_number ?? ""}
            vendor={sendRow.vendor_supplier_name ?? ""}
            articles={(sendLinesState?.lines ?? []).map((l) => ({
              line_number: l.line_number,
              name: l.sku_name || l.particulars || "—",
            }))}
            onClose={() => setSendTxn(null)}
          />
        )
      ) : null}
    </div>
  );
}

// ── Toolbar ───────────────────────────────────────────────────────────────────

function MaterialInToolbar({
  query, onQueryChange, search, onSearch, onRefresh, qcFilter, onQcFilterChange,
}: {
  query: PoListQuery;
  onQueryChange: (patch: Partial<PoListQuery>) => void;
  search: string;
  onSearch: (v: string) => void;
  onRefresh: () => void;
  qcFilter: QcFilter;
  onQcFilterChange: (f: QcFilter) => void;
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

      {/* QC status filter chips — client-side over the current page */}
      <span className="mx-0.5 h-5 w-px bg-[var(--aws-border)]" aria-hidden />
      {QC_FILTER_CHIPS.map((c) => (
        <button
          key={c.value}
          type="button"
          onClick={() => onQcFilterChange(c.value)}
          className={[
            "h-8 px-3 text-[12px] rounded-full border transition-colors",
            qcFilter === c.value
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
        const inputId = `mi-adv-filter-${f.key as string}`;
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
      <label htmlFor="mi-date-from" className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">From</label>
      <input
        id="mi-date-from"
        type="date"
        value={from}
        onChange={(e) => { setFrom(e.target.value); setRangeErr(""); }}
        className="w-full h-8 px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] mb-2"
      />
      <label htmlFor="mi-date-to" className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">To</label>
      <input
        id="mi-date-to"
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
        `material-in-export-${new Date().toISOString().slice(0, 10)}.csv`,
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

// ── QC status pill (per-transaction) ──────────────────────────────────────────
// Pending arrival (grey) / Arrived (amber/blue) / Completed (green). For
// Completed, also reflect accepted/rejected counts from the summary.

function QcTxnBadge({ summary }: { summary?: ArrivalSummaryItem }) {
  const status: QcTxnStatus = summary ? summary.status : "pending_arrival";
  if (status === "pending_arrival") {
    return (
      <span
        className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-sm whitespace-nowrap"
        style={{ background: "var(--surface-disabled)", color: "var(--text-secondary)", border: "1px solid var(--aws-border)" }}
      >
        Pending arrival
      </span>
    );
  }
  if (status === "arrived") {
    return (
      <span
        className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-sm whitespace-nowrap"
        style={{ background: "#fbe7d6", color: "#9a5b00", border: "1px solid #f0cfa0" }}
        title={summary ? `${summary.awaiting} awaiting · ${summary.in_qc} in QC · ${summary.accepted}✓ ${summary.rejected}✗` : undefined}
      >
        Arrived
      </span>
    );
  }
  // completed
  const accepted = summary?.accepted ?? 0;
  const rejected = summary?.rejected ?? 0;
  return (
    <span
      className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-sm whitespace-nowrap"
      style={{ background: "#eaf6ed", color: "var(--text-success)", border: "1px solid #b6dbb1" }}
      title={`Completed · ${accepted} accepted · ${rejected} rejected`}
    >
      {`Completed · ${accepted}✓ ${rejected}✗`}
    </span>
  );
}

// ── QC status pill (per-article, inside the expansion) ────────────────────────
// Pending arrival / Arrived / In QC / Accepted / Rejected. When a line has
// multiple arrivals in differing states, show the least-progressed state + count.

const QC_ARTICLE_STYLE: Record<QcArrivalState, { bg: string; fg: string; border: string }> = {
  arrived:  { bg: "#fbe7d6", fg: "#9a5b00",                border: "#f0cfa0" },
  in_qc:    { bg: "#eaf0fb", fg: "#2c5fa8",                border: "#c3d4f0" },
  accepted: { bg: "#eaf6ed", fg: "var(--text-success)",   border: "#b6dbb1" },
  rejected: { bg: "#fbeced", fg: "var(--aws-error)",      border: "#f0c0c4" },
};

function QcArticleBadge({ states }: { states: QcArrivalState[] }) {
  if (states.length === 0) {
    return (
      <span
        className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-sm whitespace-nowrap"
        style={{ background: "var(--surface-disabled)", color: "var(--text-secondary)", border: "1px solid var(--aws-border)" }}
      >
        Pending arrival
      </span>
    );
  }
  // Pick the least-done state to summarise; show a count when mixed.
  const least = [...states].sort((a, b) => QC_STATE_RANK[a] - QC_STATE_RANK[b])[0];
  const uniform = states.every((s) => s === states[0]);
  const style = QC_ARTICLE_STYLE[least];
  const label = QC_STATE_LABEL[least];
  return (
    <span
      className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-sm whitespace-nowrap"
      style={{ background: style.bg, color: style.fg, border: `1px solid ${style.border}` }}
      title={uniform ? `${states.length} arrival(s): ${label}` : `${states.length} arrivals · ${states.map((s) => QC_STATE_LABEL[s]).join(", ")}`}
    >
      {label}
      {states.length > 1 ? <span className="ml-1 opacity-70">×{states.length}</span> : null}
    </span>
  );
}

// Match a PO line to its arrivals. PoLineOut has no sku_id, so match by article
// name (line's sku_name||particulars vs arrival sku_name), case-insensitive.
function arrivalsForLine(line: PoLineOut, arrivals: ArrivalItem[]): QcArrivalState[] {
  const lineName = (line.sku_name || line.particulars || "").trim().toLowerCase();
  if (!lineName) return [];
  return arrivals
    .filter((a) => (a.sku_name || "").trim().toLowerCase() === lineName)
    .map((a) => a.qc_state);
}

// ── Articles column cell ──────────────────────────────────────────────────────
// Mirrors send-intimation.js's paintPoArticleCell: shows first 2 names + "+N more".

function ArticlesSummary({
  linesState,
}: {
  linesState?: { lines?: PoLineOut[]; loading: boolean; error?: string };
}) {
  if (!linesState || linesState.loading) {
    return <span className="text-[var(--text-muted)] text-[12px]">…</span>;
  }
  if (linesState.error) {
    return <span className="text-[var(--text-muted)] text-[12px]">—</span>;
  }
  const lines = linesState.lines ?? [];
  if (lines.length === 0) {
    return <span className="text-[var(--text-muted)] italic text-[12px]">No articles</span>;
  }
  const names = lines.map((l) => l.sku_name || l.particulars || "—");
  const head = names.slice(0, 2).join(", ");
  const more = names.length > 2 ? names.length - 2 : 0;
  return (
    <span
      className="text-[12px] text-[var(--text-primary)]"
      title={names.join(" · ")}
    >
      {head}
      {more > 0 ? (
        <span className="text-[var(--text-muted)] ml-1">+{more} more</span>
      ) : null}
    </span>
  );
}

// ── Action buttons (view + send — no delete) ──────────────────────────────────

function ActionBtns({
  onToggle, onSend, isOpen,
}: {
  onToggle: () => void;
  onSend: () => void;
  isOpen: boolean;
}) {
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
      {/* Send intimation */}
      <button
        type="button"
        onClick={onSend}
        title="Send intimation"
        aria-label="Send intimation"
        className="p-1 rounded hover:bg-[#eaf0fb] text-[var(--text-secondary)] hover:text-[#2c5fa8]"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <line x1="22" y1="2" x2="11" y2="13" />
          <polygon points="22 2 15 22 11 13 2 9 22 2" />
        </svg>
      </button>
    </div>
  );
}

// ── Table Row + Detail ─────────────────────────────────────────────────────────

function MaterialInTableRow({
  row, isOpen, onToggle, onSend, linesState, qcSummaryItem, arrivalsState,
}: {
  row: PoListItem;
  isOpen: boolean;
  onToggle: () => void;
  onSend: () => void;
  linesState?: { lines?: PoLineOut[]; loading: boolean; error?: string };
  qcSummaryItem?: ArrivalSummaryItem;
  arrivalsState?: { arrivals?: ArrivalItem[]; loading: boolean; error?: string };
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
          {row.transaction_no || "—"}
        </td>
        <td className="px-3 py-2 whitespace-nowrap"><EntityPill entity={row.entity} /></td>
        <td className="px-3 py-2 font-mono text-[12px] whitespace-nowrap">
          {row.po_number || "—"}
        </td>
        <td className="px-3 py-2 max-w-[220px] truncate" title={row.vendor_supplier_name ?? ""}>
          {row.vendor_supplier_name || "—"}
        </td>
        <td className="px-3 py-2 max-w-[240px]">
          <ArticlesSummary linesState={linesState} />
        </td>
        <td className="px-3 py-2 whitespace-nowrap">
          <QcTxnBadge summary={qcSummaryItem} />
        </td>
        <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
          <ActionBtns onToggle={onToggle} onSend={onSend} isOpen={isOpen} />
        </td>
      </tr>
      {isOpen ? (
        <tr className="border-b border-[var(--aws-border)] bg-[var(--surface-subtle)]">
          <td colSpan={8} className="px-3 py-3" style={{ borderLeft: "3px solid var(--aws-orange)" }}>
            <MaterialInDetailPanel key={row.transaction_no} linesState={linesState} arrivalsState={arrivalsState} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

// ── Mobile Card ───────────────────────────────────────────────────────────────

function MaterialInMobileCard({
  row, isOpen, onToggle, onSend, linesState, qcSummaryItem, arrivalsState,
}: {
  row: PoListItem;
  isOpen: boolean;
  onToggle: () => void;
  onSend: () => void;
  linesState?: { lines?: PoLineOut[]; loading: boolean; error?: string };
  qcSummaryItem?: ArrivalSummaryItem;
  arrivalsState?: { arrivals?: ArrivalItem[]; loading: boolean; error?: string };
}) {
  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] overflow-hidden">
      <div className="p-3 flex items-start gap-2">
        {/* Expand toggle */}
        <button
          type="button"
          onClick={onToggle}
          className="w-6 h-6 mt-0.5 rounded-sm border border-[var(--aws-border-strong)] text-[var(--text-secondary)] flex items-center justify-center hover:border-[var(--aws-navy)] shrink-0"
          aria-label={isOpen ? "Collapse" : "Expand"}
        >
          {isOpen ? "−" : "+"}
        </button>
        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Row 1: Transaction No + Entity pill */}
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
            <span className="font-mono text-[12px] font-semibold text-[var(--aws-link)] truncate">
              {row.transaction_no || "—"}
            </span>
            <EntityPill entity={row.entity} />
          </div>
          {/* Row 2: PO Number */}
          <p className="text-[11px] text-[var(--text-muted)] mb-0.5">
            PO: <span className="font-mono text-[var(--text-primary)]">{row.po_number || "—"}</span>
          </p>
          {/* Row 3: Vendor */}
          <p className="text-[13px] text-[var(--text-primary)] truncate mb-1" title={row.vendor_supplier_name ?? ""}>
            {row.vendor_supplier_name || "—"}
          </p>
          {/* Row 4: Articles summary */}
          <div className="text-[12px] text-[var(--text-secondary)]">
            <ArticlesSummary linesState={linesState} />
          </div>
          {/* Row 5: QC status badge */}
          <div className="mt-1">
            <QcTxnBadge summary={qcSummaryItem} />
          </div>
        </div>
        {/* Actions */}
        <div className="shrink-0">
          <ActionBtns onToggle={onToggle} onSend={onSend} isOpen={isOpen} />
        </div>
      </div>
      {/* Expanded detail */}
      {isOpen ? (
        <div className="border-t border-[var(--aws-border)] p-3 bg-[var(--surface-subtle)]">
          <MaterialInDetailPanel key={row.transaction_no} linesState={linesState} arrivalsState={arrivalsState} />
        </div>
      ) : null}
    </div>
  );
}

// ── Detail Panel — simplified, Article / Pack / Weight only ──────────────────

function MaterialInDetailPanel({
  linesState, arrivalsState,
}: {
  linesState?: { lines?: PoLineOut[]; loading: boolean; error?: string };
  arrivalsState?: { arrivals?: ArrivalItem[]; loading: boolean; error?: string };
}) {
  if (linesState?.loading) {
    return (
      <div className="py-3 text-center text-[var(--text-secondary)] flex items-center justify-center gap-2 text-[12px]">
        <span className="inline-block w-3 h-3 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
        Loading articles…
      </div>
    );
  }
  if (linesState?.error) {
    return <p className="text-[var(--aws-error)] text-[12px] py-2">{linesState.error}</p>;
  }
  if (!linesState) {
    return <p className="text-[var(--text-muted)] italic text-[12px] py-2">Articles will appear here once loaded.</p>;
  }
  const lines = linesState.lines ?? [];
  if (lines.length === 0) {
    return <p className="text-[var(--text-muted)] italic text-[12px] py-2">No articles on this PO.</p>;
  }

  return (
    <div className="space-y-2 text-[12px]">
      <div className="text-[11px] uppercase tracking-wide font-bold text-[var(--text-muted)] mb-1">
        Articles ({lines.length})
      </div>
      {/* Content-width table (not w-full) so the few columns sit together
          instead of being stretched edge-to-edge across the panel. */}
      <div className="overflow-x-auto rounded-[2px] border border-[var(--aws-border)]">
        <table className="w-auto text-[12px] border-collapse">
          <thead className="bg-[var(--surface-subtle)]">
            <tr className="border-b border-[var(--aws-border)]">
              <th className="px-3 py-1 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)] w-8">#</th>
              <th className="px-3 py-1 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">Article</th>
              <th className="px-3 py-1 text-right text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)] whitespace-nowrap">Pack</th>
              <th className="px-3 py-1 text-right text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)] whitespace-nowrap">Weight</th>
              <th className="px-3 py-1 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)] whitespace-nowrap">QC Status</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.line_number ?? i} className="border-b border-[var(--aws-border)] last:border-b-0 hover:bg-[var(--surface-subtle)]">
                <td className="px-3 py-1 text-[var(--text-muted)]">{l.line_number ?? i + 1}</td>
                <td className="px-3 py-1 max-w-[420px] truncate" title={l.sku_name || l.particulars || ""}>
                  {l.sku_name || l.particulars || "—"}
                </td>
                <td className="px-3 py-1 text-right font-mono tabular-nums whitespace-nowrap">{fmtNum(l.pack_count)}</td>
                <td className="px-3 py-1 text-right font-mono tabular-nums whitespace-nowrap">{fmtNum(l.po_weight)}</td>
                <td className="px-3 py-1 whitespace-nowrap">
                  {arrivalsState?.loading ? (
                    <span className="text-[var(--text-muted)] text-[11px]">…</span>
                  ) : arrivalsState?.error ? (
                    <span className="text-[var(--text-muted)] text-[11px]">—</span>
                  ) : (
                    <QcArticleBadge states={arrivalsForLine(l, arrivalsState?.arrivals ?? [])} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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

function MiPagination({
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
