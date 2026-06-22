// Fulfillment API surface. Mirrors the endpoint set used by
// frontend_replica/src/modules/production/fulfillment/fulfillment.js —
// see that file for the original Electron-client implementation.
//
// The deferred edit flows (BOM override modal, floor-stock modal,
// carryforward) are typed here so a follow-up can wire them up without
// re-deriving the wire shapes.

import { apiFetch } from "./auth";

// ── Listing types ────────────────────────────────────────────────────────

export interface FulfillmentRow {
  fulfillment_id: number;
  so_line_id?: number | null;
  customer_name?: string | null;
  so_number?: string | null;
  fg_sku_name?: string | null;
  pending_qty_kg?: number | string | null;
  pending_qty_units?: number | string | null;
  delivery_deadline?: string | null;
  status?: "open" | "partial" | "fulfilled" | string | null;
  entity?: string | null;
  is_planned?: boolean | null;
  [k: string]: unknown;
}

export interface Pagination {
  page?: number;
  page_size?: number;
  total?: number;
  total_pages?: number;
}

export interface FulfillmentListResponse {
  results?: FulfillmentRow[];
  pagination?: Pagination;
}

export interface FulfillmentFilterOptions {
  customers?: string[];
  so_numbers?: string[];
  articles?: string[];
}

// ── Listing query ────────────────────────────────────────────────────────

export interface FulfillmentListQuery {
  entity?: string;
  customer?: string[];
  so_number?: string[];
  article?: string[];
  page?: number;
  page_size?: number;
}

function buildListParams(q: FulfillmentListQuery): URLSearchParams {
  const p = new URLSearchParams();
  if (q.entity) p.set("entity", q.entity);
  if (q.customer && q.customer.length) p.set("customer", q.customer.join(","));
  if (q.so_number && q.so_number.length) p.set("so_number", q.so_number.join(","));
  if (q.article && q.article.length) p.set("article", q.article.join(","));
  if (q.page != null) p.set("page", String(q.page));
  if (q.page_size != null) p.set("page_size", String(q.page_size));
  return p;
}

// ── Calls ────────────────────────────────────────────────────────────────

export async function listFulfillments(
  q: FulfillmentListQuery,
  signal?: AbortSignal,
): Promise<FulfillmentListResponse> {
  const p = buildListParams(q);
  const res = await apiFetch(`/api/v1/production/fulfillment-v2?${p}`, { signal });
  if (!res.ok) throw new Error(`Fulfillment HTTP ${res.status}`);
  return (await res.json()) as FulfillmentListResponse;
}

export async function fetchFulfillmentFilterOptions(
  q: Omit<FulfillmentListQuery, "page" | "page_size">,
  signal?: AbortSignal,
): Promise<FulfillmentFilterOptions> {
  // Cross-filtering: the server prunes options for each dimension based on
  // the values currently picked in the others.
  const p = buildListParams(q);
  const res = await apiFetch(
    `/api/v1/production/fulfillment-v2/filter-options?${p}`,
    { signal },
  );
  if (!res.ok) throw new Error(`Filter options HTTP ${res.status}`);
  return (await res.json()) as FulfillmentFilterOptions;
}

export interface FulfillmentSyncResponse {
  synced?: number;
  summary?: { synced?: number };
  [k: string]: unknown;
}

export async function syncFulfillmentNow(
  entity?: string,
): Promise<FulfillmentSyncResponse> {
  const res = await apiFetch(`/api/v1/production/fulfillment-v2/sync`, {
    method: "POST",
    body: JSON.stringify({ entity: entity || null }),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { detail?: string };
      if (j.detail) detail = j.detail;
    } catch { /* non-JSON */ }
    throw new Error(detail);
  }
  return (await res.json()) as FulfillmentSyncResponse;
}

// ── Detail ───────────────────────────────────────────────────────────────
//
// Server returns a NESTED dict (services/fulfillment_v2.py:990) — the
// top-level keys group their respective concerns:
//
//   {
//     fulfillment:    { ...row fields..., is_planned, plan_line_id, pending_qty_warning },
//     bom:            { bom_id, bom_note, process_routes, lines, floors? },
//     floor_machines: [ ... ],
//     linked_so:      { so_number, so_date, customer_name, sku_name, ... } | null,
//     revision_log:   [ { revised_at, revision_type, old_value, new_value, reason, revised_by } ],
//     floor_stock:    [ ... ],
//   }
//
// The `fulfillment` block carries the same column names as the LIST row
// (see _V2_LIST_SELECT) — note `original_qty_kg` (NOT `ordered_qty_kg`)
// and `order_status` (NOT `status`), and `delivery_deadline` aliased from
// `deadline_date`.

export interface FulfillmentDetailRow {
  fulfillment_id: number;
  so_line_id?: number | null;
  financial_year?: string | null;
  fg_sku_name?: string | null;
  customer_name?: string | null;
  entity?: string | null;
  original_qty_kg?: number | string | null;
  produced_qty_kg?: number | string | null;
  dispatched_qty_kg?: number | string | null;
  planned_qty_kg?: number | string | null;
  pending_qty_kg?: number | string | null;
  original_qty_units?: number | string | null;
  produced_qty_units?: number | string | null;
  dispatched_qty_units?: number | string | null;
  planned_qty_units?: number | string | null;
  pending_qty_units?: number | string | null;
  delivery_deadline?: string | null;
  order_status?: string | null;
  so_id?: number | null;
  so_number?: string | null;
  so_date?: string | null;
  is_planned?: boolean | null;
  plan_line_id?: number | null;
  pending_qty_warning?: boolean | null;
  [k: string]: unknown;
}

export interface RevisionLogEntry {
  revised_at?: string | null;
  revision_type?: string | null;
  old_value?: string | null;
  new_value?: string | null;
  reason?: string | null;
  revised_by?: string | null;
  [k: string]: unknown;
}

export interface BomProcessRoute {
  step_number?: number | null;
  process_name?: string | null;
  stage?: string | null;
  std_time_min?: number | null;
  loss_pct?: number | null;
  machine_type?: string | null;
  [k: string]: unknown;
}

export interface FulfillmentDetail {
  fulfillment: FulfillmentDetailRow;
  bom?: {
    bom_id?: number | null;
    bom_note?: string | null;
    process_routes?: BomProcessRoute[];
    lines?: unknown[];
    [k: string]: unknown;
  };
  floor_machines?: unknown[];
  linked_so?: Record<string, unknown> | null;
  revision_log?: RevisionLogEntry[];
  floor_stock?: unknown[];
  [k: string]: unknown;
}

export async function fetchFulfillmentDetail(
  id: number,
  signal?: AbortSignal,
): Promise<FulfillmentDetail> {
  const res = await apiFetch(`/api/v1/production/fulfillment-v2/${id}/detail`, { signal });
  if (!res.ok) throw new Error(`Detail HTTP ${res.status}`);
  return (await res.json()) as FulfillmentDetail;
}

// ── Revise (deadline) ────────────────────────────────────────────────────

export interface ReviseDeadlineBody {
  new_date: string;            // YYYY-MM-DD
  reason?: string | null;
}

export async function reviseFulfillment(
  id: number,
  body: ReviseDeadlineBody,
): Promise<unknown> {
  const res = await apiFetch(`/api/v1/production/fulfillment-v2/${id}/revise`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { detail?: string };
      if (j.detail) detail = j.detail;
    } catch { /* non-JSON */ }
    throw new Error(detail);
  }
  return await res.json();
}

// ── Create plan from selection ───────────────────────────────────────────
//
// Body shape mirrors server_replica/.../router.py:83 (PlanV2Create) and the
// per-line shape that frontend_replica/.../fulfillment.js:2098 builds:
//
//   { entity, warehouse, plan_type="daily", plan_date,
//     date_from?, date_to?,
//     lines: [{ fg_sku_name, customer_name, planned_qty_kg,
//               planned_qty_units, linked_so_fulfillment_ids: [fid],
//               steps?, area?, deadline_date? }] }
//
// `entity`, `warehouse`, and `plan_date` are all required server-side; sending
// nulls or omitting them yields a 422.

export interface CreatePlanStep {
  process_name?: string | null;
  stage?: string | null;
  floor?: string | null;
  std_time_min?: number | null;
  loss_pct?: number | null;
}

export interface CreatePlanLine {
  fg_sku_name: string;
  customer_name?: string | null;
  planned_qty_kg: number;
  planned_qty_units: number;
  linked_so_fulfillment_ids: number[];
  steps?: CreatePlanStep[];
  area?: string | null;
  deadline_date?: string | null;     // YYYY-MM-DD
}

export interface CreatePlanBody {
  entity: string;                    // required by server
  warehouse: string;                 // required by server
  plan_type?: string;                // defaults "daily"
  plan_date: string;                 // YYYY-MM-DD, required by server
  date_from?: string | null;
  date_to?: string | null;
  lines: CreatePlanLine[];
}

export interface CreatePlanResponse {
  plan_id?: number;
  [k: string]: unknown;
}

export async function createPlan(body: CreatePlanBody): Promise<CreatePlanResponse> {
  const res = await apiFetch(`/api/v1/production/plans-v2`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { detail?: string };
      if (j.detail) detail = j.detail;
    } catch { /* non-JSON */ }
    throw new Error(detail);
  }
  return (await res.json()) as CreatePlanResponse;
}

// ── Resolve SO lines → fulfillment rows ──────────────────────────────────
//
// Backs the SO-Creation "Selected for Plan" panel: the operator checks SO
// article lines (so_line rows) and the panel needs the matching fulfillment
// rows (fulfillment_id, pending qty, deadline, entity) to build a plan.
// Read-only — never creates rows. The server returns the rows in the same
// shape as listFulfillments plus the so_line_ids that have no fulfillment
// row yet (not synced) so the caller can prompt the operator to run Sync.
// Mirrors router.py:571 /fulfillment-v2/by-so-lines.

export interface FulfillmentBySoLinesResponse {
  results: FulfillmentRow[];
  missing_so_line_ids: number[];
}

export async function fetchFulfillmentsBySoLines(
  soLineIds: number[],
  entity?: string,
): Promise<FulfillmentBySoLinesResponse> {
  const res = await apiFetch(`/api/v1/production/fulfillment-v2/by-so-lines`, {
    method: "POST",
    body: JSON.stringify({ so_line_ids: soLineIds, entity: entity || null }),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { detail?: string };
      if (j.detail) detail = j.detail;
    } catch { /* non-JSON */ }
    throw new Error(detail);
  }
  return (await res.json()) as FulfillmentBySoLinesResponse;
}

// ── Deferred (typed only): BOM / floor-stock / carryforward ─────────────
//
// These power the detail-panel "Override BOM" and "Override floor stock"
// modals plus the carryforward flow. Not used by this iteration's UI; types
// reflect the server schemas (router.py:60-79) so a follow-up doesn't need
// to re-derive them.

export interface BomOverrideEntry {
  // The server treats line items as opaque dicts (BomOverrideV2Request.overrides:
  // list[dict] = []). The frontend writer side hasn't been fully audited here;
  // typical fields seen in the original Electron client. Extend as needed.
  material_sku_name?: string | null;
  quantity_per_unit?: number | null;
  loss_pct?: number | null;
  [k: string]: unknown;
}

export interface BomOverrideBody {
  overrides: BomOverrideEntry[];
  overridden_by?: string;
}

export async function fetchBomOverride(
  id: number,
  signal?: AbortSignal,
): Promise<{ overrides?: BomOverrideEntry[]; [k: string]: unknown }> {
  const res = await apiFetch(`/api/v1/production/fulfillment-v2/${id}/bom-override`, { signal });
  if (!res.ok) throw new Error(`BOM override HTTP ${res.status}`);
  return (await res.json()) as { overrides?: BomOverrideEntry[] };
}

export async function saveBomOverride(
  id: number,
  body: BomOverrideBody,
): Promise<unknown> {
  const res = await apiFetch(`/api/v1/production/fulfillment-v2/${id}/bom-override`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`BOM override HTTP ${res.status}`);
  return await res.json();
}

export interface FloorStockEntry {
  material_sku_name?: string | null;
  qty_kg?: number | null;
  [k: string]: unknown;
}

export interface FloorStockBody {
  entries: FloorStockEntry[];
  added_by?: string;
}

export async function fetchFloorStock(
  id: number,
  signal?: AbortSignal,
): Promise<{ entries?: FloorStockEntry[]; [k: string]: unknown }> {
  const res = await apiFetch(`/api/v1/production/fulfillment-v2/${id}/floor-stock`, { signal });
  if (!res.ok) throw new Error(`Floor stock HTTP ${res.status}`);
  return (await res.json()) as { entries?: FloorStockEntry[] };
}

export async function saveFloorStock(
  id: number,
  body: FloorStockBody,
): Promise<unknown> {
  const res = await apiFetch(`/api/v1/production/fulfillment-v2/${id}/floor-stock`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Floor stock HTTP ${res.status}`);
  return await res.json();
}

export interface CarryforwardBody {
  fulfillment_ids: number[];   // required
  new_fy: string;              // required, e.g. "2025-26"
  revised_by?: string;
}

export async function carryforwardFulfillment(body: CarryforwardBody): Promise<unknown> {
  const res = await apiFetch(`/api/v1/production/fulfillment-v2/carryforward`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Carryforward HTTP ${res.status}`);
  return await res.json();
}

// ── Formatters reused by the page ────────────────────────────────────────

export function fmtKg(v: number | string | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = typeof v === "number" ? v : parseFloat(v);
  if (Number.isNaN(n)) return "—";
  return n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

export function fmtUnits(v: number | string | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = typeof v === "number" ? v : parseFloat(v);
  if (Number.isNaN(n)) return "—";
  return n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

export function fmtDeadline(iso?: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  } catch {
    return iso;
  }
}

export type DeadlineTone = "overdue" | "soon" | "ok" | "none";

export function deadlineTone(iso?: string | null): DeadlineTone {
  if (!iso) return "none";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "none";
  const now = Date.now();
  const daysAhead = (t - now) / (1000 * 60 * 60 * 24);
  if (daysAhead < 0) return "overdue";
  if (daysAhead < 3) return "soon";
  return "ok";
}
