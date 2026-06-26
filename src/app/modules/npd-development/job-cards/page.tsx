"use client";

// NPD development job cards — standalone R&D, decoupled from sample requisitions.
// Lists npd_dev_job_cards; creation and closure (which promotes the trial recipe
// into a live BOM) are their own process, separate from the sample-issuance
// lifecycle. Hydration-safe via a `mounted` gate.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { Breadcrumbs, NPD_DEV_ROOT } from "@/components/Breadcrumbs";
import { useRequireAuth, useUserInitial, useMe } from "@/lib/user";
import { sampleCaps } from "@/lib/sample-roles";
import { listDevJobCards, type DevJobCard } from "@/lib/npd-dev";
import { DEV_JC_STATUS_STYLES, DevJcStatusPill } from "../../sample/_shared";

const STATUS_OPTIONS = Object.keys(DEV_JC_STATUS_STYLES);

function Shell({ initial, router, children }: {
  initial: string;
  router: ReturnType<typeof useRouter>;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-4 sm:px-6 gap-4">
        <BrandMark />
        <span className="text-[#d5dbdb] text-[13px] hidden sm:inline">Console</span>
        <nav className="text-[12px] text-[#d5dbdb] hidden md:flex items-center gap-2 ml-2">
          <button onClick={() => router.push("/modules/npd-development")} className="hover:underline">NPD Development</button>
          <span>/</span>
          <span className="text-white">Job cards</span>
        </nav>
        <div className="flex-1" />
        <button
          onClick={() => router.push("/modules/profile")}
          aria-label="Open profile" title="Profile"
          className="w-8 h-8 rounded-full bg-[var(--aws-orange)] text-white text-[13px] font-bold flex items-center justify-center hover:bg-[var(--aws-orange-hover)]"
        >{initial}</button>
      </header>
      <main className="flex-1 max-w-[1280px] w-full mx-auto px-4 sm:px-6 py-6">{children}</main>
    </div>
  );
}

export default function NpdDevJobCardsPage() {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);
  const initial = useUserInitial();
  const me = useMe();
  const caps = useMemo(() => sampleCaps(me), [me]);

  const [status, setStatus] = useState("");
  const [rows, setRows] = useState<DevJobCard[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [mounted, setMounted] = useState(false);
  useEffect(() => { queueMicrotask(() => setMounted(true)); }, []);

  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await listDevJobCards(status || undefined);
        if (!cancelled) setRows(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load development job cards");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [authed, status]);

  function openRow(id: number) {
    router.push(`/modules/npd-development/job-cards/${id}`);
  }

  if (!mounted) {
    return (
      <Shell initial={initial} router={router}>
        <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[var(--text-secondary)]">
          <span className="inline-flex items-center gap-2 text-[13px]">
            <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
            Loading development job cards…
          </span>
        </div>
      </Shell>
    );
  }

  return (
    <Shell initial={initial} router={router}>
      <Breadcrumbs items={[...NPD_DEV_ROOT, { label: "Job cards", href: "/modules/npd-development/job-cards" }]} className="mb-3" />
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="min-w-0">
          <h1 className="text-[22px] leading-7 font-semibold text-[var(--text-primary)]">NPD development job cards</h1>
          <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">{rows.length} shown · standalone product development</p>
        </div>
        <div className="flex-1" />
        {caps.canNpd && (
          <button
            onClick={() => router.push("/modules/npd-development/job-cards/new")}
            className="h-9 px-4 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] font-medium hover:bg-[var(--aws-orange-hover)]"
          >+ New job card</button>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4">
        <select className="form-input !w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
        </select>
        {loading && <span className="self-center text-[12px] text-[var(--text-muted)]">Refreshing…</span>}
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-[#f0c7be] bg-[#fdf3f1] px-3 py-2 text-[13px] text-[#b1361e]">{error}</div>
      )}

      {rows.length === 0 && !loading ? (
        <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[13px] text-[var(--text-secondary)]">
          No development job cards yet.{caps.canNpd ? " Use “+ New job card” to start one." : ""}
        </div>
      ) : (
        <>
          {/* Mobile cards */}
          <div className="grid grid-cols-1 gap-2 md:hidden">
            {rows.map((r) => (
              <button key={r.id} onClick={() => openRow(r.id)}
                className="text-left bg-white border border-[var(--aws-border)] rounded-md p-3 hover:border-[var(--aws-orange)]">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-[13px] text-[var(--text-primary)] font-mono tabular-nums">{r.id}</span>
                  <DevJcStatusPill status={r.status} />
                </div>
                <div className="mt-0.5 text-[13px] text-[var(--text-primary)] truncate">{r.title}</div>
                {r.fg_sku_name && <div className="text-[12px] text-[var(--text-secondary)] truncate">Target: {r.fg_sku_name}</div>}
                <div className="mt-1 text-[12px] text-[var(--text-secondary)] flex flex-wrap gap-x-3 gap-y-0.5">
                  {r.customer_name && <span>{r.customer_name}</span>}
                  {r.warehouse && <span>{r.warehouse}</span>}
                  {r.target_qty != null && <span>{Number(r.target_qty).toLocaleString("en-IN")} {r.uom ?? "kg"}</span>}
                  <span>{r.line_count ?? 0} line(s)</span>
                  {r.yield_pct != null && <span>{Number(r.yield_pct).toLocaleString("en-IN")}% yield</span>}
                  {r.promoted_bom_id != null && <span>→ BOM #{r.promoted_bom_id}</span>}
                  <span>{(r.created_at ?? "").slice(0, 10)}</span>
                </div>
              </button>
            ))}
          </div>

          {/* Desktop table */}
          <div className="hidden md:block bg-white border border-[var(--aws-border)] rounded-md overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-[var(--surface-subtle)] text-left text-[12px] text-[var(--text-secondary)]">
                  <th className="px-3 py-2 font-semibold">Job card</th>
                  <th className="px-3 py-2 font-semibold">Title</th>
                  <th className="px-3 py-2 font-semibold">Target FG</th>
                  <th className="px-3 py-2 font-semibold">Customer</th>
                  <th className="px-3 py-2 font-semibold">Warehouse</th>
                  <th className="px-3 py-2 font-semibold text-right">Target qty</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                  <th className="px-3 py-2 font-semibold text-right">Yield</th>
                  <th className="px-3 py-2 font-semibold">Promoted BOM</th>
                  <th className="px-3 py-2 font-semibold">Created</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} onClick={() => openRow(r.id)}
                    className="border-t border-[var(--surface-divider)] hover:bg-[var(--surface-subtle)] cursor-pointer">
                    <td className="px-3 py-2 font-medium text-[var(--text-primary)] font-mono tabular-nums whitespace-nowrap">{r.id}</td>
                    <td className="px-3 py-2 max-w-[200px] truncate" title={r.title}>{r.title}</td>
                    <td className="px-3 py-2 max-w-[200px] truncate" title={r.fg_sku_name ?? ""}>{r.fg_sku_name ?? "—"}</td>
                    <td className="px-3 py-2 max-w-[160px] truncate" title={r.customer_name ?? ""}>{r.customer_name ?? "—"}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{r.warehouse ?? "—"}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">{r.target_qty != null ? `${Number(r.target_qty).toLocaleString("en-IN")} ${r.uom ?? "kg"}` : "—"}</td>
                    <td className="px-3 py-2"><DevJcStatusPill status={r.status} /></td>
                    <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">{r.yield_pct != null ? `${Number(r.yield_pct).toLocaleString("en-IN")}%` : "—"}</td>
                    <td className="px-3 py-2 text-[var(--text-secondary)] whitespace-nowrap">{r.promoted_bom_id != null ? `BOM #${r.promoted_bom_id}` : "—"}</td>
                    <td className="px-3 py-2 text-[var(--text-secondary)] whitespace-nowrap">{(r.created_at ?? "").slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Shell>
  );
}
