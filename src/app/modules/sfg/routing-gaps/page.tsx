"use client";

// Routing Gaps — SFG reconciliation queue. Production reviews unrouted FG
// articles grouped by product family, tweaks the suggested Process Category per
// row, and applies (which routes them). Backed by GET/POST /production/routing-gaps
// (built in parallel — every fetch is defensive: a 404/error degrades to a quiet
// "not available yet" state, never a crash).

import { useCallback, useEffect, useMemo, useState } from "react";
import { SfgShell } from "../shell";
import { apiFetch, readApiErrorMessage } from "@/lib/auth";
import {
  fetchRoutingGaps,
  applyRoutingGaps,
  ROUTING_GAPS_WORKSHEET_PATH,
  type RoutingGapsResponse,
  type RoutingGapApplyResult,
} from "@/lib/sfg";

export default function RoutingGapsPage() {
  const [data, setData] = useState<RoutingGapsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  // `unavailable` = endpoint not live yet (404/network). We keep this distinct
  // from a hard error so the screen stays calm while the backend lands.
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-article edited Process Category, keyed by article. Seeded from the
  // suggested value on each load; transform-family blanks stay empty.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const [applying, setApplying] = useState(false);
  const [results, setResults] = useState<RoutingGapApplyResult[] | null>(null);
  const [applySummary, setApplySummary] = useState<{ applied: number; skipped: number } | null>(null);
  const [downloading, setDownloading] = useState(false);

  const load = useCallback((signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    setUnavailable(false);
    fetchRoutingGaps(signal)
      .then((d) => {
        if (signal?.aborted) return;
        const safe: RoutingGapsResponse = {
          total: d?.total ?? 0,
          families: Array.isArray(d?.families) ? d.families : [],
        };
        setData(safe);
        // Seed the editable inputs from each article's suggestion.
        const seed: Record<string, string> = {};
        for (const fam of safe.families) {
          for (const art of fam.articles ?? []) {
            seed[art.article] = art.suggested_process_category ?? "";
          }
        }
        setEdits(seed);
      })
      .catch((e: unknown) => {
        if (signal?.aborted || (e as Error)?.name === "AbortError") return;
        const msg = e instanceof Error ? e.message : String(e);
        // Treat "not found"/network as the quiet not-available state.
        if (/404|not found|failed to fetch|networkerror/i.test(msg)) {
          setUnavailable(true);
          setData({ total: 0, families: [] });
        } else {
          setError(msg);
        }
      })
      .finally(() => {
        if (!signal?.aborted) setLoading(false);
      });
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const families = data?.families ?? [];

  // Articles with a non-empty (trimmed) Process Category — only these get POSTed.
  const pendingAssignments = useMemo(() => {
    const out: { article: string; process_category: string }[] = [];
    for (const fam of families) {
      for (const art of fam.articles ?? []) {
        const pc = (edits[art.article] ?? "").trim();
        if (pc) out.push({ article: art.article, process_category: pc });
      }
    }
    return out;
  }, [families, edits]);

  const resultByArticle = useMemo(() => {
    const m = new Map<string, RoutingGapApplyResult>();
    for (const r of results ?? []) m.set(r.article, r);
    return m;
  }, [results]);

  function setEdit(article: string, value: string) {
    setEdits((prev) => ({ ...prev, [article]: value }));
  }

  function toggleFamily(family: string) {
    setCollapsed((prev) => ({ ...prev, [family]: !prev[family] }));
  }

  async function apply(assignments: { article: string; process_category: string }[]) {
    if (assignments.length === 0 || applying) return;
    setApplying(true);
    setError(null);
    try {
      const resp = await applyRoutingGaps(assignments, null);
      setResults(Array.isArray(resp?.results) ? resp.results : []);
      setApplySummary({ applied: resp?.applied ?? 0, skipped: resp?.skipped ?? 0 });
      // Refetch so routed articles drop out of the queue.
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  }

  function applyFamily(family: string) {
    const fam = families.find((f) => f.family === family);
    if (!fam) return;
    const assignments: { article: string; process_category: string }[] = [];
    for (const art of fam.articles ?? []) {
      const pc = (edits[art.article] ?? "").trim();
      if (pc) assignments.push({ article: art.article, process_category: pc });
    }
    void apply(assignments);
  }

  async function downloadWorksheet() {
    if (downloading) return;
    setDownloading(true);
    setError(null);
    try {
      const res = await apiFetch(ROUTING_GAPS_WORKSHEET_PATH);
      if (!res.ok) {
        setError(await readApiErrorMessage(res, "Could not download the worksheet CSV"));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "routing-gaps-worksheet.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <SfgShell
      title="Routing Gaps"
      subtitle="Reconciliation queue — review the suggested Process Category for each unrouted FG article, tweak as needed, and apply to route them."
      crumb="Routing Gaps"
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          onClick={downloadWorksheet}
          disabled={downloading}
          className="px-3 h-9 text-[13px] border border-[var(--aws-border)] rounded-md hover:border-[var(--aws-navy)] disabled:opacity-40"
        >
          {downloading ? "Downloading…" : "Download worksheet (CSV)"}
        </button>
        <button
          onClick={() => apply(pendingAssignments)}
          disabled={applying || pendingAssignments.length === 0}
          className="px-3 h-9 text-[13px] font-semibold rounded-md bg-[var(--aws-orange)] text-white hover:bg-[var(--aws-orange-hover)] disabled:opacity-40"
        >
          {applying ? "Applying…" : `Apply assignments (${pendingAssignments.length})`}
        </button>
        {data ? (
          <span className="text-[12px] text-[var(--text-secondary)] whitespace-nowrap">
            {data.total} unrouted article{data.total === 1 ? "" : "s"} · {families.length} famil
            {families.length === 1 ? "y" : "ies"}
          </span>
        ) : null}
        <button
          onClick={() => load()}
          disabled={loading}
          className="ml-auto px-3 h-9 text-[13px] border border-[var(--aws-border)] rounded-md hover:border-[var(--aws-navy)] disabled:opacity-40"
        >
          Refresh
        </button>
      </div>

      {error ? (
        <div className="text-[13px] text-[var(--aws-red,#d13212)] bg-[#fdf3f1] border border-[#f5c6bd] rounded-md px-3 py-2 mb-3">
          {error}
        </div>
      ) : null}

      {applySummary ? (
        <div className="text-[13px] text-[var(--text-primary)] bg-[#f0f7f1] border border-[#c5e0c9] rounded-md px-3 py-2 mb-3">
          Applied {applySummary.applied} · skipped {applySummary.skipped}.{" "}
          {results && results.some((r) => /error|fail/i.test(r.status)) ? (
            <span className="text-[var(--aws-red,#d13212)]">Some rows reported errors — see the status column below.</span>
          ) : null}
        </div>
      ) : null}

      {loading && families.length === 0 ? (
        <div className="bg-white border border-[var(--aws-border)] rounded-md px-3 py-6 text-center text-[13px] text-[var(--text-secondary)]">
          Loading…
        </div>
      ) : unavailable ? (
        <div className="bg-white border border-[var(--aws-border)] rounded-md px-3 py-8 text-center text-[13px] text-[var(--text-secondary)]">
          Routing-gaps reporting is not available yet. Once the endpoint is live, unrouted articles will appear here grouped by product family.
        </div>
      ) : families.length === 0 ? (
        <div className="bg-white border border-[var(--aws-border)] rounded-md px-3 py-8 text-center text-[13px] text-[var(--text-secondary)]">
          No routing gaps — every FG article is routed.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {families.map((fam) => {
            const isCollapsed = !!collapsed[fam.family];
            const arts = fam.articles ?? [];
            const famPending = arts.filter((a) => (edits[a.article] ?? "").trim()).length;
            return (
              <div key={fam.family} className="bg-white border border-[var(--aws-border)] rounded-md overflow-hidden">
                <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-[var(--surface-secondary,#f2f3f3)]">
                  <button
                    onClick={() => toggleFamily(fam.family)}
                    className="text-[13px] font-semibold text-[var(--text-primary)] flex items-center gap-2 hover:underline"
                    aria-expanded={!isCollapsed}
                  >
                    <span className="inline-block w-3 text-[var(--text-secondary)]">{isCollapsed ? "▸" : "▾"}</span>
                    {fam.family || "(unnamed family)"}
                  </button>
                  <span className="text-[11px] text-[var(--text-secondary)]">
                    {fam.count} article{fam.count === 1 ? "" : "s"}
                  </span>
                  {fam.needs_review ? (
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-[#8a6d00] bg-[#fef8e7] border border-[#f0e0a8] rounded px-1.5 py-0.5">
                      Needs review
                    </span>
                  ) : null}
                  {fam.suggested_process_category ? (
                    <span className="text-[11px] text-[var(--text-secondary)] font-mono">
                      → {fam.suggested_process_category}
                    </span>
                  ) : null}
                  <button
                    onClick={() => applyFamily(fam.family)}
                    disabled={applying || famPending === 0}
                    className="ml-auto px-2.5 h-7 text-[12px] border border-[var(--aws-border)] rounded-md hover:border-[var(--aws-navy)] disabled:opacity-40"
                  >
                    Apply all in family ({famPending})
                  </button>
                </div>

                {isCollapsed ? null : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-[12px]">
                      <thead>
                        <tr className="text-left text-[var(--text-secondary)] border-t border-[var(--aws-border)]">
                          <th className="px-3 py-2 font-semibold">Article</th>
                          <th className="px-3 py-2 font-semibold">In all_sku</th>
                          <th className="px-3 py-2 font-semibold">Current</th>
                          <th className="px-3 py-2 font-semibold">Process Category</th>
                          <th className="px-3 py-2 font-semibold">Result</th>
                        </tr>
                      </thead>
                      <tbody>
                        {arts.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="px-3 py-4 text-center text-[var(--text-secondary)]">
                              No articles in this family.
                            </td>
                          </tr>
                        ) : (
                          arts.map((art) => {
                            const r = resultByArticle.get(art.article);
                            const isErr = r ? /error|fail/i.test(r.status) : false;
                            const isSkip = r ? /skip/i.test(r.status) : false;
                            return (
                              <tr
                                key={art.article}
                                className="border-t border-[var(--aws-border)] hover:bg-[var(--surface-hover,#fafbfc)]"
                              >
                                <td className="px-3 py-2 font-mono text-[var(--text-primary)]">{art.article}</td>
                                <td className="px-3 py-2">
                                  {art.in_all_sku ? (
                                    <span className="text-[#1a7f37]" title="Present in all_sku">✓</span>
                                  ) : (
                                    <span className="text-[var(--text-secondary)]" title="Not in all_sku">—</span>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-[var(--text-secondary)] font-mono">
                                  {art.current_process_category ?? "—"}
                                </td>
                                <td className="px-3 py-2">
                                  <input
                                    value={edits[art.article] ?? ""}
                                    onChange={(e) => setEdit(art.article, e.target.value)}
                                    placeholder="Set process category…"
                                    className="w-full max-w-[280px] h-8 px-2 text-[12px] font-mono border border-[var(--aws-border)] rounded-md focus:outline-none focus:border-[var(--aws-navy)]"
                                  />
                                </td>
                                <td className="px-3 py-2">
                                  {r ? (
                                    <span
                                      className={
                                        isErr
                                          ? "text-[var(--aws-red,#d13212)]"
                                          : isSkip
                                            ? "text-[var(--text-secondary)]"
                                            : "text-[#1a7f37]"
                                      }
                                      title={r.detail}
                                    >
                                      {r.status}
                                      {r.bom_id != null ? ` · BOM ${r.bom_id}` : ""}
                                    </span>
                                  ) : (
                                    <span className="text-[var(--text-secondary)]">—</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </SfgShell>
  );
}
