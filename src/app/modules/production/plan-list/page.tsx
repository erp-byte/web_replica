"use client";

// Plan List page — mirrors
// frontend_replica/src/modules/production/plan-list/* (review approved
// plans and their job-card chains). Operators filter by entity / status /
// type / date range / search, then approve drafts or cancel them with a
// reason.
//
// Out of scope this iteration:
//   • Row-click navigation to plan detail (separate page; not yet ported)
//   • Per-plan job-card landing after approve (would deep-link to job-card list)
//   • Date range picker (date_from/date_to query support is in the lib;
//     just no UI yet — easy to add)
//   • Plan name edit / re-revision flow

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrandMark } from "@/components/BrandMark";
import { useRouter } from "next/navigation";
import { useRequireAuth, useUserInitial } from "@/lib/user";
import { friendlyApiError } from "@/lib/apiErrors";
import { BackLink } from "@/components/BackLink";
import {
  type PlanRow,
  type PlanRowLineSummary,
  type PlanPagination,
  type PlanDetail,
  type PlanLineRow,
  type PlanBomLine,
  type PlanBomSummary,
  listPlans,
  getPlan,
  fetchPlanBom,
  createLineJobCards,
  replaceLineJobCards,
  fetchLineJobCardConfig,
  fmtPlanKg,
  fmtPlanDate,
  fmtDateRange,
} from "@/lib/plans";
import { FACTORY_TO_WAREHOUSE, FLOORS_BY_FACTORY, type FactoryCode } from "@/lib/planBuilder";
import { PROCESS_OPTIONS } from "@/lib/processCatalog";

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

type Entity = "" | "cfpl" | "cdpl";
type StatusKey = "draft" | "approved" | "executed" | "cancelled";
type PlanTypeKey = "daily" | "weekly";
// Warehouse filter values match the values stored in
// production_plan_v2.warehouse (canonical hyphenated form). The chip
// labels use the shorter factory-code form ("W202", "A185") that
// operators see elsewhere in the app. Empty string = "All".
type WarehouseKey = "" | "W-202" | "A-185";
const WAREHOUSE_OPTS: { v: Exclude<WarehouseKey, "">; label: string }[] = [
  { v: "W-202", label: "W202" },
  { v: "A-185", label: "A185" },
];

const STATUS_OPTS: { v: StatusKey; label: string }[] = [
  { v: "draft",     label: "Draft" },
  { v: "approved",  label: "Approved" },
  { v: "executed",  label: "Executed" },
  { v: "cancelled", label: "Cancelled" },
];
const TYPE_OPTS: { v: PlanTypeKey; label: string }[] = [
  { v: "daily",  label: "Daily" },
  { v: "weekly", label: "Weekly" },
];

// ── Page ──────────────────────────────────────────────────────────────────

export default function PlanListPage() {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);
  const initial = useUserInitial();

  // Filter state
  const [entity, setEntity] = useState<Entity>("");
  const [warehouse, setWarehouse] = useState<WarehouseKey>("");
  const [status, setStatus] = useState<StatusKey[]>([]);
  const [planType, setPlanType] = useState<PlanTypeKey[]>([]);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  // Bump after a successful mutation (approve / cancel) to force the
  // fetch effect to refire even when no other dependency changed. The
  // previous reload() called setPage(1), which was a no-op when the
  // operator was already on page 1 — React saw an identical state value
  // and skipped the re-render, so the cleared rows[] never re-populated
  // and the list looked empty until a manual filter change.
  const [reloadKey, setReloadKey] = useState(0);

  // Data state
  const [rows, setRows] = useState<PlanRow[]>([]);
  const [pagination, setPagination] = useState<PlanPagination>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // UI state
  const [toast, setToast] = useState<string | null>(null);
  const [expandedPlanId, setExpandedPlanId] = useState<number | null>(null);
  // Create-Job-Card flow (scaffold). Opening sets the target plan; the modal
  // lets the operator pick ONE of the plan's articles (radio). The actual
  // job-card creation (entering process/floor at the JC) is wired in a later
  // step — for now Continue just confirms the pick. This is the path that will
  // replace Approve once the full flow lands.
  const [jcPlan, setJcPlan] = useState<PlanRow | null>(null);

  // Debounce search; bump page back to 1 on every change so a stale page
  // beyond the new result set isn't requested.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  // Stable fingerprints for the array filters so the fetch effect doesn't
  // re-fire on identical array re-allocations.
  const statusKey = status.join("|");
  const typeKey = planType.join("|");

  useEffect(() => {
    if (!authed) return;
    const c = new AbortController();
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const resp = await listPlans(
          {
            entity,
            warehouse: warehouse || undefined,
            status,
            plan_type: planType,
            search: debouncedSearch || undefined,
            page,
            page_size: PAGE_SIZE,
          },
          c.signal,
        );
        if (c.signal.aborted) return;
        setRows(resp.results ?? []);
        setPagination(resp.pagination ?? {});
      } catch (e) {
        if (c.signal.aborted) return;
        setError(friendlyApiError(e));
      } finally {
        if (!c.signal.aborted) setLoading(false);
      }
    })();
    return () => c.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed, entity, warehouse, statusKey, typeKey, debouncedSearch, page, reloadKey]);

  const resetForFilterChange = useCallback(() => setPage(1), []);

  function changeEntity(v: Entity) {
    setEntity(v);
    resetForFilterChange();
  }

  function toggleWarehouse(v: Exclude<WarehouseKey, "">) {
    // Single-select chip group — click the active chip to clear it.
    setWarehouse((cur) => (cur === v ? "" : v));
    resetForFilterChange();
  }

  function toggleStatus(v: StatusKey) {
    setStatus((cur) => (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]));
    resetForFilterChange();
  }

  function toggleType(v: PlanTypeKey) {
    setPlanType((cur) => (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]));
    resetForFilterChange();
  }

  function clearAllFilters() {
    setEntity("");
    setWarehouse("");
    setStatus([]);
    setPlanType([]);
    setSearch("");
    resetForFilterChange();
  }

  // Reload after a successful approve / cancel. Bumping reloadKey
  // forces the fetch effect to refire even when no other dep changed
  // (e.g. operator already on page 1). Resetting page to 1 here is
  // intentional — after a status change the operator usually wants to
  // see the newly-affected plan, which most likely sits at the top of
  // the canonical sort.
  function reload() {
    setPage(1);
    setReloadKey((k) => k + 1);
  }

  // Summary derived client-side from the current page.
  const summary = useMemo(() => {
    const counts = { draft: 0, approved: 0, executed: 0, cancelled: 0 };
    for (const r of rows) {
      const s = (r.status ?? "").toLowerCase();
      if (s in counts) counts[s as keyof typeof counts] += 1;
    }
    return { ...counts, total: pagination.total ?? rows.length };
  }, [rows, pagination.total]);

  const anyFilterActive = !!entity || !!warehouse || status.length > 0 || planType.length > 0 || !!debouncedSearch;

  // Stable handlers so the memoized row components below don't see new
  // function identities on every parent render — without these, every
  // chip click / search keystroke would invalidate React.memo on every
  // row and the table would re-render in full.  router is mutable across
  // renders but its `push` reference is stable in app-router.
  const onToggleExpand = useCallback((p: PlanRow) => {
    setExpandedPlanId((c) => (c === p.plan_id ? null : p.plan_id));
  }, []);
  const onOpen = useCallback((p: PlanRow) => {
    router.push(`/modules/production/plan-list/${p.plan_id}`);
  }, [router]);
  const onPage = useCallback((p: number) => setPage(p), []);

  // Surface a thin, non-blocking progress bar whenever a fetch is in
  // flight AND we already have rows on screen (the rows-empty case is
  // handled by the centred "Loading plans…" panel below). Without this
  // strip, filter / pagination clicks felt unresponsive — the click
  // landed, but nothing visually changed until the network round-trip
  // completed.
  const showRefreshBar = loading && rows.length > 0;

  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <PageHeader initial={initial} router={router} />

      <main className="flex-1 max-w-[1400px] w-full mx-auto px-4 sm:px-6 py-6">
        <div className="mb-3">
          <BackLink parentHref="/modules/production" label="production" />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-baseline gap-3 min-w-0">
            <h1 className="text-[20px] leading-[24px] font-semibold text-[var(--text-primary)]">Plan List</h1>
            <p className="hidden lg:inline text-[12px] text-[var(--text-muted)] truncate">
              Approved + draft plans · filter by entity, status, or type.
            </p>
          </div>
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <EntitySelector value={entity} onChange={changeEntity} />
          </div>
        </div>

        {/* Filter toolbar — search + warehouse + status + type + clear.
            Each chip group wraps onto its own row on narrow screens via
            flex-wrap so phones don't get a horizontal scrollbar. */}
        <div className="border-b border-[var(--aws-border)] mb-3 pb-3 flex flex-wrap items-center gap-1.5">
          <SearchInput value={search} onChange={setSearch} />
          <div className="flex items-center gap-1 ml-1 flex-wrap">
            <span className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)] mr-1 hidden sm:inline">Warehouse</span>
            {WAREHOUSE_OPTS.map((o) => (
              <FilterChip
                key={o.v}
                label={o.label}
                active={warehouse === o.v}
                onClick={() => toggleWarehouse(o.v)}
              />
            ))}
          </div>
          <div className="flex items-center gap-1 ml-1 flex-wrap">
            <span className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)] mr-1 hidden sm:inline">Status</span>
            {STATUS_OPTS.map((o) => (
              <FilterChip
                key={o.v}
                label={o.label}
                active={status.includes(o.v)}
                onClick={() => toggleStatus(o.v)}
                tone={STATUS_TONE[o.v]}
              />
            ))}
          </div>
          <div className="flex items-center gap-1 ml-1 flex-wrap">
            <span className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)] mr-1 hidden sm:inline">Type</span>
            {TYPE_OPTS.map((o) => (
              <FilterChip
                key={o.v}
                label={o.label}
                active={planType.includes(o.v)}
                onClick={() => toggleType(o.v)}
              />
            ))}
          </div>
          {anyFilterActive ? (
            <button
              onClick={clearAllFilters}
              className="h-7 px-2.5 text-[11px] rounded-full border border-[var(--aws-border)] text-[var(--text-secondary)] bg-white hover:border-[var(--aws-error)] hover:text-[var(--aws-error)] flex items-center gap-1"
            >
              <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
              Clear
            </button>
          ) : null}
        </div>

        {/* Compact summary chip row — one strip, not a card grid. */}
        <SummaryStrip summary={summary} />

        {toast ? (
          <div className="mb-3 px-3 py-2 rounded-sm border border-[var(--aws-border)] bg-[#f1faff] text-[12px] text-[var(--text-primary)] flex items-center justify-between gap-2">
            <span>{toast}</span>
            <button onClick={() => setToast(null)} className="text-[var(--aws-link)] hover:underline">
              Dismiss
            </button>
          </div>
        ) : null}

        {/* Thin animated bar — instant feedback for chip / pagination
            clicks while the fetch is still in flight. CSS-only; cheap. */}
        <div
          aria-hidden
          className={[
            "h-0.5 rounded-full overflow-hidden transition-opacity duration-150 mb-2",
            showRefreshBar ? "opacity-100" : "opacity-0",
          ].join(" ")}
        >
          <div className="h-full bg-[var(--aws-orange)] animate-pulse" />
        </div>

        {loading && rows.length === 0 ? (
          <Centered>Loading plans…</Centered>
        ) : error ? (
          <Centered tone="error">{error}</Centered>
        ) : rows.length === 0 ? (
          <Centered>No plans match your filters.</Centered>
        ) : (
          <>
            <div
              aria-busy={loading}
              className={loading ? "opacity-70 transition-opacity" : "transition-opacity"}
            >
              <PlansList
                rows={rows}
                expandedPlanId={expandedPlanId}
                onToggleExpand={onToggleExpand}
                onOpen={onOpen}
                onCreateJobCard={setJcPlan}
              />
            </div>
            <Pagination pg={pagination} onPage={onPage} loading={loading} />
          </>
        )}
      </main>


      {jcPlan ? (
        <CreateJobCardModal
          plan={jcPlan}
          onClose={() => setJcPlan(null)}
          onContinue={async (p) => {
            if (p.planLineId == null) {
              setToast("Pick an article first.");
              return false;
            }
            // Same identity scheme the modal selects with (getLineId).
            const ln = (jcPlan.lines_summary ?? []).find((l, i) => getLineId(l, i) === p.planLineId);
            const article = ln?.fg_sku_name ?? "article";
            const body = {
              qty_kg: Number(p.qtyKg),
              qty_units: p.qtyUnits.trim() !== "" ? Number(p.qtyUnits) : null,
              wip_steps: p.wipSteps.map((s) => ({
                process: s.process,
                floor: s.floor,
                sfg_output: s.sfgOutput || null,
              })),
              pkg_floor: p.pkgFloor,
            };
            setToast(null);
            try {
              if (p.mode === "edit") {
                const r = await replaceLineJobCards(p.planLineId, body);
                setToast(`Updated job cards for ${article} · ${r.count} stage${r.count === 1 ? "" : "s"} re-dispatched.`);
              } else {
                const r = await createLineJobCards(p.planLineId, body);
                setToast(`Created ${r.count} job card${r.count === 1 ? "" : "s"} for ${article} · dispatched to floors.`);
              }
              reload();
              return true;
            } catch (e) {
              setToast(`${p.mode === "edit" ? "Edit" : "Create"} job card failed: ${friendlyApiError(e)}`);
              return false;
            }
          }}
        />
      ) : null}

      <Footer />
    </div>
  );
}

// ── Chrome ────────────────────────────────────────────────────────────────

function PageHeader({ initial, router }: { initial: string; router: ReturnType<typeof useRouter> }) {
  return (
    <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-6 gap-4">
      <BrandMark />
      <span className="text-[#d5dbdb] text-[13px] hidden sm:inline">Console</span>
      <nav className="text-[12px] text-[#d5dbdb] hidden md:flex items-center gap-2 ml-2">
        <button onClick={() => router.push("/modules")} className="hover:underline">Modules</button>
        <span>/</span>
        <button onClick={() => router.push("/modules/production")} className="hover:underline">Production</button>
        <span>/</span>
        <span className="text-white">Plan List</span>
      </nav>
      <div className="flex-1" />
      <button
        onClick={() => router.push("/modules/profile")}
        aria-label="Open profile"
        title="Profile"
        className="w-8 h-8 rounded-full bg-[var(--aws-orange)] text-white text-[13px] font-bold flex items-center justify-center hover:bg-[var(--aws-orange-hover)]"
      >
        {initial}
      </button>
    </header>
  );
}

function Footer() {
  return (
    <footer className="border-t border-[var(--aws-border)] bg-white py-3 px-6 text-[11px] text-[var(--text-secondary)] flex flex-wrap justify-center gap-x-4 gap-y-1">
      <a href="#" className="hover:underline">Privacy</a>
      <span>© {new Date().getFullYear()}</span>
    </footer>
  );
}

function Centered({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return (
    <div
      className={[
        "bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[13px]",
        tone === "error" ? "text-[var(--aws-error)]" : "text-[var(--text-secondary)]",
      ].join(" ")}
    >
      {children}
    </div>
  );
}

// ── Entity selector ──────────────────────────────────────────────────────

function EntitySelector({ value, onChange }: { value: Entity; onChange: (v: Entity) => void }) {
  const opts: { v: Entity; label: string }[] = [
    { v: "",     label: "All" },
    { v: "cfpl", label: "CFPL" },
    { v: "cdpl", label: "CDPL" },
  ];
  return (
    <div className="flex items-center bg-white border border-[var(--aws-border-strong)] rounded-[2px] overflow-hidden">
      {opts.map((o, i) => (
        <button
          key={o.v || "all"}
          onClick={() => onChange(o.v)}
          className={[
            "h-8 px-3 text-[12px] font-medium transition-colors",
            i > 0 ? "border-l border-[var(--aws-border)]" : "",
            value === o.v
              ? "bg-[var(--aws-navy)] text-white"
              : "bg-white text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)]",
          ].join(" ")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Search input ─────────────────────────────────────────────────────────

function SearchInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative flex-1 min-w-[160px] sm:min-w-[200px] sm:max-w-[260px]">
      <svg
        viewBox="0 0 24 24"
        className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)]"
        fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"
      >
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search plans…"
        className="w-full h-7 pl-7 pr-2 text-[12px] rounded-[2px] bg-white border border-[var(--aws-border)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
      />
    </div>
  );
}

// ── Status tone palette ─────────────────────────────────────────────────

const STATUS_TONE: Record<StatusKey, "blue" | "green" | "purple" | "neutral"> = {
  draft:     "blue",
  approved:  "green",
  executed:  "purple",
  cancelled: "neutral",
};

function FilterChip({
  label, active, onClick, tone,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  tone?: "blue" | "green" | "purple" | "neutral";
}) {
  // Tinted active state per-tone; otherwise a neutral selected state.
  const activeCls = tone === "green"   ? "bg-[#eaf6ed] border-[#b6dbb1] text-[#1d8102]"
                  : tone === "purple"  ? "bg-[#f0eef8] border-[#d2cef0] text-[#5752c4]"
                  : tone === "neutral" ? "bg-[var(--surface-subtle)] border-[var(--aws-border)] text-[var(--text-secondary)]"
                  : tone === "blue"    ? "bg-[#eaf3ff] border-[#bbd9f3] text-[var(--aws-link)]"
                                       : "bg-[var(--aws-navy)] border-[var(--aws-navy)] text-white";
  return (
    <button
      onClick={onClick}
      className={[
        "h-7 px-2.5 text-[12px] rounded-full border transition-colors",
        active ? activeCls : "bg-white border-[var(--aws-border)] text-[var(--text-primary)] hover:border-[var(--aws-navy)]",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

// ── Summary strip ───────────────────────────────────────────────────────

function SummaryStrip({
  summary,
}: {
  summary: { total: number; draft: number; approved: number; executed: number; cancelled: number };
}) {
  const items = [
    { label: "Total",     value: summary.total,     tone: "neutral" as const },
    { label: "Draft",     value: summary.draft,     tone: "blue"    as const },
    { label: "Approved",  value: summary.approved,  tone: "green"   as const },
    { label: "Executed",  value: summary.executed,  tone: "purple"  as const },
    { label: "Cancelled", value: summary.cancelled, tone: "neutral" as const },
  ];
  const dotCls = (t: "neutral" | "blue" | "green" | "purple") =>
    t === "blue"   ? "bg-[var(--aws-link)]" :
    t === "green"  ? "bg-[#1d8102]" :
    t === "purple" ? "bg-[#5752c4]" :
                     "bg-[var(--text-muted)]";
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mb-3 text-[12px]">
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          <span className={["inline-block w-1.5 h-1.5 rounded-full", dotCls(it.tone)].join(" ")} />
          <span className="text-[var(--text-muted)]">{it.label}</span>
          <span className="font-semibold text-[var(--text-primary)]">{it.value}</span>
        </span>
      ))}
    </div>
  );
}

// ── Plans list (table + mobile cards) ────────────────────────────────────

function PlansList({
  rows, expandedPlanId, onToggleExpand, onOpen, onCreateJobCard,
}: {
  rows: PlanRow[];
  expandedPlanId: number | null;
  onToggleExpand: (p: PlanRow) => void;
  onOpen:    (p: PlanRow) => void;
  onCreateJobCard: (p: PlanRow) => void;
}) {
  // The handlers are passed through verbatim — the row components apply
  // the per-row binding internally.  Wrapping callbacks here with an
  // inline `() => onOpen(r)` would mint a new function identity per
  // row per render and defeat React.memo on the rows.
  return (
    <>
      {/* Mobile (< md): stacked cards */}
      <div className="md:hidden space-y-2 mb-3">
        {rows.map((r) => (
          <PlanMobileCard
            key={r.plan_id}
            row={r}
            expanded={expandedPlanId === r.plan_id}
            onToggleExpand={onToggleExpand}
            onOpen={onOpen}
            onCreateJobCard={onCreateJobCard}
          />
        ))}
      </div>

      {/* md+: table */}
      <div className="hidden md:block bg-white border border-[var(--aws-border)] rounded-md overflow-hidden mb-4">
        <div className="overflow-x-auto">
          <table className="w-full text-[12px] border-collapse">
            <thead className="bg-[var(--surface-subtle)] text-[var(--text-primary)]">
              <tr className="border-b border-[var(--aws-border)]">
                <Th />
                <Th>Plan</Th>
                <Th>Type</Th>
                <Th>Date range</Th>
                <Th>Status</Th>
                <Th right>Lines</Th>
                <Th right>Volume</Th>
                <Th>Created</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <PlanRowDesktop
                  key={r.plan_id}
                  row={r}
                  expanded={expandedPlanId === r.plan_id}
                  onToggleExpand={onToggleExpand}
                  onOpen={onOpen}
                  onCreateJobCard={onCreateJobCard}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// ── Article + qty summary (inline, under each plan row) ──────────────────
//
// Server returns up to 20 line summaries per plan in `lines_summary`.  We
// surface the first three inline so the operator can scan plans by their
// FG SKU + kg without expanding the row.  When the plan has more lines,
// a "+N more" hint nudges them to click expand for the full picture.

function ArticleSummary({
  summary, totalLineCount,
}: {
  summary?: PlanRowLineSummary[] | null;
  totalLineCount?: number | null;
}) {
  if (!summary || summary.length === 0) return null;
  const SHOW = 3;
  const shown = summary.slice(0, SHOW);
  const known = summary.length;
  const total = typeof totalLineCount === "number" ? totalLineCount : known;
  const remainder = Math.max(0, total - shown.length);
  return (
    <ul className="mt-1 space-y-0.5 text-[11px] leading-[14px] text-[var(--text-secondary)]">
      {shown.map((l, i) => {
        const kg = l.planned_qty_kg != null ? fmtPlanKg(l.planned_qty_kg) : null;
        const pcs = l.planned_qty_units != null && l.planned_qty_units !== ""
          ? String(l.planned_qty_units)
          : null;
        return (
          <li
            key={l.plan_line_id ?? `${i}-${l.fg_sku_name ?? ""}`}
            className="flex items-baseline gap-1.5 min-w-0"
            title={l.fg_sku_name ?? ""}
          >
            <span className="truncate text-[var(--text-primary)]">
              {l.fg_sku_name || "—"}
            </span>
            <span className="shrink-0 font-mono text-[var(--text-muted)] whitespace-nowrap">
              {kg != null ? `${kg} kg` : ""}
              {kg != null && pcs != null ? " · " : ""}
              {pcs != null ? `${pcs} pcs` : ""}
            </span>
          </li>
        );
      })}
      {remainder > 0 ? (
        <li className="text-[10px] text-[var(--text-muted)] italic">
          + {remainder} more line{remainder === 1 ? "" : "s"}
        </li>
      ) : null}
    </ul>
  );
}

function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={[
        "px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)]",
        right ? "text-right" : "text-left",
      ].join(" ")}
    >
      {children}
    </th>
  );
}

// React.memo so each row only re-renders when its own props change.
// Without this, every search keystroke / chip click / pagination tick
// re-renders the entire ~50-row table — even when nothing about a
// given row's data changed.  Parent-supplied callbacks are stabilised
// with useCallback so this memo isn't busted by new function identities.
const PlanRowDesktop = memo(function PlanRowDesktop({
  row, expanded, onToggleExpand, onOpen, onCreateJobCard,
}: {
  row: PlanRow;
  expanded: boolean;
  onToggleExpand: (p: PlanRow) => void;
  onOpen: (p: PlanRow) => void;
  onCreateJobCard: (p: PlanRow) => void;
}) {
  // Any article already carded ⇒ the row's action is "Edit Job Card".
  const hasJobCards = (row.lines_summary ?? []).some((l) => (l.job_card_count ?? 0) > 0);
  // Memoise the row-bound adapters so the per-row buttons / rowclick
  // don't churn their own listeners on every render either.
  const handleToggle = useCallback(() => onToggleExpand(row), [onToggleExpand, row]);
  const handleOpen = useCallback(() => onOpen(row), [onOpen, row]);
  const handleCreateJobCard = useCallback(() => onCreateJobCard(row), [onCreateJobCard, row]);
  return (
    <>
    <tr
      className={[
        "border-b border-[var(--aws-border)] hover:bg-[var(--surface-subtle)] cursor-pointer",
        expanded ? "bg-[var(--surface-subtle)]" : "",
      ].join(" ")}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        handleToggle();
      }}
    >
      <td className="px-2 py-1.5 w-[24px] text-[var(--text-secondary)]">
        <button
          type="button"
          aria-label={expanded ? "Collapse plan" : "Expand plan"}
          onClick={(e) => { e.stopPropagation(); handleToggle(); }}
          className="inline-flex items-center justify-center w-5 h-5 rounded-sm hover:bg-white"
        >
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2} style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform .15s" }}>
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </td>
      <td className="px-2.5 py-1.5 min-w-[180px] max-w-[360px]">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="font-medium text-[var(--text-primary)]">
            {row.plan_name || `Plan #${row.plan_id}`}
          </span>
          {row.revision_number != null && row.revision_number > 1 ? (
            <span className="text-[9px] uppercase font-bold tracking-wide text-[var(--text-secondary)] bg-[var(--surface-subtle)] border border-[var(--aws-border)] rounded-sm px-1 py-0">
              rev {row.revision_number}
            </span>
          ) : null}
        </div>
        {row.warehouse ? (
          <div className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted)] mt-0.5">
            {row.warehouse}
          </div>
        ) : null}
        <ArticleSummary
          summary={row.lines_summary}
          totalLineCount={row.line_count ?? null}
        />
      </td>
      <td className="px-2.5 py-1.5">
        <TypeBadge type={row.plan_type} />
      </td>
      <td className="px-2.5 py-1.5 text-[var(--text-secondary)] whitespace-nowrap">
        {fmtDateRange(row.date_from, row.date_to)}
      </td>
      <td className="px-2.5 py-1.5">
        <StatusBadge status={row.status} />
      </td>
      <td className="px-2.5 py-1.5 text-right font-mono">{row.line_count ?? 0}</td>
      <td className="px-2.5 py-1.5 text-right whitespace-nowrap">
        <span className="font-semibold">{fmtPlanKg(row.total_planned_kg)} kg</span>
      </td>
      <td className="px-2.5 py-1.5 text-[var(--text-muted)] whitespace-nowrap text-[11px]">
        {fmtPlanDate(row.created_at)}
      </td>
      <td className="px-2.5 py-1.5 text-right">
        <RowActions
          hasJobCards={hasJobCards}
          onOpen={handleOpen}
          onCreateJobCard={handleCreateJobCard}
        />
      </td>
    </tr>
    {expanded ? (
      <tr className="border-b border-[var(--aws-border)] bg-[var(--surface-subtle)]">
        <td colSpan={9} className="px-3 py-3">
          <PlanInlinePreview planId={row.plan_id} onOpen={handleOpen} />
        </td>
      </tr>
    ) : null}
    </>
  );
});

const PlanMobileCard = memo(function PlanMobileCard({
  row, expanded, onToggleExpand, onOpen, onCreateJobCard,
}: {
  row: PlanRow;
  expanded: boolean;
  onToggleExpand: (p: PlanRow) => void;
  onOpen: (p: PlanRow) => void;
  onCreateJobCard: (p: PlanRow) => void;
}) {
  const hasJobCards = (row.lines_summary ?? []).some((l) => (l.job_card_count ?? 0) > 0);
  const handleToggle = useCallback(() => onToggleExpand(row), [onToggleExpand, row]);
  const handleOpen = useCallback(() => onOpen(row), [onOpen, row]);
  const handleCreateJobCard = useCallback(() => onCreateJobCard(row), [onCreateJobCard, row]);
  return (
    <div
      className="bg-white border border-[var(--aws-border)] rounded-md overflow-hidden cursor-pointer hover:border-[var(--aws-navy)]"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        handleToggle();
      }}
    >
      <div className="px-2.5 py-2">
        <div className="flex items-center justify-between gap-2 mb-1">
          <div className="min-w-0 flex items-center gap-1.5 flex-wrap">
            <button
              type="button"
              aria-label={expanded ? "Collapse" : "Expand"}
              onClick={(e) => { e.stopPropagation(); handleToggle(); }}
              className="shrink-0 inline-flex items-center justify-center w-5 h-5 -ml-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2} style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform .15s" }}>
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
            <span className="text-[13px] font-semibold text-[var(--text-primary)] truncate">
              {row.plan_name || `Plan #${row.plan_id}`}
            </span>
            {row.revision_number != null && row.revision_number > 1 ? (
              <span className="text-[9px] uppercase font-bold tracking-wide text-[var(--text-secondary)] bg-[var(--surface-subtle)] border border-[var(--aws-border)] rounded-sm px-1 py-0">
                rev {row.revision_number}
              </span>
            ) : null}
          </div>
          <StatusBadge status={row.status} />
        </div>
        <div className="flex items-center flex-wrap gap-x-2 gap-y-0.5 text-[11px] mb-1.5">
          <TypeBadge type={row.plan_type} />
          {row.warehouse ? (
            <span className="text-[var(--text-muted)] font-mono text-[10px]">{row.warehouse}</span>
          ) : null}
          <span className="text-[var(--text-muted)]">{fmtDateRange(row.date_from, row.date_to)}</span>
        </div>
        <div className="flex items-center gap-3 text-[11px] mb-1.5">
          <span><span className="text-[var(--text-muted)]">Lines</span> <strong>{row.line_count ?? 0}</strong></span>
          <span><span className="text-[var(--text-muted)]">Volume</span> <strong>{fmtPlanKg(row.total_planned_kg)} kg</strong></span>
        </div>
        <ArticleSummary
          summary={row.lines_summary}
          totalLineCount={row.line_count ?? null}
        />
        <div className="flex items-center gap-2 mt-2">
          <RowActions
            hasJobCards={hasJobCards}
            onOpen={handleOpen}
            onCreateJobCard={handleCreateJobCard}
          />
        </div>
      </div>
      {expanded ? (
        <div className="border-t border-[var(--aws-border)] px-2.5 py-3 bg-[var(--surface-subtle)]">
          <PlanInlinePreview planId={row.plan_id} onOpen={handleOpen} />
        </div>
      ) : null}
    </div>
  );
});

function RowActions({
  hasJobCards, onOpen, onCreateJobCard,
}: {
  hasJobCards: boolean;
  onOpen: () => void;
  onCreateJobCard: () => void;
}) {
  return (
    <div className="inline-flex items-center gap-1.5">
      {/* Create / Edit Job Card — the per-article job-card flow (replaces the
          old Approve auto-generate). Label flips to "Edit" once this plan has
          any job cards. */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onCreateJobCard(); }}
        title={hasJobCards ? "Edit this plan's job cards" : "Create a job card from one of this plan's articles"}
        className="h-7 px-2.5 text-[11px] rounded-[2px] font-semibold border bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white inline-flex items-center gap-1"
      >
        {hasJobCards ? (
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        )}
        {hasJobCards ? "Edit Job Card" : "Create Job Card"}
      </button>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onOpen(); }}
        title="Open approval workspace"
        className="h-7 px-2.5 text-[11px] rounded-[2px] border border-[var(--aws-border)] bg-white text-[var(--aws-link)] hover:border-[var(--aws-navy)] inline-flex items-center gap-1"
      >
        Open
        <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </svg>
      </button>
    </div>
  );
}

// ── Create Job Card modal (scaffold) ───────────────────────────────────
//
// Opened by the per-plan "Create Job Card" button. Lists the plan's articles
// (lines_summary) as a single-select radio checklist. Picking one + Continue
// is where the new per-article job-card flow begins — the downstream steps
// (entering process / floor at the job card) are wired in a follow-up. This is
// the path that will replace Approve once complete.

// Canonical line identity for the Create-Job-Card flow. A plan line SHOULD
// carry a plan_line_id, but the summary type allows null/undefined; when it's
// missing we fall back to the row's array index. Every site (initial radio
// selection, the selectedLine lookup, the radio key, AND the parent's
// onContinue lookup) MUST use this same scheme — mixing `?? 0` / `?? i` /
// `?? null` resolves the wrong (or no) line when plan_line_id is absent.
function getLineId(line: PlanRowLineSummary, index: number): number {
  return line.plan_line_id ?? index;
}

function CreateJobCardModal({
  plan, onClose, onContinue,
}: {
  plan: PlanRow;
  onClose: () => void;
  onContinue: (payload: {
    planLineId: number | null;
    qtyKg: string;
    qtyUnits: string;
    wipSteps: WipStep[];
    pkgFloor: string;
    mode: "create" | "edit";
  }) => Promise<boolean>;
}) {
  const lines = plan.lines_summary ?? [];
  const [step, setStep] = useState<1 | 2>(1);
  const [selected, setSelected] = useState<number | null>(
    lines.length === 1 ? getLineId(lines[0], 0) : null,
  );
  const [qtyKg, setQtyKg] = useState("");
  const [qtyUnits, setQtyUnits] = useState("");
  // WIP is one or more processes, each with its own floor + SFG output.
  const [wipSteps, setWipSteps] = useState<WipStep[]>(
    [{ process: "", floor: "", sfgOutput: "" }],
  );
  const [pkgFloor, setPkgFloor] = useState("");

  // BOM of the selected article — drives the read-only per-step RM/PM view.
  const [bom, setBom] = useState<PlanBomSummary | null>(null);
  const [bomLoading, setBomLoading] = useState(false);
  const [bomErr, setBomErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Edit mode: the chosen article already has job cards, so step 2 is prefilled
  // from the existing chain and saving REPLACES it. `editable` is false once a
  // stage has started (then save is blocked). `loadingCfg` covers the prefill
  // fetch behind the Next button.
  const [mode, setMode] = useState<"create" | "edit">("create");
  const [editable, setEditable] = useState(true);
  const [loadingCfg, setLoadingCfg] = useState(false);

  const selectedLine = lines.find((l, i) => getLineId(l, i) === selected) ?? null;
  const selectedBomId = selectedLine?.bom_id ?? null;
  const selectedCarded = (selectedLine?.job_card_count ?? 0) > 0;

  // Load the full BOM (no 30-line cap) whenever the chosen article changes.
  // Async-IIFE + AbortController is this file's accepted fetch-in-effect shape
  // (avoids the no-sync-setState-in-effect lint). RM SOs / lines without a
  // bom_id resolve to no BOM, so the per-step panel hides itself.
  useEffect(() => {
    const c = new AbortController();
    void (async () => {
      // All setState lives inside the async IIFE — this file's accepted shape
      // for the no-sync-setState-in-effect rule (incl. the no-BOM reset).
      if (selectedBomId == null) {
        setBom(null);
        setBomErr(null);
        setBomLoading(false);
        return;
      }
      setBomLoading(true);
      setBomErr(null);
      try {
        const r = await fetchPlanBom(selectedBomId, { full: true, signal: c.signal });
        if (!c.signal.aborted) setBom(r);
      } catch (e) {
        if (!c.signal.aborted) {
          setBom(null);
          setBomErr(e instanceof Error ? e.message : "Failed to load BOM");
        }
      } finally {
        if (!c.signal.aborted) setBomLoading(false);
      }
    })();
    return () => c.abort();
  }, [selectedBomId]);

  // Floors come from the plan's factory: warehouse → factory code → floor set.
  const factory = (Object.keys(FACTORY_TO_WAREHOUSE) as FactoryCode[])
    .find((c) => FACTORY_TO_WAREHOUSE[c] === plan.warehouse);
  const floors = factory ? [...FLOORS_BY_FACTORY[factory]] : [];

  async function goNext() {
    if (selected == null) return;
    if (selectedCarded && selectedLine?.plan_line_id != null) {
      // Editing an already-carded article — prefill step 2 from its chain.
      setLoadingCfg(true);
      try {
        const cfg = await fetchLineJobCardConfig(selectedLine.plan_line_id);
        if (cfg.exists) {
          setMode("edit");
          setEditable(cfg.editable !== false);
          setQtyKg(cfg.qty_kg != null ? String(cfg.qty_kg) : "");
          setQtyUnits(cfg.qty_units != null ? String(cfg.qty_units) : "");
          setWipSteps(
            cfg.wip_steps && cfg.wip_steps.length
              ? cfg.wip_steps.map((s) => ({ process: s.process ?? "", floor: s.floor ?? "", sfgOutput: s.sfg_output ?? "" }))
              : [{ process: "", floor: "", sfgOutput: "" }],
          );
          setPkgFloor(cfg.pkg_floor ?? "");
        } else {
          setMode("create");
        }
      } catch {
        setMode("create");   // fall back to a create attempt; the server still guards
      } finally {
        setLoadingCfg(false);
      }
    } else {
      setMode("create");
      // Prefill qty + units from the chosen line the first time we advance.
      if (qtyKg === "" && selectedLine?.planned_qty_kg != null) {
        setQtyKg(String(selectedLine.planned_qty_kg));
      }
      if (qtyUnits === "" && selectedLine?.planned_qty_units != null && selectedLine.planned_qty_units !== "") {
        setQtyUnits(String(selectedLine.planned_qty_units));
      }
    }
    setStep(2);
  }

  function addWipProcess() {
    setWipSteps((s) => [...s, { process: "", floor: "", sfgOutput: "" }]);
  }

  // Every WIP process needs both a process and a floor; plus a packaging floor.
  const wipOk = wipSteps.length > 0 && wipSteps.every((s) => s.process !== "" && s.floor !== "");
  const canCreate =
    qtyKg.trim() !== "" && Number(qtyKg) > 0 && wipOk && pkgFloor !== "";
  // In edit mode a started chain can't be replaced, so saving is blocked.
  const canSubmit = canCreate && (mode === "create" || editable);

  // Soft over-qty hint. Producing more than the line's planned kg can be
  // legitimate (catch-up / rework), so we don't block — but an accidental
  // extra digit is easy to miss, so we flag it. Hard reconciliation against
  // the live pending qty is enforced server-side when the create endpoint is
  // wired (see the Create-Job-Card backend design).
  const plannedKg = selectedLine?.planned_qty_kg != null ? Number(selectedLine.planned_qty_kg) : null;
  const overQty = plannedKg != null && plannedKg > 0 && Number(qtyKg) > plannedKg;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Create job card"
    >
      <div
        className="bg-white rounded-md shadow-[0_8px_28px_rgba(0,28,36,0.28)] w-full max-w-[460px] max-h-[80vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-[var(--aws-border)] flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">
              {mode === "edit" ? "Edit Job Card" : "Create Job Card"}
            </h2>
            <p className="text-[11px] text-[var(--text-secondary)] mt-0.5 truncate">
              {plan.plan_name || `Plan #${plan.plan_id}`} · {step === 1 ? "pick an article" : "quantity & steps"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 w-7 h-7 inline-flex items-center justify-center rounded-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-subtle)]"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {step === 1 ? (
          <div className="overflow-y-auto p-2">
            {lines.length === 0 ? (
              <p className="text-[12px] text-[var(--text-muted)] italic p-3">This plan has no articles.</p>
            ) : (
              <ul className="space-y-1">
                {lines.map((l, i) => {
                  const id = getLineId(l, i);
                  const kg = l.planned_qty_kg != null ? fmtPlanKg(l.planned_qty_kg) : null;
                  const pcs = l.planned_qty_units != null && l.planned_qty_units !== ""
                    ? String(l.planned_qty_units) : null;
                  const checked = selected === id;
                  const carded = (l.job_card_count ?? 0) > 0;
                  return (
                    <li key={id}>
                      <label
                        className={[
                          "flex items-center gap-2.5 px-3 py-2 rounded-sm border cursor-pointer transition-colors",
                          checked
                            ? "border-[var(--aws-orange)] bg-[#fef6e7]"
                            : "border-[var(--aws-border)] hover:border-[var(--aws-navy)]",
                        ].join(" ")}
                      >
                        <input
                          type="radio"
                          name="jc-article"
                          checked={checked}
                          onChange={() => {
                            // Switching article drops the previous article's qty
                            // and edit state so goNext re-resolves from the newly
                            // picked line (create-prefill or edit-prefill).
                            if (selected !== id) {
                              setSelected(id);
                              setQtyKg("");
                              setQtyUnits("");
                              setMode("create");
                              setEditable(true);
                            }
                          }}
                          className="accent-[var(--aws-orange)]"
                        />
                        <span className="flex-1 min-w-0">
                          <span className="flex items-center gap-1.5 min-w-0">
                            <span className="text-[13px] text-[var(--text-primary)] truncate" title={l.fg_sku_name ?? ""}>
                              {l.fg_sku_name || "—"}
                            </span>
                            {carded ? (
                              <span className="shrink-0 px-1 py-0.5 text-[9px] font-bold uppercase rounded-[2px] border bg-[#eef7ee] text-[#2e7d32] border-[#bfe0c0]">
                                Carded
                              </span>
                            ) : null}
                          </span>
                          {(kg != null || pcs != null) ? (
                            <span className="block text-[11px] font-mono text-[var(--text-muted)]">
                              {kg != null ? `${kg} kg` : ""}{kg != null && pcs != null ? " · " : ""}{pcs != null ? `${pcs} pcs` : ""}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : (
          <div className="overflow-y-auto p-4 space-y-4">
            <div className="text-[12px]">
              <span className="text-[var(--text-muted)]">Article: </span>
              <span className="font-semibold text-[var(--text-primary)]">{selectedLine?.fg_sku_name ?? "—"}</span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">
                  Quantity (kg) <span className="text-[var(--aws-error)]">*</span>
                </span>
                <input
                  type="number"
                  step="any"
                  min="0"
                  value={qtyKg}
                  onChange={(e) => setQtyKg(e.target.value)}
                  placeholder="0"
                  className="w-full h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
                />
              </label>
              <label className="block">
                <span className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">Units (nos)</span>
                <input
                  type="number"
                  step="any"
                  min="0"
                  value={qtyUnits}
                  onChange={(e) => setQtyUnits(e.target.value)}
                  placeholder="0"
                  className="w-full h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
                />
              </label>
            </div>

            {overQty ? (
              <p className="text-[11px] text-[#9a393e] -mt-2">
                Quantity exceeds this article&apos;s planned {fmtPlanKg(plannedKg!)} kg — double-check before creating.
              </p>
            ) : null}

            <div className="space-y-3">
              {/* WIP — one or more processes, each on its own floor */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[11px] uppercase tracking-wide font-semibold text-[var(--text-secondary)]">
                    WIP <span className="text-[var(--aws-error)]">*</span>
                  </span>
                  <button
                    type="button"
                    onClick={addWipProcess}
                    className="h-6 px-2 text-[11px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] inline-flex items-center gap-1"
                  >
                    <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    Add process
                  </button>
                </div>
                <WipProcessList steps={wipSteps} floors={floors} onChange={setWipSteps} />
              </div>

              {/* Packaging — single floor */}
              <StepFloorRow label="Packaging" floors={floors} value={pkgFloor} onChange={setPkgFloor} />

              {floors.length === 0 ? (
                <p className="text-[10px] text-[var(--text-muted)] italic">
                  No floor list for this warehouse — enter the floor name.
                </p>
              ) : null}
            </div>

            {mode === "edit" && !editable ? (
              <p className="px-2 py-1.5 text-[11px] rounded border text-[#9a393e] border-[var(--aws-border)] bg-[#fdf0f1]">
                These job cards have already started — they can&apos;t be edited.
              </p>
            ) : null}

            {/* BOM per process step (read-only). RM+PM under the first WIP
                step, SFG opening-input under packaging — the operational
                model of how job cards actually issue material. */}
            <MaterialsByStep
              wipSteps={wipSteps}
              pkgFloor={pkgFloor}
              bom={bom}
              loading={bomLoading}
              err={bomErr}
              hasBom={selectedBomId != null}
            />
          </div>
        )}

        <div className="px-4 py-3 border-t border-[var(--aws-border)] flex items-center justify-between gap-2">
          {step === 1 ? (
            <>
              <span className="text-[11px] text-[var(--text-muted)] italic">Pick the article to make a job card for.</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={selected == null || loadingCfg}
                  onClick={goNext}
                  className="h-8 px-4 text-[12px] rounded-[2px] font-semibold border bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loadingCfg ? "Loading…" : "Next"}
                </button>
              </div>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setStep(1)}
                className="h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]"
              >
                Back
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!canSubmit || creating}
                  onClick={async () => {
                    setCreating(true);
                    const ok = await onContinue({ planLineId: selected, qtyKg, qtyUnits, wipSteps, pkgFloor, mode });
                    if (ok) onClose();        // success → modal unmounts
                    else setCreating(false);  // failure → stay open (toast shows why)
                  }}
                  className="h-8 px-4 text-[12px] rounded-[2px] font-semibold border bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {creating
                    ? (mode === "edit" ? "Saving…" : "Creating…")
                    : (mode === "edit" ? "Save changes" : "Create Job Card")}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// WIP process list — mirrors the planning page's StepsSection logic
// (drag + ↑/↓ reorder, multi-select merge, remove) adapted to the WIP
// { process, floor } shape. Merge joins process names with " + " and keeps a
// floor only when the selected rows agree (conflict → blank, operator re-picks),
// matching planning's mergeCardSteps. State (drag + merge-selection) is local;
// committed changes flow up through onChange.
type WipStep = { process: string; floor: string; sfgOutput: string };

function WipProcessList({
  steps, floors, onChange,
}: {
  steps: WipStep[];
  floors: string[];
  onChange: (next: WipStep[]) => void;
}) {
  const dragFromRef = useRef<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [selectedIdxs, setSelectedIdxs] = useState<Set<number>>(new Set());

  // Merge is one-shot — once the list length changes the indices no longer
  // line up, so clear the selection. Deferred past the effect body to satisfy
  // the no-sync-setState-in-effect rule (same pattern as planning).
  useEffect(() => {
    queueMicrotask(() => setSelectedIdxs(new Set()));
  }, [steps.length]);

  const allSelected = steps.length > 0 && selectedIdxs.size === steps.length;
  const anySelected = selectedIdxs.size > 0;

  function move(from: number, to: number) {
    if (from < 0 || from >= steps.length || to < 0 || to >= steps.length || from === to) return;
    const next = steps.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
  }
  function setField(i: number, patch: Partial<WipStep>) {
    onChange(steps.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  }
  function remove(i: number) {
    if (steps.length <= 1) return;
    onChange(steps.filter((_, j) => j !== i));
  }
  function toggleSelect(i: number) {
    setSelectedIdxs((prev) => {
      const n = new Set(prev);
      if (n.has(i)) n.delete(i); else n.add(i);
      return n;
    });
  }
  function selectAll(on: boolean) {
    setSelectedIdxs(on ? new Set(steps.map((_, i) => i)) : new Set());
  }
  function merge() {
    const valid = [...selectedIdxs].filter((i) => i >= 0 && i < steps.length).sort((a, b) => a - b);
    if (valid.length < 2) return;
    const picked = valid.map((i) => steps[i]);
    const process = picked.map((p) => p.process || "—").join(" + ");
    const uniqueFloors = new Set(picked.map((p) => p.floor).filter(Boolean));
    const floor = uniqueFloors.size === 1 ? [...uniqueFloors][0] : "";
    // Preserve every distinct SFG output rather than silently keeping only the
    // first — output identity is load-bearing for the SFG seam, so dropping the
    // rest would lose the codes the operator entered. Distinct, in order; the
    // operator can prune the joined value if the merge was a mistake.
    const sfgOutput = [...new Set(picked.map((p) => p.sfgOutput).filter(Boolean))].join(" + ");
    const [firstIdx, ...rest] = valid;
    const next = steps.slice();
    // Remove the trailing merged rows right-to-left so earlier indices stay put,
    // then write the merged step into the first selected slot.
    [...rest].reverse().forEach((i) => next.splice(i, 1));
    next[firstIdx] = { process, floor, sfgOutput };
    setSelectedIdxs(new Set());
    onChange(next);
  }

  const iconBtn = "w-6 h-7 inline-flex items-center justify-center rounded-sm text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)] disabled:opacity-30 disabled:cursor-not-allowed";

  return (
    <div>
      {/* Process checklist toolbar — a checkbox per process (below) plus
          Select-all + Merge here. Always shown; Merge stays disabled until 2+
          processes are checked. Mirrors the planning page's StepsSection. */}
      <div className="flex flex-wrap items-center gap-2 mb-1.5 px-2 py-1.5 bg-[var(--surface-subtle)] border border-[var(--aws-border)] rounded">
          <label className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)] cursor-pointer">
            <input
              type="checkbox"
              checked={allSelected}
              ref={(el) => { if (el) el.indeterminate = anySelected && !allSelected; }}
              onChange={(e) => selectAll(e.target.checked)}
              className="accent-[var(--aws-orange)]"
            />
            <span>Select all</span>
          </label>
          <span className="text-[11px] text-[var(--text-muted)]">·</span>
          <span className="text-[11px] text-[var(--text-secondary)]">
            <strong className="text-[var(--text-primary)]">{selectedIdxs.size}</strong> selected
          </span>
          <div className="flex-1" />
          <button
            type="button"
            disabled={selectedIdxs.size < 2}
            onClick={merge}
            title="Combine the selected processes into one (names joined with +)"
            className={[
              "h-7 px-2.5 text-[11px] rounded-[2px] font-semibold border inline-flex items-center gap-1.5",
              selectedIdxs.size < 2
                ? "bg-[var(--surface-disabled)] border-[var(--aws-border)] text-[var(--text-disabled)] cursor-not-allowed"
                : "bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white",
            ].join(" ")}
          >
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <polyline points="8 12 3 12 8 7" /><polyline points="16 12 21 12 16 17" /><line x1="3" y1="12" x2="21" y2="12" />
            </svg>
            Merge processes
          </button>
      </div>

      <ol className="space-y-1.5">
        {steps.map((s, i) => {
          const isDragOver = dragOverIdx === i;
          return (
            <li
              key={`${s.process}-${i}`}
              draggable
              onDragStart={(e) => { dragFromRef.current = i; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(i)); }}
              onDragEnd={() => { dragFromRef.current = null; setDragOverIdx(null); }}
              onDragOver={(e) => { if (dragFromRef.current == null) return; e.preventDefault(); setDragOverIdx(i); }}
              onDragLeave={() => setDragOverIdx((c) => (c === i ? null : c))}
              onDrop={(e) => { e.preventDefault(); const from = dragFromRef.current; if (from == null || from === i) return; move(from, i); dragFromRef.current = null; setDragOverIdx(null); }}
              className={[
                "border rounded bg-white px-2 py-1.5",
                isDragOver ? "border-[var(--aws-orange)] bg-[#fdf0f1]" : "border-[var(--aws-border)]",
              ].join(" ")}
            >
              <div className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={selectedIdxs.has(i)}
                  onChange={() => toggleSelect(i)}
                  title="Select to merge"
                  className="accent-[var(--aws-orange)] shrink-0"
                />
                <span aria-hidden title="Drag to reorder" className="shrink-0 inline-flex items-center justify-center w-4 h-7 text-[var(--text-muted)] cursor-grab active:cursor-grabbing">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
                    <circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" /><circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" /><circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" />
                  </svg>
                </span>
                <span className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full bg-[var(--aws-navy)] text-white text-[10px] font-bold">{i + 1}</span>
                {/* Process + floor stacked in one aligned column; the process
                    name truncates with … and shows full on hover (title). */}
                <div className="flex-1 min-w-0 space-y-1">
                  <select
                    value={s.process}
                    onChange={(e) => setField(i, { process: e.target.value })}
                    title={s.process || undefined}
                    className="w-full truncate h-7 px-1.5 text-[12px] font-semibold rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
                  >
                    <option value="">— Process —</option>
                    {PROCESS_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                  {floors.length > 0 ? (
                    <select
                      value={s.floor}
                      onChange={(e) => setField(i, { floor: e.target.value })}
                      title={s.floor || undefined}
                      className="w-full truncate h-7 px-1.5 text-[12px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
                    >
                      <option value="">— Floor —</option>
                      {floors.map((f) => <option key={f} value={f}>{f}</option>)}
                    </select>
                  ) : (
                    <input
                      value={s.floor}
                      onChange={(e) => setField(i, { floor: e.target.value })}
                      placeholder="Floor"
                      className="w-full h-7 px-1.5 text-[12px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
                    />
                  )}
                  <input
                    value={s.sfgOutput}
                    onChange={(e) => setField(i, { sfgOutput: e.target.value })}
                    title={s.sfgOutput || undefined}
                    placeholder="SFG output (e.g. SFG0042)"
                    className="w-full truncate h-7 px-1.5 text-[12px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
                  />
                </div>
                <div className="flex items-center gap-0.5 shrink-0">
                  <button type="button" onClick={() => move(i, i - 1)} disabled={i === 0} aria-label="Move up" className={iconBtn}>
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><polyline points="6 15 12 9 18 15" /></svg>
                  </button>
                  <button type="button" onClick={() => move(i, i + 1)} disabled={i === steps.length - 1} aria-label="Move down" className={iconBtn}>
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
                  </button>
                  <button type="button" onClick={() => remove(i)} disabled={steps.length <= 1} aria-label="Remove process" className={[iconBtn, "hover:text-[var(--aws-error)]"].join(" ")}>
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// Required floor field for a job-card step (WIP / Packaging). A select when the
// plan's warehouse has a known floor set, else a free-text input.
function StepFloorRow({
  label, floors, value, onChange,
}: {
  label: string; floors: string[]; value: string; onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-[88px] shrink-0 text-[12px] font-medium text-[var(--text-primary)]">
        {label} <span className="text-[var(--aws-error)]">*</span>
      </span>
      {floors.length > 0 ? (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
        >
          <option value="">— Pick floor —</option>
          {floors.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Floor"
          className="flex-1 h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
        />
      )}
    </div>
  );
}

// Read-only "Materials per step" — maps the BOM's RM / PM / SFG lines onto the
// job card's process steps using the OPERATIONAL model (how job cards actually
// issue material, per job_card_v2._materialise_indents): ALL RM + PM are issued
// on the FIRST WIP step; intermediate WIP steps consume upstream WIP and issue
// nothing fresh; any SFG opening-input is consumed at the packaging (Final FG)
// step. Reflects the live wipSteps order, so reordering updates which step is
// "first". Renders nothing for articles without a BOM (e.g. RM SOs).
function MaterialsByStep({
  wipSteps, pkgFloor, bom, loading, err, hasBom,
}: {
  wipSteps: WipStep[];
  pkgFloor: string;
  bom: PlanBomSummary | null;
  loading: boolean;
  err: string | null;
  hasBom: boolean;
}) {
  if (!hasBom) return null;

  const kind = (t: string | null | undefined) => (t ?? "").trim().toLowerCase();
  const allLines = bom?.lines ?? [];
  const rm = allLines.filter((l) => kind(l.item_type) === "rm");
  const pm = allLines.filter((l) => kind(l.item_type) === "pm");
  const sfg = allLines.filter((l) => kind(l.item_type) === "sfg");

  const chip = (t: string | null | undefined) => {
    const k = kind(t);
    const cls =
      k === "rm" ? "bg-[#fef6e7] text-[#8a6d1a] border-[#e8d8a8]"
      : k === "pm" ? "bg-[#eef4fb] text-[var(--aws-navy)] border-[#c9ddf2]"
      : k === "sfg" ? "bg-[#fdeee0] text-[#9a5a14] border-[#f0c79a]"
      : "bg-[var(--surface-subtle)] text-[var(--text-secondary)] border-[var(--aws-border)]";
    return (
      <span className={`shrink-0 px-1 py-0.5 text-[9px] font-bold uppercase rounded-[2px] border ${cls}`}>
        {t || "—"}
      </span>
    );
  };

  // A plain render helper (NOT a nested component) so it doesn't trip the
  // unstable-nested-component rule and never remounts the rows.
  const renderRows = (rows: PlanBomLine[]) =>
    rows.length === 0 ? null : (
      <ul className="mt-1 space-y-0.5">
        {rows.map((l, i) => (
          <li key={`${l.bom_line_id ?? "x"}-${i}`} className="flex items-center gap-1.5 text-[11px]">
            {chip(l.item_type)}
            <span className="flex-1 min-w-0 truncate text-[var(--text-primary)]" title={l.material_sku_name ?? ""}>
              {l.material_sku_name || "—"}
            </span>
            <span className="shrink-0 font-mono text-[var(--text-secondary)]">
              {l.quantity_per_unit != null ? l.quantity_per_unit : "—"}{l.uom ? ` ${l.uom}` : ""}
            </span>
            {l.godown ? <span className="shrink-0 text-[10px] text-[var(--text-muted)]">{l.godown}</span> : null}
          </li>
        ))}
      </ul>
    );

  return (
    <div>
      <span className="text-[11px] uppercase tracking-wide font-semibold text-[var(--text-secondary)]">
        Materials per step
      </span>
      {loading ? (
        <div className="mt-1.5 text-[11px] text-[var(--text-secondary)] flex items-center gap-2 py-1">
          <span className="inline-block w-3 h-3 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
          Loading BOM…
        </div>
      ) : err ? (
        <p className="mt-1.5 px-2 py-1.5 text-[11px] italic rounded border text-[var(--aws-error)] border-[var(--aws-border)] bg-[#fdf0f1]">
          {err}
        </p>
      ) : allLines.length === 0 ? (
        <p className="mt-1.5 px-2 py-1.5 text-[11px] italic rounded border border-dashed border-[var(--aws-border)] bg-[var(--surface-subtle)] text-[var(--text-muted)]">
          No BOM materials configured for this article.
        </p>
      ) : (
        <div className="mt-1.5 space-y-1.5">
          {wipSteps.map((s, i) => (
            <div key={`${s.process}-${i}`} className="border border-[var(--aws-border)] rounded px-2 py-1.5 bg-white">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--text-primary)]">
                <span className="shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-full bg-[var(--aws-navy)] text-white text-[9px] font-bold">{i + 1}</span>
                <span className="truncate" title={s.process || undefined}>{s.process || `WIP step ${i + 1}`}</span>
                {s.floor ? <span className="shrink-0 text-[10px] font-normal text-[var(--text-muted)]">· {s.floor}</span> : null}
              </div>
              {i === 0 ? (
                rm.length + pm.length === 0 ? (
                  <p className="mt-1 text-[10px] italic text-[var(--text-muted)]">No RM/PM in this BOM.</p>
                ) : (
                  <>
                    {renderRows(rm)}
                    {renderRows(pm)}
                  </>
                )
              ) : (
                <p className="mt-1 text-[10px] italic text-[var(--text-muted)]">
                  Consumes WIP from the previous stage — no fresh material issued.
                </p>
              )}
            </div>
          ))}

          {/* Packaging — the Final FG stage; consumes the SFG opening input. */}
          <div className="border border-[var(--aws-border)] rounded px-2 py-1.5 bg-white">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--text-primary)]">
              <span className="shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-full bg-[var(--aws-orange)] text-white text-[9px] font-bold">P</span>
              <span>Packaging</span>
              {pkgFloor ? <span className="shrink-0 text-[10px] font-normal text-[var(--text-muted)]">· {pkgFloor}</span> : null}
            </div>
            {sfg.length > 0 ? (
              renderRows(sfg)
            ) : (
              <p className="mt-1 text-[10px] italic text-[var(--text-muted)]">
                Final FG / packing — no opening SFG in this BOM.
              </p>
            )}
          </div>

          <p className="text-[10px] text-[var(--text-muted)] leading-snug">
            RM + PM are issued on the first stage (matching how job cards issue material); any SFG opening input is consumed at packaging.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Inline preview (shown when a row is expanded) ──────────────────────
//
// Lazy-loads via GET /plans-v2/{id} and surfaces a compact summary: header
// audit metadata + lines table (or stacked cards on mobile) + per-line
// floor + step counts. Mirrors the same lazy + cancel pattern used by the
// Planning page's DetailPanel so it survives rapid expand/collapse.

function PlanInlinePreview({
  planId, onOpen,
}: {
  planId: number;
  onOpen: () => void;
}) {
  const [detail, setDetail] = useState<PlanDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const c = new AbortController();
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const d = await getPlan(planId, c.signal);
        if (!c.signal.aborted) setDetail(d);
      } catch (e) {
        if (!c.signal.aborted) setError(friendlyApiError(e));
      } finally {
        if (!c.signal.aborted) setLoading(false);
      }
    })();
    return () => c.abort();
  }, [planId]);

  if (loading) {
    return (
      <p className="text-[11px] text-[var(--text-secondary)] flex items-center gap-2">
        <span className="inline-block w-3 h-3 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
        Loading plan…
      </p>
    );
  }
  if (error) return <p className="text-[11px] text-[var(--aws-error)]">{error}</p>;
  if (!detail) return null;

  const lines = detail.lines ?? [];

  return (
    <div className="space-y-3">
      {/* Compact KV grid for plan-level audit data */}
      <dl className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-x-4 gap-y-1.5 text-[12px]">
        <PreviewKV label="Plan ID"     value={`#${detail.plan_id}`} mono />
        <PreviewKV label="Entity"      value={detail.entity?.toUpperCase()} />
        <PreviewKV label="Plan date"   value={detail.plan_date ? fmtPlanDate(detail.plan_date) : undefined} />
        <PreviewKV label="Created by"  value={detail.created_by} />
        <PreviewKV label="Created at"  value={detail.created_at ? fmtPlanDate(detail.created_at) : undefined} />
        {detail.approved_at ? (
          <PreviewKV
            label="Approved"
            value={`${detail.approved_by ?? "—"} · ${fmtPlanDate(detail.approved_at)}`}
          />
        ) : null}
      </dl>

      {/* Lines preview — mobile cards / desktop table */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)]">
            Lines · {lines.length}
          </span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onOpen(); }}
            className="text-[11px] text-[var(--aws-link)] hover:underline inline-flex items-center gap-1"
          >
            Open approval workspace
            <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </button>
        </div>
        {lines.length === 0 ? (
          <p className="text-[11px] text-[var(--text-muted)] italic">No lines on this plan.</p>
        ) : (
          <PreviewLinesList lines={lines.slice(0, 6)} />
        )}
        {lines.length > 6 ? (
          <p className="text-[10px] text-[var(--text-muted)] mt-1">
            Showing first 6 of {lines.length} lines · open the approval workspace to see all.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function PreviewKV({ label, value, mono }: { label: string; value?: string | number | null; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="uppercase tracking-wide font-semibold text-[var(--text-muted)] text-[9px] leading-[12px]">
        {label}
      </div>
      <div className={["text-[12px] leading-[16px] text-[var(--text-primary)] truncate", mono ? "font-mono" : ""].join(" ")}>
        {value == null || value === "" ? "—" : value}
      </div>
    </div>
  );
}

function PreviewLinesList({ lines }: { lines: PlanLineRow[] }) {
  return (
    <>
      {/* Mobile (< sm): stacked rows */}
      <ul className="sm:hidden space-y-1.5">
        {lines.map((l) => (
          <li key={l.plan_line_id} className="border border-[var(--aws-border)] rounded bg-white px-2 py-1.5">
            <div className="text-[12px] font-semibold text-[var(--text-primary)] truncate" title={l.fg_sku_name ?? ""}>
              {l.fg_sku_name || "—"}
            </div>
            <div className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted)] truncate">
              {l.customer_name || "—"}
            </div>
            <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] mt-1">
              <span className="font-semibold">{fmtPlanKg(l.planned_qty_kg)} kg</span>
              {l.planned_qty_units != null ? <span className="text-[var(--text-muted)]">{l.planned_qty_units} pcs</span> : null}
              {l.area ? <span className="text-[var(--text-secondary)]">@ {l.area}</span> : null}
              {l.deadline_date ? <span className="text-[var(--text-muted)]">· {fmtPlanDate(l.deadline_date)}</span> : null}
              {l.steps && l.steps.length > 0 ? (
                <span className="text-[10px] font-semibold text-[var(--text-secondary)] bg-[var(--surface-subtle)] border border-[var(--aws-border)] rounded-sm px-1 py-0">
                  {l.steps.length} steps
                </span>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {/* sm+: table */}
      <div className="hidden sm:block bg-white border border-[var(--aws-border)] rounded overflow-hidden">
        <table className="w-full text-[11px] border-collapse">
          <thead className="bg-[var(--surface-subtle)] text-[var(--text-muted)]">
            <tr>
              <th className="px-2 py-1 text-left text-[10px] font-bold uppercase tracking-wide">FG SKU</th>
              <th className="px-2 py-1 text-left text-[10px] font-bold uppercase tracking-wide">Customer</th>
              <th className="px-2 py-1 text-right text-[10px] font-bold uppercase tracking-wide">Qty (kg)</th>
              <th className="px-2 py-1 text-right text-[10px] font-bold uppercase tracking-wide">Pcs</th>
              <th className="px-2 py-1 text-left text-[10px] font-bold uppercase tracking-wide">Floor / Area</th>
              <th className="px-2 py-1 text-left text-[10px] font-bold uppercase tracking-wide">Deadline</th>
              <th className="px-2 py-1 text-right text-[10px] font-bold uppercase tracking-wide">Steps</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const stepsWithFloor = (l.steps ?? []).filter((s) => !!s.floor).length;
              return (
                <tr key={l.plan_line_id} className="border-t border-[var(--aws-border)]">
                  <td className="px-2 py-1 max-w-[220px] truncate" title={l.fg_sku_name ?? ""}>{l.fg_sku_name || "—"}</td>
                  <td className="px-2 py-1 max-w-[180px] truncate" title={l.customer_name ?? ""}>{l.customer_name || "—"}</td>
                  <td className="px-2 py-1 text-right font-mono">{fmtPlanKg(l.planned_qty_kg)}</td>
                  <td className="px-2 py-1 text-right font-mono">{l.planned_qty_units ?? "—"}</td>
                  <td className="px-2 py-1 text-[var(--text-secondary)]">{l.area || "—"}</td>
                  <td className="px-2 py-1 text-[var(--text-secondary)] whitespace-nowrap">
                    {l.deadline_date ? fmtPlanDate(l.deadline_date) : "—"}
                  </td>
                  <td className="px-2 py-1 text-right font-mono">
                    {l.steps?.length ?? 0}
                    {stepsWithFloor > 0 ? <span className="text-[10px] text-[var(--text-muted)] ml-1">({stepsWithFloor} floored)</span> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ── Badges ───────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status?: string | null }) {
  const s = (status || "draft").toLowerCase();
  const styles: Record<string, string> = {
    draft:     "text-[var(--aws-link)] bg-[#eaf3ff] border-[#bbd9f3]",
    approved:  "text-[#1d8102] bg-[#eaf6ed] border-[#b6dbb1]",
    executed:  "text-[#5752c4] bg-[#f0eef8] border-[#d2cef0]",
    cancelled: "text-[var(--text-muted)] bg-[var(--surface-subtle)] border-[var(--aws-border)]",
  };
  const cls = styles[s] ?? "text-[var(--text-secondary)] bg-[#f4f4f4] border-[#d5dbdb]";
  return (
    <span className={["inline-block text-[10px] font-semibold capitalize px-1.5 py-0.5 rounded-sm border", cls].join(" ")}>
      {s}
    </span>
  );
}

function TypeBadge({ type }: { type?: string | null }) {
  const t = (type || "daily").toLowerCase();
  const cls = t === "weekly"
    ? "text-[#9a393e] bg-[#fbeced] border-[#e6bcbe]"
    : "text-[var(--text-secondary)] bg-[var(--surface-subtle)] border-[var(--aws-border)]";
  return (
    <span className={["inline-block text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-sm border", cls].join(" ")}>
      {t}
    </span>
  );
}

// ── Pagination ──────────────────────────────────────────────────────────

function Pagination({
  pg, onPage, loading,
}: {
  pg: PlanPagination;
  onPage: (p: number) => void;
  loading: boolean;
}) {
  const page = pg.page ?? 1;
  const totalPages = pg.total_pages ?? 1;
  const total = pg.total ?? 0;
  const pageSize = pg.page_size ?? PAGE_SIZE;
  if (totalPages <= 1) return null;
  const start = total ? (page - 1) * pageSize + 1 : 0;
  const end = Math.min(page * pageSize, total);

  const maxVisible = 5;
  let startPage = Math.max(1, page - Math.floor(maxVisible / 2));
  const endPage = Math.min(totalPages, startPage + maxVisible - 1);
  if (endPage - startPage + 1 < maxVisible) {
    startPage = Math.max(1, endPage - maxVisible + 1);
  }
  const pageNums: number[] = [];
  for (let i = startPage; i <= endPage; i++) pageNums.push(i);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-1 py-2 text-[11px]">
      <span className="text-[var(--text-secondary)]">
        Showing {start}–{end} of {total} plans
      </span>
      <div className="flex items-center gap-1">
        <PageBtn disabled={page <= 1 || loading} onClick={() => onPage(page - 1)} aria="Previous">‹</PageBtn>
        {startPage > 1 ? (
          <>
            <PageBtn onClick={() => onPage(1)}>{1}</PageBtn>
            {startPage > 2 ? <span className="px-1 text-[var(--text-muted)]">…</span> : null}
          </>
        ) : null}
        {pageNums.map((p) => (
          <PageBtn key={p} active={p === page} onClick={() => onPage(p)}>{p}</PageBtn>
        ))}
        {endPage < totalPages ? (
          <>
            {endPage < totalPages - 1 ? <span className="px-1 text-[var(--text-muted)]">…</span> : null}
            <PageBtn onClick={() => onPage(totalPages)}>{totalPages}</PageBtn>
          </>
        ) : null}
        <PageBtn disabled={page >= totalPages || loading} onClick={() => onPage(page + 1)} aria="Next">›</PageBtn>
      </div>
    </div>
  );
}

function PageBtn({
  children, onClick, disabled, active, aria,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  aria?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={aria}
      className={[
        "min-w-[24px] h-6 px-1.5 text-[11px] rounded-sm border",
        active
          ? "bg-[var(--aws-navy)] text-white border-[var(--aws-navy)]"
          : "bg-white text-[var(--text-primary)] border-[var(--aws-border-strong)] hover:border-[var(--aws-navy)]",
        disabled ? "opacity-50 cursor-not-allowed hover:border-[var(--aws-border-strong)]" : "",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

