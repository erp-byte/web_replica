"use client";

// Sample requisition queue (checklist B4). Hydration-safe: state seeds from a
// tab-scoped sessionStorage cache via lazy-init, but the first render emits a
// cache-free shell behind the `mounted` gate so SSR and the client's first
// paint match (see lib/sample-list-cache.ts and the JC list page this mirrors).

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { useRequireAuth, useUserInitial, useMe, useIsAdmin } from "@/lib/user";
import { sampleCaps } from "@/lib/sample-roles";
import { listRequisitions, WAREHOUSES, type Requisition } from "@/lib/sample";
import { loadSampleListCache, saveSampleListCache } from "@/lib/sample-list-cache";
import { STATUS_STYLES, TYPE_LABEL, StatusPill } from "./_shared";

const STATUS_OPTIONS = Object.keys(STATUS_STYLES);
const TYPE_OPTIONS = Object.keys(TYPE_LABEL);

// Module-level so the component isn't re-created on every render (React 19
// react-hooks/static-components). Header chrome shared by the shell + main view.
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
          <button onClick={() => router.push("/modules")} className="hover:underline">Modules</button>
          <span>/</span>
          <span className="text-white">Sample</span>
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

// Compact billing summary for a list row (NPD/TRIAL): return type + paid amount.
// "—" when nothing is set (e.g. non-NPD requisitions).
function billingSummary(r: Requisition): string {
  const rt = r.returnable ? "Returnable" : r.non_returnable ? "Non-returnable" : "";
  const paid = r.paid
    ? `Paid ${Number(r.amount ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "";
  return [rt, paid].filter(Boolean).join(" · ") || "—";
}

export default function SampleQueuePage() {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);
  const initial = useUserInitial();
  const me = useMe();
  const isAdmin = useIsAdmin();
  const caps = useMemo(() => sampleCaps(me), [me]);

  const [cache] = useState(() => loadSampleListCache());
  const [status, setStatus] = useState(() => cache?.status ?? "");
  const [sampleType, setSampleType] = useState(() => cache?.sampleType ?? "");
  const [warehouse, setWarehouse] = useState(() => cache?.warehouse ?? "");
  const [rows, setRows] = useState<Requisition[]>(() => cache?.rows ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [mounted, setMounted] = useState(false);
  useEffect(() => { queueMicrotask(() => setMounted(true)); }, []);

  // Seed-then-refresh: cached rows paint instantly, the fetch keeps them fresh.
  const firstRun = useRef(true);
  useEffect(() => {
    if (!authed) return;
    // Admin-gate (R8): non-admins shouldn't even hit the list endpoint —
    // they'd 401 anyway, and we don't want to leak filter state into the
    // cache for them. The denial banner below covers the UI.
    if (!isAdmin) return;
    let cancelled = false;
    (async () => {
      // On the very first run, if we hydrated rows from cache, skip the
      // spinner so the cached list stays visible while we refresh silently.
      if (!(firstRun.current && (cache?.rows?.length ?? 0) > 0)) setLoading(true);
      firstRun.current = false;
      setError(null);
      try {
        const data = await listRequisitions({ status, sample_type: sampleType, warehouse, limit: 200 });
        if (cancelled) return;
        setRows(data);
        saveSampleListCache({ status, sampleType, warehouse, rows: data, scrollY: 0 });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load requisitions");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [authed, isAdmin, status, sampleType, warehouse, cache]);

  function openRow(id: number) {
    router.push(`/modules/sample/${id}`);
  }

  if (!mounted) {
    return (
      <Shell initial={initial} router={router}>
        <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[var(--text-secondary)]">
          <span className="inline-flex items-center gap-2 text-[13px]">
            <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
            Loading sample requisitions…
          </span>
        </div>
      </Shell>
    );
  }

  if (!isAdmin) {
    return (
      <Shell initial={initial} router={router}>
        <Breadcrumbs items={[{ label: "Modules", href: "/modules" }, { label: "Sample" }]} className="mb-3" />
        <h1 className="text-[22px] leading-7 font-semibold text-[var(--text-primary)] mb-3">Sample Requisitions</h1>
        <section className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-[13px] text-[var(--text-secondary)]">
          You don&rsquo;t have access to the Sample module. Ask an administrator to grant you access, or switch to a different account.
        </section>
      </Shell>
    );
  }

  return (
    <Shell initial={initial} router={router}>
      <Breadcrumbs items={[{ label: "Modules", href: "/modules" }, { label: "Sample" }]} className="mb-3" />
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="min-w-0">
          <h1 className="text-[22px] leading-7 font-semibold text-[var(--text-primary)]">Sample Requisitions</h1>
          <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">{rows.length} shown</p>
        </div>
        <div className="flex-1" />
        <button
          onClick={() => router.push("/modules/sample/rm-issue-forms")}
          className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] font-medium hover:bg-[var(--surface-subtle)]"
        >RM forms</button>
        <button
          onClick={() => router.push("/modules/npd-development")}
          className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] font-medium hover:bg-[var(--surface-subtle)]"
        >NPD Development</button>
        {caps.canRequest && (
          <button
            onClick={() => router.push("/modules/sample/npd/new")}
            className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] font-medium hover:bg-[var(--surface-subtle)]"
          >+ New NPD request</button>
        )}
        {caps.canRequest && (
          <button
            onClick={() => router.push("/modules/sample/new")}
            className="h-9 px-4 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] font-medium hover:bg-[var(--aws-orange-hover)]"
          >+ New requisition</button>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4">
        <select className="form-input !w-auto" value={sampleType} onChange={(e) => setSampleType(e.target.value)} aria-label="Sample type">
          <option value="">All types</option>
          {TYPE_OPTIONS.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select>
        <select className="form-input !w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
        </select>
        <select className="form-input !w-auto" value={warehouse} onChange={(e) => setWarehouse(e.target.value)} aria-label="Warehouse">
          <option value="">All warehouses</option>
          {WAREHOUSES.map((w) => <option key={w} value={w}>{w}</option>)}
        </select>
        {loading && <span className="self-center text-[12px] text-[var(--text-muted)]">Refreshing…</span>}
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-[#f0c7be] bg-[#fdf3f1] px-3 py-2 text-[13px] text-[#b1361e]">{error}</div>
      )}

      {rows.length === 0 && !loading ? (
        <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[13px] text-[var(--text-secondary)]">
          No requisitions match these filters.
        </div>
      ) : (
        <>
          {/* Mobile: cards. md+: full-field table. Long values truncate with a
              hover tooltip (title) showing the full text. */}
          <div className="grid grid-cols-1 gap-2 md:hidden">
            {rows.map((r) => (
              <button key={r.id} onClick={() => openRow(r.id)}
                className="text-left bg-white border border-[var(--aws-border)] rounded-md p-3 hover:border-[var(--aws-orange)]">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-[13px] text-[var(--text-primary)] tabular-nums truncate" title={String(r.request_id ?? "")}>{r.request_id ?? "—"}</span>
                  <StatusPill status={r.status} />
                </div>
                <div className="mt-1 text-[12px] text-[var(--text-secondary)] flex flex-wrap gap-x-3 gap-y-0.5">
                  <span>{TYPE_LABEL[r.sample_type] ?? r.sample_type}</span>
                  <span>{r.warehouse}</span>
                  {r.quantity != null && <span>Qty {r.quantity}</span>}
                  {billingSummary(r) !== "—" && <span>{billingSummary(r)}</span>}
                  <span>{(r.created_at ?? "").slice(0, 10)}</span>
                </div>
                {r.npd_target_name && (
                  <div className="mt-1 text-[12px] text-[var(--text-secondary)] truncate" title={r.npd_target_name}>Target: {r.npd_target_name}</div>
                )}
              </button>
            ))}
          </div>

          <div className="hidden md:block bg-white border border-[var(--aws-border)] rounded-md overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-[var(--surface-subtle)] text-left text-[12px] text-[var(--text-secondary)]">
                  <th className="px-3 py-2 font-semibold">Request ID</th>
                  <th className="px-3 py-2 font-semibold">Type</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                  <th className="px-3 py-2 font-semibold">Warehouse</th>
                  <th className="px-3 py-2 font-semibold">Target article</th>
                  <th className="px-3 py-2 font-semibold text-right">Qty</th>
                  <th className="px-3 py-2 font-semibold">Purpose</th>
                  <th className="px-3 py-2 font-semibold">Team</th>
                  <th className="px-3 py-2 font-semibold">Billing</th>
                  <th className="px-3 py-2 font-semibold">Created</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} onClick={() => openRow(r.id)}
                    className="border-t border-[var(--surface-divider)] hover:bg-[var(--surface-subtle)] cursor-pointer">
                    <td className="px-3 py-2 font-medium text-[var(--text-primary)] tabular-nums">{r.request_id ?? "—"}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{TYPE_LABEL[r.sample_type] ?? r.sample_type}</td>
                    <td className="px-3 py-2"><StatusPill status={r.status} /></td>
                    <td className="px-3 py-2">{r.warehouse}</td>
                    <td className="px-3 py-2 max-w-[200px] truncate" title={r.npd_target_name ?? ""}>{r.npd_target_name ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.quantity ?? "—"}</td>
                    <td className="px-3 py-2 max-w-[160px] truncate" title={r.purpose_tag ?? ""}>{r.purpose_tag ?? "—"}</td>
                    <td className="px-3 py-2 max-w-[160px] truncate" title={r.requestor_team ?? ""}>{r.requestor_team ?? "—"}</td>
                    <td className="px-3 py-2 whitespace-nowrap tabular-nums text-[12px]">{billingSummary(r)}</td>
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
