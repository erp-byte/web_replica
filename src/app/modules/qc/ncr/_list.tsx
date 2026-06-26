"use client";

// Controlled NCR listing. Mirrors the inward-inspection _list.tsx pattern:
// AbortController fetch keyed on a stable query fingerprint + reloadKey,
// status pills, search toolbar, desktop table + md:hidden mobile cards, and
// a 7-window pagination footer.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  type NcrListItem,
  type NcrListQuery,
  type NcrListResponse,
  listNcrs,
} from "@/lib/qc";
import { CreateNcrModal } from "./_CreateNcrModal";

// ── Public interface ─────────────────────────────────────────────────────────

export interface NcrListProps {
  query: NcrListQuery;
  onQueryChange: (patch: Partial<NcrListQuery>) => void;
  search: string;
  onSearch: (v: string) => void;
  reloadKey: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtDateShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function humanize(s: string | null | undefined): string {
  if (!s) return "—";
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Status / severity pills ─────────────────────────────────────────────────

function StatusPill({ status }: { status: string | null }): React.JSX.Element {
  if (!status) return <span className="text-(--text-muted)">—</span>;
  const map: Record<string, { bg: string; fg: string; border: string; label: string }> = {
    open:               { bg: "#eaf0fb", fg: "#2c5fa8", border: "#b3caf0", label: "Open" },
    in_supplier_action: { bg: "#fdf8e1", fg: "#856404", border: "#f0d97a", label: "In Supplier Action" },
    closed:             { bg: "#eaf6ed", fg: "#1a7a3c", border: "#b6dbb1", label: "Closed" },
  };
  const s = map[status] ?? { bg: "#f4f4f4", fg: "#6b7280", border: "#d1d5db", label: humanize(status) };
  return (
    <span
      className="inline-block text-[11px] font-semibold px-2 py-0.5 rounded-sm"
      style={{ background: s.bg, color: s.fg, border: `1px solid ${s.border}` }}
    >
      {s.label}
    </span>
  );
}

function SeverityPill({ severity }: { severity: string | null }): React.JSX.Element {
  if (!severity) return <span className="text-(--text-muted)">—</span>;
  const map: Record<string, { bg: string; fg: string; border: string }> = {
    critical: { bg: "#fdf3f1", fg: "#b1361e", border: "#f0c7be" },
    major:    { bg: "#fdf8e1", fg: "#856404", border: "#f0d97a" },
    minor:    { bg: "#eaf0fb", fg: "#2c5fa8", border: "#b3caf0" },
  };
  const s = map[severity] ?? { bg: "#f4f4f4", fg: "#6b7280", border: "#d1d5db" };
  return (
    <span
      className="inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded-sm uppercase tracking-wide"
      style={{ background: s.bg, color: s.fg, border: `1px solid ${s.border}` }}
    >
      {severity}
    </span>
  );
}

function FoodSafetyBadge(): React.JSX.Element {
  return (
    <span className="inline-block text-[10px] font-bold px-1.5 py-0.5 rounded-sm bg-[#fdf3f1] text-[#b1361e] border border-[#f0c7be] uppercase tracking-wide">
      Food Safety
    </span>
  );
}

// ── Main export ──────────────────────────────────────────────────────────────

export function NcrList(props: NcrListProps): React.JSX.Element {
  const { query, onQueryChange, search, onSearch, reloadKey } = props;
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<NcrListResponse | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  // Stable fetch fingerprint (sorted, blank-stripped).
  const queryFp = JSON.stringify(
    Object.entries(query)
      .sort(([a], [b]) => a.localeCompare(b))
      .filter(([, v]) => v !== "" && v != null),
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const controller = new AbortController();
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const resp = await listNcrs(query, controller.signal);
        if (controller.signal.aborted) return;
        setData(resp);
      } catch (e) {
        if (controller.signal.aborted) return;
        if (e instanceof Error && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Failed to load NCRs");
        setData(null);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
    // queryFp + reloadKey are stable fingerprints
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryFp, reloadKey]);

  function openDetail(id: number) {
    router.push(`/modules/qc/ncr/${id}`);
  }

  const rows = data?.items ?? [];

  return (
    <div>
      {/* Header actions */}
      <div className="flex justify-end mb-3">
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="h-8 px-3 text-[12px] rounded-[2px] bg-(--aws-navy) text-white hover:bg-[var(--aws-navy-hover,#0d2535)] flex items-center gap-1.5"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
          Raise NCR
        </button>
      </div>

      {/* Status pills */}
      <StatusPills status={query.status ?? ""} onStatus={(s) => onQueryChange({ status: s, page: 1 })} />

      {/* Toolbar (search) */}
      <div className="bg-white border border-(--aws-border) rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] mb-4 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[220px]">
            <svg
              viewBox="0 0 24 24"
              className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-(--text-muted)"
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
              placeholder="Search NCR no, product, supplier…"
              className="w-full h-8 pl-7 pr-2 text-[13px] rounded-[2px] bg-white border border-(--aws-border-strong) outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
            />
          </div>
        </div>
      </div>

      {/* Desktop table */}
      <div className="hidden md:block bg-white border border-(--aws-border) rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[13px] border-collapse">
            <thead className="bg-(--surface-subtle) text-(--text-primary)">
              <tr className="border-b border-(--aws-border)">
                <Th>NCR No</Th>
                <Th>Product</Th>
                <Th>Supplier</Th>
                <Th>Status</Th>
                <Th>Severity</Th>
                <Th>Disposition</Th>
                <Th width={70}>Params</Th>
                <Th>Documented</Th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-10 text-center text-(--text-secondary)">
                    <span className="inline-flex items-center gap-2">
                      <span className="inline-block w-4 h-4 border-2 border-(--aws-border-strong) border-t-(--aws-orange) rounded-full animate-spin" />
                      Loading NCRs…
                    </span>
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-(--aws-error) text-[13px]">{error}</td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-12 text-center text-(--text-secondary)">
                    <p className="font-semibold text-[14px] mb-1">No NCRs</p>
                    <p className="text-[12px]">No non-conformance reports match your current filters.</p>
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <NcrTableRow key={row.ncr_id} row={row} onOpen={openDetail} />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden space-y-2">
        {loading && rows.length === 0 ? (
          <div className="bg-white border border-(--aws-border) rounded-md p-8 text-center text-(--text-secondary)">
            <span className="inline-flex items-center gap-2 text-[13px]">
              <span className="inline-block w-4 h-4 border-2 border-(--aws-border-strong) border-t-(--aws-orange) rounded-full animate-spin" />
              Loading NCRs…
            </span>
          </div>
        ) : error ? (
          <div className="bg-white border border-(--aws-border) rounded-md p-6 text-center text-(--aws-error) text-[13px]">{error}</div>
        ) : rows.length === 0 ? (
          <div className="bg-white border border-(--aws-border) rounded-md p-8 text-center text-(--text-secondary)">
            <p className="font-semibold text-[14px] mb-1">No NCRs</p>
            <p className="text-[12px]">No non-conformance reports match your current filters.</p>
          </div>
        ) : (
          rows.map((row) => (
            <NcrMobileCard key={row.ncr_id} row={row} onOpen={openDetail} />
          ))
        )}
      </div>

      {/* Pagination */}
      {data && data.total > 0 && data.total_pages > 1 ? (
        <NcrPagination
          page={data.page}
          totalPages={data.total_pages}
          total={data.total}
          pageSize={data.page_size}
          onPage={(p) => onQueryChange({ page: p })}
          loading={loading}
        />
      ) : null}

      {/* Create modal */}
      {createOpen ? (
        <CreateNcrModal
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => { setCreateOpen(false); router.push(`/modules/qc/ncr/${id}`); }}
        />
      ) : null}
    </div>
  );
}

// ── Status Pills ─────────────────────────────────────────────────────────────

const STATUS_PILLS: { value: string; label: string }[] = [
  { value: "", label: "All" },
  { value: "open", label: "Open" },
  { value: "in_supplier_action", label: "In Supplier Action" },
  { value: "closed", label: "Closed" },
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
              ? "bg-(--aws-navy) text-white border-(--aws-navy)"
              : "bg-white text-(--text-primary) border-(--aws-border-strong) hover:border-(--aws-navy)",
          ].join(" ")}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

// ── Table Th ─────────────────────────────────────────────────────────────────

function Th({ children, width }: { children: React.ReactNode; width?: number }) {
  return (
    <th
      style={width ? { width } : undefined}
      className="px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-(--text-secondary) whitespace-nowrap"
    >
      {children}
    </th>
  );
}

// ── Desktop Table Row ────────────────────────────────────────────────────────

function NcrTableRow({ row, onOpen }: { row: NcrListItem; onOpen: (id: number) => void }) {
  const product = row.product_description ?? "—";
  const supplier = row.supplier_name ?? (row.supplier_id != null ? `#${row.supplier_id}` : "—");

  return (
    <tr
      className="border-b border-(--aws-border) hover:bg-(--surface-subtle) cursor-pointer"
      onClick={() => onOpen(row.ncr_id)}
    >
      {/* NCR No */}
      <td className="px-3 py-2 whitespace-nowrap">
        <span className="font-mono text-[12px] text-(--aws-link)">
          {row.ncr_no ?? `#${row.ncr_id}`}
        </span>
        {row.transaction_no ? (
          <div className="text-[11px] text-(--text-muted) font-mono">{row.transaction_no}</div>
        ) : null}
      </td>
      {/* Product */}
      <td className="px-3 py-2 max-w-[200px]">
        <span className="block truncate" title={product}>{product}</span>
      </td>
      {/* Supplier */}
      <td className="px-3 py-2 max-w-[160px]">
        <span className="block truncate" title={supplier}>{supplier}</span>
      </td>
      {/* Status */}
      <td className="px-3 py-2"><StatusPill status={row.status} /></td>
      {/* Severity */}
      <td className="px-3 py-2"><SeverityPill severity={row.severity_rollup} /></td>
      {/* Disposition */}
      <td className="px-3 py-2 whitespace-nowrap text-[12px]">
        {row.disposition ? humanize(row.disposition) : "—"}
        {row.food_safety_flag ? <span className="ml-1.5 align-middle"><FoodSafetyBadge /></span> : null}
      </td>
      {/* Params */}
      <td className="px-3 py-2 text-[12px]">{row.param_count}</td>
      {/* Documented */}
      <td className="px-3 py-2 whitespace-nowrap text-[12px] text-(--text-secondary)">
        {fmtDateShort(row.documented_date ?? row.created_at)}
      </td>
    </tr>
  );
}

// ── Mobile Card ──────────────────────────────────────────────────────────────

function NcrMobileCard({ row, onOpen }: { row: NcrListItem; onOpen: (id: number) => void }) {
  const product = row.product_description ?? "—";
  const supplier = row.supplier_name ?? (row.supplier_id != null ? `#${row.supplier_id}` : "—");

  return (
    <div
      className="bg-white border border-(--aws-border) rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] overflow-hidden p-3"
      onClick={() => onOpen(row.ncr_id)}
    >
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        <span className="font-mono text-[12px] font-semibold text-(--aws-link)">
          {row.ncr_no ?? `#${row.ncr_id}`}
        </span>
        <StatusPill status={row.status} />
        <SeverityPill severity={row.severity_rollup} />
        {row.food_safety_flag ? <FoodSafetyBadge /> : null}
      </div>
      <p className="text-[13px] text-(--text-primary) truncate" title={product}>{product}</p>
      <div className="mt-1 text-[11px] text-(--text-muted) flex flex-wrap gap-x-3 gap-y-0.5">
        <span className="truncate max-w-[60%]">Supplier: {supplier}</span>
        <span>Params: {row.param_count}</span>
        {row.disposition ? <span>{humanize(row.disposition)}</span> : null}
        <span>{fmtDateShort(row.documented_date ?? row.created_at)}</span>
      </div>
    </div>
  );
}

// ── Pagination ───────────────────────────────────────────────────────────────

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
          ? "bg-(--aws-navy) text-white border-(--aws-navy)"
          : "bg-white text-(--text-primary) border-(--aws-border-strong) hover:border-(--aws-navy)",
        disabled ? "opacity-50 cursor-not-allowed" : "",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

function NcrPagination({
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
      <span className="text-[12px] text-(--text-secondary)">
        Showing {start}–{end} of {total} NCR{total === 1 ? "" : "s"}
      </span>
      <div className="flex items-center gap-1">
        <PageBtn p={page - 1} label="‹" disabled={page <= 1} onPage={onPage} loading={loading} />
        {from > 1 ? <PageBtn p={1} label={1} onPage={onPage} loading={loading} /> : null}
        {from > 2 ? <span className="px-1 text-(--text-muted)">…</span> : null}
        {pages.map((p) => (
          <PageBtn key={p} p={p} label={p} active={p === page} onPage={onPage} loading={loading} />
        ))}
        {to < totalPages - 1 ? <span className="px-1 text-(--text-muted)">…</span> : null}
        {to < totalPages ? (
          <PageBtn p={totalPages} label={totalPages} onPage={onPage} loading={loading} />
        ) : null}
        <PageBtn p={page + 1} label="›" disabled={page >= totalPages} onPage={onPage} loading={loading} />
      </div>
    </div>
  );
}
