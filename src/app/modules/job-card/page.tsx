"use client";

// Replicates frontend_replica/src/modules/production/job-cards/* — entity
// buttons, summary cards, search + status filter, paginated table, status
// badges, issuance bar. Backed by GET /api/v1/production/job-cards-v2.
//
// C2 (Wave 4) — extended with the full v2 filter contract (so_number,
// date_from / date_to, team_leader), server-driven pagination with a
// 25/50/100 page-size selector, status visual + lock indicators per row,
// and role-aware row actions (View / Force-Unlock). The cards
// grid stays on sm: viewports for the operator-friendly tap targets; the
// dense table only renders on md+.

import { useEffect, useMemo, useRef, useState } from "react";
import { BrandMark } from "@/components/BrandMark";
import { useRouter } from "next/navigation";
import { apiFetch, readApiErrorMessage } from "@/lib/auth";
import { useRequireAuth, deriveRowLockIndicator, useUserInitial, useUserScope } from "@/lib/user";
import { userHasWarehouse } from "@/lib/warehouseScope";
// W4-MED-3/M10 — single context-driven subscription point.
import { UserProvider, useUserCtx } from "./_UserContext";
import { userMayForceUnlock } from "./_useLockState";
import { JC_LIST_PAGE_SIZE, SEARCH_DEBOUNCE_MS } from "@/lib/constants";
import { friendlyApiError } from "@/lib/apiErrors";
import { BackLink } from "@/components/BackLink";
import { ActionButton, LockableButton } from "./_ActionButton";
import {
  loadListCache,
  saveListCache,
  patchListCache,
  type CachedRow,
  type JcListCache,
} from "@/lib/jc-list-cache";

type JobCardRow = {
  job_card_id: number;
  job_card_number?: string | null;
  fg_sku_name?: string | null;
  customer_name?: string | null;
  // v2 stores planned qty (kg + units); the v1 frontend referred to this as
  // batch_size_kg — kept the alias here in case a v1 row sneaks through.
  planned_qty_kg?: number | string | null;
  batch_size_kg?: number | string | null;
  stage?: string | null;
  floor?: string | null;
  factory?: string | null;
  assigned_to_team_leader?: string | null;
  // v2 has no issuance %; v1 frontend exposed it. Treat as optional.
  issuance_pct?: number | string | null;
  status?: string | null;
  entity?: string | null;
  plan_id?: number | null;
  // Chain identity. A single `plan_id` can contain MANY independent process
  // chains — one per `production_plan_line_v2` (a distinct FG batch / SO line).
  // `plan_line_id` is the chain key; `step_number` orders the stages within
  // that chain (sorting=1 → packaging=2 → …). The list/search endpoints return
  // both on every row (see job_card_v2.list_job_cards). Grouping by plan_id
  // alone interleaves sibling chains into one ladder — group by plan_line_id.
  plan_line_id?: number | null;
  step_number?: number | null;
  process_name?: string | null;
  // Slice 3/7 seam codes. The v2 list endpoint surfaces the SFG#### codes a
  // step consumes (`input_code`) and produces (`output_code`) so the list can
  // show the Create-WIP code without opening the detail page. Both optional:
  // the backend may not return them yet, and most rows have no seam. Render
  // defensively — only show the chip when a code is actually present.
  input_kind?: string | null;
  output_kind?: string | null;
  input_code?: string | null;   // SFG#### this step consumes
  output_code?: string | null;  // SFG#### this step produces (Create-WIP)
  // Per-line batch label from the backend: `P{plan_id}-L{plan_line_id}-S{step}`.
  batch_number?: string | null;
  // Aggregated SO numbers for this JC's plan line — backend returns
  // ARRAY_AGG(DISTINCT so_header.so_number). May be null when no SO is
  // linked (manual job cards, scratch plans, etc.).
  so_numbers?: string[] | null;
  // C2 (Wave 4) — lock metadata. Used by the per-row lock chip and the
  // Force-Unlock CTA. `force_unlocked` flips true once an admin has
  // already unlocked; we hide the CTA in that case to avoid re-prompting.
  is_locked?: boolean | null;
  locked_reason?: string | null;
  lock_reason?: string | null;
  force_unlocked?: boolean | null;
  // C2 (Wave 4) — created_at for the table column.
  created_at?: string | null;
  // Plan date pulled from production_plan_v2 via the JC's plan_id.
  // Distinct from SO date (which the operator never wants tampered).
  // Server returns ISO date string; default list sort is plan_date DESC.
  plan_date?: string | null;
};

type Pagination = {
  page?: number;
  page_size?: number;
  total?: number;
  total_pages?: number;
};

type ListResponse = {
  results?: JobCardRow[];
  pagination?: Pagination;
  filter_options?: { customers?: string[] };
};

// /job-cards-v2/search returns the same row shape but no pagination block —
// it's deliberately unpaginated; the service caps at hard_cap and tells the
// caller via `capped` so the UI can prompt the user to narrow the query.
type SearchResponse = {
  results?: JobCardRow[];
  total?: number;
  capped?: boolean;
  hard_cap?: number;
};

// Floor master per plant. Kept inline here (rather than importing from the
// planning page) so the JC list has no cross-route module dependency. Values
// match planning/page.tsx FLOORS_BY_FACTORY byte-for-byte — keep them in sync
// when a floor is added/renamed in one place.
const FLOORS_BY_PLANT: Record<"W-202" | "A-185", readonly string[]> = {
  "W-202": [
    "Lower Basement", "Upper Basement",
    "First Floor", "First Floor Mezz",
    "Second Floor", "Second Floor Mezz",
    "Terrace",
  ],
  "A-185": [
    "Roasting Area", "Mezzanine", "Sorting Area", "Printing Area",
    "Dmart Production Area", "Dmart Packing Area",
    "Cheese Floor", "FG store", "FFS Packing Area",
  ],
};

// Flat (Plant, Floor) tuple list for the unfiltered floor select. Used when
// no Plant filter is selected so an admin can still pick any floor — the
// option labels are prefixed with the plant for disambiguation.
const ALL_FLOOR_OPTIONS: { plant: "W-202" | "A-185"; floor: string }[] = [
  ...FLOORS_BY_PLANT["W-202"].map((f) => ({ plant: "W-202" as const, floor: f })),
  ...FLOORS_BY_PLANT["A-185"].map((f) => ({ plant: "A-185" as const, floor: f })),
];

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "locked", label: "Locked" },
  { value: "unlocked", label: "Unlocked" },
  { value: "assigned", label: "Assigned" },
  { value: "material_received", label: "Material Received" },
  { value: "in_progress", label: "In Progress" },
  { value: "completed", label: "Completed" },
  { value: "closed", label: "Closed" },
  { value: "cancelled", label: "Cancelled" },
];

// PAGE_SIZE lives in @/lib/constants as JC_LIST_PAGE_SIZE; aliased here so
// the rest of the file reads more naturally (`PAGE_SIZE` matches the
// pagination-bar variable conventions).
const PAGE_SIZE = JC_LIST_PAGE_SIZE;

// Status → AWS-console-leaning badge palette. Keeps the same status-pill
// vocabulary as the original frontend (locked/red, in-progress/blue, etc.).
// C2 (Wave 4) — audit-specified palette extensions: assigned=blue,
// material_received=indigo, in_progress=amber, qc_review=violet,
// closed=emerald, force_closed=rose. Tuned to keep mid-air rows
// distinguishable at a glance on a busy floor display.
const STATUS_STYLES: Record<string, { bg: string; fg: string; ring: string }> = {
  locked:            { bg: "#fdf3f1", fg: "#b1361e", ring: "#f0c7be" },
  unlocked:          { bg: "#f4f4f4", fg: "#414d5c", ring: "#d5dbdb" },
  assigned:          { bg: "#eaf3ff", fg: "#1d4ed8", ring: "#bbd9f3" }, // blue
  material_received: { bg: "#eef2ff", fg: "#4338ca", ring: "#c7d2fe" }, // indigo
  in_progress:       { bg: "#fef3c7", fg: "#92400e", ring: "#fde68a" }, // amber
  qc_review:         { bg: "#f5f3ff", fg: "#6d28d9", ring: "#ddd6fe" }, // violet
  completed:         { bg: "#eaf6ed", fg: "#1d8102", ring: "#b6dbb1" },
  closed:            { bg: "#ecfdf5", fg: "#047857", ring: "#a7f3d0" }, // emerald
  force_closed:      { bg: "#fff1f2", fg: "#be123c", ring: "#fecdd3" }, // rose
  cancelled:         { bg: "#f4f4f4", fg: "#687078", ring: "#d5dbdb" },
};

// Allowed page-size choices. Mirrors the v2 backend's `page_size: int = Query(100, ge=1, le=500)`.
const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

function clampPageSize(v: number | undefined): PageSize {
  if (v === 25 || v === 50 || v === 100) return v;
  // JC_LIST_PAGE_SIZE is a constant 100 today, but we widen it through a
  // generic number compare so future tweaks (e.g. 50) don't require a
  // recompile here. The fallback to 100 is the safe default at the cap.
  const def: number = JC_LIST_PAGE_SIZE;
  if (def === 25 || def === 50 || def === 100) return def;
  return 100;
}

function fmtCreatedAt(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    // dd-MMM (e.g. 14-Mar) — keeps the column narrow on mobile.
    return d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
  } catch {
    return iso;
  }
}

// Plan date arrives as a bare YYYY-MM-DD (Postgres DATE type) rather
// than an ISO timestamp. Parse manually so we don't reinterpret it as
// UTC midnight and slip the displayed date by one day on negative-
// offset locales.
function fmtPlanDate(s: string | null | undefined): string {
  if (!s) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "2-digit" });
}

function fmtStatus(s?: string | null): string {
  return (s || "").replace(/_/g, " ");
}

function fmtBatch(v: number | string | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = typeof v === "number" ? v : parseFloat(v);
  if (Number.isNaN(n)) return "—";
  return `${n.toLocaleString("en-IN")} kg`;
}

// A plan line can bundle multiple SOs; the card has room for one cell. Show
// the first SO with a "+N" suffix to signal there are more, and pass the
// full comma-separated list as a tooltip via the Meta `title` override.
function formatSo(arr: string[] | null | undefined): { display: string; tooltip: string } {
  if (!arr || arr.length === 0) return { display: "—", tooltip: "" };
  if (arr.length === 1) return { display: arr[0], tooltip: arr[0] };
  return { display: `${arr[0]} +${arr.length - 1}`, tooltip: arr.join(", ") };
}

// W4-MED-3/M10 — wraps the body in <UserProvider> so every nested
// ActionButton / LockableButton / row-action consumes a single shared user
// snapshot via context instead of subscribing to userStore on every render.
export default function JobCardListingPage() {
  return (
    <UserProvider>
      <JobCardListingPageBody />
    </UserProvider>
  );
}

function JobCardListingPageBody() {
  const router = useRouter();

  // ── Initial state — hydrate from the session cache when present so
  // returning from the detail page lands the operator on the exact same
  // filtered view they left, without a network round-trip. The cache lives
  // in sessionStorage (lib/jc-list-cache.ts) and is scoped to the tab.
  //
  // CRITICAL: `useState` lazy init runs ONCE on mount. We deliberately do
  // not call loadListCache() on every render — each call returns a fresh
  // object reference, which would invalidate the load-effect's dep array
  // every render → fetch → setState → re-render → fetch → … request storm.
  const [cache] = useState<JcListCache | null>(() =>
    typeof window !== "undefined" ? loadListCache() : null,
  );

  const [rows, setRows] = useState<JobCardRow[]>(cache?.rows ?? []);
  const [pagination, setPagination] = useState<Pagination>(cache?.pagination ?? {});
  // If we have a cache, skip the initial load — don't even render the
  // spinner; the operator's previous list is already on screen.
  const [loading, setLoading] = useState(!cache);
  const [error, setError] = useState<string | null>(null);

  const [entity, setEntity] = useState<"" | "cfpl" | "cdpl">(
    (cache?.entity as "" | "cfpl" | "cdpl" | undefined) ?? "",
  );
  const [factory, setFactory] = useState<"" | "W-202" | "A-185">(
    (cache?.factory as "" | "W-202" | "A-185" | undefined) ?? "",
  );
  const [floor, setFloor] = useState<string>(cache?.floor ?? "");
  const [statusFilter, setStatusFilter] = useState<string[]>(cache?.statusFilter ?? []);
  const [search, setSearch] = useState(cache?.search ?? "");
  const [debouncedSearch, setDebouncedSearch] = useState(cache?.search ?? "");
  const [page, setPage] = useState(cache?.page ?? 1);
  // C2 (Wave 4) — extended filter state. soNumber + dateFrom/dateTo +
  // teamLeader all map to v2 list endpoint query params. Plant filter is
  // admin/plant_manager-only; team leader filter same. Each filter change
  // resets the page to 1 so the fetch effect doesn't ask for an
  // out-of-range page after the result set shrinks.
  const [soNumber, setSoNumber] = useState<string>(cache?.soNumber ?? "");
  const [debouncedSoNumber, setDebouncedSoNumber] = useState<string>(cache?.soNumber ?? "");
  const [dateFrom, setDateFrom] = useState<string>(cache?.dateFrom ?? "");
  const [dateTo, setDateTo] = useState<string>(cache?.dateTo ?? "");
  const [teamLeader, setTeamLeader] = useState<string>(cache?.teamLeader ?? "");
  const [debouncedTeamLeader, setDebouncedTeamLeader] = useState<string>(cache?.teamLeader ?? "");
  const [pageSize, setPageSize] = useState<PageSize>(clampPageSize(cache?.pageSize));
  const initial = useUserInitial();
  const userScope = useUserScope();
  // W4-MED-3/M10 — consume the single context value rather than re-subscribing.
  const { isAdmin } = useUserCtx();
  // Populated only when we hit /search; null when we hit the paginated list.
  const [searchMeta, setSearchMeta] = useState<{
    total: number;
    capped: boolean;
    hardCap: number;
  } | null>(cache?.searchMeta ?? null);

  // Manual reload trigger. Force-Unlock bumps this so the list refetches
  // after a write so the operator sees the lock/state flip in the same view.
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((k) => k + 1);

  // W4-MED-2 — derived guard for the date-range inputs. Both dates are
  // ISO YYYY-MM-DD strings so lexicographic compare matches chronological.
  // Used by the fetch effect to skip the network round-trip when the range
  // is inverted, and by the Date-to input to render an inline error.
  const dateRangeInvalid = !!dateFrom && !!dateTo && dateFrom > dateTo;

  // Hydration guard. The state above is seeded from a sessionStorage cache
  // (the `cache` lazy-init) that only exists on the client, so rendering it on
  // the first pass diverged from the server's cache-less render and tripped a
  // hydration mismatch (filters + grid). `mounted` is false on the server AND
  // the client's first render, so both emit the same shell (see early return
  // below); the post-mount flip then reveals the cache-hydrated UI.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // Deferred past the effect body so the react-hooks/set-state-in-effect
    // rule doesn't fire (same pattern as the detail page's re-sync effects).
    queueMicrotask(() => setMounted(true));
  }, []);

  // Skip the first fetch if we hydrated from cache — the rows the operator
  // last saw are already on screen. Any filter change after this point will
  // trigger a normal refetch via the load() effect below.
  const hasHydratedFromCache = useRef(!!cache);

  // Debounce the search box like the original. Also resets the page so
  // the fetch effect doesn't ask for an out-of-range page after the
  // result set shrinks. setPage(1) is a no-op when page is already 1.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  // C2 (Wave 4) — same debounce pattern for soNumber + teamLeader so
  // typing a 6-char SO# doesn't fire six network requests.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSoNumber(soNumber.trim());
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [soNumber]);
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedTeamLeader(teamLeader.trim());
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [teamLeader]);

  // Filter-change handlers: paired with setPage(1) so the fetch effect
  // fires exactly once with the new filter + page-1. The earlier "watch
  // filters in a useEffect, then setPage(1)" approach fired the fetch
  // twice — once with the OLD page and once with page 1 — because the
  // page-reset effect ran in a separate commit. setPage(1) when page is
  // already 1 is a no-op (React bails out on Object.is-equal primitives).
  function changeEntity(v: typeof entity) {
    setEntity(v);
    setPage(1);
  }
  function changeFactory(v: typeof factory) {
    setFactory(v);
    // Drop a floor selection that is no longer valid for the new plant.
    // Matches the planning page's "factory cleared → no floors valid" rule
    // (planning page.tsx, FLOORS_BY_FACTORY guard). Clearing to "" is also
    // valid → keep whatever floor the operator had.
    if (v && floor && !(FLOORS_BY_PLANT[v]?.includes(floor))) {
      setFloor("");
    }
    setPage(1);
  }
  function changeFloor(v: string) {
    setFloor(v);
    setPage(1);
  }
  function changeStatus(next: string[]) {
    setStatusFilter(next);
    setPage(1);
  }

  // Single fetch effect. Depends directly on the filter primitives instead
  // of going through a useCallback — that indirection was creating a new
  // `load` reference whenever its inner setStates changed React state, and
  // because `load` was in the effect's dep array, the effect kept re-firing
  // → fetch → setState → re-render → new `load` reference → fetch again.
  //
  // The effect now runs only when an actual filter value (or page) changes.
  // The AbortController cancels any in-flight fetch from a previous render
  // so a slow request doesn't stomp on the result of a newer one when the
  // operator changes filters quickly.
  // Boot-time auth gate. The hook redirects when no usable refresh token
  // is present and stashes the current path so login can bounce back.
  // Returns false during the brief window between the redirect being
  // scheduled and the navigation completing; we use it to skip the fetch.
  const authed = useRequireAuth(router.replace);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!authed) return;
    // W4-MED-2 — suppress the fetch when the date range is inverted. The
    // input shows an inline error in that case; firing the request anyway
    // would return zero rows and replace the operator's last good view.
    if (dateRangeInvalid) return;
    // First mount with cache hydration: skip the fetch entirely; rows are
    // already on screen. Subsequent runs (after a filter change) clear the
    // flag and refetch normally.
    if (hasHydratedFromCache.current) {
      hasHydratedFromCache.current = false;
      const y = cache?.scrollY ?? 0;
      if (y > 0) {
        // Two RAFs — first paints the rows, second lets layout settle so
        // window.scrollTo lands on the right offset.
        requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, y)));
      }
      return;
    }

    const controller = new AbortController();
    void (async () => {
      setLoading(true);
      setError(null);
      // Free-text search routes through the unpaginated /search endpoint;
      // when the search box is empty we hit the paginated list instead.
      const useSearch = !!debouncedSearch;
      const params = new URLSearchParams();
      if (entity) params.set("entity", entity);
      if (factory) params.set("factory", factory);
      if (floor) params.set("floor", floor);
      if (statusFilter.length) params.set("status", statusFilter.join(","));
      // C2 (Wave 4) — extra v2 query params. Server allows so_number,
      // date_from / date_to (YYYY-MM-DD), and customer-style free text
      // filters. team_leader uses the `customer` param's adjacent
      // assigned-to-team-leader filter when surfaced via the search box;
      // dedicated team_leader filter is appended via the search `q`
      // fallback when populated and the list endpoint doesn't accept it
      // directly (current backend signature exposes so_number / customer
      // / date_* / floor / machine_id; team-leader filtering rides via
      // `customer` as a free-text match the same way the legacy frontend
      // did).
      if (debouncedSoNumber) params.set("so_number", debouncedSoNumber);
      if (dateFrom) params.set("date_from", dateFrom);
      if (dateTo) params.set("date_to", dateTo);
      // Team-leader filter — surfaced for admin / plant_manager only via
      // the toolbar. When populated we pass it as a search hint; the
      // server's /job-cards-v2 endpoint maps the column on its end.
      if (debouncedTeamLeader) params.set("customer", debouncedTeamLeader);
      if (useSearch) {
        params.set("q", debouncedSearch);
      } else {
        params.set("page", String(page));
        params.set("page_size", String(pageSize));
      }
      const path = useSearch
        ? `/api/v1/production/job-cards-v2/search`
        : `/api/v1/production/job-cards-v2`;
      try {
        const res = await apiFetch(`${path}?${params}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        // 401 is intercepted by apiFetch globally — it triggers signOut()
        // and a hard redirect to "/". Just bail out of this fetch.
        if (res.status === 401) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (useSearch) {
          const data = (await res.json()) as SearchResponse;
          if (controller.signal.aborted) return;
          const nextRows = data.results ?? [];
          const nextMeta = { total: data.total ?? 0, capped: !!data.capped, hardCap: data.hard_cap ?? 0 };
          setRows(nextRows);
          setPagination({});
          setSearchMeta(nextMeta);
          saveListCache({
            entity, factory, statusFilter, search: debouncedSearch, page,
            rows: nextRows as unknown as CachedRow[],
            pagination: undefined,
            searchMeta: nextMeta,
            scrollY: 0,
            soNumber: debouncedSoNumber, dateFrom, dateTo,
            teamLeader: debouncedTeamLeader, pageSize, floor,
          });
        } else {
          const data = (await res.json()) as ListResponse;
          if (controller.signal.aborted) return;
          const nextRows = data.results ?? [];
          const nextPagination = data.pagination ?? {};
          setRows(nextRows);
          setPagination(nextPagination);
          setSearchMeta(null);
          saveListCache({
            entity, factory, statusFilter, search: debouncedSearch, page,
            rows: nextRows as unknown as CachedRow[],
            pagination: nextPagination,
            searchMeta: null,
            scrollY: 0,
            soNumber: debouncedSoNumber, dateFrom, dateTo,
            teamLeader: debouncedTeamLeader, pageSize, floor,
          });
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(friendlyApiError(e));
        setRows([]);
        setPagination({});
        setSearchMeta(null);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => {
      controller.abort();
    };
  }, [
    entity, factory, floor, statusFilter,
    debouncedSearch, debouncedSoNumber, debouncedTeamLeader,
    dateFrom, dateTo, dateRangeInvalid, page, pageSize, router, cache, authed, reloadKey,
  ]);

  function toggleStatus(s: string) {
    // Wraps changeStatus so the page-reset stays atomic with the toggle.
    changeStatus(
      statusFilter.includes(s)
        ? statusFilter.filter((x) => x !== s)
        : [...statusFilter, s],
    );
  }

  // Avatar initial + scope come from the shared hooks in lib/user — both
  // read the same cached MeResponse so no per-page effect is needed.

  // Until mounted, render a cache-free shell identical on server + client so
  // hydration matches. The real cache-hydrated UI mounts one frame later —
  // this replaces what was previously a hydration error + full client-side
  // tree regeneration, so it is strictly smoother than the broken state.
  if (!mounted) {
    return (
      <div className="min-h-screen flex flex-col bg-[var(--background)]">
        <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-6 gap-4">
          <BrandMark />
          <span className="text-[#d5dbdb] text-[13px] hidden sm:inline">Console</span>
        </header>
        <main className="flex-1 max-w-[1280px] w-full mx-auto px-4 sm:px-6 py-6">
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[var(--text-secondary)]">
            <span className="inline-flex items-center gap-2 text-[13px]">
              <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
              Loading job cards…
            </span>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-6 gap-4">
        <BrandMark />
        <span className="text-[#d5dbdb] text-[13px] hidden sm:inline">Console</span>
        <nav className="text-[12px] text-[#d5dbdb] hidden md:flex items-center gap-2 ml-2">
          <button onClick={() => router.push("/modules")} className="hover:underline">
            Modules
          </button>
          <span>/</span>
          <span className="text-white">Job Cards</span>
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

      <main className="flex-1 max-w-[1280px] w-full mx-auto px-4 sm:px-6 py-6">
        <div className="mb-3">
          <BackLink parentHref="/modules" label="modules" />
        </div>
        <div className="flex flex-wrap items-end justify-between gap-4 mb-5">
          <div>
            <h1 className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)]">
              Job Cards
            </h1>
            <p className="text-[13px] text-[var(--text-secondary)] mt-1">
              Track job card lifecycle across the factory floor
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <ChipGroup
              label="Entity"
              value={entity}
              options={[
                { value: "", label: "All" },
                { value: "cfpl", label: "CFPL" },
                { value: "cdpl", label: "CDPL" },
              ]}
              onChange={(v) => changeEntity(v as typeof entity)}
            />
            {/* C2 (Wave 4) — plant filter is admin-only. Non-admin operators
                are server-scoped to their assigned plant via /me anyway, so
                surfacing the filter for them is misleading (they can't pick
                a plant outside their warehouses list — the server returns
                empty). The banner below already explains the scope. */}
            {isAdmin ? (
              <ChipGroup
                label="Plant"
                value={factory}
                options={[
                  { value: "", label: "All" },
                  { value: "W-202", label: "W-202" },
                  { value: "A-185", label: "A-185" },
                ]}
                onChange={(v) => changeFactory(v as typeof factory)}
              />
            ) : null}
            {/* Floor filter — narrows by `job_card_v2.floor`. The plant
                dictates which floors are valid; when no plant is picked,
                the dropdown lists every plant's floors with a "(W-202)"
                / "(A-185)" suffix so the operator can still pick. Admin
                only, mirroring the Plant chip group above (non-admins are
                already auto-scoped to their assigned floors server-side). */}
            {isAdmin ? (
              <FloorSelect
                value={floor}
                plant={factory}
                onChange={changeFloor}
              />
            ) : null}
          </div>
        </div>

        {!userScope.isAdmin && userScope.warehouses.length > 0 ? (
          <div className="mb-4 border border-[var(--aws-border)] bg-[#f1faff] text-[12px] text-[var(--text-primary)] px-3 py-2 rounded-sm flex items-center gap-2">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#9a393e" strokeWidth={2}>
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="13" />
              <circle cx="12" cy="16" r="0.6" fill="#9a393e" />
            </svg>
            <span>
              Your account is scoped to{" "}
              <strong>{userScope.warehouses.join(", ")}</strong>. Job cards for
              other plants are hidden by the server.
            </span>
          </div>
        ) : null}

        {/* C2 (Wave 4) — sticky filters bar on lg+. The toolbar wraps onto
            multiple rows on narrow viewports to keep tap targets large;
            on lg+ it sticks to the top of the viewport so operators don't
            lose the filter context while scrolling a long list. */}
        <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] mb-5 p-3 lg:sticky lg:top-2 lg:z-20">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[220px]">
              <svg
                viewBox="0 0 24 24"
                className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]"
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
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search JC#, SKU, customer, batch…"
                className="w-full h-8 pl-7 pr-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
              />
            </div>
            <StatusMultiSelect
              value={statusFilter}
              onToggle={toggleStatus}
              onClear={() => changeStatus([])}
            />
            <PageSizeSelect
              value={pageSize}
              onChange={(v) => {
                setPageSize(v);
                setPage(1);
              }}
            />
          </div>
          {/* Second toolbar row — SO# / date range / team leader. Stacks
              on mobile, single row on md+. */}
          <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-2">
            <label className="block">
              <span className="block text-[10px] uppercase tracking-wide text-[var(--text-secondary)] font-semibold mb-0.5">SO #</span>
              <input
                type="text"
                value={soNumber}
                onChange={(e) => setSoNumber(e.target.value)}
                placeholder="SO-CFPL-…"
                className="w-full h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
              />
            </label>
            <label className="block">
              <span className="block text-[10px] uppercase tracking-wide text-[var(--text-secondary)] font-semibold mb-0.5">Date from</span>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
                className="w-full h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
              />
            </label>
            <label className="block">
              <span className="block text-[10px] uppercase tracking-wide text-[var(--text-secondary)] font-semibold mb-0.5">Date to</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
                aria-invalid={dateRangeInvalid || undefined}
                aria-describedby={dateRangeInvalid ? "jc-date-range-error" : undefined}
                className={[
                  "w-full h-8 px-2 text-[13px] rounded-[2px] bg-white border outline-none focus:shadow-[0_0_0_1px_#9a393e]",
                  dateRangeInvalid
                    ? "border-[var(--aws-error)] focus:border-[var(--aws-error)]"
                    : "border-[var(--aws-border-strong)] focus:border-[#9a393e]",
                ].join(" ")}
              />
              {/* W4-MED-2 — inline error when the range is inverted. The
                  fetch effect skips firing while this is true, so the list
                  stays on the last good result instead of flickering empty. */}
              {dateRangeInvalid ? (
                <span id="jc-date-range-error" className="block text-[10px] text-[var(--aws-error)] mt-0.5">
                  From date must be before To date
                </span>
              ) : null}
            </label>
            {/* Team leader filter — admin / plant_manager only. The audit
                lists plant_manager as part of the visibility set; admin
                bypass covers admin. Non-admin team_leaders aren't shown
                the filter because their view is already auto-scoped to
                themselves on the server. */}
            {isAdmin ? (
              <label className="block">
                <span className="block text-[10px] uppercase tracking-wide text-[var(--text-secondary)] font-semibold mb-0.5">Team leader / customer</span>
                <input
                  type="text"
                  value={teamLeader}
                  onChange={(e) => setTeamLeader(e.target.value)}
                  placeholder="Name contains…"
                  className="w-full h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
                />
                {/* W4-HIGH-3 — backend has no discrete team_leader query
                    param (router.py:4757-4782 lists none), so this input
                    rides the `customer` filter. Set expectations honestly:
                    it primarily matches customer names but also surfaces
                    team-leader-only assignments where customer is empty,
                    via the v2 free-text join. */}
                <span className="block text-[10px] text-[var(--text-muted)] mt-0.5">
                  Filters by customer name; also catches team-leader-only assignments where the customer field is empty.
                </span>
              </label>
            ) : null}
          </div>
        </div>

        {loading && rows.length === 0 ? (
          // C2 (Wave 4) — 3-row skeleton mirrors the table shell on md+
          // and the card grid on sm: so the reflow doesn't jolt the
          // operator once the real rows arrive.
          <ListSkeleton />
        ) : error ? (
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-8 text-center text-[var(--aws-error)] text-[13px]">
            {error}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            entity={entity}
            factory={factory}
            floor={floor}
            statusFilter={statusFilter}
            search={debouncedSearch}
            userScope={userScope}
            onClear={() => {
              // Clear all filters at once — setPage(1) only fires once
              // (React bails subsequent same-value calls).
              setEntity("");
              setFactory("");
              setFloor("");
              setStatusFilter([]);
              setSearch("");
              setSoNumber("");
              setDateFrom("");
              setDateTo("");
              setTeamLeader("");
              // W4-MED-6 — also flush the debounced shadow state so the
              // refetch fires immediately. Without this, the next fetch is
              // delayed by SEARCH_DEBOUNCE_MS while the debounce timer
              // settles to the cleared values.
              setDebouncedSearch("");
              setDebouncedSoNumber("");
              setDebouncedTeamLeader("");
              setPage(1);
            }}
          />
        ) : (
          <>
            {searchMeta ? (
              <div
                className={[
                  "mb-3 px-3 py-2 rounded-sm border text-[12px] flex items-center gap-2",
                  searchMeta.capped
                    ? "border-[var(--aws-error)] bg-[#fdf3f1] text-[var(--text-primary)]"
                    : "border-[var(--aws-border)] bg-[#f1faff] text-[var(--text-primary)]",
                ].join(" ")}
              >
                <span>
                  <strong>{searchMeta.total}</strong> match
                  {searchMeta.total === 1 ? "" : "es"} for &ldquo;
                  {debouncedSearch}&rdquo;
                </span>
                {searchMeta.capped ? (
                  <span className="text-[var(--aws-error)]">
                    · capped at {searchMeta.hardCap} — narrow your query for more
                  </span>
                ) : null}
              </div>
            ) : null}
            {/* C2 (Wave 4) — cards on sm (single column, then 2-up at sm:),
                dense table on md+. The table hides the densest columns
                (Lock, Created) below xl: to keep the row compact on
                tablet-class viewports. */}
            <div className="md:hidden">
              <JobCardGroupedGrid rows={rows} onReload={reload} />
            </div>
            <div className="hidden md:block">
              <JobCardTable rows={rows} onReload={reload} />
            </div>
          </>
        )}

        {pagination.total ? (
          <div className="mt-4 bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] overflow-hidden">
            <PaginationBar
              pg={pagination}
              onPage={(p) => setPage(p)}
              loading={loading}
            />
          </div>
        ) : null}
      </main>

      <footer className="border-t border-[var(--aws-border)] bg-white py-3 px-6 text-[11px] text-[var(--text-secondary)] flex flex-wrap justify-center gap-x-4 gap-y-1">
        <a href="#" className="hover:underline">Terms of Use</a>
        <a href="#" className="hover:underline">Privacy</a>
        <span>© {new Date().getFullYear()}</span>
      </footer>
    </div>
  );
}

// ── Grouped grid: one card per process CHAIN + loose JCs ────────────────
//
// A single production `plan_id` contains many independent process chains —
// one per `plan_line_id` (a distinct FG batch / SO line). Each chain is its
// own sorting → packaging → … sequence, ordered by `step_number`. Grouping by
// `plan_id` alone flattened every chain into one ladder sorted by job_card_id,
// which interleaves sibling chains (a chain's sorting could land below another
// chain's packaging) and makes the lock/unlock pattern read as nonsense to the
// operator. So we partition by `plan_line_id`: one merged card per chain, with
// its stages ordered by `step_number`. Rows without a `plan_line_id` (manual /
// scratch JCs) render as standalone loose cards. The mixed list is reassembled
// latest-first by plan_date (tie-break on each group's MAX(job_card_id)) so
// freshly approved plans surface at the top.

interface PlanGroup {
  kind: "plan";
  plan_line_id: number;          // the chain key — one card per chain
  plan_id: number | null;        // parent plan, shown on the header for provenance
  stages: JobCardRow[];          // sorted by step_number then job_card_id asc
  newestJcId: number;            // used for latest-first global ordering
}
interface LooseGroup {
  kind: "loose";
  row: JobCardRow;
  newestJcId: number;
}
type Group = PlanGroup | LooseGroup;

function buildGroups(rows: JobCardRow[]): Group[] {
  const byChain = new Map<number, JobCardRow[]>();
  const loose: LooseGroup[] = [];
  for (const jc of rows) {
    // Chain key is plan_line_id. Fall back to a loose card when it's missing
    // (manual JCs, or a malformed row) rather than silently merging unrelated
    // stages under a null key.
    if (jc.plan_line_id != null) {
      const list = byChain.get(jc.plan_line_id) ?? [];
      list.push(jc);
      byChain.set(jc.plan_line_id, list);
    } else {
      loose.push({ kind: "loose", row: jc, newestJcId: jc.job_card_id });
    }
  }
  const planGroups: PlanGroup[] = [];
  for (const [plan_line_id, stages] of byChain.entries()) {
    // Order the chain top-down the way production runs: by step_number
    // ascending (NULLs last), tie-break on job_card_id so it stays stable.
    const ordered = [...stages].sort((a, b) => {
      const aS = a.step_number, bS = b.step_number;
      if (aS != null && bS != null && aS !== bS) return aS - bS;
      if (aS == null && bS != null) return 1;
      if (aS != null && bS == null) return -1;
      return a.job_card_id - b.job_card_id;
    });
    const newestJcId = stages.reduce((m, s) => (s.job_card_id > m ? s.job_card_id : m), 0);
    planGroups.push({
      kind: "plan",
      plan_line_id,
      plan_id: ordered[0]?.plan_id ?? null,
      stages: ordered,
      newestJcId,
    });
  }
  // Merge + sort by plan_date desc (latest plan first), tie-break on
  // newestJcId so two chains from the same date land in stable order. Null
  // plan_dates sink to the bottom. Matches the table sort so the two views
  // never disagree.
  const planDateOf = (g: Group) =>
    g.kind === "plan"
      ? (g.stages[0]?.plan_date ?? null)
      : (g.row.plan_date ?? null);
  return [...planGroups, ...loose].sort((a, b) => {
    const aP = planDateOf(a) ?? "";
    const bP = planDateOf(b) ?? "";
    if (aP === bP) return b.newestJcId - a.newestJcId;
    if (!aP) return 1;
    if (!bP) return -1;
    return bP.localeCompare(aP);
  });
}

function JobCardGroupedGrid({ rows, onReload }: { rows: JobCardRow[]; onReload: () => void }) {
  const groups = buildGroups(rows);
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {groups.map((g) => (
        g.kind === "plan" ? (
          <PlanMergedCard key={`chain-${g.plan_line_id}`} group={g} />
        ) : (
          <JobCard key={`jc-${g.row.job_card_id}`} jc={g.row} onReload={onReload} />
        )
      ))}
    </div>
  );
}

// C2 (Wave 4) — dense table view used on md+ viewports. Hides plan
// grouping (the card view keeps that affordance on small screens for
// glance-friendly scanning) and surfaces every row with the columns the
// audit asked for: JC#, SO#, FG SKU, Plant, Stage, Status, Lock, Created,
// Action. Cost columns would be gated by useSeesCost — none are
// surfaced in the list endpoint today, so the gate is a no-op here but
// the seam exists for future column additions.
function JobCardTable({ rows, onReload }: { rows: JobCardRow[]; onReload: () => void }) {
  // Operator-stated: sort by plan_date desc — latest plan at the top,
  // older scrolls down. Server already returns this order (the default
  // sort_by flipped from created_at → plan_date), but we re-sort
  // defensively so a malformed response or fallback doesn't flip the
  // visible ordering. Tie-break on job_card_id desc keeps same-day
  // plans stable. NULL plan_date rows sink to the bottom.
  const sorted = [...rows].sort((a, b) => {
    const aP = a.plan_date ?? "";
    const bP = b.plan_date ?? "";
    if (aP === bP) return b.job_card_id - a.job_card_id;
    if (!aP) return 1;
    if (!bP) return -1;
    return bP.localeCompare(aP);
  });
  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] overflow-hidden">
      <table className="w-full text-[12px] border-collapse table-auto">
        <thead className="bg-[var(--surface-subtle)]">
          <tr className="border-b border-[var(--aws-border)]">
            <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">JC #</th>
            <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">SO #</th>
            <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">FG SKU</th>
            <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)] hidden lg:table-cell">Plant</th>
            <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)] hidden lg:table-cell">Stage</th>
            <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">Status</th>
            <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)] hidden lg:table-cell">Floor</th>
            <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)] hidden md:table-cell">Plan Date</th>
            <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)] hidden xl:table-cell">Created</th>
            <th className="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">Action</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((jc) => (
            <JobCardTableRow key={jc.job_card_id} jc={jc} onReload={onReload} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function JobCardTableRow({ jc, onReload }: { jc: JobCardRow; onReload: () => void }) {
  const router = useRouter();
  const status = jc.status ?? "";
  const style = STATUS_STYLES[status] ?? { bg: "#f4f4f4", fg: "#414d5c", ring: "#d5dbdb" };
  // Show the 8-digit JC number (job_card_id). The long PLAN-… job_card_number
  // reference is kept on the title tooltip for traceability.
  const jcNum = String(jc.job_card_id);
  const jcRef = jc.job_card_number || "";
  const so = formatSo(jc.so_numbers);

  function openDetail() {
    patchListCache({ scrollY: typeof window !== "undefined" ? window.scrollY : 0 });
    router.push(`/modules/job-card/${jc.job_card_id}`);
  }

  return (
    <tr className="border-b border-[var(--aws-border)] hover:bg-[var(--surface-subtle)]">
      <td className="px-3 py-2 font-mono text-[11px] text-[var(--aws-link)] truncate max-w-[160px]" title={jcRef || jcNum}>
        <button type="button" onClick={openDetail} className="hover:underline">
          {jcNum}
        </button>
      </td>
      <td className="px-3 py-2 text-[var(--text-primary)] truncate max-w-[140px]" title={so.tooltip}>
        {so.display}
      </td>
      <td className="px-3 py-2 text-[var(--text-primary)] truncate max-w-[200px]" title={jc.fg_sku_name ?? ""}>
        {jc.fg_sku_name || "—"}
      </td>
      <td className="px-3 py-2 text-[var(--text-secondary)] hidden lg:table-cell">{jc.factory || "—"}</td>
      <td className="px-3 py-2 text-[var(--text-secondary)] hidden lg:table-cell max-w-[180px]" title={jc.stage ?? ""}>
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="truncate">{jc.stage || "—"}</span>
          {/* Slice 7 — SFG#### produced by a Create-WIP step. Defensive:
              only rendered when output_code is present (backend may omit it). */}
          {jc.output_code ? (
            <span
              className="shrink-0 font-mono font-semibold text-[10px] text-[var(--aws-navy)] px-1 py-0.5 rounded-sm bg-[var(--surface-subtle)] border border-[var(--aws-border)]"
              title={`Produces ${jc.output_code}`}
            >
              {jc.output_code}
            </span>
          ) : null}
        </div>
      </td>
      <td className="px-3 py-2">
        <span
          className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-sm capitalize whitespace-nowrap border"
          style={{ background: style.bg, color: style.fg, borderColor: style.ring }}
        >
          {fmtStatus(status) || "—"}
        </span>
      </td>
      <td className="px-3 py-2 text-[var(--text-secondary)] hidden lg:table-cell truncate max-w-[140px]" title={jc.floor ?? ""}>
        {jc.floor || "—"}
      </td>
      <td className="px-3 py-2 text-[var(--text-primary)] font-medium hidden md:table-cell">
        {fmtPlanDate(jc.plan_date)}
      </td>
      <td className="px-3 py-2 text-[var(--text-secondary)] hidden xl:table-cell">
        {fmtCreatedAt(jc.created_at)}
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap items-center justify-end gap-1">
          <RowActions row={jc} onReload={onReload} onOpenDetail={openDetail} />
        </div>
      </td>
    </tr>
  );
}

// Compact merged card: one per process CHAIN (plan line), with each stage
// rendered as a single row inside, ordered by step_number. Click a stage row
// to jump to that JC's detail page. Header shows SKU + customer + plant; the
// stage rows show step number · process · floor · qty · status.
function PlanMergedCard({ group }: { group: PlanGroup }) {
  const router = useRouter();
  const first = group.stages[0];
  const sku = first?.fg_sku_name || "—";
  const customer = first?.customer_name || "—";
  const plant = first?.factory || "—";
  // This card is ONE process chain (one plan line), so the meaningful figure
  // is the batch size — not a sum across stages. Summing would double-count
  // (sorting 2,610 kg + packaging 2,610 kg ≠ a 5,220 kg batch). Take the
  // largest per-stage planned qty, which equals the chain's entry quantity.
  const batchQty = group.stages.reduce(
    (m, jc) => {
      const q = parseFloat(String(jc.planned_qty_kg ?? jc.batch_size_kg ?? 0)) || 0;
      return q > m ? q : m;
    },
    0,
  );
  // SO numbers de-duped across all stages.
  const allSos = Array.from(
    new Set(group.stages.flatMap((jc) => jc.so_numbers ?? [])),
  );
  const so = formatSo(allSos);
  // Stable per-line label for traceability when several chains share one plan.
  // The backend batch_number is `P{plan}-L{line}-S{step}`; drop the step suffix
  // so the label is constant across the chain's stages. Shown as the card's
  // hover title so operators can tell sibling chains apart unambiguously.
  const batchLabel = (first?.batch_number ?? "").replace(/-S\d+$/i, "")
    || (group.plan_id != null ? `Plan #${group.plan_id}` : "Chain");

  function openStage(jcId: number) {
    patchListCache({ scrollY: typeof window !== "undefined" ? window.scrollY : 0 });
    router.push(`/modules/job-card/${jcId}`);
  }

  return (
    <div
      className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] overflow-hidden"
      title={batchLabel}
    >
      {/* Header — compact: plan id + SKU + customer + plant chip + batch size.
          One card == one process chain (plan line); the step count + batch
          size describe just this chain, not the whole plan. */}
      <div className="px-3 py-2 border-b border-[var(--aws-border)] bg-[var(--surface-subtle)]">
        <div className="flex items-center justify-between gap-2 mb-0.5">
          <span
            className="font-mono text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)] truncate"
            title={batchLabel}
          >
            {group.plan_id != null ? `Plan #${group.plan_id}` : "Chain"}
          </span>
          <span className="text-[10px] font-semibold text-[var(--text-secondary)] shrink-0">
            {group.stages.length} step{group.stages.length === 1 ? "" : "s"} · {fmtBatch(batchQty)}
          </span>
        </div>
        <div className="text-[13px] font-semibold text-[var(--text-primary)] truncate" title={sku}>{sku}</div>
        <div className="text-[11px] text-[var(--text-secondary)] truncate" title={customer}>{customer}</div>
        <div className="flex items-center gap-2 mt-1 text-[10px] text-[var(--text-muted)] flex-wrap">
          <span>{plant}</span>
          {so.display !== "—" ? (
            <>
              <span>·</span>
              <span title={so.tooltip}>SO {so.display}</span>
            </>
          ) : null}
          {first?.plan_date ? (
            <>
              <span>·</span>
              <span title="Plan date" className="font-medium text-[var(--text-secondary)]">
                Plan {fmtPlanDate(first.plan_date)}
              </span>
            </>
          ) : null}
        </div>
      </div>

      {/* Stage list — one row per JC. Compact: number badge · process/stage
          · qty · status pill. Tap any row to open that JC's detail page. */}
      <ol>
        {group.stages.map((jc, i) => {
          const status = jc.status ?? "";
          const style = STATUS_STYLES[status] ?? { bg: "#f4f4f4", fg: "#414d5c", ring: "#d5dbdb" };
          const qty = jc.planned_qty_kg ?? jc.batch_size_kg;
          const processLabel = jc.process_name || jc.stage || `Stage ${i + 1}`;
          // Real step number from the chain — not the array index. Within a
          // single chain these match, but showing the backend value keeps the
          // badge honest if a step is ever filtered out or missing.
          const stepNo = jc.step_number ?? i + 1;
          return (
            <li
              key={jc.job_card_id}
              role="button"
              tabIndex={0}
              aria-label={`Open ${processLabel} stage`}
              className={[
                "flex items-center gap-2 px-3 py-1.5 text-[11px] cursor-pointer hover:bg-[var(--surface-subtle)] focus:outline-none focus:ring-1 focus:ring-[#9a393e]",
                i > 0 ? "border-t border-[var(--aws-border)]" : "",
              ].join(" ")}
              onClick={() => openStage(jc.job_card_id)}
              // W4-MED-5 — keyboard parity with the click handler. Without
              // this, Tab focuses the row but Enter/Space do nothing.
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  openStage(jc.job_card_id);
                }
              }}
            >
              <span className="shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-full bg-[var(--aws-navy)] text-white text-[9px] font-bold">
                {stepNo}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-medium text-[var(--text-primary)] truncate" title={processLabel}>
                    {processLabel}
                  </span>
                  {/* Slice 7 — surface the SFG#### this Create-WIP step
                      produces. Defensive: the v2 list endpoint may not return
                      output_code yet, and non-producer steps have none — only
                      render the chip when a code is actually present. */}
                  {jc.output_code ? (
                    <span
                      className="shrink-0 font-mono font-semibold text-[9px] text-[var(--aws-navy)] px-1 py-0.5 rounded-sm bg-[var(--surface-subtle)] border border-[var(--aws-border)]"
                      title={`Produces ${jc.output_code}`}
                    >
                      {jc.output_code}
                    </span>
                  ) : null}
                </div>
                <div className="text-[10px] text-[var(--text-muted)] truncate">
                  {jc.floor || "—"} · {fmtBatch(qty)}
                </div>
              </div>
              <span
                className="shrink-0 text-[9px] font-semibold px-1.5 py-0.5 rounded-sm capitalize"
                style={{
                  background: style.bg,
                  color: style.fg,
                  border: `1px solid ${style.ring}`,
                }}
              >
                {fmtStatus(status) || "—"}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function JobCard({ jc, onReload }: { jc: JobCardRow; onReload: () => void }) {
  const router = useRouter();
  const status = jc.status ?? "";
  const style = STATUS_STYLES[status] ?? {
    bg: "#f4f4f4",
    fg: "#414d5c",
    ring: "#d5dbdb",
  };
  // Show the 8-digit JC number (job_card_id). The long PLAN-… job_card_number
  // reference is kept on the title tooltip for traceability.
  const jcNum = String(jc.job_card_id);
  const jcRef = jc.job_card_number || "";
  // v2 returns planned_qty_kg; v1 returns batch_size_kg — accept either.
  const qty = jc.planned_qty_kg ?? jc.batch_size_kg;
  const plant = jc.factory ?? "—";
  const so = formatSo(jc.so_numbers);

  function openDetail() {
    patchListCache({ scrollY: typeof window !== "undefined" ? window.scrollY : 0 });
    router.push(`/modules/job-card/${jc.job_card_id}`);
  }

  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] p-4 hover:border-[var(--aws-navy)] hover:shadow-[0_2px_6px_rgba(0,28,36,0.18)] transition flex flex-col">
      <div className="flex items-start justify-between gap-2 mb-2">
        <span
          className="font-mono text-[12px] font-semibold text-[var(--aws-link)] truncate"
          title={jcRef || jcNum}
        >
          {jcNum}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          <span
            className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-sm capitalize whitespace-nowrap border"
            style={{ background: style.bg, color: style.fg, borderColor: style.ring }}
          >
            {fmtStatus(status) || "—"}
          </span>
        </div>
      </div>

      <button
        type="button"
        onClick={openDetail}
        className="text-left focus:outline-none focus:ring-1 focus:ring-[#9a393e] rounded-sm"
      >
        <div
          className="text-[14px] font-semibold text-[var(--text-primary)] truncate"
          title={jc.fg_sku_name ?? ""}
        >
          {jc.fg_sku_name || "—"}
        </div>
        <div
          className="text-[12px] text-[var(--text-secondary)] truncate mb-3"
          title={jc.customer_name ?? ""}
        >
          {jc.customer_name || "—"}
        </div>

        <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
          <Meta label="Plant" value={plant} />
          <Meta label="Floor" value={jc.floor || "—"} />
          <Meta label="Stage" value={jc.stage || "—"} />
          <Meta label="Qty" value={fmtBatch(qty)} />
          <Meta label="Assigned" value={jc.assigned_to_team_leader || "—"} />
          <Meta label="SO" value={so.display} title={so.tooltip} />
        </dl>
      </button>

      {/* Row actions footer. ActionButton hides itself entirely when the
          role isn't allowed, so the footer only shows what the operator can
          act on. View is always rendered as the primary CTA. */}
      <div className="mt-3 pt-3 border-t border-[var(--aws-border)] flex flex-wrap items-center justify-end gap-2">
        <RowActions row={jc} onReload={onReload} onOpenDetail={openDetail} />
      </div>
    </div>
  );
}

// Shared row actions. Used by both the card grid (sm) and the dense table
// (md+). Encapsulates the lock-aware Force-Unlock CTA so neither rendering
// path duplicates logic.
function RowActions({
  row,
  onReload,
  onOpenDetail,
}: {
  row: JobCardRow;
  onReload: () => void;
  onOpenDetail: () => void;
}) {
  // W4-MED-3/M10 — pure lock derivation off the context-provided me snapshot.
  const { me } = useUserCtx();
  const lock = useMemo(
    () => deriveRowLockIndicator(row, userMayForceUnlock(me)),
    [row, me],
  );
  const jcId = row.job_card_id;

  async function forceUnlock() {
    // W4-MED-4 — match the detail-page UX: pre-fill empty, validate reason
    // ≥ 5 chars, alert when the operator cancelled or left it empty so the
    // CTA doesn't silently no-op.
    const authority = window.prompt("Force unlock — authority (e.g. plant manager name):", "");
    if (authority == null) return; // explicit cancel — silent
    if (!authority.trim()) {
      window.alert("Authority is required.");
      return;
    }
    const reason = window.prompt("Force unlock — reason:", "");
    if (reason == null) return; // explicit cancel — silent
    const trimmedReason = reason.trim();
    if (trimmedReason.length < 5) {
      window.alert("Reason must be at least 5 characters.");
      return;
    }
    try {
      const res = await apiFetch(`/api/v1/production/job-cards-v2/${jcId}/force-unlock`, {
        method: "PUT",
        body: JSON.stringify({ authority: authority.trim(), reason: trimmedReason }),
      });
      if (!res.ok) {
        // W4-HIGH-2 — shared envelope reader.
        const msg = await readApiErrorMessage(res, "Force-unlock failed");
        throw new Error(msg);
      }
      window.alert("Job card force-unlocked.");
      onReload();
    } catch (e) {
      window.alert(friendlyApiError(e));
    }
  }

  return (
    <>
      <ActionButton variant="secondary" onClick={onOpenDetail}>
        View
      </ActionButton>
      {lock.shouldShowForceUnlock ? (
        // LockableButton with a synthetic lockState that includes
        // mayForceUnlock so the button stays interactive for the
        // already-vetted role list (admin / floor_manager / plant_manager /
        // inventory_manager). Server-side gate is still authoritative.
        <LockableButton
          roleAllow="floor_manager,plant_manager,inventory_manager"
          variant="danger"
          lockState={{
            isLocked: lock.isLocked,
            lockedReason: lock.lockedReason,
            mayForceUnlock: lock.mayForceUnlock,
          }}
          onClick={() => void forceUnlock()}
        >
          Force unlock
        </LockableButton>
      ) : null}
    </>
  );
}

function ChipGroup({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] uppercase tracking-wide text-[var(--text-secondary)] font-semibold mr-1">
        {label}
      </span>
      {options.map((opt) => (
        <button
          key={opt.value || "all"}
          onClick={() => onChange(opt.value)}
          className={[
            "h-7 px-3 text-[12px] rounded-full border transition-colors",
            value === opt.value
              ? "bg-[var(--aws-navy)] text-white border-[var(--aws-navy)]"
              : "bg-white text-[var(--text-primary)] border-[var(--aws-border-strong)] hover:border-[var(--aws-navy)]",
          ].join(" ")}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function FloorSelect({
  value,
  plant,
  onChange,
}: {
  value: string;
  plant: "" | "W-202" | "A-185";
  // Free-form string — backend expects the floor label as-is.
  onChange: (v: string) => void;
}) {
  // When a plant is chosen, only that plant's floors are valid. When no
  // plant is chosen, show every floor with a plant suffix so the operator
  // can disambiguate same-name floors across plants (today there's no
  // overlap, but it's a cheap forward-looking guard).
  const scoped = plant ? FLOORS_BY_PLANT[plant] : null;
  return (
    <label className="flex items-center gap-2">
      <span className="text-[11px] uppercase tracking-wide text-[var(--text-secondary)] font-semibold mr-1">
        Floor
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 px-2 text-[12px] rounded-full bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
        aria-label="Filter by floor"
      >
        <option value="">All</option>
        {scoped
          ? scoped.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))
          : ALL_FLOOR_OPTIONS.map((o) => (
              <option key={`${o.plant}|${o.floor}`} value={o.floor}>
                {o.floor} ({o.plant})
              </option>
            ))}
      </select>
    </label>
  );
}

function EmptyState({
  entity,
  factory,
  floor,
  statusFilter,
  search,
  userScope,
  onClear,
}: {
  entity: string;
  factory: string;
  floor: string;
  statusFilter: string[];
  search: string;
  userScope: { isAdmin: boolean; warehouses: string[] };
  onClear: () => void;
}) {
  const active: string[] = [];
  if (entity) active.push(`entity=${entity}`);
  if (factory) active.push(`plant=${factory}`);
  if (floor) active.push(`floor=${floor}`);
  if (statusFilter.length) active.push(`status=${statusFilter.join(",")}`);
  if (search) active.push(`search="${search}"`);
  const hasFilters = active.length > 0;

  // If the user is scoped to specific factories AND they're filtering to a
  // factory outside that scope, the server returned 0 rows because of the
  // scope intersection — flag that explicitly.  Uses the shared warehouse
  // matcher so an admin-typed "W202" / "W-202" / "w-202" all resolve the
  // same way (previously a strict includes() locked legitimately-assigned
  // operators out of their own plant).
  const factoryOutOfScope =
    !!factory &&
    !userScope.isAdmin &&
    userScope.warehouses.length > 0 &&
    !userHasWarehouse(userScope.warehouses, factory);

  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[var(--text-secondary)]">
      <p className="font-semibold text-[14px] mb-1">No job cards found</p>
      {factoryOutOfScope ? (
        <p className="text-[12px] text-[var(--aws-error)] mb-2">
          Plant <strong>{factory}</strong> is outside your assignment (
          {userScope.warehouses.join(", ")}). Ask an admin to add the plant to
          your account.
        </p>
      ) : hasFilters ? (
        <p className="text-[12px] mb-2">
          No job cards match: <span className="font-mono">{active.join(" · ")}</span>
        </p>
      ) : !userScope.isAdmin && userScope.warehouses.length > 0 ? (
        <p className="text-[12px] mb-2">
          No job cards on the plants assigned to you (
          {userScope.warehouses.join(", ")}).
        </p>
      ) : (
        <p className="text-[12px] mb-2">There are no job cards yet.</p>
      )}
      {hasFilters ? (
        <button
          onClick={onClear}
          className="mt-2 h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]"
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );
}

function Meta({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  // Override the tooltip when the visible value is an elided summary (e.g.
  // SO "ABC +2" → tooltip "ABC, DEF, GHI"). Defaults to `value` otherwise.
  title?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="uppercase tracking-wide font-semibold text-[var(--text-muted)] text-[10px]">
        {label}
      </dt>
      <dd
        className="text-[12px] text-[var(--text-primary)] truncate"
        title={title ?? value}
      >
        {value}
      </dd>
    </div>
  );
}

// C2 (Wave 4) — page-size selector. Mirrors the v2 backend's allowed
// values (1-500 cap) but offers the operator-facing trio of 25 / 50 / 100.
function PageSizeSelect({
  value,
  onChange,
}: {
  value: PageSize;
  onChange: (v: PageSize) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="text-[11px] uppercase tracking-wide text-[var(--text-secondary)] font-semibold whitespace-nowrap">
        Per page
      </span>
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value) as PageSize)}
        className="h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
      >
        {PAGE_SIZE_OPTIONS.map((n) => (
          <option key={n} value={n}>{n}</option>
        ))}
      </select>
    </label>
  );
}

function StatusMultiSelect({
  value,
  onToggle,
  onClear,
}: {
  value: string[];
  onToggle: (s: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // W4-MED-11 — gate the document listener on `open`. The original effect
  // wired the listener unconditionally on mount, so even with the dropdown
  // closed every mousedown anywhere in the page hit this handler — wasteful
  // on a busy list page and easy to leak when components unmount mid-event.
  // Re-binding only while open also lets the cleanup remove it on close.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);
  const label =
    value.length === 0
      ? "All Statuses"
      : value.length === 1
        ? STATUS_OPTIONS.find((o) => o.value === value[0])?.label ?? value[0]
        : `${value.length} statuses`;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="h-8 px-3 text-[13px] bg-white border border-[var(--aws-border-strong)] rounded-[2px] hover:border-[var(--aws-navy)] flex items-center gap-2"
      >
        <span>{label}</span>
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open ? (
        <div
          className={[
            // Positioning: on small viewports the toolbar wraps the trigger
            // to its own row at the left edge, so anchor LEFT and let the
            // panel extend right; from sm+ the trigger sits at the right of
            // the toolbar so anchor RIGHT and let it extend left. Either
            // way, `max-w-[calc(100vw-1rem)]` keeps the panel inside the
            // viewport — when 220px would overflow it breaks below the
            // edge into the narrower wrapped width.
            "absolute z-10 mt-1 w-[220px] max-w-[calc(100vw-1rem)]",
            "left-0 sm:left-auto sm:right-0",
            // Long status lists scroll vertically rather than running off
            // the bottom of the viewport.
            "max-h-[60vh] overflow-y-auto",
            "bg-white border border-[var(--aws-border)] rounded-md shadow-[0_4px_12px_rgba(0,28,36,0.18)] p-1",
          ].join(" ")}
        >
          {STATUS_OPTIONS.map((opt) => {
            const selected = value.includes(opt.value);
            return (
              <label
                key={opt.value}
                className="flex items-center gap-2 px-2 py-1.5 text-[13px] hover:bg-[#f4f4f4] rounded-sm cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() => onToggle(opt.value)}
                  className="accent-[var(--aws-orange)]"
                />
                {opt.label}
              </label>
            );
          })}
          {value.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                onClear();
                setOpen(false);
              }}
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

function PaginationBar({
  pg,
  onPage,
  loading,
}: {
  pg: Pagination;
  onPage: (p: number) => void;
  loading: boolean;
}) {
  const page = pg.page ?? 1;
  const totalPages = pg.total_pages ?? 1;
  const total = pg.total ?? 0;
  const pageSize = pg.page_size ?? PAGE_SIZE;
  const start = total ? (page - 1) * pageSize + 1 : 0;
  const end = Math.min(page * pageSize, total);

  // C2 (Wave 4) — single-page case: still surface "showing X of N" so the
  // operator knows how many rows landed even when there's no paging to do.
  if (totalPages <= 1) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-t border-[var(--aws-border)] bg-[var(--surface-subtle)]">
        <span className="text-[12px] text-[var(--text-secondary)]">
          Showing {start}–{end} of {total} job cards
        </span>
      </div>
    );
  }

  const maxVisible = 5;
  let startPage = Math.max(1, page - Math.floor(maxVisible / 2));
  const endPage = Math.min(totalPages, startPage + maxVisible - 1);
  if (endPage - startPage + 1 < maxVisible) {
    startPage = Math.max(1, endPage - maxVisible + 1);
  }

  const pageNums: number[] = [];
  for (let i = startPage; i <= endPage; i++) pageNums.push(i);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-t border-[var(--aws-border)] bg-[var(--surface-subtle)]">
      <span className="text-[12px] text-[var(--text-secondary)]">
        Showing {start}–{end} of {total} job cards
      </span>
      <div className="flex items-center gap-1">
        <PageBtn disabled={page <= 1 || loading} onClick={() => onPage(page - 1)} ariaLabel="Previous">
          ‹
        </PageBtn>
        {startPage > 1 ? (
          <>
            <PageBtn onClick={() => onPage(1)}>{1}</PageBtn>
            {startPage > 2 ? <span className="px-1 text-[#879596]">…</span> : null}
          </>
        ) : null}
        {pageNums.map((p) => (
          <PageBtn key={p} active={p === page} onClick={() => onPage(p)}>
            {p}
          </PageBtn>
        ))}
        {endPage < totalPages ? (
          <>
            {endPage < totalPages - 1 ? <span className="px-1 text-[#879596]">…</span> : null}
            <PageBtn onClick={() => onPage(totalPages)}>{totalPages}</PageBtn>
          </>
        ) : null}
        <PageBtn disabled={page >= totalPages || loading} onClick={() => onPage(page + 1)} ariaLabel="Next">
          ›
        </PageBtn>
      </div>
    </div>
  );
}

function PageBtn({
  children,
  onClick,
  disabled,
  active,
  ariaLabel,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={[
        "min-w-[28px] h-7 px-2 text-[12px] rounded-sm border",
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

// C2 (Wave 4) — 3-row skeleton. Renders the card layout on small viewports
// and the table layout on md+, so the visual mass before and after the
// fetch is similar (no big jolt). Animate-pulse keeps the "still loading"
// signal subtle.
function ListSkeleton() {
  return (
    <>
      <div className="md:hidden grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] p-4 animate-pulse"
          >
            <div className="flex items-start justify-between gap-2 mb-2">
              <div className="h-3 w-20 bg-[var(--aws-border)] rounded-sm" />
              <div className="h-3 w-16 bg-[var(--aws-border)] rounded-sm" />
            </div>
            <div className="h-4 w-3/4 bg-[var(--aws-border)] rounded-sm mb-1" />
            <div className="h-3 w-1/2 bg-[var(--aws-border)] rounded-sm mb-4" />
            <div className="grid grid-cols-2 gap-2">
              {[0, 1, 2, 3, 4, 5].map((j) => (
                <div key={j} className="h-3 w-full bg-[var(--aws-border)] rounded-sm" />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="hidden md:block bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] overflow-hidden">
        <table className="w-full text-[12px] border-collapse">
          <thead className="bg-[var(--surface-subtle)]">
            <tr className="border-b border-[var(--aws-border)]">
              {["JC #", "SO #", "FG SKU", "Status", "Action"].map((h) => (
                <th key={h} className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[0, 1, 2].map((i) => (
              <tr key={i} className="border-b border-[var(--aws-border)] animate-pulse">
                {[0, 1, 2, 3, 4].map((j) => (
                  <td key={j} className="px-3 py-3">
                    <div className="h-3 w-full bg-[var(--aws-border)] rounded-sm" />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
