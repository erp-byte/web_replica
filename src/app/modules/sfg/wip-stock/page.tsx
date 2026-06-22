"use client";

// WIP Stock — on-hand semi-finished stock by SFG#### (design ref §9.5), backed by
// GET /job-cards-v2/sfg-wip-stock (inventory_batch item_type='wip', keyed on the
// 057 sfg_code column). Entity-scoped.

import { useEffect, useRef, useState } from "react";
import { SfgShell, ENTITIES, type Entity } from "../shell";
import { fetchWipStock, type WipStockRow, type Pagination } from "@/lib/sfg";

export default function WipStockPage() {
  const [entity, setEntity] = useState<Entity>("cfpl");
  const [rows, setRows] = useState<WipStockRow[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);
  const reqId = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => { setDebounced(search); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => { setPage(1); }, [entity]);

  useEffect(() => {
    const ctrl = new AbortController();
    const id = ++reqId.current;
    setLoading(true); setError(null);
    fetchWipStock(entity, { search: debounced || undefined, page, page_size: 50 }, ctrl.signal)
      .then((d) => { if (id === reqId.current) { setRows(d.results); setPagination(d.pagination); } })
      .catch((e) => { if (id === reqId.current && e.name !== "AbortError") { setError(e.message); setRows([]); } })
      .finally(() => { if (id === reqId.current) setLoading(false); });
    return () => ctrl.abort();
  }, [entity, debounced, page]);

  const totalKg = rows.reduce((s, r) => s + (r.total_qty_kg || 0), 0);

  return (
    <SfgShell
      title="WIP Stock"
      subtitle="On-hand semi-finished stock by SFG#### — total kg, batches, oldest lot, and floor."
      crumb="WIP Stock"
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex rounded-md border border-[var(--aws-border)] overflow-hidden">
          {ENTITIES.map((e) => (
            <button
              key={e}
              onClick={() => setEntity(e)}
              className={[
                "px-3 h-9 text-[13px] uppercase",
                entity === e ? "bg-[var(--aws-navy)] text-white" : "bg-white text-[var(--text-secondary)] hover:bg-[var(--surface-hover,#fafbfc)]",
              ].join(" ")}
            >{e}</button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search code or name…"
          className="w-full max-w-[320px] h-9 px-3 text-[13px] border border-[var(--aws-border)] rounded-md focus:outline-none focus:border-[var(--aws-navy)]"
        />
        {pagination ? (
          <span className="text-[12px] text-[var(--text-secondary)] whitespace-nowrap">
            {pagination.total} SFG{pagination.total === 1 ? "" : "s"} · {totalKg.toFixed(1)} kg (page)
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
              <th className="px-3 py-2 font-semibold text-right">On Hand (kg)</th>
              <th className="px-3 py-2 font-semibold text-right">Batches</th>
              <th className="px-3 py-2 font-semibold">Oldest Lot</th>
              <th className="px-3 py-2 font-semibold">Floors</th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 ? (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-[var(--text-secondary)]">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-[var(--text-secondary)]">No WIP stock on hand.</td></tr>
            ) : (
              rows.map((r) => (
                <tr key={r.sfg_code} className="border-t border-[var(--aws-border)] hover:bg-[var(--surface-hover,#fafbfc)]">
                  <td className="px-3 py-2 font-mono text-[var(--text-primary)]">{r.sfg_code}</td>
                  <td className="px-3 py-2 text-[var(--text-primary)]">{r.sfg_name ?? "—"}</td>
                  <td className="px-3 py-2 text-right text-[var(--text-primary)]">{r.total_qty_kg.toFixed(3)}</td>
                  <td className="px-3 py-2 text-right text-[var(--text-secondary)]">{r.batch_count}</td>
                  <td className="px-3 py-2 text-[var(--text-secondary)]">{r.oldest_inward ?? "—"}</td>
                  <td className="px-3 py-2 text-[var(--text-secondary)]">{r.floors.length ? r.floors.join(", ") : "—"}</td>
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
