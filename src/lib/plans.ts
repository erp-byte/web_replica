// Plan v2 API surface. Mirrors the endpoint set used by
// frontend_replica/src/modules/production/plan-list/plan-list.js. Server
// routes live in server_replica/app/modules/production/router.py:4261+.
//
// The list response shape is { results: PlanRow[], pagination: { page,
// page_size, total, total_pages } } — drop-in compatible with v1.

import { apiFetch, readApiErrorMessage } from "./auth";

// ── Row shape ────────────────────────────────────────────────────────────

// Per-line summary returned by the v2 list endpoint so the list page
// can show articles + qty inline without a per-plan detail fetch.
// Server caps at 20 entries per plan; bigger plans surface the truncation
// in the UI ("+N more").
export interface PlanRowLineSummary {
  plan_line_id?: number | null;
  bom_id?: number | null;
  fg_sku_name?: string | null;
  customer_name?: string | null;
  planned_qty_kg?: number | string | null;
  planned_qty_units?: number | string | null;
  area?: string | null;
  job_card_count?: number | null;   // >0 ⇒ article already carded (Edit, not Create)
}

export interface PlanRow {
  plan_id: number;
  plan_name?: string | null;
  entity?: string | null;
  warehouse?: string | null;
  plan_type?: "daily" | "weekly" | string | null;
  status?: "draft" | "approved" | "executed" | "cancelled" | string | null;
  plan_date?: string | null;            // YYYY-MM-DD
  date_from?: string | null;
  date_to?: string | null;
  total_planned_kg?: number | string | null;
  total_planned_units?: number | string | null;
  line_count?: number | null;
  revision_number?: number | null;
  created_at?: string | null;
  created_by?: string | null;
  approved_at?: string | null;
  approved_by?: string | null;
  lines_summary?: PlanRowLineSummary[] | null;
  [k: string]: unknown;
}

export interface PlanPagination {
  page?: number;
  page_size?: number;
  total?: number;
  total_pages?: number;
}

export interface PlanListResponse {
  results?: PlanRow[];
  pagination?: PlanPagination;
}

// ── Listing query ───────────────────────────────────────────────────────
//
// Server param names: entity, warehouse, plan_type, status, date_from,
// date_to, page, page_size. Comma-separated multi-values are supported by
// server-side list_plans for `status` and `plan_type`.
//
// NOTE: frontend_replica sends `type` as the param name for plan_type,
// which the server silently ignores (it treats it as an unknown query).
// We send the correct `plan_type` so the filter actually applies.

export interface PlanListQuery {
  entity?: string;
  warehouse?: string;
  plan_type?: string[];        // joined comma-separated on the wire
  status?: string[];           // joined comma-separated on the wire
  date_from?: string;          // YYYY-MM-DD
  date_to?: string;
  search?: string;
  page?: number;
  page_size?: number;
}

function buildListParams(q: PlanListQuery): URLSearchParams {
  const p = new URLSearchParams();
  if (q.entity) p.set("entity", q.entity);
  if (q.warehouse) p.set("warehouse", q.warehouse);
  if (q.plan_type && q.plan_type.length) p.set("plan_type", q.plan_type.join(","));
  if (q.status && q.status.length) p.set("status", q.status.join(","));
  if (q.date_from) p.set("date_from", q.date_from);
  if (q.date_to) p.set("date_to", q.date_to);
  if (q.search) p.set("search", q.search);
  if (q.page != null) p.set("page", String(q.page));
  if (q.page_size != null) p.set("page_size", String(q.page_size));
  return p;
}

// ── Calls ────────────────────────────────────────────────────────────────

export async function listPlans(
  q: PlanListQuery,
  signal?: AbortSignal,
): Promise<PlanListResponse> {
  const res = await apiFetch(`/api/v1/production/plans-v2?${buildListParams(q)}`, { signal });
  if (!res.ok) {
    // Surface the server's actual message ({message,error,detail}
    // envelope) so the UI shows "column p.plan_name does not exist"
    // instead of a generic "Plans HTTP 500". readApiErrorMessage handles
    // non-JSON bodies and the fallback in one place.
    throw new Error(await readApiErrorMessage(res, `Plans HTTP ${res.status}`));
  }
  return (await res.json()) as PlanListResponse;
}

// ── Plan detail (GET /plans-v2/{plan_id}) ────────────────────────────────
//
// Server returns the plan header flattened at top level plus a `lines`
// array where each line has its own ordered `steps` array. Matches the
// shape produced by services/plan_v2.py:get_plan().

export interface PlanStepRow {
  step_id?: number;
  plan_line_id?: number;
  step_order?: number;
  process_name?: string | null;
  stage?: string | null;
  floor?: string | null;
  std_time_min?: number | string | null;
  loss_pct?: number | string | null;
  notes?: string | null;
  [k: string]: unknown;
}

export interface PlanLineRow {
  plan_line_id?: number;
  plan_id?: number;
  fg_sku_name?: string | null;
  customer_name?: string | null;
  planned_qty_kg?: number | string | null;
  planned_qty_units?: number | string | null;
  area?: string | null;
  deadline_date?: string | null;
  linked_so_fulfillment_ids?: number[] | null;
  steps?: PlanStepRow[];
  [k: string]: unknown;
}

// PlanDetail extends PlanRow because the server flattens the header fields
// at the top level and adds `lines[]`. Use intersection so callers can
// reach line-level data without losing access to header fields.
export type PlanDetail = PlanRow & {
  lines?: PlanLineRow[];
};

export async function getPlan(
  planId: number,
  signal?: AbortSignal,
): Promise<PlanDetail> {
  const res = await apiFetch(`/api/v1/production/plans-v2/${planId}`, { signal });
  if (res.status === 404) throw new Error("Plan not found.");
  if (!res.ok) {
    throw new Error(await readApiErrorMessage(res, `Plan HTTP ${res.status}`));
  }
  return (await res.json()) as PlanDetail;
}

// ── BOM summary (for the Create-Job-Card wizard's per-step RM/PM view) ──────
// Backed by GET /plans-v2/bom/{bom_id}. Pass full=true to get EVERY line —
// the endpoint otherwise caps at 30 for the Plan-Detail hover-card.
export interface PlanBomLine {
  bom_line_id?: number | null;
  line_number?: number | null;
  material_sku_name?: string | null;
  item_type?: string | null;        // 'rm' | 'pm' | 'sfg' | 'fg'
  quantity_per_unit?: number | null;
  uom?: string | null;
  loss_pct?: number | null;
  godown?: string | null;           // 'RM Store' | 'PM Store' | ...
}

export interface PlanBomSummary {
  header?: Record<string, unknown> | null;
  counts?: { rm_count?: number; pm_count?: number; total_count?: number } | null;
  lines: PlanBomLine[];
  steps?: Array<Record<string, unknown>> | null;
}

export async function fetchPlanBom(
  bomId: number,
  opts?: { full?: boolean; signal?: AbortSignal },
): Promise<PlanBomSummary> {
  const qs = opts?.full ? "?full=true" : "";
  const res = await apiFetch(`/api/v1/production/plans-v2/bom/${bomId}${qs}`, { signal: opts?.signal });
  if (res.status === 404) throw new Error("BOM not found.");
  if (!res.ok) {
    throw new Error(await readApiErrorMessage(res, `BOM HTTP ${res.status}`));
  }
  return (await res.json()) as PlanBomSummary;
}

// ── Create Job Card (per-article wizard) ───────────────────────────────────
// One chained job card per WIP process → a terminating Packaging card, each
// dispatched to its floor. Backed by POST /plans-v2/lines/{id}/job-cards.
export interface CreateJobCardStep {
  process: string;
  floor: string;
  sfg_output?: string | null;
}

export interface CreateJobCardBody {
  qty_kg: number;
  qty_units?: number | null;
  wip_steps: CreateJobCardStep[];
  pkg_floor: string;
}

export interface CreateJobCardResult {
  plan_id: number;
  plan_line_id: number;
  job_card_ids: number[];
  count: number;
}

export async function createLineJobCards(
  planLineId: number,
  body: CreateJobCardBody,
): Promise<CreateJobCardResult> {
  const res = await apiFetch(
    `/api/v1/production/plans-v2/lines/${planLineId}/job-cards`,
    { method: "POST", body: JSON.stringify(body) },
  );
  if (!res.ok) {
    throw new Error(await readApiErrorMessage(res, `Create job card HTTP ${res.status}`));
  }
  return (await res.json()) as CreateJobCardResult;
}

// Current job-card config for a line, shaped to prefill the Edit wizard.
// exists=false ⇒ no cards yet (Create); editable=false ⇒ a stage already
// started, so it can't be replaced.
export interface LineJobCardConfigStep {
  job_card_id?: number | null;
  process?: string | null;
  floor?: string | null;
  sfg_output?: string | null;
  status?: string | null;
  started?: boolean;
}

export interface LineJobCardConfig {
  exists: boolean;
  // Canonical SFG name for this line's FG (SFG canonicalization design §5.4);
  // null when the FG has no SFG (plain repack / hamper / RM) or isn't catalogued.
  canonical_sfg?: string | null;
  editable?: boolean;
  started?: boolean;
  qty_kg?: number | null;
  qty_units?: number | null;
  wip_steps?: LineJobCardConfigStep[];
  pkg_floor?: string | null;
  pkg_job_card_id?: number | null;
  pkg_status?: string | null;
  pkg_started?: boolean;
}

export async function fetchLineJobCardConfig(
  planLineId: number,
): Promise<LineJobCardConfig> {
  const res = await apiFetch(`/api/v1/production/plans-v2/lines/${planLineId}/job-cards`);
  if (!res.ok) {
    throw new Error(await readApiErrorMessage(res, `Load job card HTTP ${res.status}`));
  }
  return (await res.json()) as LineJobCardConfig;
}

// One canonical-SFG typeahead suggestion (SFG canonicalization design §5.4).
export interface CanonicalSfgSuggestion {
  sfg_name: string;
  fg_count: number;
  fg_salegroup?: string | null;
}

// Typeahead over the canonical SFG catalogue (sfg_canonical_map). Returns []
// on empty term or any error so the picker degrades to plain free text.
export async function searchCanonicalSfg(
  q: string,
  entity?: string | null,
  limit = 20,
  signal?: AbortSignal,
): Promise<CanonicalSfgSuggestion[]> {
  const term = q.trim();
  if (!term) return [];
  const p = new URLSearchParams({ q: term, limit: String(limit) });
  if (entity) p.set("entity", entity);
  try {
    const res = await apiFetch(`/api/v1/production/sfg-canonical/search?${p}`, { signal });
    if (!res.ok) return [];
    const data = (await res.json()) as { results?: CanonicalSfgSuggestion[] };
    return data.results ?? [];
  } catch {
    return [];
  }
}

// Edit = replace the line's job cards (delete + recreate). Refused server-side
// (409) once any stage has started.
export async function replaceLineJobCards(
  planLineId: number,
  body: CreateJobCardBody,
): Promise<CreateJobCardResult> {
  const res = await apiFetch(
    `/api/v1/production/plans-v2/lines/${planLineId}/job-cards`,
    { method: "PUT", body: JSON.stringify(body) },
  );
  if (!res.ok) {
    throw new Error(await readApiErrorMessage(res, `Edit job card HTTP ${res.status}`));
  }
  return (await res.json()) as CreateJobCardResult;
}

// ── Live edit (constrained, started-chain) ───────────────────────────────
//
// Unlike replaceLineJobCards (full delete+recreate, blocked once started),
// apply-edits works on a started chain: floor + qty change anytime, add a
// process in the un-started tail, and remove a process (force-records the JC's
// data then cancels it). Qty changes sync to the linked SO (ledger + so_line).
// Existing steps carry job_card_id; new ones omit it. Any existing WIP
// job_card_id absent from `steps` is treated as a removal.

export interface ApplyEditsStep {
  job_card_id?: number | null;
  process: string;
  floor: string;
  sfg_output?: string | null;
}

export interface ApplyEditsBody {
  qty_kg: number;
  qty_units?: number | null;
  steps: ApplyEditsStep[];
  pkg_floor: string;
  pkg_job_card_id?: number | null;
  remove_reasons?: Record<string, string>;
}

export interface ApplyEditsResult {
  plan_id: number;
  plan_line_id: number;
  job_card_ids: number[];
  removed: number;
  added: number;
  floors_changed: number;
  qty_changed: boolean;
  so_sync?: {
    synced: boolean;
    fulfillment_ids?: number[];
    so_line_ids?: number[];
    delta_kg?: number;
    delta_units?: number;
    so_lines?: { so_line_id: number; new_kg: number; new_pcs: number }[];
  };
}

export async function applyLiveJobCardEdits(
  planLineId: number,
  body: ApplyEditsBody,
): Promise<ApplyEditsResult> {
  const res = await apiFetch(
    `/api/v1/production/plans-v2/lines/${planLineId}/job-cards/apply-edits`,
    { method: "POST", body: JSON.stringify(body) },
  );
  if (!res.ok) {
    throw new Error(await readApiErrorMessage(res, `Apply job-card edits HTTP ${res.status}`));
  }
  return (await res.json()) as ApplyEditsResult;
}

// ── FG Dispatch (completed packaging stage → notify billing/ops/stores) ──────
//
// dispatch-info prefills the modal: the packaging (FG) job card + its batches
// (the batch selector, defaulting to the packaging stage — never another WIP
// process). dispatch sends the email (To billing/candor_operations/store_head,
// CC business_head/operations_head/inventory_manager/production_manager) and
// records it. num_boxes / customer_location / transport fields are operator-
// entered (no stored source).

export interface DispatchBatch {
  batch_id: number;
  batch_number: number;
  batch_date?: string | null;
  status?: string | null;
  qty_kg: number;
  qty_units: number;
}

export interface LineDispatchInfo {
  exists: boolean;
  message?: string;
  plan_id?: number;
  plan_line_id?: number;
  job_card_id?: number;
  job_card_number?: string;
  fg_sku_name?: string;
  customer_name?: string | null;
  warehouse?: string | null;
  floor?: string | null;
  uom?: string | null;
  packaging_status?: string;
  packaging_completed?: boolean;
  batches?: DispatchBatch[];
  to_roles?: string[];
  cc_roles?: string[];
}

export async function fetchLineDispatchInfo(planLineId: number): Promise<LineDispatchInfo> {
  const res = await apiFetch(`/api/v1/production/plans-v2/lines/${planLineId}/dispatch-info`);
  if (!res.ok) {
    throw new Error(await readApiErrorMessage(res, `Dispatch info HTTP ${res.status}`));
  }
  return (await res.json()) as LineDispatchInfo;
}

export interface DispatchBody {
  batch_id: number;
  num_boxes?: number | null;
  customer_location?: string | null;
  vehicle_number?: string | null;
  transporter?: string | null;
  transport_location?: string | null;
}

export interface DispatchResult {
  dispatched: boolean;
  dispatch_id: number;
  email_sent: boolean;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
}

export async function createLineDispatch(
  planLineId: number,
  body: DispatchBody,
): Promise<DispatchResult> {
  const res = await apiFetch(
    `/api/v1/production/plans-v2/lines/${planLineId}/dispatch`,
    { method: "POST", body: JSON.stringify(body) },
  );
  if (!res.ok) {
    throw new Error(await readApiErrorMessage(res, `Dispatch HTTP ${res.status}`));
  }
  return (await res.json()) as DispatchResult;
}

// ── Update (partial) ────────────────────────────────────────────────────
//
// Server route: PUT /plans-v2/{plan_id} (router.py:4347) — body is
// PlanV2Update, but the server filters None fields BEFORE applying:
//   fields = {k: v for k, v in body.model_dump().items() if v is not None}
// so any field we omit is left untouched on the server side. To support
// "only the changed values get sent", the caller passes a body containing
// just the fields they intend to change; everything else is undefined and
// therefore omitted from the JSON wire.
//
// Server-side allow-list (services/plan_v2.py:387): plan_date, date_from,
// date_to, plan_type. Status changes flow through approve/cancel.

export interface UpdatePlanBody {
  plan_date?: string;             // YYYY-MM-DD
  date_from?: string;
  date_to?: string;
  plan_type?: string;
}

export async function updatePlan(
  planId: number,
  body: UpdatePlanBody,
): Promise<unknown> {
  // Drop undefined keys so they aren't serialised as null — the server
  // treats null and missing identically, but cleaner wire is friendlier in
  // logs and request inspectors.
  const trimmed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (v !== undefined && v !== "") trimmed[k] = v;
  }
  if (Object.keys(trimmed).length === 0) {
    throw new Error("Nothing to update");
  }
  const res = await apiFetch(`/api/v1/production/plans-v2/${planId}`, {
    method: "PUT",
    body: JSON.stringify(trimmed),
  });
  if (!res.ok) {
    throw new Error(await readApiErrorMessage(res, `HTTP ${res.status}`));
  }
  return await res.json();
}

// ── Approved-plan field-change amendment (R8) ───────────────────────────
//
// When a plan is in status='approved', direct PUTs are no longer the
// right path — the operator-stated rule is "edits to an approved plan
// require admin approval". Per the R8 framework, the edit becomes a
// `plan_field_change` amendment request. Admin approval triggers the
// apply step (server-side `_apply_plan_field_change`), which:
//   • updates production_plan_v2 with the supplied plan_fields
//   • updates production_plan_line_v2 for each line_changes[].fields
//   • cascades qty + deadline to JCs in status locked / unlocked /
//     assigned; JCs past that point stay frozen (the response carries
//     `jcs_cascaded` + `jcs_skipped` for the operator's audit).
//
// Drafts continue to use the direct PUT helpers above — no maker-checker
// loop adds value before initial approval.

export interface PlanFieldChangePayload {
  plan_id: number;
  /** Plan-level fields. Allow-list mirrors UpdatePlanBody. */
  plan_fields?: Pick<UpdatePlanBody, "plan_date" | "date_from" | "date_to" | "plan_type">;
  /** Per-line patches. Allow-list mirrors UpdatePlanLineBody. */
  line_changes?: Array<{
    plan_line_id: number;
    fields: UpdatePlanLineBody;
  }>;
}

export async function submitPlanFieldChangeAmendment(
  payload: PlanFieldChangePayload,
  reason: string,
): Promise<unknown> {
  // Strip undefined / empty strings from the nested objects so the
  // server sees only fields the operator actually touched.
  const cleanFields = (obj: Record<string, unknown> | undefined) => {
    if (!obj) return undefined;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v !== undefined && v !== "") out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };
  const cleanedPlanFields = cleanFields(payload.plan_fields as Record<string, unknown> | undefined);
  const cleanedLineChanges = (payload.line_changes ?? [])
    .map((lc) => ({
      plan_line_id: lc.plan_line_id,
      fields: cleanFields(lc.fields as Record<string, unknown>),
    }))
    .filter((lc) => lc.fields !== undefined) as Array<{ plan_line_id: number; fields: Record<string, unknown> }>;

  if (!cleanedPlanFields && cleanedLineChanges.length === 0) {
    throw new Error("Nothing to change");
  }
  if (!reason || reason.trim().length < 20) {
    throw new Error("Reason must be at least 20 characters");
  }

  const res = await apiFetch(`/api/v1/production/amendments`, {
    method: "POST",
    body: JSON.stringify({
      request_type: "plan_field_change",
      payload: {
        plan_id: payload.plan_id,
        plan_fields:  cleanedPlanFields ?? {},
        line_changes: cleanedLineChanges,
      },
      reason: reason.trim(),
    }),
  });
  if (!res.ok) {
    throw new Error(await readApiErrorMessage(res, `HTTP ${res.status}`));
  }
  return await res.json();
}

// ── Per-line + per-step partial updates ─────────────────────────────────
//
// Mirror the planning page's editing model end-to-end. Server routes (all
// under /api/v1/production):
//   • PUT    /plans-v2/lines/{plan_line_id}                       — line patch
//   • PUT    /plans-v2/steps/{step_id}                            — step patch
//   • PUT    /plans-v2/lines/{plan_line_id}/steps/reorder         — reorder
//   • DELETE /plans-v2/steps/{step_id}                            — drop step
//
// All four flow through apiFetch so they pick up the silent-refresh path
// added earlier — no special handling needed for auth.

export interface UpdatePlanLineBody {
  planned_qty_kg?: number;
  planned_qty_units?: number;
  area?: string;
  deadline_date?: string;   // YYYY-MM-DD
}

export async function updatePlanLine(
  planLineId: number,
  body: UpdatePlanLineBody,
): Promise<unknown> {
  const trimmed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (v !== undefined && v !== "") trimmed[k] = v;
  }
  if (Object.keys(trimmed).length === 0) throw new Error("Nothing to update");
  const res = await apiFetch(`/api/v1/production/plans-v2/lines/${planLineId}`, {
    method: "PUT",
    body: JSON.stringify(trimmed),
  });
  if (!res.ok) {
    throw new Error(await readApiErrorMessage(res, `HTTP ${res.status}`));
  }
  return await res.json();
}

export interface UpdatePlanStepBody {
  process_name?: string;
  stage?: string;
  floor?: string | null;
  std_time_min?: number | null;
  loss_pct?: number | null;
  notes?: string;
}

export async function updatePlanStep(
  stepId: number,
  body: UpdatePlanStepBody,
): Promise<unknown> {
  // Allow explicit `null` for floor/std_time_min/loss_pct (lets the operator
  // clear a value). Only drop `undefined`s — those are "field not touched".
  const trimmed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (v !== undefined) trimmed[k] = v;
  }
  if (Object.keys(trimmed).length === 0) throw new Error("Nothing to update");
  const res = await apiFetch(`/api/v1/production/plans-v2/steps/${stepId}`, {
    method: "PUT",
    body: JSON.stringify(trimmed),
  });
  if (!res.ok) {
    throw new Error(await readApiErrorMessage(res, `HTTP ${res.status}`));
  }
  return await res.json();
}

// Append a step to a plan line. Returns the created row (server
// includes the assigned step_id so callers can patch / reorder it
// without a refetch). process_name is required by StepV2Add on the
// server — caller must supply a non-empty string.
export interface AddPlanStepBody {
  process_name: string;
  stage?: string | null;
  floor?: string | null;
  std_time_min?: number | null;
  loss_pct?: number | null;
  notes?: string | null;
}

export async function addPlanStep(
  planLineId: number,
  body: AddPlanStepBody,
): Promise<{ step_id?: number } & Record<string, unknown>> {
  // Drop undefined keys; preserve explicit null (matches updatePlanStep
  // semantics — null = "set this column to NULL", absent = "skip").
  const trimmed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (v !== undefined) trimmed[k] = v;
  }
  if (!trimmed.process_name) throw new Error("process_name is required");
  const res = await apiFetch(
    `/api/v1/production/plans-v2/lines/${planLineId}/steps`,
    {
      method: "POST",
      body: JSON.stringify(trimmed),
    },
  );
  if (!res.ok) {
    throw new Error(await readApiErrorMessage(res, `HTTP ${res.status}`));
  }
  return await res.json();
}

export async function reorderPlanSteps(
  planLineId: number,
  stepIds: number[],
): Promise<unknown> {
  const res = await apiFetch(
    `/api/v1/production/plans-v2/lines/${planLineId}/steps/reorder`,
    {
      method: "PUT",
      body: JSON.stringify({ step_ids: stepIds }),
    },
  );
  if (!res.ok) {
    throw new Error(await readApiErrorMessage(res, `HTTP ${res.status}`));
  }
  return await res.json();
}

export async function deletePlanStep(stepId: number): Promise<unknown> {
  const res = await apiFetch(`/api/v1/production/plans-v2/steps/${stepId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    throw new Error(await readApiErrorMessage(res, `HTTP ${res.status}`));
  }
  return await res.json();
}

// ── Delete (approved plans only) ────────────────────────────────────────
//
// Server route: POST /plans-v2/{plan_id}/delete (added in this iteration).
// Only valid when the plan is in `approved` status. The server-side handler
// fans out a notification email to every active admin user before
// confirming the delete, so the action always carries an audit trail.

export interface DeletePlanBody {
  reason: string;                 // required — surfaces in the admin email
  deleted_by?: string;            // operator identity (defaults to "" server-side)
}

export interface DeletePlanResponse {
  plan_id?: number;
  status?: string;
  admin_email_count?: number;     // how many admins were notified
  [k: string]: unknown;
}

export async function deletePlan(
  planId: number,
  body: DeletePlanBody,
): Promise<DeletePlanResponse> {
  const res = await apiFetch(`/api/v1/production/plans-v2/${planId}/delete`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await readApiErrorMessage(res, `HTTP ${res.status}`));
  }
  return (await res.json()) as DeletePlanResponse;
}

export interface ApprovePlanBody {
  approved_by: string;          // required by PlanV2Approve
}

export interface ApprovePlanResponse {
  plan_id?: number;
  status?: string;
  // The backend auto-generates per-floor job cards on approve. Shape varies;
  // the original frontend reads job_cards.lines[*].job_card_ids.
  job_cards?: {
    error?: string;
    count?: number;
    lines?: Array<{ job_card_ids?: number[] }>;
  };
  [k: string]: unknown;
}

export async function approvePlan(
  planId: number,
  body: ApprovePlanBody,
): Promise<ApprovePlanResponse> {
  const res = await apiFetch(`/api/v1/production/plans-v2/${planId}/approve`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await readApiErrorMessage(res, `HTTP ${res.status}`));
  }
  return (await res.json()) as ApprovePlanResponse;
}

export interface CancelPlanBody {
  reason?: string;              // defaults to "" server-side
}

export async function cancelPlan(planId: number, body: CancelPlanBody): Promise<unknown> {
  const res = await apiFetch(`/api/v1/production/plans-v2/${planId}/cancel`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await readApiErrorMessage(res, `HTTP ${res.status}`));
  }
  return await res.json();
}

// ── Formatters reused by the page ───────────────────────────────────────

export function fmtPlanKg(v: number | string | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = typeof v === "number" ? v : parseFloat(v);
  if (Number.isNaN(n)) return "—";
  return n.toLocaleString("en-IN", { maximumFractionDigits: 1 });
}

// Whole-piece (pcs) total — units are counts, so no decimals.
export function fmtPlanUnits(v: number | string | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = typeof v === "number" ? v : parseFloat(v);
  if (Number.isNaN(n)) return "—";
  return Math.round(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

export function fmtPlanDate(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  } catch {
    return iso;
  }
}

export function fmtDateRange(from?: string | null, to?: string | null): string {
  if (!from && !to) return "—";
  if (from && to && from === to) return fmtPlanDate(from);
  return `${fmtPlanDate(from)} → ${fmtPlanDate(to)}`;
}
