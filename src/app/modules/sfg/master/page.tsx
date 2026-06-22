"use client";

// SFG Master — the dedicated semi-finished-goods catalogue (design ref §8.1),
// backed by GET /job-cards-v2/sfg-master (the sfg_master view).

import { useEffect, useRef, useState } from "react";
import { SfgShell } from "../shell";
import { fetchSfgMaster, type SfgMasterRow, type Pagination } from "@/lib/sfg";

// Origin chip — distinguishes catalogue SFGs from ones the Phase-9 seam-minting
// synthesised ('SEAM_MINTED' → amber "Minted") vs the original derived-inline
// rows ('DERIVED_INLINE' → neutral "Derived"). null/other render as "—".
function OriginChip({ origin }: { origin: string | null | undefined }) {
  if (!origin) return <span className="text-[var(--text-secondary)]">—</span>;
  if (origin === "SEAM_MINTED") {
    return (
      <span
        title={origin}
        className="text-[10px] font-semibold uppercase tracking-wide text-[#8a6d00] bg-[#fef8e7] border border-[#f0e0a8] rounded px-1.5 py-0.5"
      >
        Minted
      </span>
    );
  }
  if (origin === "DERIVED_INLINE") {
    return (
      <span
        title={origin}
        className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-secondary)] bg-[var(--surface-secondary,#f2f3f3)] border border-[var(--aws-border)] rounded px-1.5 py-0.5"
      >
        Derived
      </span>
    );
  }
  // Unknown origin value — show it raw but compact, with the value as the tooltip.
  return (
    <span
      title={origin}
      className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-secondary)] bg-[var(--surface-secondary,#f2f3f3)] border border-[var(--aws-border)] rounded px-1.5 py-0.5"
    >
      {origin}
    </span>
  );
}

export default function SfgMasterPage() {
  const [rows, setRows] = useState<SfgMasterRow[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);
  const reqId = useRef(0);

  // Debounce the search box (300ms); reset to page 1 on a new query.
  useEffect(() => {
    const t = setTimeout(() => { setDebounced(search); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    const ctrl = new AbortController();
    const id = ++reqId.current;
    setLoading(true); setError(null);
    fetchSfgMaster({ search: debounced || undefined, page, page_size: 50 }, ctrl.signal)
      .then((d) => { if (id === reqId.current) { setRows(d.results); setPagination(d.pagination); } })
      .catch((e) => { if (id === reqId.current && e.name !== "AbortError") setError(e.message); })
      .finally(() => { if (id === reqId.current) setLoading(false); });
    return () => ctrl.abort();
  }, [debounced, page]);

  return (
    <SfgShell
      title="SFG Master"
      subtitle="The semi-finished-goods catalogue — every SFG#### with its recipe family and create-WIP stage."
      crumb="Master"
    >
      <div className="mb-4 flex items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search code or name…"
          className="w-full max-w-[360px] h-9 px-3 text-[13px] border border-[var(--aws-border)] rounded-md focus:outline-none focus:border-[var(--aws-navy)]"
        />
        {pagination ? (
          <span className="text-[12px] text-[var(--text-secondary)] whitespace-nowrap">
            {pagination.total} SFG{pagination.total === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>

      {error ? (
        <div className="text-[13px] text-[var(--aws-red,#d13212)] bg-[#fdf3f1] border border-[#f5c6bd] rounded-md px-3 py-2 mb-3">{error}</div>
      ) : null}

      <div className="bg-white border border-[var(--aws-border)] rounded-md overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="bg-[var(--surface-secondary,#f2f3f3)] text-left text-[var(--text-secondary)]">
              <th className="px-3 py-2 font-semibold">SFG Code</th>
              <th className="px-3 py-2 font-semibold">Name</th>
              <th className="px-3 py-2 font-semibold">Base Recipe</th>
              <th className="px-3 py-2 font-semibold">Create-WIP Op</th>
              <th className="px-3 py-2 font-semibold">Stage</th>
              <th className="px-3 py-2 font-semibold">Origin</th>
              <th className="px-3 py-2 font-semibold">Item Group</th>
              <th className="px-3 py-2 font-semibold text-right"># FGs</th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 ? (
              <tr><td colSpan={8} className="px-3 py-6 text-center text-[var(--text-secondary)]">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={8} className="px-3 py-6 text-center text-[var(--text-secondary)]">No SFG items found.</td></tr>
            ) : (
              rows.map((r) => (
                <tr key={r.sfg_code} className="border-t border-[var(--aws-border)] hover:bg-[var(--surface-hover,#fafbfc)]">
                  <td className="px-3 py-2 font-mono text-[var(--text-primary)]">{r.sfg_code}</td>
                  <td className="px-3 py-2 text-[var(--text-primary)]">{r.sfg_name}</td>
                  <td className="px-3 py-2 text-[var(--text-secondary)]">{r.base_recipe ?? "—"}</td>
                  <td className="px-3 py-2 text-[var(--text-secondary)]">{r.create_wip_operation ?? "—"}</td>
                  <td className="px-3 py-2 text-[var(--text-secondary)]">{r.produced_at_stage ?? "—"}</td>
                  <td className="px-3 py-2"><OriginChip origin={r.sfg_origin} /></td>
                  <td className="px-3 py-2 text-[var(--text-secondary)]">{r.item_group ?? "—"}</td>
                  <td className="px-3 py-2 text-right text-[var(--text-secondary)]">{r.consumed_by_fg_count ?? 0}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {pagination && pagination.total_pages > 1 ? (
        <div className="mt-3 flex items-center justify-end gap-2 text-[12px]">
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="px-3 h-8 border border-[var(--aws-border)] rounded-md disabled:opacity-40 hover:border-[var(--aws-navy)]"
          >Prev</button>
          <span className="text-[var(--text-secondary)]">Page {pagination.page} / {pagination.total_pages}</span>
          <button
            disabled={page >= pagination.total_pages}
            onClick={() => setPage((p) => p + 1)}
            className="px-3 h-8 border border-[var(--aws-border)] rounded-md disabled:opacity-40 hover:border-[var(--aws-navy)]"
          >Next</button>
        </div>
      ) : null}
    </SfgShell>
  );
}
