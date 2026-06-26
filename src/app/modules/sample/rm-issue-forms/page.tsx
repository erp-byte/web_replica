"use client";

// RM Issue / Collection Forms (Document 015) — NPD plan §10. NPD authors raise
// indents; the Store approves + issues (which fires the 265 Goods Issue). List
// view; hydration-safe via a `mounted` gate.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { Breadcrumbs, SAMPLE_ROOT } from "@/components/Breadcrumbs";
import { useRequireAuth, useUserInitial, useMe } from "@/lib/user";
import { sampleCaps } from "@/lib/sample-roles";
import { listRmForms, type RmForm } from "@/lib/rm-issue-form";
import { RM_FORM_STATUS_STYLES, RmFormStatusPill } from "../_shared";

const STATUS_OPTIONS = Object.keys(RM_FORM_STATUS_STYLES);

function Shell({ initial, router, children }: {
  initial: string; router: ReturnType<typeof useRouter>; children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-4 sm:px-6 gap-4">
        <BrandMark />
        <span className="text-[#d5dbdb] text-[13px] hidden sm:inline">Console</span>
        <nav className="text-[12px] text-[#d5dbdb] hidden md:flex items-center gap-2 ml-2">
          <button onClick={() => router.push("/modules/sample")} className="hover:underline">Sample</button>
          <span>/</span><span className="text-white">RM Issue Forms</span>
        </nav>
        <div className="flex-1" />
        <button onClick={() => router.push("/modules/profile")} aria-label="Open profile" title="Profile"
          className="w-8 h-8 rounded-full bg-[var(--aws-orange)] text-white text-[13px] font-bold flex items-center justify-center hover:bg-[var(--aws-orange-hover)]">{initial}</button>
      </header>
      <main className="flex-1 max-w-[1280px] w-full mx-auto px-4 sm:px-6 py-6">{children}</main>
    </div>
  );
}

export default function RmIssueFormsPage() {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);
  const initial = useUserInitial();
  const me = useMe();
  const caps = useMemo(() => sampleCaps(me), [me]);

  const [status, setStatus] = useState("");
  const [rows, setRows] = useState<RmForm[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { queueMicrotask(() => setMounted(true)); }, []);

  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    (async () => {
      setLoading(true); setError(null);
      try {
        const data = await listRmForms(status || undefined);
        if (!cancelled) setRows(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load forms");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [authed, status]);

  if (!mounted) {
    return (
      <Shell initial={initial} router={router}>
        <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[var(--text-secondary)]">
          <span className="inline-flex items-center gap-2 text-[13px]">
            <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
            Loading RM issue forms…
          </span>
        </div>
      </Shell>
    );
  }

  return (
    <Shell initial={initial} router={router}>
      <Breadcrumbs items={[...SAMPLE_ROOT, { label: "RM forms" }]} className="mb-3" />
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="min-w-0">
          <h1 className="text-[22px] leading-7 font-semibold text-[var(--text-primary)]">RM Issue Forms</h1>
          <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">{rows.length} shown · Document 015</p>
        </div>
        <div className="flex-1" />
        {caps.canNpd && (
          <button onClick={() => router.push("/modules/sample/rm-issue-forms/new")}
            className="h-9 px-4 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] font-medium hover:bg-[var(--aws-orange-hover)]">+ Raise indent</button>
        )}
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <select className="form-input !w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        {loading && <span className="self-center text-[12px] text-[var(--text-muted)]">Refreshing…</span>}
      </div>

      {error && <div className="mb-4 rounded-md border border-[#f0c7be] bg-[#fdf3f1] px-3 py-2 text-[13px] text-[#b1361e]">{error}</div>}

      {rows.length === 0 && !loading ? (
        <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[13px] text-[var(--text-secondary)]">No RM issue forms yet.</div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-2 md:hidden">
            {rows.map((r) => (
              <button key={r.id} onClick={() => router.push(`/modules/sample/rm-issue-forms/${r.id}`)}
                className="text-left bg-white border border-[var(--aws-border)] rounded-md p-3 hover:border-[var(--aws-orange)]">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-[13px] text-[var(--text-primary)]">{r.form_number}</span>
                  <RmFormStatusPill status={r.status} />
                </div>
                <div className="mt-0.5 text-[13px] text-[var(--text-primary)] truncate">{r.trial_name || r.product_name || "—"}</div>
                <div className="mt-1 text-[12px] text-[var(--text-secondary)] flex flex-wrap gap-x-3">
                  <span>{r.customer_name || "Internal"}</span>
                  <span>{r.line_count ?? 0} line(s)</span>
                  <span>{(r.created_at ?? "").slice(0, 10)}</span>
                </div>
              </button>
            ))}
          </div>
          <div className="hidden md:block bg-white border border-[var(--aws-border)] rounded-md overflow-hidden">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-[var(--surface-subtle)] text-left text-[12px] text-[var(--text-secondary)]">
                  <th className="px-3 py-2 font-semibold">Form</th>
                  <th className="px-3 py-2 font-semibold">Trial / Product</th>
                  <th className="px-3 py-2 font-semibold">Customer</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                  <th className="px-3 py-2 font-semibold text-right">Lines</th>
                  <th className="px-3 py-2 font-semibold">Created</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} onClick={() => router.push(`/modules/sample/rm-issue-forms/${r.id}`)}
                    className="border-t border-[var(--surface-divider)] hover:bg-[var(--surface-subtle)] cursor-pointer">
                    <td className="px-3 py-2 font-medium text-[var(--text-primary)]">{r.form_number}</td>
                    <td className="px-3 py-2 max-w-[260px] truncate">{r.trial_name || r.product_name || "—"}</td>
                    <td className="px-3 py-2">{r.customer_name || "Internal"}</td>
                    <td className="px-3 py-2"><RmFormStatusPill status={r.status} /></td>
                    <td className="px-3 py-2 text-right">{r.line_count ?? 0}</td>
                    <td className="px-3 py-2 text-[var(--text-secondary)]">{(r.created_at ?? "").slice(0, 10)}</td>
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
