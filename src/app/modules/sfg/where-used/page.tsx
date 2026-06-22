"use client";

// Where Used — reverse index (design ref §9.2): enter an SFG#### and list every
// finished good that consumes it. Backed by GET /job-cards-v2/sfg-where-used.

import { useState } from "react";
import { SfgShell } from "../shell";
import { fetchWhereUsed, type WhereUsedRow } from "@/lib/sfg";

export default function WhereUsedPage() {
  const [code, setCode] = useState("");
  const [rows, setRows] = useState<WhereUsedRow[] | null>(null);
  const [queried, setQueried] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(e?: React.FormEvent) {
    e?.preventDefault();
    // The submit BUTTON is disabled while loading, but pressing Enter in the
    // input still fires onSubmit — guard so an in-flight lookup can't be
    // superseded by a slower one that resolves last and shows a stale code.
    if (loading) return;
    const c = code.trim();
    if (!c) return;
    setLoading(true); setError(null);
    try {
      const d = await fetchWhereUsed(c);
      setRows(d.consumed_by);
      setQueried(c);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lookup failed");
      setRows(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <SfgShell
      title="Where Used"
      subtitle="Enter an SFG#### code to see every finished good that consumes it, and at which stage."
      crumb="Where Used"
    >
      <form onSubmit={run} className="mb-4 flex items-center gap-2">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="e.g. SFG0001"
          className="w-full max-w-[260px] h-9 px-3 text-[13px] font-mono border border-[var(--aws-border)] rounded-md focus:outline-none focus:border-[var(--aws-navy)]"
        />
        <button
          type="submit"
          disabled={loading || !code.trim()}
          className="h-9 px-4 text-[13px] font-semibold rounded-md bg-[var(--aws-navy)] text-white disabled:opacity-50 hover:bg-[var(--aws-navy-hover,#16212e)]"
        >
          {loading ? "Looking up…" : "Look up"}
        </button>
      </form>

      {error ? (
        <div className="text-[13px] text-[var(--aws-red,#d13212)] bg-[#fdf3f1] border border-[#f5c6bd] rounded-md px-3 py-2 mb-3">{error}</div>
      ) : null}

      {rows !== null ? (
        rows.length === 0 ? (
          <div className="text-[13px] text-[var(--text-secondary)]">
            No finished goods consume <span className="font-mono">{queried}</span>.
          </div>
        ) : (
          <>
            <div className="mb-2 text-[12px] text-[var(--text-secondary)]">
              <span className="font-mono text-[var(--text-primary)]">{queried}</span>
              {rows[0]?.sfg_name ? ` · ${rows[0].sfg_name}` : ""} — consumed by {rows.length} FG{rows.length === 1 ? "" : "s"}
            </div>
            <div className="bg-white border border-[var(--aws-border)] rounded-md overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="bg-[var(--surface-secondary,#f2f3f3)] text-left text-[var(--text-secondary)]">
                    <th className="px-3 py-2 font-semibold">Finished Good</th>
                    <th className="px-3 py-2 font-semibold">Entity</th>
                    <th className="px-3 py-2 font-semibold">Consumed at Step</th>
                    <th className="px-3 py-2 font-semibold">Stage</th>
                    <th className="px-3 py-2 font-semibold text-right">BOM ID</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={`${r.bom_id}-${r.consumed_at_step}-${i}`} className="border-t border-[var(--aws-border)] hover:bg-[var(--surface-hover,#fafbfc)]">
                      <td className="px-3 py-2 text-[var(--text-primary)]">{r.fg_sku_name}</td>
                      <td className="px-3 py-2 text-[var(--text-secondary)] uppercase">{r.entity ?? "—"}</td>
                      <td className="px-3 py-2 text-[var(--text-secondary)]">{r.consumed_at_step ?? "—"}</td>
                      <td className="px-3 py-2 text-[var(--text-secondary)]">{r.consumed_at_stage ?? "—"}</td>
                      <td className="px-3 py-2 text-right text-[var(--text-secondary)]">{r.bom_id}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )
      ) : (
        <div className="text-[13px] text-[var(--text-secondary)]">Enter an SFG code above to search.</div>
      )}
    </SfgShell>
  );
}
