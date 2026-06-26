// QC Inward Inspection client. Wraps /api/v1/qc/* and the reused
// /api/v1/receipt/coa* endpoints. All types mirror server_replica
// app/modules/qc/schemas.py and app/modules/receipt/schemas.py.

import { apiFetch } from "./auth";

// ── Shared error reader ────────────────────────────────────────────────────

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json() as {
      detail?: string | { message?: string; error?: string };
      message?: string;
      error?: string;
    } | null;
    if (body) {
      if (typeof body.detail === "string" && body.detail) return body.detail;
      if (body.detail && typeof body.detail === "object") {
        if (body.detail.message) return String(body.detail.message);
        if (body.detail.error)   return String(body.detail.error);
      }
      if (body.message) return String(body.message);
      if (body.error)   return String(body.error);
    }
  } catch { /* non-JSON body */ }
  return `${fallback} (HTTP ${res.status})`;
}

// ── Reading & audit types (qc/schemas.py: Reading, AuditEvent) ─────────────

export interface Reading {
  reading_id: number;
  parameter_id: number | null;
  parameter_name: string | null;
  parameter_unit: string | null;
  observed_value_num: number | null;
  observed_value_text: string | null;
  spec_min: number | null;
  spec_max: number | null;
  spec_target: number | null;
  is_within_spec: boolean | null;
  severity: string | null;
  deviation_pct: number | null;
  method: string | null;
  instrument: string | null;
  notes: string | null;
  recorded_at: string | null;
}

export interface AuditEvent {
  event_type: string;
  from_state: string | null;
  to_state: string | null;
  occurred_at: string | null;
  actor_user_id: number | null;
  payload_diff: Record<string, unknown> | null;
}

// ── List / detail types (qc/schemas.py: InspectionListItem, InspectionDetail) ─

export interface InspectionListItem {
  inspection_id: number;
  po_number: string | null;
  transaction_no: string | null;
  sku_name: string | null;
  sku_name_raw: string | null;
  sku_id: number | null;
  vehicle_no: string | null;
  warehouse: string | null;
  verdict: string | null;
  status: string | null;
  decision: string | null;
}

export interface InspectionListResponse {
  items: InspectionListItem[];
  total: number;
  total_pages: number;
  page: number;
  page_size: number;
}

export interface InspectionDetail {
  inspection_id: number;
  inspection_ref: string | null;
  qc_intimation_id: number | null;
  status: string | null;
  verdict: string | null;
  sample_size: number | null;
  inspection_method: string | null;
  inspector_user_id: number | null;
  started_at: string | null;
  started_by: number | null;
  started_by_name: string | null;
  verdict_at: string | null;
  accepted_qty: number | null;
  rejected_qty: number | null;
  ncr_no: string | null;
  cancelled_at: string | null;
  cancelled_by_name: string | null;
  cancel_reason: string | null;
  reopened_at: string | null;
  reopen_reason: string | null;
  verdict_overridden_by: number | null;
  verdict_overridden_by_name: string | null;
  override_reason: string | null;
  approved_by: number | null;
  approved_by_name: string | null;
  approved_at: string | null;
  remarks: string | null;
  // Denormalised display fields
  po_number: string | null;
  transaction_no: string | null;
  sku_id: number | null;
  sku_name: string | null;
  sku_name_raw: string | null;
  supplier_id: number | null;
  supplier_name: string | null;
  lot_number: string | null;
  vehicle_no: string | null;
  warehouse: string | null;
  readings: Reading[];
}

// ── Intimation types (qc/schemas.py: IntimationItem) ──────────────────────

export interface IntimationItem {
  qc_intimation_id: number;
  sku_name: string | null;
  sku_name_raw: string | null;
  sku_id: number | null;
  po_number: string | null;
  transaction_no: string | null;
  supplier_name: string | null;
  supplier_id: number | null;
  lot_number: string | null;
  coa_received: boolean;
}

// ── Request / response body types ─────────────────────────────────────────

export interface ReadingInput {
  parameter_id: number;
  observed_value_num?: number | null;
  observed_value_text?: string | null;
  method?: string | null;
  instrument?: string | null;
  notes?: string | null;
}

export interface StartInspectionBody {
  qc_intimation_id: number;
  sample_size: number;
  inspection_method?: string;
  remarks?: string | null;
}

export interface StartInspectionResponse {
  inspection_id: number;
}

export interface ReadingsBatchResponse {
  inserted_count: number;
  out_of_spec_count: number;
}

export interface ReadingUpdateBody {
  observed_value_num?: number | null;
  observed_value_text?: string | null;
  method?: string | null;
  instrument?: string | null;
  notes?: string | null;
}

export interface VerdictBody {
  verdict: "passed" | "failed";
  accepted_qty?: number | null;
  rejected_qty?: number | null;
  summary_remarks?: string | null;
}

export interface VerdictResponse {
  verdict: string;
  next_step: string | null;
}

export interface OverrideVerdictBody {
  new_verdict: "passed" | "failed";
  reason: string;
}

export interface OverrideVerdictResponse {
  old_verdict: string | null;
  new_verdict: string;
}

export interface HeaderUpdateBody {
  sample_size?: number | null;
  inspection_method?: string | null;
  inspector_user_id?: number | null;
  remarks?: string | null;
}

export interface ReportResponse {
  report_id: string;
  download_url: string | null;
}

// ── COA types (receipt/schemas.py: CoaListItem, CoaUploadResponse, CoaReplaceResponse) ─

export interface CoaItem {
  coa_id: string;
  transaction_no: string | null;
  line_number: number | null;
  po_number: string | null;
  dock_intimation_id: number | null;
  qc_intimation_id: number | null;
  sku_id: number | null;
  sku_name: string | null;
  supplier_id: number | null;
  supplier_name: string | null;
  lot_number: string | null;
  vendor_coa_date: string | null;
  file_name: string | null;
  file_size_bytes: number | null;
  mime_type: string | null;
  scan_status: string;
  coa_status: string;
  uploaded_by_name: string | null;
  uploaded_at: string | null;
  download_url: string | null;
  // Detail-only fields (present when fetching CoaDetailResponse)
  parsed_params_json?: Record<string, unknown> | null;
  replaces_coa_id?: string | null;
  remarks?: string | null;
}

export interface CoaListResponse {
  total: number;
  page: number;
  page_size: number;
  items: CoaItem[];
}

export interface CoaUploadResponse {
  coa_id: string;
  s3_key: string;
  file_name: string;
  file_size_bytes: number;
  mime_type: string;
  scan_status: string;
  coa_status: string;
  uploaded_at: string;
}

export interface CoaReplaceResponse {
  old_coa_id: string;
  new_coa_id: string;
  replaced_at: string;
}

export interface RequestCoaFromVendorBody {
  qc_intimation_id: number;
  deadline_date?: string | null;
  custom_message?: string | null;
}

export interface RequestCoaFromVendorResponse {
  vendor_contact: { name: string } & Record<string, unknown>;
  notifications_dispatched: number;
}

// ── List query ─────────────────────────────────────────────────────────────

export interface InspectionListQuery {
  page?: number;
  page_size?: number;
  status?: string;
  transaction_no?: string;
  supplier_id?: string | number;
  sku_id?: string | number;
  verdict?: string;
  from_date?: string;
  to_date?: string;
}

function toQuery(q: InspectionListQuery): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === "" || v == null) continue;
    p.set(k, String(v));
  }
  return p.toString();
}

// ── Inspection endpoints ───────────────────────────────────────────────────

/** GET /api/v1/qc/inspection — paginated list of inspections. */
export async function listInspections(
  query: InspectionListQuery,
  signal?: AbortSignal,
): Promise<InspectionListResponse> {
  const qs = toQuery(query);
  const res = await apiFetch(`/api/v1/qc/inspection${qs ? `?${qs}` : ""}`, { signal });
  if (res.status === 404) throw new Error("QC backend not available on this server yet.");
  if (!res.ok) throw new Error(await readError(res, "Failed to load inspections"));
  return res.json() as Promise<InspectionListResponse>;
}

/** GET /api/v1/qc/inspection/{id} — full inspection detail with readings. */
export async function getInspection(id: number): Promise<InspectionDetail> {
  const res = await apiFetch(`/api/v1/qc/inspection/${encodeURIComponent(id)}`);
  if (res.status === 404) throw new Error("QC backend not available on this server yet.");
  if (!res.ok) throw new Error(await readError(res, "Failed to load inspection"));
  return res.json() as Promise<InspectionDetail>;
}

/** GET /api/v1/qc/inspection/{id}/audit — audit timeline for an inspection. */
export async function getInspectionAudit(id: number): Promise<AuditEvent[]> {
  const res = await apiFetch(`/api/v1/qc/inspection/${encodeURIComponent(id)}/audit`);
  if (res.status === 404) throw new Error("QC backend not available on this server yet.");
  if (!res.ok) throw new Error(await readError(res, "Failed to load audit log"));
  return res.json() as Promise<AuditEvent[]>;
}

/** POST /api/v1/qc/inspection/start — create a new inspection from an intimation. */
export async function startInspection(body: StartInspectionBody): Promise<StartInspectionResponse> {
  const res = await apiFetch("/api/v1/qc/inspection/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 404) throw new Error("QC backend not available on this server yet.");
  if (!res.ok) throw new Error(await readError(res, "Failed to start inspection"));
  return res.json() as Promise<StartInspectionResponse>;
}

/** GET /api/v1/qc/intimations — list pending intimations available to inspect. */
export async function listIntimations(
  q?: string,
  limit?: number,
  signal?: AbortSignal,
): Promise<{ items: IntimationItem[] }> {
  const p = new URLSearchParams({ status: "pending" });
  if (q) p.set("q", q);
  if (limit != null) p.set("limit", String(limit));
  const res = await apiFetch(`/api/v1/qc/intimations?${p.toString()}`, { signal });
  if (res.status === 404) throw new Error("QC backend not available on this server yet.");
  if (!res.ok) throw new Error(await readError(res, "Failed to load intimations"));
  return res.json() as Promise<{ items: IntimationItem[] }>;
}

/** POST /api/v1/qc/inspection/{id}/readings — submit a batch of readings. */
export async function addReadings(
  id: number,
  readings: ReadingInput[],
): Promise<ReadingsBatchResponse> {
  const res = await apiFetch(`/api/v1/qc/inspection/${encodeURIComponent(id)}/readings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ readings }),
  });
  if (res.status === 404) throw new Error("QC backend not available on this server yet.");
  if (!res.ok) throw new Error(await readError(res, "Failed to add readings"));
  return res.json() as Promise<ReadingsBatchResponse>;
}

/** PUT /api/v1/qc/inspection/{id}/readings/{rid} — edit a single reading. */
export async function updateReading(
  id: number,
  rid: number,
  body: ReadingUpdateBody,
): Promise<Reading> {
  const res = await apiFetch(
    `/api/v1/qc/inspection/${encodeURIComponent(id)}/readings/${encodeURIComponent(rid)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (res.status === 404) throw new Error("QC backend not available on this server yet.");
  if (!res.ok) throw new Error(await readError(res, "Failed to update reading"));
  return res.json() as Promise<Reading>;
}

/** DELETE /api/v1/qc/inspection/{id}/readings/{rid} — soft-delete a reading. */
export async function deleteReading(
  id: number,
  rid: number,
  reason?: string,
): Promise<{ ok: boolean }> {
  const res = await apiFetch(
    `/api/v1/qc/inspection/${encodeURIComponent(id)}/readings/${encodeURIComponent(rid)}`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: reason ?? null }),
    },
  );
  if (res.status === 404) throw new Error("QC backend not available on this server yet.");
  if (!res.ok) throw new Error(await readError(res, "Failed to delete reading"));
  return res.json() as Promise<{ ok: boolean }>;
}

/** POST /api/v1/qc/inspection/{id}/verdict — record pass/fail verdict. */
export async function setVerdict(id: number, body: VerdictBody): Promise<VerdictResponse> {
  const res = await apiFetch(`/api/v1/qc/inspection/${encodeURIComponent(id)}/verdict`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 404) throw new Error("QC backend not available on this server yet.");
  if (!res.ok) throw new Error(await readError(res, "Failed to set verdict"));
  return res.json() as Promise<VerdictResponse>;
}

/** POST /api/v1/qc/inspection/{id}/verdict/override — manager/admin override. */
export async function overrideVerdict(
  id: number,
  body: OverrideVerdictBody,
): Promise<OverrideVerdictResponse> {
  const res = await apiFetch(
    `/api/v1/qc/inspection/${encodeURIComponent(id)}/verdict/override`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (res.status === 404) throw new Error("QC backend not available on this server yet.");
  if (!res.ok) throw new Error(await readError(res, "Failed to override verdict"));
  return res.json() as Promise<OverrideVerdictResponse>;
}

/** POST /api/v1/qc/inspection/{id}/cancel — cancel an in-progress inspection. */
export async function cancelInspection(id: number, reason: string): Promise<{ ok: boolean }> {
  const res = await apiFetch(`/api/v1/qc/inspection/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  });
  if (res.status === 404) throw new Error("QC backend not available on this server yet.");
  if (!res.ok) throw new Error(await readError(res, "Failed to cancel inspection"));
  return res.json() as Promise<{ ok: boolean }>;
}

/** POST /api/v1/qc/inspection/{id}/reopen — reopen a cancelled inspection. */
export async function reopenInspection(id: number, reason: string): Promise<{ ok: boolean }> {
  const res = await apiFetch(`/api/v1/qc/inspection/${encodeURIComponent(id)}/reopen`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  });
  if (res.status === 404) throw new Error("QC backend not available on this server yet.");
  if (!res.ok) throw new Error(await readError(res, "Failed to reopen inspection"));
  return res.json() as Promise<{ ok: boolean }>;
}

/** PUT /api/v1/qc/inspection/{id} — partial header update. */
export async function updateInspectionHeader(
  id: number,
  body: HeaderUpdateBody,
): Promise<{ ok: boolean }> {
  const res = await apiFetch(`/api/v1/qc/inspection/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 404) throw new Error("QC backend not available on this server yet.");
  if (!res.ok) throw new Error(await readError(res, "Failed to update inspection"));
  return res.json() as Promise<{ ok: boolean }>;
}

/** POST /api/v1/qc/inspection/{id}/rm-report — generate RM quality report. */
export async function generateRmReport(id: number): Promise<ReportResponse> {
  const res = await apiFetch(`/api/v1/qc/inspection/${encodeURIComponent(id)}/rm-report`, {
    method: "POST",
  });
  if (res.status === 404) throw new Error("QC backend not available on this server yet.");
  if (!res.ok) throw new Error(await readError(res, "Failed to generate RM report"));
  return res.json() as Promise<ReportResponse>;
}

/** POST /api/v1/qc/inspection/{id}/ncr-report — generate NCR report. */
export async function generateNcrReport(id: number): Promise<ReportResponse> {
  const res = await apiFetch(`/api/v1/qc/inspection/${encodeURIComponent(id)}/ncr-report`, {
    method: "POST",
  });
  if (res.status === 404) throw new Error("QC backend not available on this server yet.");
  if (!res.ok) throw new Error(await readError(res, "Failed to generate NCR report"));
  return res.json() as Promise<ReportResponse>;
}

// ── Parameter catalog (qc/ncr_schemas.py: ParameterItem) ───────────────────

export interface ParameterItem {
  parameter_id: number;
  code: string;
  name: string;
  unit: string | null;
  param_group: string | null;
  data_type: string | null;
  value_kind: string | null;   // 'num' | 'text'
  spec_note: string | null;
  sort_order: number | null;
  is_active: boolean;
}

/** GET /api/v1/qc/parameters — RM-check parameter catalog (grouped/ordered). */
export async function listParameters(
  activeOnly = true,
  signal?: AbortSignal,
): Promise<ParameterItem[]> {
  const p = new URLSearchParams({ active: String(activeOnly) });
  const res = await apiFetch(`/api/v1/qc/parameters?${p.toString()}`, { signal });
  if (res.status === 404) throw new Error("QC backend not available on this server yet.");
  if (!res.ok) throw new Error(await readError(res, "Failed to load parameters"));
  const body = (await res.json()) as { items: ParameterItem[] };
  return body.items;
}

// ── Material arrivals (qc/schemas.py: ArrivalItem, ArrivalSummaryItem) ──────

export type QcArrivalState = "arrived" | "in_qc" | "accepted" | "rejected";
export type QcTxnStatus = "pending_arrival" | "arrived" | "completed";

export interface ArrivalItem {
  qc_intimation_id: number;
  transaction_no: string | null;
  po_number: string | null;
  sku_id: number | null;
  sku_name: string | null;
  sku_name_raw: string | null;
  lot_number: string | null;
  invoice_no: string | null;
  vehicle_no: string | null;
  created_at: string | null;
  inspection_id: number | null;
  inspection_status: string | null;
  verdict: string | null;
  approved_at: string | null;
  qc_state: QcArrivalState;
}

export interface ArrivalSummaryItem {
  transaction_no: string;
  status: "arrived" | "completed"; // pending_arrival inferred client-side (absent)
  total: number;
  awaiting: number;
  in_qc: number;
  accepted: number;
  rejected: number;
}

/** GET /api/v1/qc/arrivals?transaction_no=X — arrivals + QC state for one txn. */
export async function listArrivals(
  transactionNo: string,
  signal?: AbortSignal,
): Promise<ArrivalItem[]> {
  const p = new URLSearchParams({ transaction_no: transactionNo });
  const res = await apiFetch(`/api/v1/qc/arrivals?${p.toString()}`, { signal });
  if (res.status === 404) throw new Error("QC backend not available on this server yet.");
  if (!res.ok) throw new Error(await readError(res, "Failed to load arrivals"));
  const body = (await res.json()) as { items: ArrivalItem[] };
  return body.items;
}

/** GET /api/v1/qc/arrivals/summary — per-transaction QC rollup for a batch of txns. */
export async function arrivalsSummary(
  transactionNos: string[],
  signal?: AbortSignal,
): Promise<ArrivalSummaryItem[]> {
  if (transactionNos.length === 0) return [];
  const p = new URLSearchParams();
  for (const t of transactionNos) p.append("transaction_no", t);
  const res = await apiFetch(`/api/v1/qc/arrivals/summary?${p.toString()}`, { signal });
  if (res.status === 404) throw new Error("QC backend not available on this server yet.");
  if (!res.ok) throw new Error(await readError(res, "Failed to load QC status"));
  const body = (await res.json()) as { items: ArrivalSummaryItem[] };
  return body.items;
}

// ── NCR types (qc/ncr_schemas.py) ──────────────────────────────────────────

export type NcrDeviationType = "above_max" | "below_min" | "presence" | "absence";
export type NcrSeverity = "critical" | "major" | "minor";
export type NcrDisposition = "rejected" | "returned" | "accepted_dispensation";
export type NcrFinancialAction = "correction" | "credit" | "debit";
export type NcrSupplierActionType = "info_only" | "investigation_required";
export type NcrStatus = "open" | "in_supplier_action" | "closed";
export type NcrCapaActionType = "root_cause" | "correction" | "preventive";

export interface FailedParameter {
  param_code?: string | null;
  reading_id?: number | null;
  spec_value?: number | null;
  actual_value?: number | null;
  deviation_type?: NcrDeviationType | null;
  severity?: NcrSeverity | null;
  quantity_impacted_kg?: number | null;
  disposition?: string | null;
}

export interface SupplierAction {
  action_type?: NcrCapaActionType | null;
  description?: string | null;
  responsible_party?: string | null;
  target_date?: string | null;
  actual_closure_date?: string | null;
  evidence_file_url?: string | null;
  verified_by?: number | null;
  verification_date?: string | null;
  is_effective?: boolean | null;
}

export interface NcrListItem {
  ncr_id: number;
  ncr_no: string | null;
  supplier_id: number | null;
  supplier_name: string | null;
  transaction_no: string | null;
  product_description: string | null;
  status: string | null;
  severity_rollup: string | null;
  disposition: string | null;
  food_safety_flag: boolean;
  documented_date: string | null;
  created_at: string | null;
  param_count: number;
}

export interface NcrListResponse {
  items: NcrListItem[];
  total: number;
  total_pages: number;
  page: number;
  page_size: number;
}

export interface NcrDetail {
  ncr_id: number;
  ncr_no: string | null;
  supplier_id: number | null;
  supplier_name: string | null;
  other_party: string | null;
  detected_by: number | null;
  invoice_challan_ref: string | null;
  batch_no: string | null;
  transaction_no: string | null;
  line_number: number | null;
  product_description: string | null;
  rc_no: string | null;
  quantity: number | null;
  reason_nonconformity: string | null;
  food_safety_flag: boolean;
  documented_by: number | null;
  documented_date: string | null;
  disposition: string | null;
  financial_action: string | null;
  supplier_action_type: string | null;
  target_completion_date: string | null;
  authorized_person: number | null;
  authorized_date: string | null;
  received_by: number | null;
  received_date: string | null;
  created_by: number | null;
  approved_by: number | null;
  ncr_category: string | null;
  severity_rollup: string | null;
  financial_impact_inr: number | null;
  closure_tat_days: number | null;
  status: string | null;
  failed_parameters: FailedParameter[];
  supplier_actions: SupplierAction[];
  created_at: string | null;
}

export interface NcrCreateBody {
  from_inspection_id?: number | null;
  ncr_no?: string | null;
  supplier_id?: number | null;
  supplier_name?: string | null;
  other_party?: string | null;
  detected_by?: number | null;
  invoice_challan_ref?: string | null;
  batch_no?: string | null;
  transaction_no?: string | null;
  line_number?: number | null;
  product_description?: string | null;
  rc_no?: string | null;
  quantity?: number | null;
  reason_nonconformity?: string | null;
  food_safety_flag?: boolean | null;
  documented_date?: string | null;
  disposition?: NcrDisposition | null;
  financial_action?: NcrFinancialAction | null;
  supplier_action_type?: NcrSupplierActionType | null;
  target_completion_date?: string | null;
  failed_parameters?: FailedParameter[] | null;
  supplier_actions?: SupplierAction[] | null;
}

// PATCH body — every field optional; omitted fields are left untouched.
export type NcrUpdateBody = Partial<
  Omit<NcrCreateBody, "from_inspection_id"> & {
    documented_by: number | null;
    authorized_person: number | null;
    authorized_date: string | null;
    received_by: number | null;
    received_date: string | null;
    approved_by: number | null;
    ncr_category: string | null;
    financial_impact_inr: number | null;
    status: NcrStatus;
  }
>;

export interface NcrCreateResponse {
  ncr_id: number;
  ncr_no: string | null;
}

export interface NcrListQuery {
  page?: number;
  page_size?: number;
  status?: string;
  supplier_id?: string | number;
  transaction_no?: string;
  q?: string;
}

// ── NCR endpoints ──────────────────────────────────────────────────────────

/** GET /api/v1/qc/ncr — paginated NCR list. */
export async function listNcrs(
  query: NcrListQuery,
  signal?: AbortSignal,
): Promise<NcrListResponse> {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === "" || v == null) continue;
    p.set(k, String(v));
  }
  const qs = p.toString();
  const res = await apiFetch(`/api/v1/qc/ncr${qs ? `?${qs}` : ""}`, { signal });
  if (res.status === 404) throw new Error("QC backend not available on this server yet.");
  if (!res.ok) throw new Error(await readError(res, "Failed to load NCRs"));
  return res.json() as Promise<NcrListResponse>;
}

/** GET /api/v1/qc/ncr/{id} — full NCR detail. */
export async function getNcr(id: number, signal?: AbortSignal): Promise<NcrDetail> {
  const res = await apiFetch(`/api/v1/qc/ncr/${encodeURIComponent(id)}`, { signal });
  if (res.status === 404) throw new Error("NCR not found.");
  if (!res.ok) throw new Error(await readError(res, "Failed to load NCR"));
  return res.json() as Promise<NcrDetail>;
}

/** POST /api/v1/qc/ncr — create (optionally prefilled from a failed inspection). */
export async function createNcr(body: NcrCreateBody): Promise<NcrCreateResponse> {
  const res = await apiFetch("/api/v1/qc/ncr", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 404) throw new Error("QC backend not available on this server yet.");
  if (!res.ok) throw new Error(await readError(res, "Failed to create NCR"));
  return res.json() as Promise<NcrCreateResponse>;
}

/** PATCH /api/v1/qc/ncr/{id} — partial update (header / disposition / CAPA / status). */
export async function updateNcr(id: number, body: NcrUpdateBody): Promise<NcrDetail> {
  const res = await apiFetch(`/api/v1/qc/ncr/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 404) throw new Error("NCR not found.");
  if (!res.ok) throw new Error(await readError(res, "Failed to update NCR"));
  return res.json() as Promise<NcrDetail>;
}

/** DELETE /api/v1/qc/ncr/{id} — delete an NCR. */
export async function deleteNcr(id: number): Promise<{ ok: boolean }> {
  const res = await apiFetch(`/api/v1/qc/ncr/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (res.status === 404) throw new Error("NCR not found.");
  if (!res.ok) throw new Error(await readError(res, "Failed to delete NCR"));
  return res.json() as Promise<{ ok: boolean }>;
}

// ── COA endpoints (receipt module, reused by QC) ───────────────────────────

/**
 * GET /api/v1/receipt/coa?qc_intimation_id=…&coa_status=active&page_size=100
 * Fetch COA documents linked to a QC intimation.
 */
export async function listCoa(
  qcIntimationId: number,
  signal?: AbortSignal,
): Promise<CoaListResponse> {
  const p = new URLSearchParams({
    qc_intimation_id: String(qcIntimationId),
    coa_status: "active",
    page_size: "100",
  });
  const res = await apiFetch(`/api/v1/receipt/coa?${p.toString()}`, { signal });
  if (!res.ok) throw new Error(await readError(res, "Failed to load COA documents"));
  return res.json() as Promise<CoaListResponse>;
}

/**
 * POST /api/v1/receipt/coa-upload — multipart upload of a new COA document.
 * Pass a pre-built FormData; do NOT set Content-Type (browser sets multipart boundary).
 */
export async function uploadCoa(formData: FormData): Promise<CoaUploadResponse> {
  const res = await apiFetch("/api/v1/receipt/coa-upload", {
    method: "POST",
    body: formData,
  });
  if (!res.ok) throw new Error(await readError(res, "COA upload failed"));
  return res.json() as Promise<CoaUploadResponse>;
}

/**
 * PUT /api/v1/receipt/coa/{coa_id} — replace an existing COA document.
 * Pass a pre-built FormData; do NOT set Content-Type.
 */
export async function replaceCoa(
  coaId: string,
  formData: FormData,
): Promise<CoaReplaceResponse> {
  const res = await apiFetch(`/api/v1/receipt/coa/${encodeURIComponent(coaId)}`, {
    method: "PUT",
    body: formData,
  });
  if (!res.ok) throw new Error(await readError(res, "COA replace failed"));
  return res.json() as Promise<CoaReplaceResponse>;
}

/**
 * DELETE /api/v1/receipt/coa/{coa_id}?reason=… — soft-delete a COA document.
 * Returns 204 No Content on success.
 */
export async function deleteCoa(coaId: string, reason: string): Promise<void> {
  const res = await apiFetch(
    `/api/v1/receipt/coa/${encodeURIComponent(coaId)}?reason=${encodeURIComponent(reason)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error(await readError(res, "COA delete failed"));
}

/**
 * POST /api/v1/receipt/coa-vendor-request — request COA from vendor via notification.
 * NOTE: Backend endpoint not yet implemented; throws a descriptive error if 404.
 */
export async function requestCoaFromVendor(
  body: RequestCoaFromVendorBody,
): Promise<RequestCoaFromVendorResponse> {
  const res = await apiFetch("/api/v1/receipt/coa-vendor-request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 404) throw new Error("Vendor COA request isn't available on this backend yet.");
  if (!res.ok) throw new Error(await readError(res, "Failed to request COA from vendor"));
  return res.json() as Promise<RequestCoaFromVendorResponse>;
}
