"use client";

// Planning page — replicates
// frontend_replica/src/modules/production/fulfillment/* (the SO Fulfillment
// flow) on the new web stack. Operators see open SO demand grouped by SO,
// filter by entity / customer / SO / article, expand rows for detail,
// inline-edit deadlines, select rows, and create a plan from the selection.
//
// Out of scope this iteration (deferred to follow-ups; types live in
// @/lib/fulfillment so the wires don't have to be re-derived):
//   • BOM override modal (GET/PUT bom-override)
//   • Floor stock modal (GET/PUT floor-stock)
//   • Carryforward action
//   • WebSocket fulfillment.* live updates
//   • System health dot (the dot renders, but it's not polling /health)

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrandMark } from "@/components/BrandMark";
import { useRouter } from "next/navigation";
import { useRequireAuth, useUserInitial, useUserScope } from "@/lib/user";
import { friendlyApiError } from "@/lib/apiErrors";
import { usePlanBuilder, SelectedArticlesPanel } from "@/lib/planBuilder";
import { BackLink } from "@/components/BackLink";
import {
  type FulfillmentRow,
  type FulfillmentFilterOptions,
  type FulfillmentDetail,
  type FulfillmentDetailRow,
  type Pagination,
  listFulfillments,
  fetchFulfillmentFilterOptions,
  syncFulfillmentNow,
  fetchFulfillmentDetail,
  reviseFulfillment,
  fmtKg,
  fmtUnits,
  fmtDeadline,
  deadlineTone,
} from "@/lib/fulfillment";

const PAGE_SIZE = 50;

type Entity = "" | "cfpl" | "cdpl";

// Factory + floor masters, per-card override types/helpers, and the
// Selected-Articles plan-builder all live in the shared module
// (@/lib/planBuilder) — imported above. This page adopts that module via the
// usePlanBuilder hook + SelectedArticlesPanel component below.

// ── Page ──────────────────────────────────────────────────────────────────

export default function PlanningPage() {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);
  const initial = useUserInitial();
  const scope = useUserScope();

  // Filter state
  const [entity, setEntity] = useState<Entity>("");
  const [customer, setCustomer] = useState<string[]>([]);
  const [soNumber, setSoNumber] = useState<string[]>([]);
  const [article, setArticle] = useState<string[]>([]);

  // Data state
  const [rows, setRows] = useState<FulfillmentRow[]>([]);
  const [pagination, setPagination] = useState<Pagination>({});
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Cross-filtered dropdown options
  const [filterOpts, setFilterOpts] = useState<FulfillmentFilterOptions>({});

  // UI state
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Plan-builder ("Selected for Plan") selection + per-card overrides +
  // Create-Plan path all live in the shared hook. It owns selectedIds,
  // cardCfg, selectedRowsCache, expandedCardId, creatingPlan + every card
  // handler — the page only feeds rows in on selection (see toggleSelection).
  const pb = usePlanBuilder({ entity, scope, onToast: setToast });

  // Adapter: the shared hook splits selection into selectRow(row)/deselect(id);
  // the planning list/mobile checkboxes call a single toggleSelection(id). Mirror
  // the old combined behaviour — look the row up from the live list to snapshot it.
  function toggleSelection(id: number) {
    if (pb.isSelected(id)) {
      pb.deselect(id);
    } else {
      const row = rows.find((r) => r.fulfillment_id === id);
      if (row) pb.selectRow(row);
    }
  }

  // Stable string fingerprints of array filters so effects don't re-fire on
  // every render-equal-but-reference-different value.
  const customerKey = customer.join("|");
  const soNumberKey = soNumber.join("|");
  const articleKey = article.join("|");

  // ── Load filter options (cross-filtered) ────────────────────────────────
  useEffect(() => {
    if (!authed) return;
    const c = new AbortController();
    void (async () => {
      try {
        const opts = await fetchFulfillmentFilterOptions(
          { entity, customer, so_number: soNumber, article },
          c.signal,
        );
        if (!c.signal.aborted) setFilterOpts(opts);
      } catch { /* ignore — toolbar just shows last good values */ }
    })();
    return () => c.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed, entity, customerKey, soNumberKey, articleKey]);

  // ── Load fulfillments ───────────────────────────────────────────────────
  useEffect(() => {
    if (!authed) return;
    const c = new AbortController();
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const resp = await listFulfillments(
          {
            entity,
            customer,
            so_number: soNumber,
            article,
            page,
            page_size: PAGE_SIZE,
          },
          c.signal,
        );
        if (c.signal.aborted) return;
        const incoming = sortByDeadline(resp.results ?? []);
        // Page 1 replaces; subsequent pages append.
        setRows((prev) => (page === 1 ? incoming : sortByDeadline([...prev, ...incoming])));
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
  }, [authed, entity, customerKey, soNumberKey, articleKey, page]);

  // Operator-stated: changing entity must NOT wipe in-flight plan work.
  // The list view re-fetches with the new entity scope automatically
  // (the fetch effect depends on `entity`), but the operator's
  // Selected Articles panel — selectedIds, cardCfg, selectedRowsCache,
  // expandedCardId — stays intact. They can flip CFPL ↔ CDPL while
  // composing a multi-entity plan without losing their qty / factory
  // / step / floor work.
  //
  // Page is reset to 1 because the LIST itself flips to the new
  // entity's fulfillments; that's a list-surface reset only.
  function changeEntity(v: Entity) {
    setEntity(v);
    setPage(1);
    setExpandedId(null);
  }
  const resetForFilterChange = useCallback(() => {
    // Filter change only resets the LIST surface — selected cards in the
    // panel must keep their cached row data + per-card overrides. This is
    // what makes `selectedRowsCache` necessary: server-side filtering
    // removes the underlying `rows` entries for unselected filter values,
    // and without the cache the cards would disappear from the panel.
    setPage(1);
    setExpandedId(null);
  }, []);

  function clearAllFilters() {
    setCustomer([]);
    setSoNumber([]);
    setArticle([]);
    resetForFilterChange();
  }

  const hasMore = useMemo(() => {
    const p = pagination.page ?? 1;
    const tp = pagination.total_pages ?? 1;
    return p < tp;
  }, [pagination]);

  // ── Build SO groups in stable input order ───────────────────────────────
  const groupedDisplay = useMemo(() => buildGroups(rows), [rows]);

  // ── Sync ────────────────────────────────────────────────────────────────
  async function onSync() {
    setSyncing(true);
    setToast(null);
    try {
      const r = await syncFulfillmentNow(entity || undefined);
      const synced = r.synced ?? r.summary?.synced ?? 0;
      setToast(synced ? `Synced ${synced} line${synced === 1 ? "" : "s"}.` : "Sync complete.");
      // Refresh list.
      setPage(1);
      // Trigger a refetch by toggling a dummy — easier: re-set page (no-op when 1)
      // and rely on the existing fetch effect. We can also bump page even if 1
      // is the same; React bails out. Instead, invalidate by clearing rows.
      setRows([]);
    } catch (e) {
      setToast(`Sync failed: ${friendlyApiError(e)}`);
    } finally {
      setSyncing(false);
    }
  }

  // ── Inline deadline edit ────────────────────────────────────────────────
  const [editingDeadlineId, setEditingDeadlineId] = useState<number | null>(null);

  async function saveDeadline(id: number, newDate: string) {
    if (!newDate) { setToast("Pick a date first."); return; }
    try {
      await reviseFulfillment(id, { new_date: newDate, reason: "Set by planner" });
      setToast("Deadline updated.");
      setEditingDeadlineId(null);
      // Patch the row locally so we don't refetch the world.
      setRows((prev) => prev.map((r) =>
        r.fulfillment_id === id ? { ...r, delivery_deadline: newDate } : r,
      ));
    } catch (e) {
      setToast(`Revise failed: ${friendlyApiError(e)}`);
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <PageHeader initial={initial} router={router} />

      <main
        className={[
          "flex-1 max-w-[1400px] w-full mx-auto px-4 sm:px-6 py-6",
          // When the mobile sticky CTA is visible (selection present), pad
          // the bottom so the last card isn't hidden under the bar.
          pb.selectedIds.size > 0 ? "pb-24 md:pb-6" : "",
        ].join(" ")}
      >
        <div className="mb-3">
          <BackLink parentHref="/modules/production" label="production" />
        </div>

        {/* Compact header — title + actions on a single row at md+, the
            descriptive subtitle drops to the second row only on desktop.
            Eyebrow chip + verbose subtitle removed to tighten the page
            entry; the breadcrumb already says "Modules / Production /
            Planning". */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-baseline gap-3 min-w-0">
            <h1 className="text-[20px] leading-[24px] font-semibold text-[var(--text-primary)] flex items-center gap-2">
              Planning
              <span
                className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--text-success)]"
                title="System health (not polling /health yet)"
              />
            </h1>
            <p className="hidden lg:inline text-[12px] text-[var(--text-muted)] truncate">
              Open demand by entity · set deadlines · build plans.
            </p>
          </div>
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <EntitySelector value={entity} onChange={changeEntity} />
            <button
              onClick={onSync}
              disabled={syncing}
              className="h-8 px-2.5 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] flex items-center gap-1.5 disabled:opacity-50"
              title="Sync fulfillment data from SAP"
            >
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2}>
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
              <span className="hidden sm:inline">{syncing ? "Syncing…" : "Sync"}</span>
            </button>
            <button
              onClick={() => void pb.onCreatePlan()}
              disabled={pb.creatingPlan || pb.selectedIds.size === 0}
              className="hidden md:inline-flex h-8 px-3 text-[12px] rounded-[2px] font-semibold border bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white disabled:opacity-50 disabled:cursor-not-allowed items-center gap-1.5"
            >
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2}>
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              {pb.creatingPlan
                ? "Creating…"
                : pb.selectedIds.size > 0
                  ? `Create Plan · ${pb.selectedIds.size}`
                  : "Create Plan"}
            </button>
          </div>
        </div>

        <FilterToolbar
          customer={customer}
          soNumber={soNumber}
          article={article}
          options={filterOpts}
          onCustomerChange={(v) => { setCustomer(v); resetForFilterChange(); }}
          onSoNumberChange={(v) => { setSoNumber(v); resetForFilterChange(); }}
          onArticleChange={(v) => { setArticle(v); resetForFilterChange(); }}
          onClearAll={clearAllFilters}
        />

        <SelectedArticlesPanel
          selectedIds={pb.selectedIds}
          rowsCache={pb.selectedRowsCache}
          cardCfg={pb.cardCfg}
          expandedCardId={pb.expandedCardId}
          scope={scope}
          factoryOpts={pb.factoryOpts}
          onToggleExpand={(id) => {
            pb.setExpandedCardId((c) => (c === id ? null : id));
            // Fire-and-forget; the function early-returns if the BOM is
            // already loaded or in flight. Idempotent on repeat expand.
            void pb.ensureStepsLoaded(id);
          }}
          onPatch={pb.patchCardOverride}
          onReset={pb.resetCardOverride}
          onRemove={(id) => toggleSelection(id)}
          onClearAll={pb.clearAllSelection}
          onSetFactory={pb.setCardFactory}
          onSetStepFloor={pb.setCardStepFloor}
          onSetStepProcess={pb.setCardStepProcess}
          onMoveStep={pb.moveCardStep}
          onMergeSteps={pb.mergeCardSteps}
          onAddStep={pb.addCardStep}
          onRemoveStep={pb.removeCardStep}
          onRefreshSteps={pb.refreshCardSteps}
        />

        {toast ? (
          <div className="mb-3 px-3 py-2 rounded-sm border border-[var(--aws-border)] bg-[#f1faff] text-[12px] text-[var(--text-primary)] flex items-center justify-between gap-2">
            <span>{toast}</span>
            <button onClick={() => setToast(null)} className="text-[var(--aws-link)] hover:underline">Dismiss</button>
          </div>
        ) : null}

        {loading && rows.length === 0 ? (
          <Centered>Loading fulfillment…</Centered>
        ) : error ? (
          <Centered tone="error">{error}</Centered>
        ) : groupedDisplay.length === 0 ? (
          <Centered>No fulfillment records match your filters.</Centered>
        ) : (
          <FulfillmentTable
            groups={groupedDisplay}
            openGroups={openGroups}
            onToggleGroup={(soNum) => {
              setOpenGroups((prev) => {
                const next = new Set(prev);
                if (next.has(soNum)) next.delete(soNum); else next.add(soNum);
                return next;
              });
            }}
            expandedId={expandedId}
            onExpand={(id) => setExpandedId((prev) => (prev === id ? null : id))}
            selectedIds={pb.selectedIds}
            onToggleSelection={toggleSelection}
            editingDeadlineId={editingDeadlineId}
            onStartEditDeadline={(id) => setEditingDeadlineId(id)}
            onCancelEditDeadline={() => setEditingDeadlineId(null)}
            onSaveDeadline={saveDeadline}
          />
        )}

        {hasMore ? (
          <div className="text-center py-4">
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={loading}
              className="h-8 px-4 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] disabled:opacity-50"
            >
              {loading ? "Loading…" : "Load more"}
            </button>
          </div>
        ) : null}
      </main>

      {/* Mobile sticky CTA — fixed at viewport bottom when at least one
          article is checked. Reuses onCreatePlan so it picks up factory +
          steps validation just like the desktop header button. */}
      {pb.selectedIds.size > 0 ? (
        <div className="md:hidden fixed bottom-0 left-0 right-0 z-20 bg-white border-t border-[var(--aws-border)] shadow-[0_-2px_8px_rgba(0,28,36,0.12)] px-4 py-3 flex items-center gap-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-semibold text-[var(--text-primary)] truncate">
              {pb.selectedIds.size} article{pb.selectedIds.size === 1 ? "" : "s"} selected
            </div>
            <div className="text-[11px] text-[var(--text-muted)] truncate">
              {entity ? `Entity: ${entity.toUpperCase()}` : "Pick an entity to plan"}
            </div>
          </div>
          <button
            onClick={() => void pb.onCreatePlan()}
            disabled={pb.creatingPlan}
            className="h-10 px-5 text-[13px] rounded-[2px] font-semibold border bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={2}>
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            {pb.creatingPlan ? "Creating…" : "Create Plan"}
          </button>
        </div>
      ) : null}

      <Footer />
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function toNum(v: number | string | null | undefined): number {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function sortByDeadline(rs: FulfillmentRow[]): FulfillmentRow[] {
  return [...rs].sort((a, b) => {
    const aD = a.delivery_deadline;
    const bD = b.delivery_deadline;
    if (!aD && !bD) return 0;
    if (!aD) return 1;
    if (!bD) return -1;
    return new Date(aD).getTime() - new Date(bD).getTime();
  });
}

interface SoGroup {
  // null = "loose" row (no SO grouping)
  soNumber: string | null;
  rows: FulfillmentRow[];
}

function buildGroups(rs: FulfillmentRow[]): SoGroup[] {
  const seen = new Set<string>();
  const groups: SoGroup[] = [];
  for (const r of rs) {
    const so = r.so_number && r.so_number !== "--" ? r.so_number : null;
    if (!so) { groups.push({ soNumber: null, rows: [r] }); continue; }
    if (seen.has(so)) continue;
    seen.add(so);
    groups.push({ soNumber: so, rows: rs.filter((x) => x.so_number === so) });
  }
  return groups;
}

// ── Chrome ───────────────────────────────────────────────────────────────

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
        <span className="text-white">Planning</span>
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

// ── Entity selector (segmented control) ─────────────────────────────────

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

// ── Filter toolbar ───────────────────────────────────────────────────────

function FilterToolbar({
  customer, soNumber, article, options,
  onCustomerChange, onSoNumberChange, onArticleChange, onClearAll,
}: {
  customer: string[]; soNumber: string[]; article: string[];
  options: FulfillmentFilterOptions;
  onCustomerChange: (v: string[]) => void;
  onSoNumberChange: (v: string[]) => void;
  onArticleChange: (v: string[]) => void;
  onClearAll: () => void;
}) {
  const anyActive = customer.length + soNumber.length + article.length > 0;
  const activeCount = customer.length + soNumber.length + article.length;
  return (
    <div className="border-b border-[var(--aws-border)] mb-3 pb-3 flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)] mr-1 hidden sm:inline">
        Filter
      </span>
      <MultiSelect
        triggerLabel="All Customers"
        selectedLabel="customer"
        selectedLabelPlural="customers"
        options={options.customers ?? []}
        value={customer}
        onChange={onCustomerChange}
        placeholder="Search customer…"
      />
      <MultiSelect
        triggerLabel="All SOs"
        selectedLabel="SO"
        selectedLabelPlural="SOs"
        options={options.so_numbers ?? []}
        value={soNumber}
        onChange={onSoNumberChange}
        placeholder="Search SO number…"
      />
      <MultiSelect
        triggerLabel="All Articles"
        selectedLabel="article"
        selectedLabelPlural="articles"
        options={options.articles ?? []}
        value={article}
        onChange={onArticleChange}
        placeholder="Search article…"
      />
      {anyActive ? (
        <button
          onClick={onClearAll}
          className="h-7 px-2.5 text-[11px] rounded-full border border-[var(--aws-border)] text-[var(--aws-error)] bg-white hover:bg-[#fdf3f1] hover:border-[var(--aws-error)] flex items-center gap-1"
          title={`${activeCount} active filter${activeCount === 1 ? "" : "s"}`}
        >
          <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
          Clear
        </button>
      ) : null}
    </div>
  );
}

function MultiSelect({
  triggerLabel, selectedLabel, selectedLabelPlural,
  options, value, onChange, placeholder,
}: {
  triggerLabel: string;
  selectedLabel: string;
  selectedLabelPlural: string;
  options: string[];
  value: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const visible = useMemo(() => {
    const lc = q.trim().toLowerCase();
    if (!lc) return options;
    return options.filter((o) => o.toLowerCase().includes(lc));
  }, [q, options]);

  function toggle(v: string) {
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  }

  const label = value.length === 0
    ? triggerLabel
    : value.length === 1
      ? value[0]
      : `${value.length} ${selectedLabelPlural}`;

  // Reuse selectedLabel singular when count is exactly one — avoids the
  // awkward "1 customers" plural fallback.
  const renderedLabel = value.length === 1 ? `1 ${selectedLabel}` : label;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={[
          "h-7 px-2.5 text-[12px] rounded-[2px] flex items-center gap-1.5 border transition-colors",
          value.length > 0
            ? "bg-[#eaf3ff] border-[#bbd9f3] text-[var(--aws-link)] hover:border-[var(--aws-navy)]"
            : "bg-white border-[var(--aws-border)] text-[var(--text-primary)] hover:border-[var(--aws-navy)]",
        ].join(" ")}
      >
        <span>{value.length === 0 ? triggerLabel : renderedLabel}</span>
        {value.length > 0 ? (
          <span className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 text-[10px] rounded-full bg-[var(--aws-navy)] text-white font-bold">
            {value.length}
          </span>
        ) : null}
        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open ? (
        <div className="absolute z-10 mt-1 w-[260px] max-w-[calc(100vw-1rem)] bg-white border border-[var(--aws-border)] rounded-md shadow-[0_4px_12px_rgba(0,28,36,0.18)] p-2">
          <input
            autoFocus
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={placeholder}
            className="w-full h-8 px-2 mb-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
          />
          <div className="max-h-[280px] overflow-y-auto">
            {visible.length === 0 ? (
              <p className="text-[12px] text-[var(--text-muted)] italic p-2">No matches.</p>
            ) : visible.map((opt) => {
              const checked = value.includes(opt);
              return (
                <label
                  key={opt}
                  className="flex items-center gap-2 px-2 py-1.5 text-[13px] hover:bg-[#f4f4f4] rounded-sm cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(opt)}
                    className="accent-[var(--aws-orange)]"
                  />
                  <span className="truncate" title={opt}>{opt}</span>
                </label>
              );
            })}
          </div>
          {value.length > 0 ? (
            <button
              type="button"
              onClick={() => onChange([])}
              className="w-full mt-1 px-2 py-1 text-[12px] text-[var(--aws-link)] hover:underline text-left"
            >
              Clear selection
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ── Table ────────────────────────────────────────────────────────────────

function FulfillmentTable({
  groups, openGroups, onToggleGroup,
  expandedId, onExpand,
  selectedIds, onToggleSelection,
  editingDeadlineId, onStartEditDeadline, onCancelEditDeadline, onSaveDeadline,
}: {
  groups: SoGroup[];
  openGroups: Set<string>;
  onToggleGroup: (soNum: string) => void;
  expandedId: number | null;
  onExpand: (id: number) => void;
  selectedIds: Set<number>;
  onToggleSelection: (id: number) => void;
  editingDeadlineId: number | null;
  onStartEditDeadline: (id: number) => void;
  onCancelEditDeadline: () => void;
  onSaveDeadline: (id: number, newDate: string) => void;
}) {
  return (
    <>
      {/* Mobile (< md): stacked cards. The desktop table has nine columns of
          fixed-width content; on phones we render each row as a card and
          collapse the SO group into a header card with expandable children.
          Both layouts share the same expandedId / selectedIds state, so
          interactions are continuous across viewport breakpoints. */}
      <div className="md:hidden space-y-2 mb-4">
        {groups.map((g, gi) => {
          if (g.soNumber == null) {
            const r = g.rows[0];
            return (
              <MobileDataCard
                key={`ml-${r.fulfillment_id}-${gi}`}
                row={r}
                inGroup={false}
                expanded={expandedId === r.fulfillment_id}
                onExpand={() => onExpand(r.fulfillment_id)}
                selected={selectedIds.has(r.fulfillment_id)}
                onToggleSelection={() => onToggleSelection(r.fulfillment_id)}
                editing={editingDeadlineId === r.fulfillment_id}
                onStartEditDeadline={() => onStartEditDeadline(r.fulfillment_id)}
                onCancelEditDeadline={onCancelEditDeadline}
                onSaveDeadline={onSaveDeadline}
              />
            );
          }
          return (
            <MobileGroupCard
              key={`mg-${g.soNumber}`}
              group={g}
              isOpen={openGroups.has(g.soNumber)}
              onToggleGroup={() => onToggleGroup(g.soNumber as string)}
              expandedId={expandedId}
              onExpand={onExpand}
              selectedIds={selectedIds}
              onToggleSelection={onToggleSelection}
              editingDeadlineId={editingDeadlineId}
              onStartEditDeadline={onStartEditDeadline}
              onCancelEditDeadline={onCancelEditDeadline}
              onSaveDeadline={onSaveDeadline}
            />
          );
        })}
      </div>

      {/* md+ desktop table */}
      <div className="hidden md:block bg-white border border-[var(--aws-border)] rounded-md overflow-hidden mb-4">
      <div className="overflow-x-auto">
        <table className="w-full text-[12px] border-collapse">
          <thead className="bg-[var(--surface-subtle)] text-[var(--text-primary)]">
            <tr className="border-b border-[var(--aws-border)]">
              <th className="px-2 py-1.5 w-[28px]" />
              <th className="px-1 py-1.5 w-[20px]" />
              <th className="px-2.5 py-1.5 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)]">Customer</th>
              <th className="px-2.5 py-1.5 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)]">SO</th>
              <th className="px-2.5 py-1.5 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)]">FG SKU</th>
              <th className="px-2.5 py-1.5 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)]">Pending</th>
              <th className="px-2.5 py-1.5 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)]">Deadline</th>
              <th className="px-2.5 py-1.5 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)]">Status</th>
              <th className="px-2.5 py-1.5 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)]" />
            </tr>
          </thead>
          <tbody>
            {groups.map((g, gi) => {
              if (g.soNumber == null) {
                // Loose (ungrouped) row.
                const r = g.rows[0];
                return (
                  <DataRowBlock
                    key={`l-${r.fulfillment_id}-${gi}`}
                    row={r}
                    inGroup={false}
                    expanded={expandedId === r.fulfillment_id}
                    onExpand={() => onExpand(r.fulfillment_id)}
                    selected={selectedIds.has(r.fulfillment_id)}
                    onToggleSelection={() => onToggleSelection(r.fulfillment_id)}
                    editing={editingDeadlineId === r.fulfillment_id}
                    onStartEditDeadline={() => onStartEditDeadline(r.fulfillment_id)}
                    onCancelEditDeadline={onCancelEditDeadline}
                    onSaveDeadline={onSaveDeadline}
                  />
                );
              }
              const isOpen = openGroups.has(g.soNumber);
              return (
                <GroupBlock
                  key={g.soNumber}
                  group={g}
                  isOpen={isOpen}
                  onToggleGroup={() => onToggleGroup(g.soNumber as string)}
                  expandedId={expandedId}
                  onExpand={onExpand}
                  selectedIds={selectedIds}
                  onToggleSelection={onToggleSelection}
                  editingDeadlineId={editingDeadlineId}
                  onStartEditDeadline={onStartEditDeadline}
                  onCancelEditDeadline={onCancelEditDeadline}
                  onSaveDeadline={onSaveDeadline}
                />
              );
            })}
          </tbody>
        </table>
      </div>
      </div>
    </>
  );
}

// ── Mobile cards (< md) ──────────────────────────────────────────────────

function MobileGroupCard({
  group, isOpen, onToggleGroup,
  expandedId, onExpand,
  selectedIds, onToggleSelection,
  editingDeadlineId, onStartEditDeadline, onCancelEditDeadline, onSaveDeadline,
}: {
  group: SoGroup;
  isOpen: boolean;
  onToggleGroup: () => void;
  expandedId: number | null;
  onExpand: (id: number) => void;
  selectedIds: Set<number>;
  onToggleSelection: (id: number) => void;
  editingDeadlineId: number | null;
  onStartEditDeadline: (id: number) => void;
  onCancelEditDeadline: () => void;
  onSaveDeadline: (id: number, newDate: string) => void;
}) {
  const count = group.rows.length;
  const totalKg = group.rows.reduce((s, a) => s + toNum(a.pending_qty_kg), 0);
  const dates = group.rows.map((a) => a.delivery_deadline).filter((x): x is string => !!x).sort();
  const earliest = dates[0] ?? null;
  const customer = group.rows[0]?.customer_name || "—";
  const statuses = new Set(group.rows.map((a) => a.status || "open"));
  const statusLabel = statuses.size === 1 ? [...statuses][0] : "mixed";
  const inPlanCount = group.rows.filter((a) => a.is_planned).length;

  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md overflow-hidden">
      <button
        type="button"
        onClick={onToggleGroup}
        className="w-full text-left px-2.5 py-2 bg-[var(--surface-subtle)] flex items-start gap-2 hover:bg-[#eef3f5]"
      >
        <svg
          viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"
          strokeWidth={2} className="mt-1 shrink-0 text-[var(--text-secondary)]"
          style={{ transform: isOpen ? "rotate(90deg)" : "none", transition: "transform .15s" }}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted)]">
            <span className="font-mono normal-case tracking-normal text-[var(--aws-link)] font-semibold">{group.soNumber}</span>
            <span className="opacity-50">·</span>
            <span>{count} article{count > 1 ? "s" : ""}</span>
          </div>
          <p className="text-[13px] text-[var(--text-primary)] truncate leading-tight" title={customer}>{customer}</p>
          <div className="flex items-center flex-wrap gap-x-2 gap-y-0.5 mt-1 text-[11px]">
            <span className="font-semibold text-[var(--text-primary)]">{fmtKg(totalKg)} kg</span>
            {earliest ? <DeadlineBadge iso={earliest} /> : null}
            <StatusPill status={statusLabel} />
            {inPlanCount > 0 ? (
              <span className="text-[10px] font-semibold text-[#1d8102] bg-[#eaf6ed] border border-[#b6dbb1] rounded-sm px-1.5 py-0">
                {inPlanCount}/{count} planned
              </span>
            ) : null}
          </div>
        </div>
      </button>
      {isOpen ? (
        <div className="border-t border-[var(--aws-border)] p-1.5 space-y-1.5 bg-[var(--background)]">
          {group.rows.map((r) => (
            <MobileDataCard
              key={r.fulfillment_id}
              row={r}
              inGroup
              expanded={expandedId === r.fulfillment_id}
              onExpand={() => onExpand(r.fulfillment_id)}
              selected={selectedIds.has(r.fulfillment_id)}
              onToggleSelection={() => onToggleSelection(r.fulfillment_id)}
              editing={editingDeadlineId === r.fulfillment_id}
              onStartEditDeadline={() => onStartEditDeadline(r.fulfillment_id)}
              onCancelEditDeadline={onCancelEditDeadline}
              onSaveDeadline={onSaveDeadline}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MobileDataCard({
  row, inGroup, expanded, onExpand,
  selected, onToggleSelection,
  editing, onStartEditDeadline, onCancelEditDeadline, onSaveDeadline,
}: {
  row: FulfillmentRow;
  inGroup: boolean;
  expanded: boolean;
  onExpand: () => void;
  selected: boolean;
  onToggleSelection: () => void;
  editing: boolean;
  onStartEditDeadline: () => void;
  onCancelEditDeadline: () => void;
  onSaveDeadline: (id: number, newDate: string) => void;
}) {
  const sku = row.fg_sku_name || "—";
  return (
    <div
      className={[
        "bg-white border rounded-md overflow-hidden transition-colors",
        selected
          ? "border-[var(--aws-orange)] border-l-[3px] border-l-[var(--aws-orange)]"
          : "border-[var(--aws-border)]",
      ].join(" ")}
    >
      <div
        className="px-2 py-2 flex items-start gap-1 cursor-pointer hover:bg-[var(--surface-subtle)]"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("button, input, label, a, select")) return;
          onExpand();
        }}
      >
        {/* Bigger tap target around the checkbox — the 16px native input
            is below the comfortable thumb target; the surrounding label
            absorbs taps within a 36px box without changing the visuals. */}
        <label
          className="shrink-0 inline-flex items-center justify-center w-9 h-9 -m-1 cursor-pointer"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelection}
            className="accent-[var(--aws-orange)]"
          />
        </label>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onExpand(); }}
          aria-label={expanded ? "Collapse" : "Expand"}
          className="shrink-0 inline-flex items-center justify-center w-9 h-9 -m-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          <svg
            viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
            strokeWidth={2}
            style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform .15s" }}
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          {/* Customer + SO header: hidden for in-group rows because the parent
              group card already carries that information. */}
          {!inGroup ? (
            <div className="flex items-center gap-2 mb-0.5 flex-wrap">
              <span className="text-[12px] text-[var(--text-primary)] truncate" title={row.customer_name ?? ""}>
                {row.customer_name || "—"}
              </span>
              {row.so_number ? (
                <span className="font-mono text-[11px] text-[var(--aws-link)] shrink-0">{row.so_number}</span>
              ) : null}
            </div>
          ) : (
            <div className="text-[10px] text-[var(--text-muted)] mb-0.5">↳ article</div>
          )}
          <p className="text-[13px] font-semibold text-[var(--text-primary)] mb-1 break-words" title={sku}>{sku}</p>
          <div className="flex items-center flex-wrap gap-2 mb-1">
            <span className="text-[12px] font-semibold text-[var(--text-primary)]">{fmtKg(row.pending_qty_kg)} kg</span>
            {toNum(row.pending_qty_units) > 0 ? (
              <span className="text-[11px] text-[var(--text-muted)]">{fmtUnits(row.pending_qty_units)} pcs</span>
            ) : null}
            <StatusPill status={row.status} />
            {row.is_planned ? (
              <span className="text-[10px] font-semibold text-[#1d8102] bg-[#eaf6ed] border border-[#b6dbb1] rounded-sm px-1.5 py-0.5">
                In Plan
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] font-semibold">Deadline</span>
            <DeadlineCell
              row={row}
              editing={editing}
              onStartEdit={onStartEditDeadline}
              onCancelEdit={onCancelEditDeadline}
              onSave={(date) => onSaveDeadline(row.fulfillment_id, date)}
            />
          </div>
        </div>
      </div>
      {expanded ? (
        <div className="border-t border-[var(--aws-border)] p-3 bg-[var(--surface-subtle)]">
          <DetailPanel fulfillmentId={row.fulfillment_id} />
        </div>
      ) : null}
    </div>
  );
}

function GroupBlock({
  group, isOpen, onToggleGroup,
  expandedId, onExpand,
  selectedIds, onToggleSelection,
  editingDeadlineId, onStartEditDeadline, onCancelEditDeadline, onSaveDeadline,
}: {
  group: SoGroup;
  isOpen: boolean;
  onToggleGroup: () => void;
  expandedId: number | null;
  onExpand: (id: number) => void;
  selectedIds: Set<number>;
  onToggleSelection: (id: number) => void;
  editingDeadlineId: number | null;
  onStartEditDeadline: (id: number) => void;
  onCancelEditDeadline: () => void;
  onSaveDeadline: (id: number, newDate: string) => void;
}) {
  const count = group.rows.length;
  const totalKg = group.rows.reduce((s, a) => s + toNum(a.pending_qty_kg), 0);
  const totalUnits = group.rows.reduce((s, a) => s + toNum(a.pending_qty_units), 0);
  const dates = group.rows.map((a) => a.delivery_deadline).filter((x): x is string => !!x).sort();
  const earliest = dates[0] ?? null;
  const customer = group.rows[0]?.customer_name || "—";
  const statuses = new Set(group.rows.map((a) => a.status || "open"));
  const statusLabel = statuses.size === 1 ? [...statuses][0] : "mixed";
  const inPlanCount = group.rows.filter((a) => a.is_planned).length;

  return (
    <>
      <tr
        className="border-b border-[var(--aws-border)] bg-[var(--surface-subtle)] cursor-pointer hover:bg-[#eef3f5]"
        onClick={onToggleGroup}
      >
        <td className="px-2 py-1.5" />
        <td className="px-1 py-1.5 text-[var(--text-secondary)]">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2} style={{ transform: isOpen ? "rotate(90deg)" : "none", transition: "transform .15s" }}>
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </td>
        <td className="px-2.5 py-1.5 truncate max-w-[200px] font-medium" title={customer}>{customer}</td>
        <td className="px-2.5 py-1.5 font-mono text-[11px] text-[var(--aws-link)]">{group.soNumber}</td>
        <td className="px-2.5 py-1.5 text-[11px] text-[var(--text-muted)]">{count} article{count > 1 ? "s" : ""}</td>
        <td className="px-2.5 py-1.5">
          <span className="font-semibold">{fmtKg(totalKg)} kg</span>
          {totalUnits > 0 ? <span className="text-[10px] text-[var(--text-muted)] ml-1.5">{fmtUnits(totalUnits)} pcs</span> : null}
        </td>
        <td className="px-2.5 py-1.5">
          {earliest ? <DeadlineBadge iso={earliest} /> : <span className="text-[var(--text-muted)]">—</span>}
        </td>
        <td className="px-2.5 py-1.5"><StatusPill status={statusLabel} /></td>
        <td className="px-2.5 py-1.5">
          {inPlanCount > 0 ? (
            <span className="text-[10px] font-semibold text-[#1d8102] bg-[#eaf6ed] border border-[#b6dbb1] rounded-sm px-1.5 py-0.5">
              {inPlanCount}/{count} planned
            </span>
          ) : null}
        </td>
      </tr>
      {isOpen ? group.rows.map((r) => (
        <DataRowBlock
          key={r.fulfillment_id}
          row={r}
          inGroup
          expanded={expandedId === r.fulfillment_id}
          onExpand={() => onExpand(r.fulfillment_id)}
          selected={selectedIds.has(r.fulfillment_id)}
          onToggleSelection={() => onToggleSelection(r.fulfillment_id)}
          editing={editingDeadlineId === r.fulfillment_id}
          onStartEditDeadline={() => onStartEditDeadline(r.fulfillment_id)}
          onCancelEditDeadline={onCancelEditDeadline}
          onSaveDeadline={onSaveDeadline}
        />
      )) : null}
    </>
  );
}

function DataRowBlock({
  row, inGroup, expanded, onExpand,
  selected, onToggleSelection,
  editing, onStartEditDeadline, onCancelEditDeadline, onSaveDeadline,
}: {
  row: FulfillmentRow;
  inGroup: boolean;
  expanded: boolean;
  onExpand: () => void;
  selected: boolean;
  onToggleSelection: () => void;
  editing: boolean;
  onStartEditDeadline: () => void;
  onCancelEditDeadline: () => void;
  onSaveDeadline: (id: number, newDate: string) => void;
}) {
  const skuFull = row.fg_sku_name || "—";
  const skuShort = skuFull.length > 32 ? skuFull.slice(0, 32) + "…" : skuFull;
  return (
    <>
      <tr
        className={[
          "border-b border-[var(--aws-border)] hover:bg-[var(--surface-subtle)] cursor-pointer",
          selected ? "bg-[#eaf3ff]" : "",
        ].join(" ")}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("button, input, label, a, select")) return;
          onExpand();
        }}
      >
        <td className="px-2 py-1.5">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelection}
            onClick={(e) => e.stopPropagation()}
            className="accent-[var(--aws-orange)]"
          />
        </td>
        <td className="px-1 py-1.5 text-[var(--text-secondary)]">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2} style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform .15s" }}>
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </td>
        {inGroup ? (
          <td className="px-2.5 py-1.5 text-[var(--text-muted)]">↳</td>
        ) : (
          <td className="px-2.5 py-1.5 truncate max-w-[200px]" title={row.customer_name ?? ""}>{row.customer_name || "—"}</td>
        )}
        {inGroup ? (
          <td className="px-2.5 py-1.5" />
        ) : (
          <td className="px-2.5 py-1.5 font-mono text-[11px] text-[var(--aws-link)]">{row.so_number || "—"}</td>
        )}
        <td className="px-2.5 py-1.5 truncate max-w-[280px]" title={skuFull}>{skuShort}</td>
        <td className="px-2.5 py-1.5">
          <span className="font-semibold">{fmtKg(row.pending_qty_kg)} kg</span>
          {toNum(row.pending_qty_units) > 0 ? <span className="text-[10px] text-[var(--text-muted)] ml-1.5">{fmtUnits(row.pending_qty_units)} pcs</span> : null}
        </td>
        <td className="px-2.5 py-1.5">
          <DeadlineCell
            row={row}
            editing={editing}
            onStartEdit={onStartEditDeadline}
            onCancelEdit={onCancelEditDeadline}
            onSave={(date) => onSaveDeadline(row.fulfillment_id, date)}
          />
        </td>
        <td className="px-2.5 py-1.5"><StatusPill status={row.status} /></td>
        <td className="px-2.5 py-1.5">
          {row.is_planned ? (
            <span className="text-[10px] font-semibold text-[#1d8102] bg-[#eaf6ed] border border-[#b6dbb1] rounded-sm px-1.5 py-0.5">
              In Plan
            </span>
          ) : null}
        </td>
      </tr>
      {expanded ? (
        <tr className="border-b border-[var(--aws-border)] bg-[var(--surface-subtle)]">
          <td colSpan={9} className="px-4 py-3">
            <DetailPanel fulfillmentId={row.fulfillment_id} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function DeadlineCell({
  row, editing, onStartEdit, onCancelEdit, onSave,
}: {
  row: FulfillmentRow;
  editing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSave: (date: string) => void;
}) {
  const [val, setVal] = useState<string>(() => row.delivery_deadline?.slice(0, 10) ?? "");
  useEffect(() => {
    // Re-sync the date input when the parent row refreshes (e.g. after a
    // successful revise patches delivery_deadline in place). Deferred past
    // the sync effect body so the react-hooks/set-state-in-effect rule
    // stays happy — matches the queueMicrotask pattern used elsewhere in
    // this codebase (see lib/user.ts and the job-card detail page).
    queueMicrotask(() => setVal(row.delivery_deadline?.slice(0, 10) ?? ""));
  }, [row.delivery_deadline]);

  if (editing) {
    return (
      <div className="inline-flex items-center gap-1">
        <input
          type="date"
          autoFocus
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          className="h-7 px-1.5 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e]"
        />
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onSave(val); }}
          className="h-7 px-2 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--text-success)] text-[var(--text-success)]"
        >✓</button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onCancelEdit(); }}
          className="h-7 px-2 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-error)] text-[var(--aws-error)]"
        >✕</button>
      </div>
    );
  }
  if (row.delivery_deadline) {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onStartEdit(); }}
        title="Click to change deadline"
        className="text-left"
      >
        <DeadlineBadge iso={row.delivery_deadline} />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onStartEdit(); }}
      className="inline-flex items-center gap-1 h-7 px-2 text-[12px] rounded-[2px] border border-dashed border-[var(--aws-border-strong)] text-[var(--text-secondary)] hover:border-[var(--aws-navy)] hover:text-[var(--text-primary)]"
    >
      <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
      </svg>
      Set deadline
    </button>
  );
}

function DeadlineBadge({ iso }: { iso: string }) {
  const tone = deadlineTone(iso);
  const cls = tone === "overdue" ? "text-[#b1361e] bg-[#fdf3f1] border-[#f0c7be]"
            : tone === "soon"    ? "text-[#9a393e] bg-[#fbeced] border-[#e6bcbe]"
            : tone === "ok"      ? "text-[var(--text-primary)] bg-white border-[var(--aws-border)]"
                                  : "text-[var(--text-muted)] bg-white border-[var(--aws-border)]";
  return (
    <span className={["inline-block text-[11px] font-semibold px-2 py-0.5 rounded-sm border", cls].join(" ")}>
      {fmtDeadline(iso)}
    </span>
  );
}

function StatusPill({ status }: { status?: string | null }) {
  const s = (status || "open").toLowerCase();
  const styles: Record<string, string> = {
    open:      "text-[#9a393e] bg-[#eaf3ff] border-[#bbd9f3]",
    partial:   "text-[#9a393e] bg-[#fbeced] border-[#e6bcbe]",
    fulfilled: "text-[#1d8102] bg-[#eaf6ed] border-[#b6dbb1]",
    mixed:     "text-[#5752c4] bg-[#f0eef8] border-[#d2cef0]",
  };
  const cls = styles[s] ?? "text-[var(--text-secondary)] bg-[#f4f4f4] border-[#d5dbdb]";
  return (
    <span className={["inline-block text-[11px] font-semibold capitalize px-2 py-0.5 rounded-sm border", cls].join(" ")}>
      {s}
    </span>
  );
}

// ── Detail panel (lazy-loaded) ──────────────────────────────────────────

function DetailPanel({ fulfillmentId }: { fulfillmentId: number }) {
  const [detail, setDetail] = useState<FulfillmentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const c = new AbortController();
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const d = await fetchFulfillmentDetail(fulfillmentId, c.signal);
        if (!c.signal.aborted) setDetail(d);
      } catch (e) {
        if (!c.signal.aborted) setError(friendlyApiError(e));
      } finally {
        if (!c.signal.aborted) setLoading(false);
      }
    })();
    return () => c.abort();
  }, [fulfillmentId]);

  if (loading) {
    return <p className="text-[12px] text-[var(--text-secondary)]">Loading detail…</p>;
  }
  if (error) {
    return <p className="text-[12px] text-[var(--aws-error)]">{error}</p>;
  }
  if (!detail) return null;

  // Server nests the fulfillment row under `detail.fulfillment`; field names
  // mirror the LIST row (original_qty_kg, order_status, delivery_deadline).
  const f = detail.fulfillment ?? ({} as FulfillmentDetailRow);
  const logs = detail.revision_log ?? [];

  return (
    <div>
      {/* Two sub-sections: meta + quantities. Splitting them visually gives
          a clearer scan path than one big 14-cell grid. */}
      <DetailSection title="Order">
        <dl className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-x-4 gap-y-1.5 text-[12px]">
          <KV label="Customer"        value={f.customer_name} />
          <KV label="SO Number"       value={f.so_number} mono />
          <KV label="FG SKU"          value={f.fg_sku_name} />
          <KV label="Entity"          value={f.entity} />
          <KV label="FY"              value={f.financial_year} mono />
          <KV label="Status"          value={f.order_status} />
          <KV label="Deadline"        value={f.delivery_deadline ? fmtDeadline(f.delivery_deadline) : "—"} />
          <KV label="In plan"         value={f.is_planned ? `#${f.plan_line_id ?? "?"}` : "No"} />
        </dl>
      </DetailSection>
      <DetailSection title="Quantities" className="mt-3">
        <dl className="grid grid-cols-3 sm:grid-cols-6 gap-x-4 gap-y-1.5 text-[12px]">
          <KV label="Original kg"   value={fmtKg(f.original_qty_kg)} />
          <KV label="Produced kg"   value={fmtKg(f.produced_qty_kg)} />
          <KV label="Dispatched kg" value={fmtKg(f.dispatched_qty_kg)} />
          <KV label="Planned kg"    value={fmtKg(f.planned_qty_kg)} />
          <KV label="Pending kg"    value={fmtKg(f.pending_qty_kg)} />
          <KV label="Pending pcs"   value={fmtUnits(f.pending_qty_units)} />
        </dl>
      </DetailSection>
      {logs.length > 0 ? (
        <div className="mt-4">
          <h4 className="text-[11px] uppercase tracking-wide font-semibold text-[var(--text-secondary)] mb-1">
            Revision log
          </h4>

          {/* Mobile (< sm): stacked entries — a 5-column table won't fit
              inside the narrow mobile card and would scroll horizontally. */}
          <ul className="sm:hidden space-y-2">
            {logs.slice(0, 8).map((l, i) => (
              <li key={i} className="border-t border-[var(--aws-border)] pt-1.5">
                <div className="flex items-center justify-between gap-2 mb-0.5">
                  <span className="text-[11px] font-semibold text-[var(--text-primary)]">{l.revision_type ?? "—"}</span>
                  <span className="font-mono text-[10px] text-[var(--text-muted)] shrink-0">
                    {l.revised_at ? fmtDeadline(l.revised_at) : "—"}
                  </span>
                </div>
                <div className="text-[11px] text-[var(--text-primary)]">
                  {l.old_value ?? "—"} → {l.new_value ?? "—"}
                </div>
                {l.reason ? (
                  <div className="text-[11px] text-[var(--text-secondary)] mt-0.5">{l.reason}</div>
                ) : null}
                <div className="text-[10px] text-[var(--text-muted)] mt-0.5">by {l.revised_by ?? "—"}</div>
              </li>
            ))}
          </ul>

          {/* sm+: table */}
          <table className="hidden sm:table w-full text-[11px] border-collapse">
            <thead className="bg-[var(--surface-subtle)] text-[var(--text-secondary)]">
              <tr>
                <th className="px-2 py-1 text-left">When</th>
                <th className="px-2 py-1 text-left">Type</th>
                <th className="px-2 py-1 text-left">Old → New</th>
                <th className="px-2 py-1 text-left">Reason</th>
                <th className="px-2 py-1 text-left">By</th>
              </tr>
            </thead>
            <tbody>
              {logs.slice(0, 8).map((l, i) => (
                <tr key={i} className="border-t border-[var(--aws-border)]">
                  <td className="px-2 py-1 whitespace-nowrap font-mono text-[10px] text-[var(--text-muted)]">
                    {l.revised_at ? fmtDeadline(l.revised_at) : "—"}
                  </td>
                  <td className="px-2 py-1">{l.revision_type ?? "—"}</td>
                  <td className="px-2 py-1">{l.old_value ?? "—"} → {l.new_value ?? "—"}</td>
                  <td className="px-2 py-1 truncate max-w-[280px]" title={l.reason ?? ""}>
                    {l.reason ?? "—"}
                  </td>
                  <td className="px-2 py-1">{l.revised_by ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {logs.length > 8 ? (
            <p className="text-[10px] text-[var(--text-muted)] mt-1">
              Showing first 8 of {logs.length} revisions.
            </p>
          ) : null}
        </div>
      ) : null}
      <p className="text-[11px] text-[var(--text-muted)] italic mt-3">
        BOM override and floor-stock override modals are not yet wired up on web.
        Use the Electron client for those flows.
      </p>
    </div>
  );
}

function DetailSection({
  title, className, children,
}: {
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={className}>
      <div className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)] mb-1.5">
        {title}
      </div>
      {children}
    </section>
  );
}

function KV({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
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
