// SO (Sales Order) client. Mirrors the Electron renderer's
// `frontend_replica/src/shared/js/so-view.js` + the per-page so-creation
// scripts. Ten endpoints in total, all under /api/v1/so/ (one fulfillment
// sync endpoint lives under /api/v1/production/).

import { apiFetch } from "./auth";

// ── Listing types ─────────────────────────────────────────────────────────

export type GstStatus = "ok" | "mismatch" | "warning" | "unmatched" | string;

export interface SoLine {
  so_line_id?: number | null;
  line_number?: number | null;
  sku_name?: string | null;
  item_category?: string | null;
  sub_category?: string | null;
  uom?: string | null;
  grp_code?: string | null;
  status?: string | null;
  quantity?: number | string | null;
  quantity_units?: number | string | null;
  rate_inr?: number | string | null;
  amount_inr?: number | string | null;
  igst_amount?: number | string | null;
  sgst_amount?: number | string | null;
  cgst_amount?: number | string | null;
  apmc_amount?: number | string | null;
  packing_amount?: number | string | null;
  freight_amount?: number | string | null;
  processing_amount?: number | string | null;
  total_amount_inr?: number | string | null;
  rate_type?: string | null;
  item_type?: string | null;
  item_description?: string | null;
  sales_group?: string | null;
  match_source?: string | null;
  match_score?: number | null;
  line_status?: string | null;
  gst_status?: GstStatus | null;
}

// Reconciliation envelope alongside each line. Backend populates this when
// the article matched into the master; null means "unmatched — no reconcile".
export interface GstRecon {
  status?: GstStatus | null;
  // Master-side echoes for the Excel-vs-Master comparison table.
  matched_item_description?: string | null;
  matched_item_category?: string | null;
  matched_sub_category?: string | null;
  matched_uom?: string | number | null;
  matched_sales_group?: string | null;
  matched_item_type?: string | null;
  // Numeric reconciliation.
  expected_gst_rate?: number | string | null;
  actual_gst_rate?: number | string | null;
  expected_gst_amount?: number | string | null;
  actual_gst_amount?: number | string | null;
  gst_difference?: number | string | null;
  gst_type?: string | null;
  // Per-rule booleans the validation checklist surfaces. null means
  // "not applicable / not run".
  gst_type_valid?: boolean | null;
  sgst_cgst_equal?: boolean | null;
  total_with_gst_valid?: boolean | null;
  uom_match?: boolean | null;
  // Master flag — RM_SOLD / PM_SOLD signal articles being sold off-spec.
  item_type_flag?: string | null;
  // Free-form audit notes, semicolon-separated when multiple.
  notes?: string | null;
}

// Each line in a list response is wrapped as { line, gst_recon } — the
// reconciliation result is materialised alongside the line so the UI can
// render mismatch detail without a separate fetch. The legacy manual-update
// endpoint returns the inner SoLine array directly without the wrapper,
// which is why both shapes need to be tolerated when reading `lines`.
export interface SoLineEntry {
  line: SoLine;
  gst_recon?: GstRecon | null;
}

export interface SoRow {
  so_id?: number | null;
  so_number?: string | null;
  so_date?: string | null;
  customer_name?: string | null;
  common_customer_name?: string | null;
  company?: string | null;
  voucher_type?: string | null;
  // Per-SO totals used by the GST bar in the table row.
  total_lines?: number | null;
  gst_ok?: number | null;
  gst_warning?: number | null;
  gst_mismatch?: number | null;
  // Convenience legacy alias from the older code path; modern responses
  // omit it. Kept so the UI can fall back when the new field is missing.
  line_count?: number | null;
  // List endpoint returns SoLineEntry[]; detail (/so/{id}) returns SoLine[].
  // Tolerate both at the type level and unwrap in the renderer.
  lines?: SoLineEntry[] | SoLine[];
  [k: string]: unknown;
}

export interface SoSummary {
  total_sos?: number;
  total_lines?: number;
  matched_lines?: number;
  gst_ok?: number;
  gst_mismatch?: number;
  gst_warning?: number;
  unmatched_lines?: number;
  // SO-level counters used by the status chip counts.
  so_ok?: number;
  so_mismatch?: number;
  so_warning?: number;
  so_unmatched?: number;
  // Fulfillment-availability counters backing the Pending / Fulfilled chips.
  // so_pending = SOs with any line still having pending qty; so_fulfilled =
  // SOs with fulfillment rows but none pending.
  so_pending?: number;
  so_fulfilled?: number;
}

export interface SoFilterOptions {
  companies?: string[];
  customer_names?: string[];
  common_customer_names?: string[];
  so_numbers?: string[];
  voucher_types?: string[];
  item_categories?: string[];
  sub_categories?: string[];
  uoms?: string[];
  grp_codes?: string[];
  rate_types?: string[];
  item_types?: string[];
  sales_groups?: string[];
  match_sources?: string[];
  statuses?: string[];
  articles?: string[];
}

export interface SoListResponse {
  page?: number;
  page_size?: number;
  total?: number;
  total_pages?: number;
  summary?: SoSummary;
  filter_options?: SoFilterOptions;
  sales_orders?: SoRow[];
}

// Listing filters. Every field is optional so the caller can build the
// query incrementally; only set keys are serialised to the wire.
export interface SoListQuery {
  page?: number;
  page_size?: number;
  search?: string;
  status?: GstStatus;
  sort_by?: "so_number" | "so_date" | "gst_status" | "customer_name" | "company";
  sort_order?: "asc" | "desc";
  date_from?: string;
  date_to?: string;
  company?: string;
  voucher_type?: string;
  customer_name?: string;
  common_customer_name?: string;
  so_number?: string;
  item_category?: string;
  sub_category?: string;
  uom?: string;
  grp_code?: string;
  rate_type?: string;
  item_type?: string;
  sales_group?: string;
  match_source?: string;
  line_status?: string;
  // Article (so_line.sku_name) multi-select — comma-joined values, OR within
  // the field, matching the planning page's "All Articles" filter.
  article?: string;
  // Fulfillment-availability filter. "pending" = SOs with any line whose
  // pending_qty_kg > 0; "fulfilled" = SOs that have fulfillment rows but none
  // pending. Independent of the GST `status` filter (a different dimension).
  fulfillment_status?: "pending" | "fulfilled";
}

export function buildListParams(q: SoListQuery): URLSearchParams {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v == null || v === "") continue;
    p.set(k, String(v));
  }
  return p;
}

export async function listSos(q: SoListQuery, signal?: AbortSignal): Promise<SoListResponse> {
  const params = buildListParams(q);
  const res = await apiFetch(`/api/v1/so/view?${params}`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as SoListResponse;
}

// ── Single SO detail ─────────────────────────────────────────────────────

export async function getSo(soId: number, signal?: AbortSignal): Promise<SoRow> {
  const res = await apiFetch(`/api/v1/so/${soId}`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as SoRow;
}

// ── Upload (xlsx) ────────────────────────────────────────────────────────

export interface SoUploadResponse {
  summary?: {
    total_sos?: number;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export async function uploadSoBook(file: File): Promise<SoUploadResponse> {
  const fd = new FormData();
  fd.append("file", file);
  // FormData triggers the browser to set the correct multipart Content-Type
  // header (with boundary). Don't set it manually.
  const res = await apiFetch(`/api/v1/so/upload-so-book`, {
    method: "POST",
    body: fd,
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { detail?: string };
      if (j.detail) detail = j.detail;
    } catch { /* non-JSON body */ }
    throw new Error(detail);
  }
  return (await res.json()) as SoUploadResponse;
}

// ── Fulfillment sync ─────────────────────────────────────────────────────
//
// The fulfillment-v2/sync client lives in lib/fulfillment.ts as
// `syncFulfillmentNow(entity?)`, which forwards an optional entity scope and
// surfaces the server's error detail. SO Creation and Planning both call it;
// the old entity-less `syncFulfillment()` here was removed to avoid two
// divergent clients for the same endpoint.

// ── Manual create / update ───────────────────────────────────────────────

export interface SoCreatePayload {
  so_number: string;
  so_date: string;
  customer_name: string;
  common_customer_name: string;
  company: string;
  voucher_type: string;
  lines: SoLine[];
}

export async function createSo(body: SoCreatePayload): Promise<unknown> {
  const res = await apiFetch(`/api/v1/so/create`, {
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
  return await res.json();
}

export interface SoUpdatePayload {
  so_number: string;
  old_header: Omit<SoCreatePayload, "lines" | "so_number">;
  new_header: Omit<SoCreatePayload, "lines" | "so_number">;
  old_lines: SoLine[];
  new_lines: SoLine[];
}

export interface SoUpdateResponse {
  header_changes?: number;
  line_changes?: number;
  [k: string]: unknown;
}

// 409 = stale snapshot. The caller surfaces a "reload + retry" hint.
export class SoStaleError extends Error {
  constructor(public body: unknown) {
    super("Stale SO snapshot");
  }
}

export async function updateSo(body: SoUpdatePayload): Promise<SoUpdateResponse> {
  const res = await apiFetch(`/api/v1/so/update`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (res.status === 409) {
    let info: unknown = null;
    try { info = await res.json(); } catch { /* ignore */ }
    throw new SoStaleError(info);
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { detail?: string };
      if (j.detail) detail = j.detail;
    } catch { /* non-JSON */ }
    throw new Error(detail);
  }
  return (await res.json()) as SoUpdateResponse;
}

// ── SKU lookup (manual entry / manual update autocomplete) ───────────────

export interface SkuLookupParams {
  item_type?: string;
  item_group?: string;
  sub_group?: string;
  sales_group?: string;
  search?: string;
  particulars?: string;
}

export interface SkuLookupResponse {
  selected_item?: {
    particulars?: string;
    sku_id?: number | string;
    uom?: string;
    gst?: number | string;
    item_type?: string;
    item_group?: string;
    sub_group?: string;
    sale_group?: string;
  };
  options?: {
    item_types?: string[];
    item_groups?: string[];
    sub_groups?: string[];
    sales_groups?: string[];
    particulars?: string[];
  };
}

export async function lookupSku(
  params: SkuLookupParams,
  signal?: AbortSignal,
): Promise<SkuLookupResponse> {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") p.set(k, String(v));
  }
  const res = await apiFetch(`/api/v1/so/sku-lookup?${p}`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as SkuLookupResponse;
}

// ── Update via Excel: preview + confirm ──────────────────────────────────

export interface SoUpdateChange {
  field?: string;
  old_value?: unknown;
  new_value?: unknown;
}

export interface SoLineChange {
  line_number?: number | null;
  sku_name?: string | null;
  change_type?: "added" | "modified" | "removed" | string;
  changes?: SoUpdateChange[];
}

export interface SoUpdatePreviewItem {
  so_id: number;
  so_number?: string | null;
  header_changes?: SoUpdateChange[];
  line_changes?: SoLineChange[];
}

export interface SoUpdatePreviewResponse {
  file_hash: string;
  total_in_file?: number;
  unchanged_count?: number;
  changed_count?: number;
  not_found_so_numbers?: string[];
  changes?: SoUpdatePreviewItem[];
}

export async function previewSoUpdate(file: File): Promise<SoUpdatePreviewResponse> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await apiFetch(`/api/v1/so/update-preview`, {
    method: "POST",
    body: fd,
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { detail?: string };
      if (j.detail) detail = j.detail;
    } catch { /* non-JSON */ }
    throw new Error(detail);
  }
  return (await res.json()) as SoUpdatePreviewResponse;
}

export interface SoUpdateConfirmResponse {
  updated_count?: number;
  [k: string]: unknown;
}

export async function confirmSoUpdate(
  fileHash: string,
  soIds: number[],
): Promise<SoUpdateConfirmResponse> {
  const res = await apiFetch(
    `/api/v1/so/update-confirm?file_hash=${encodeURIComponent(fileHash)}`,
    {
      method: "POST",
      body: JSON.stringify({ so_ids: soIds }),
    },
  );
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { detail?: string };
      if (j.detail) detail = j.detail;
    } catch { /* non-JSON */ }
    throw new Error(detail);
  }
  return (await res.json()) as SoUpdateConfirmResponse;
}

// ── Export (JSON → CSV) ──────────────────────────────────────────────────
//
// `/api/v1/so/export` returns JSON of the same row shape as `/view`,
// without pagination — every matched SO + lines comes back in one
// payload. The Electron client wraps that in xlsx-js-style to produce a
// styled .xlsx; on the web we generate a CSV client-side from the same
// data. CSV is a strict subset of what the operators do in Excel anyway:
// every column number rounds the same way, and pivot tables / styled
// rows are usually not worth the dependency footprint here.

export interface SoExportResponse {
  sales_orders?: SoRow[];
  total?: number;
}

export async function fetchSoExport(q: SoListQuery & { status?: GstStatus }): Promise<SoExportResponse> {
  // Strip pagination params — export wants every match, not just one page.
  const cleaned: SoListQuery = { ...q };
  delete cleaned.page;
  delete cleaned.page_size;
  const params = buildListParams(cleaned);
  const res = await apiFetch(`/api/v1/so/export?${params}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as SoExportResponse;
}

// ── Form helpers ─────────────────────────────────────────────────────────

// Round numeric inputs to 3 decimal places for the wire — matches the
// Electron client's parseFloat(value.toFixed(3)) before-send rounding.
export function round3(v: number | string | null | undefined): number {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : parseFloat(v);
  if (!Number.isFinite(n)) return 0;
  return parseFloat(n.toFixed(3));
}

// Compute a single line's derived fields. Caller passes raw user values
// (strings from inputs) and we return numeric totals ready for display.
export function computeLineTotals(line: {
  quantity?: string;
  uom_value?: number; // weight per unit
  rate?: string;
  igst?: string;
  sgst?: string;
  cgst?: string;
  apmc?: string;
  packing?: string;
  freight?: string;
  processing?: string;
}): { quantityUnits: number; amount: number; total: number } {
  const qty = round3(line.quantity);
  const uom = line.uom_value ?? 1;
  const quantityUnits = round3(qty * uom);
  const rate = round3(line.rate);
  const amount = round3(quantityUnits * rate);
  const charges =
    round3(line.igst) +
    round3(line.sgst) +
    round3(line.cgst) +
    round3(line.apmc) +
    round3(line.packing) +
    round3(line.freight) +
    round3(line.processing);
  const total = round3(amount + charges);
  return { quantityUnits, amount, total };
}

export const COMPANY_OPTIONS = ["CFPL", "CDPL"] as const;
export const VOUCHER_TYPE_OPTIONS = [
  "HO Sales",
  "Sales",
  "Sales - GST",
  "Sales Return",
  "Export Sales",
] as const;
