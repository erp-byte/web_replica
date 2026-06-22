// SFG / WIP catalogue client — typed wrappers over the production SFG endpoints
// (router.py: /job-cards-v2/sfg-master, /sfg-where-used, /sfg-wip-stock). All go
// through apiFetch so they pick up the silent-refresh + auth handling.

import { apiFetch, readApiErrorMessage } from "./auth";

export interface SfgMasterRow {
  sku_id: number;
  sfg_code: string;
  sfg_name: string;
  item_group: string | null;
  sub_group: string | null;
  uom: string | null;
  sale_group: string | null;
  produced_at_stage: string | null;
  consumed_by_fg_count: number | null;
  base_recipe: string | null;
  create_wip_operation: string | null;
  sfg_origin: string | null;
  va_article: string | null;
  primary_bu: string | null;
}

export interface WhereUsedRow {
  sfg_code: string;
  sfg_name: string | null;
  bom_id: number;
  fg_sku_name: string;
  entity: string | null;
  consumed_at_step: number | null;
  consumed_at_stage: string | null;
}

export interface WipStockRow {
  sfg_code: string;
  sfg_name: string | null;
  base_recipe: string | null;
  total_qty_kg: number;
  batch_count: number;
  oldest_inward: string | null;
  floors: string[];
}

export interface Pagination {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

// ── Routing Gaps ──────────────────────────────────────────────────────────────
// SFG reconciliation: unrouted FG articles grouped by product family. Production
// reviews the suggested Process Category, tweaks per row, and applies (routes).
// Backed by GET/POST /production/routing-gaps (built in parallel — code defensively).

export interface RoutingGapArticle {
  article: string;
  in_all_sku: boolean;
  current_process_category: string | null;
  suggested_process_category: string;
}

export interface RoutingGapFamily {
  family: string;
  suggested_process_category: string;
  count: number;
  needs_review: boolean;
  articles: RoutingGapArticle[];
}

export interface RoutingGapsResponse {
  total: number;
  families: RoutingGapFamily[];
}

export interface RoutingGapAssignment {
  article: string;
  process_category: string;
}

export interface RoutingGapApplyResult {
  article: string;
  status: string;
  bom_id: number | null;
  detail: string;
}

export interface RoutingGapsApplyResponse {
  applied: number;
  skipped: number;
  results: RoutingGapApplyResult[];
}

const PROD = "/api/v1/production";

/** Path to the routing-gaps worksheet CSV (fetch the blob via apiFetch to download). */
export const ROUTING_GAPS_WORKSHEET_PATH = `${PROD}/routing-gaps/worksheet.csv`;

/** Fetch unrouted FG articles grouped by product family. */
export async function fetchRoutingGaps(signal?: AbortSignal): Promise<RoutingGapsResponse> {
  const res = await apiFetch(`${PROD}/routing-gaps`, { signal });
  if (!res.ok) throw new Error(await readApiErrorMessage(res, "Failed to load routing gaps"));
  return res.json();
}

/** Apply process-category assignments (routes the articles). */
export async function applyRoutingGaps(
  assignments: RoutingGapAssignment[],
  performedBy?: string | null,
  signal?: AbortSignal,
): Promise<RoutingGapsApplyResponse> {
  const res = await apiFetch(`${PROD}/routing-gaps/apply`, {
    method: "POST",
    body: JSON.stringify({ assignments, performed_by: performedBy ?? null }),
    signal,
  });
  if (!res.ok) throw new Error(await readApiErrorMessage(res, "Failed to apply routing gaps"));
  return res.json();
}

const BASE = "/api/v1/production/job-cards-v2";

export async function fetchSfgMaster(
  opts: { search?: string; sfg_code?: string; page?: number; page_size?: number },
  signal?: AbortSignal,
): Promise<{ results: SfgMasterRow[]; pagination: Pagination }> {
  const p = new URLSearchParams();
  if (opts.search) p.set("search", opts.search);
  if (opts.sfg_code) p.set("sfg_code", opts.sfg_code);
  p.set("page", String(opts.page ?? 1));
  p.set("page_size", String(opts.page_size ?? 50));
  const res = await apiFetch(`${BASE}/sfg-master?${p.toString()}`, { signal });
  if (!res.ok) throw new Error(await readApiErrorMessage(res, "Failed to load SFG master"));
  return res.json();
}

export async function fetchWhereUsed(
  sfgCode: string,
  entity?: string,
  signal?: AbortSignal,
): Promise<{ sfg_code: string; consumed_by: WhereUsedRow[] }> {
  const p = new URLSearchParams({ sfg_code: sfgCode });
  if (entity) p.set("entity", entity);
  const res = await apiFetch(`${BASE}/sfg-where-used?${p.toString()}`, { signal });
  if (!res.ok) throw new Error(await readApiErrorMessage(res, "Failed to load where-used"));
  return res.json();
}

export async function fetchWipStock(
  entity: string,
  opts: { search?: string; page?: number; page_size?: number } = {},
  signal?: AbortSignal,
): Promise<{ results: WipStockRow[]; pagination: Pagination }> {
  const p = new URLSearchParams({ entity });
  if (opts.search) p.set("search", opts.search);
  p.set("page", String(opts.page ?? 1));
  p.set("page_size", String(opts.page_size ?? 50));
  const res = await apiFetch(`${BASE}/sfg-wip-stock?${p.toString()}`, { signal });
  if (!res.ok) throw new Error(await readApiErrorMessage(res, "Failed to load WIP stock"));
  return res.json();
}
