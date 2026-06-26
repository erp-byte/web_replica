// Sample Issuing module client. All endpoints under /api/v1/sample/* (see
// server_replica/app/modules/sample/FRONTEND_API_DOC.md). Calls go through the
// same-origin apiFetch (relative URLs → Next /api proxy → FastAPI), so there is
// no mixed-content exposure. The SKU picker reuses /api/v1/so/sku-lookup.

import { apiFetch, readApiErrorMessage } from "./auth";

export type SampleType = "BASIS_RM" | "BASIS_FG" | "NPD" | "INTERNAL" | "TRIAL";

export type SampleStatus =
  | "DRAFT" | "SUBMITTED" | "BH_APPROVED" | "BH_REJECTED" | "ON_HOLD"
  | "IN_PRODUCTION" | "PACKING" | "READY_FOR_DISPATCH"
  | "INTERNALLY_DISPATCHED" | "PARTIALLY_CONVERTED"
  | "GATE_PASS_ISSUED" | "CLOSED" | "CANCELLED";

export type ArticleRole = "RM" | "FG" | "NPD_INPUT" | "NPD_OUTPUT";
export type PurposeTag =
  | "CUSTOMER_DISPLAY" | "CUSTOMER_ISSUE" | "TASTING_SENSORY"
  | "PHYSICAL_PARAMETERS" | "INTERNAL_OTHER";

export type Warehouse =
  | "W202" | "A185" | "A68" | "F53" | "A101" | "D-39" | "D-514" | "Rishi" | "Supreme";
export const WAREHOUSES: Warehouse[] =
  ["W202", "A185", "A68", "F53", "A101", "D-39", "D-514", "Rishi", "Supreme"];

export interface Article {
  id?: number;
  sku_id: number;
  sku_name: string;
  required_qty: number | string;
  issued_qty?: number | string | null;
  uom: string;
  article_role: ArticleRole;
  pack_size_kg?: number | string | null;
  notes?: string | null;
}

export interface Approval {
  id: number;
  approval_stage: string;
  approver_user_id: number;
  role_at_action: string;
  action: "PENDING" | "APPROVED" | "REJECTED" | "HOLD";
  remarks?: string | null;
  sequence_no: number;
  actioned_at?: string | null;
  created_at?: string | null;
}

export interface AuditEntry {
  id: number;
  event_type: string;
  old_value?: unknown;
  new_value?: unknown;
  actor_user_id?: number | null;
  actor_role?: string | null;
  remarks?: string | null;
  created_at: string;
}

export interface Requisition {
  id: number;
  request_id?: number;               // 8-digit BIGINT request handle — the surfaced identifier
  sample_type: SampleType;
  status: SampleStatus;
  requestor_user_id?: number;
  requestor_team?: string | null;
  purpose_tag?: PurposeTag | null;
  purpose_note?: string | null;
  base_bom_id?: number | null;
  npd_target_name?: string | null;   // requested new NPD article name
  pcs?: number | null;               // number of pieces
  weight_per_piece?: number | null;  // weight per piece (kg)
  quantity?: number | null;          // total = pcs × weight_per_piece (kg)
  description?: string | null;       // free-text request description
  linked_dev_jc_id?: number | null;  // dev job card created from this request's Develop
  npd_draft_bom_id?: number | null;
  linked_job_card_id?: number | null;
  linked_gate_pass_id?: number | null;
  converted_from_id?: number | null;
  converted_to_external?: boolean;
  warehouse?: string;
  transporter_name?: string | null;
  vehicle_number?: string | null;
  // Customer + dispatch planning (carried onto the dev job card).
  company_name?: string | null;
  customer_name?: string | null;
  customer_contact?: string | null;
  customer_ship_to_address?: string | null;
  mode_of_transport?: string | null;
  expected_dispatch_date?: string | null;   // by BD team
  confirmed_dispatch_date?: string | null;  // by NPD
  cancellation_reason?: string | null;
  // Billing checklist (NPD/TRIAL): returnable XOR non_returnable; amount is 0 unless paid.
  returnable?: boolean | null;
  non_returnable?: boolean | null;
  paid?: boolean | null;
  amount?: number | null;
  hold_start_date?: string | null;  // date a HOLD takes effect (set on hold)
  hold_reason?: string | null;      // latest HOLD remark (list rows; for the Hold pill tooltip)
  created_at?: string | null;
  updated_at?: string | null;
  // Enriched on detail GET:
  articles?: Article[];
  approvals?: Approval[];
  audit?: AuditEntry[];
}

export interface GatePassDetails {
  requisition_id?: number;
  original_requisition_id?: number | null;
  sample_type?: string | null;
  purpose_tag?: string | null;
  purpose_note?: string | null;
  converted_from_internal?: boolean;
  conversion_qty?: number | string | null;
}

export interface GatePass {
  id: number;
  gate_pass_number: string;
  gate_pass_type?: string;
  recipient_name?: string | null;
  recipient_contact?: string | null;
  vehicle_carrier?: string | null;
  driver_name?: string | null;
  from_location?: string | null;
  print_count?: number;
  last_printed_at?: string | null;
  voided?: boolean;
  void_reason?: string | null;
  warehouse?: string;
  sample_details?: GatePassDetails | null;
}

export interface NpdLine {
  id?: number;
  sku_id: number | null;   // null for clone-from-base lines (bom_line has no sku_id)
  sku_name: string;
  qty: number | string;
  uom: string;
  item_type?: "rm" | "pm" | null;
  delta_type?: "UNCHANGED" | "ADDED" | "MODIFIED" | "REMOVED";
  original_qty?: number | string | null;
  // Per-ingredient ownership (NPD plan §3). CUSTOMER / off-master lines are
  // recorded for traceability only — they get no inventory posting.
  ownership?: "OWN" | "CUSTOMER";
  is_off_master?: boolean;
  line_order?: number;
  notes?: string | null;
}

export interface NpdDraft {
  id: number;
  requisition_id: number;
  base_bom_id?: number | null;
  fg_sku_id?: number | null;
  fg_sku_name?: string | null;
  description?: string | null;
  status: "DRAFT" | "USED" | "PROMOTED" | "ARCHIVED";
  promoted_bom_id?: number | null;
  lines?: NpdLine[];
}

// ── transport helpers ──────────────────────────────────────────────────────
// Accepts a Response OR a Promise<Response> so call sites can pass either
// `await apiFetch(...)` or the un-awaited `post(...)` / `apiFetch(...)`.
async function jsonOrThrow<T>(resP: Response | Promise<Response>, fallback: string): Promise<T> {
  const res = await resP;
  if (!res.ok) throw new Error(await readApiErrorMessage(res, fallback));
  return (await res.json()) as T;
}

function post(path: string, body?: unknown): Promise<Response> {
  return apiFetch(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
}

// ── Requisitions ───────────────────────────────────────────────────────────
export interface ListFilters {
  status?: string;
  sample_type?: string;
  sample_types?: string;   // CSV — narrows to a set (NPD queue passes "NPD,TRIAL")
  statuses?: string;       // CSV — status bucket (NPD queue maps Pending/Hold/Accepted)
  warehouse?: string;
  requestor?: string;      // exact requestor_team match (filter dropdown)
  q?: string;              // free-text: number / request_id / target / desc / requestor
  date_from?: string;      // ISO date (created_at >=)
  date_to?: string;        // ISO date (created_at <=)
  limit?: number;
  offset?: number;
}

export async function listRequisitions(f: ListFilters = {}): Promise<Requisition[]> {
  const q = new URLSearchParams();
  if (f.status) q.set("status", f.status);
  if (f.sample_type) q.set("sample_type", f.sample_type);
  if (f.sample_types) q.set("sample_types", f.sample_types);
  if (f.statuses) q.set("statuses", f.statuses);
  if (f.warehouse) q.set("warehouse", f.warehouse);
  if (f.requestor) q.set("requestor", f.requestor);
  if (f.q) q.set("q", f.q);
  if (f.date_from) q.set("date_from", f.date_from);
  if (f.date_to) q.set("date_to", f.date_to);
  q.set("limit", String(f.limit ?? 50));
  q.set("offset", String(f.offset ?? 0));
  return jsonOrThrow(await apiFetch(`/api/v1/sample/requisitions?${q}`), "Failed to load requisitions");
}

// Distinct requestor labels for the queue's Requestor filter dropdown.
export async function listRequestors(sampleTypes?: string): Promise<string[]> {
  const q = new URLSearchParams();
  if (sampleTypes) q.set("sample_types", sampleTypes);
  try {
    const res = await apiFetch(`/api/v1/sample/requisitions/requestors?${q}`);
    if (!res.ok) return [];
    return (await res.json()) as string[];
  } catch {
    return [];
  }
}

export async function getRequisition(id: number): Promise<Requisition> {
  return jsonOrThrow(await apiFetch(`/api/v1/sample/requisitions/${id}`), "Failed to load requisition");
}

export interface RequisitionCreate {
  sample_type: SampleType;
  warehouse: Warehouse;
  requestor_team?: string;
  purpose_tag?: PurposeTag;
  purpose_note?: string;
  description?: string;
  base_bom_id?: number;
  npd_target_name?: string;
  pcs?: number;
  weight_per_piece?: number;
  quantity?: number;
  internal_override?: boolean;
  transporter_name?: string;
  vehicle_number?: string;
  company_name?: string;
  customer_name?: string;
  customer_contact?: string;
  customer_ship_to_address?: string;
  mode_of_transport?: string;
  expected_dispatch_date?: string;
  confirmed_dispatch_date?: string;
  // Billing checklist (NPD/TRIAL). amount is 0 unless paid, else > 0 (≤2 decimals).
  returnable?: boolean;
  non_returnable?: boolean;
  paid?: boolean;
  amount?: number;
  // Optional — issuance flows (Basis RM/FG, Internal) send article lines; NPD /
  // TRIAL requests omit them (the backend defaults to an empty list).
  articles?: Array<Omit<Article, "id" | "issued_qty">>;
}

export async function createRequisition(body: RequisitionCreate): Promise<Requisition> {
  return jsonOrThrow(await post(`/api/v1/sample/requisitions`, body), "Failed to create requisition");
}

// ── NPD sample requisition (the NPD-first create form) ─────────────────────
// A pure request; NPD-mandatory fields are required here AND re-validated by the
// backend (NpdRequisitionCreate). Warehouse offered = the 5-code subset.
export type NpdSampleType = "NPD" | "TRIAL";
export const NPD_SAMPLE_TYPES: { value: NpdSampleType; label: string }[] = [
  { value: "NPD", label: "NPD Internal" },
  { value: "TRIAL", label: "Pilot Customer trial" },
];
export const NPD_WAREHOUSES = ["W202", "A185", "A68", "F53", "A101"] as const;

export interface NpdRequisitionCreate {
  sample_type: NpdSampleType;     // required
  npd_target_name: string;        // required: target NPD article
  pcs: number;                    // required: number of pieces
  weight_per_piece: number;       // required: kg per piece
  quantity?: number;              // computed = pcs × weight_per_piece (kg)
  warehouse: (typeof NPD_WAREHOUSES)[number];  // required
  company_name: string;           // required
  customer_name: string;          // required
  customer_contact?: string;      // nullable
  customer_ship_to_address?: string;   // nullable
  mode_of_transport?: string;     // nullable
  expected_dispatch_date?: string;     // by BD team (ISO date, nullable)
  description?: string;           // nullable
  purpose_tag?: PurposeTag;       // nullable
  requestor_team?: string;        // nullable
  // Billing checklist: returnable XOR non_returnable; amount 0 unless paid, else > 0 (≤2 decimals).
  returnable?: boolean;
  non_returnable?: boolean;
  paid?: boolean;
  amount?: number;
}

export async function createNpdRequisition(body: NpdRequisitionCreate): Promise<Requisition> {
  return jsonOrThrow(await post(`/api/v1/sample/npd-requisitions`, body), "Failed to create NPD requisition");
}

export async function updateRequisition(id: number, body: Partial<RequisitionCreate>): Promise<Requisition> {
  return jsonOrThrow(
    await apiFetch(`/api/v1/sample/requisitions/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    "Failed to update requisition");
}

export const submitRequisition = (id: number) =>
  jsonOrThrow<Requisition>(post(`/api/v1/sample/requisitions/${id}/submit`), "Submit failed");

// Lifecycle actions — all return the refreshed requisition.
const action = (id: number, verb: string, body?: unknown, fallback = "Action failed") =>
  jsonOrThrow<Requisition>(post(`/api/v1/sample/requisitions/${id}/${verb}`, body), fallback);

export const cancelRequisition = (id: number, reason: string) => action(id, "cancel", { reason }, "Cancel failed");
export const closeRequisition = (id: number) => action(id, "close", undefined, "Close failed");
export const approveRequisition = (id: number, act: "APPROVED" | "REJECTED", remarks?: string) =>
  action(id, "approve", { action: act, remarks }, "Approval failed");
export const npdReview = (
  id: number, act: "ACCEPT" | "REJECT" | "HOLD", reason?: string, start_date?: string,
) => action(id, "npd-review", { action: act, reason, start_date }, "NPD review failed");
export const issueOutward = (id: number, from_location?: string) => action(id, "outward", { from_location }, "Outward failed");
export const dispatchInternal = (id: number) => action(id, "dispatch-internal", undefined, "Dispatch failed");
export const startProduction = (id: number) => action(id, "start-production", undefined, "Start production failed");
export const markPacking = (id: number) => action(id, "mark-packing", undefined, "Failed");
export const markReady = (id: number) => action(id, "mark-ready", undefined, "Failed");
export const invVerify = (id: number, remarks?: string) => action(id, "inv-verify", { remarks }, "Verify failed");

export interface RecipientBody {
  recipient_name?: string;
  recipient_contact?: string;
  vehicle_carrier?: string;
  driver_name?: string;
  from_location?: string;
}

export const issueGatePass = (id: number, body: RecipientBody) =>
  jsonOrThrow<GatePass>(post(`/api/v1/sample/requisitions/${id}/issue-gate-pass`, body), "Gate pass failed");
export const convertFull = (id: number, body: RecipientBody & { remarks?: string }) =>
  jsonOrThrow<GatePass>(post(`/api/v1/sample/requisitions/${id}/convert-full`, body), "Conversion failed");
export const convertPartial = (id: number, body: RecipientBody & { qty: number; remarks?: string }) =>
  action(id, "convert-partial", body, "Conversion failed");

// ── Gate pass ──────────────────────────────────────────────────────────────
export const getGatePass = (gpId: number) =>
  jsonOrThrow<GatePass>(apiFetch(`/api/v1/sample/gate-passes/${gpId}`), "Failed to load gate pass");
export const voidGatePass = (gpId: number, reason: string) =>
  jsonOrThrow<GatePass>(post(`/api/v1/sample/gate-passes/${gpId}/void`, { reason }), "Void failed");

/** Fetches the rendered PDF as a Blob (auth header attached by apiFetch). */
export async function printGatePassBlob(gpId: number): Promise<Blob> {
  const res = await post(`/api/v1/sample/gate-passes/${gpId}/print`);
  if (!res.ok) throw new Error(await readApiErrorMessage(res, "Print failed"));
  return res.blob();
}

// ── NPD draft BOM ──────────────────────────────────────────────────────────
export interface NpdDraftCreate {
  base_bom_id?: number;
  fg_sku_id?: number;
  fg_sku_name?: string;
  description?: string;
  clone_from_base?: boolean;
  lines?: NpdLine[];
}

export const createNpdDraft = (reqId: number, body: NpdDraftCreate) =>
  jsonOrThrow<NpdDraft>(post(`/api/v1/sample/requisitions/${reqId}/npd-draft`, body), "Draft BOM failed");
export const getNpdDraft = (draftId: number) =>
  jsonOrThrow<NpdDraft>(apiFetch(`/api/v1/sample/npd-drafts/${draftId}`), "Failed to load draft");
export const replaceNpdLines = (draftId: number, lines: NpdLine[]) =>
  jsonOrThrow<NpdDraft>(
    apiFetch(`/api/v1/sample/npd-drafts/${draftId}/lines`, { method: "PUT", body: JSON.stringify({ lines }) }),
    "Failed to save lines");
export const promoteNpdDraft = (draftId: number) =>
  jsonOrThrow<NpdDraft>(post(`/api/v1/sample/npd-drafts/${draftId}/promote`), "Promote failed");

// ── SKU picker (reuses the SO sku-lookup) ──────────────────────────────────
interface SkuLookupResponse {
  options?: { particulars?: string[] };
  selected_item?: { sku_id: number; particulars: string; uom?: number | null } | null;
}

export async function skuSearch(text: string): Promise<string[]> {
  if (!text.trim()) return [];
  // Browser-level fetch errors (server down, DNS, CORS preflight reject)
  // throw — without this catch the SkuPicker useEffect surfaced the
  // raw "TypeError: Failed to fetch" as an uncaught render error
  // overlay. The picker treats "no options" as the safe default state,
  // so swallowing the network error here lets the page keep working
  // (the operator sees an empty dropdown until the backend comes back).
  try {
    const res = await apiFetch(`/api/v1/so/sku-lookup?search=${encodeURIComponent(text)}`);
    if (!res.ok) return [];
    const data = (await res.json()) as SkuLookupResponse;
    return (data.options?.particulars ?? []).slice(0, 25);
  } catch {
    return [];
  }
}

export async function skuDetail(particulars: string): Promise<{ sku_id: number; sku_name: string } | null> {
  try {
    const res = await apiFetch(`/api/v1/so/sku-lookup?particulars=${encodeURIComponent(particulars)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as SkuLookupResponse;
    const it = data.selected_item;
    return it ? { sku_id: it.sku_id, sku_name: it.particulars } : null;
  } catch {
    return null;
  }
}

// ── SKU cascade (material_type → item_category → sub_category → particulars) ──
// The requisition Articles section drives the same four-dropdown cascade the
// PO/SO manual-entry form uses, all off /api/v1/so/sku-lookup. Re-export the SO
// client's typed lookup (which returns both the filtered option lists and, when
// `particulars` is passed, the resolved SKU) so the sample form reuses it.
export { lookupSku, type SkuLookupParams, type SkuLookupResponse } from "./so";
