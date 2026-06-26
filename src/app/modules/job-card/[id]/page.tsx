"use client";

// Job card detail. Two fetches run in parallel: the full detail row from
// /job-cards-v2/{id} (rich sectioned payload — header + rm_indents + pm_indents
// + outputs + shift_log + sign_offs + bom_lines + consumption_lines + qc) and
// the stage chain from /job-cards-v2/{id}/chain.
//
// The Accounting + Quality forms below mirror the Android tabs:
//   OutputAccountingFragment → POST /outputs (single big body)
//   QualityFragment          → chained POSTs per check type
// Field set + categories + computed Process Loss % match the fragments line
// for line so the operator sees the same form on web as on mobile.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BrandMark } from "@/components/BrandMark";
import {
  consumptionStateFromDetail,
  balanceStateFromDetail,
  rejectionsFromDetail,
  controlSampleFromDetail,
  pmVarianceFromDetail,
  additivesFromDetail,
  type PmVarianceState,
  type RejectionRow,
} from "./outputAccounting";
import { useParams, useRouter } from "next/navigation";
import { apiFetch, readApiErrorMessage, userStore } from "@/lib/auth";
import { useIsAdmin, useMe, useRequireAuth, useUserInitial } from "@/lib/user";
import { BALANCE_TOLERANCE_KG, WEIGHT_SAMPLE_COUNT } from "@/lib/constants";
import { classifyProcess, classifySteps, STAGE_CREATE_WIP } from "@/lib/processCatalog";
import { friendlyApiError } from "@/lib/apiErrors";
import { BackLink } from "@/components/BackLink";
import { LockBanner } from "../_LockBanner";
import { lockBannerId, useLockState, userMayForceUnlock } from "../_useLockState";
// C10 / C11 (Wave 4) — canonical role-gated action button + amendments tab.
import { ActionButton, LockableButton } from "../_ActionButton";
import { AmendmentsTab } from "../_AmendmentsTab";
import { RawMaterialTab } from "./_RawMaterialTab";
import { OutputTab } from "./_OutputTab";
// W4-MED-3/M10 — single subscription via context (see _UserContext.tsx).
import { UserProvider } from "../_UserContext";

// ── Types ─────────────────────────────────────────────────────────────────

type ChainStep = {
  job_card_id: number;
  job_card_number: string | null;
  step_number: number;
  process_name: string | null;
  stage: string | null;
  factory: string | null;
  floor: string | null;
  status: string | null;
  input_kind: string | null;
  output_kind: string | null;
  input_code: string | null;   // SFG#### opened by this step (Slice 3 seam)
  output_code: string | null;  // SFG#### produced by this step (Slice 3 seam)
  planned_qty_kg: number | null;
  carried_qty_kg: number | null;
  dispatched_to_next_kg: number | null;
  prev_job_card_id: number | null;
  next_job_card_id: number | null;
  start_time: string | null;
  end_time: string | null;
  is_current: boolean;
};

// Field names match the actual /job-cards-v2/{id} response — see
// job_card_v2.get_job_card. The sectioned shape (section_1_product etc.) is
// the v1-compat mirror the Android detail screen reads from.
type BomLine = {
  bom_line_id: number | null;
  line_number?: number | null;
  material_sku_name: string;
  // Canonical set: 'RM' | 'PM' | 'SFG' | 'FG' (case-normalised to UPPERCASE in
  // the `articles` memo). SFG = a Semi-Finished/WIP intermediate carried between
  // stages (item_type='sfg' in all_sku, Slice 1). Treated on the canonical-input
  // (non-PM) side by the mass-balance predicates, same as RM.
  item_type: string | null;
  uom?: string | null;
  quantity_per_unit?: number | null;
  loss_pct?: number | null;
  godown?: string | null;
};

type IndentLine = {
  bom_line_id?: number | null;
  material_sku_name?: string | null;
  required_qty?: number | string | null;
  issued_qty?: number | string | null;
  consumed_qty?: number | string | null;
  uom?: string | null;
  status?: string | null;
  [k: string]: unknown;
};

type ConsumptionLine = {
  consumption_id?: number | null;
  bom_line_id?: number | null;
  material_sku_name?: string | null;
  input_kind?: string | null;
  uom?: string | null;
  issued_qty?: number | string | null;
  actual_consumed_qty?: number | string | null;
  return_qty?: number | string | null;
  variance?: number | string | null;
  remarks?: string | null;
};

type BalanceMaterialRow = {
  balance_id?: number | null;
  bom_line_id?: number | null;
  material_id?: number | null;
  material_name?: string | null;
  balance_type?: string | null;
  qty_kg?: number | string | null;
  remarks?: string | null;
};

type ByproductRow = {
  byproduct_id?: number | null;
  category?: string | null;
  qty_kg?: number | string | null;
  uom?: string | null;
  remarks?: string | null;
  // Migration 034 — article attribution. NULL for non-attributable
  // categories (control_sample, pm_*, dust, etc.).
  material_name?: string | null;
  bom_line_id?: number | null;
};

// Additive consumption row as returned by the server in detail.additives.
// Mirrors the row shape persisted to job_card_additive_consumption_v2.
type AdditiveServerRow = {
  additive_id?: number | null;
  /** all_sku.particulars when picked from the catalog dropdown. */
  sku_name?: string | null;
  /** Free-text name when sku_name is null ("Others" path). */
  material_name?: string | null;
  qty_kg?: number | string | null;
  remarks?: string | null;
};

type AnnexureRow = Record<string, unknown>;

type JobCardDetail = {
  job_card_id: number;
  job_card_number: string | null;
  status: string | null;
  fg_sku_name: string | null;
  customer_name: string | null;
  batch_number: string | null;
  planned_qty_kg: number | string | null;
  planned_qty_units: number | string | null;
  uom: string | null;
  factory: string | null;
  floor: string | null;
  entity: string | null;
  stage: string | null;
  process_name: string | null;
  step_number: number | null;
  plan_id: number | null;
  input_kind: string | null;
  output_kind: string | null;
  input_code: string | null;   // SFG#### this stage consumes (Slice 3 seam)
  output_code: string | null;  // SFG#### this stage produces (Slice 3 seam)
  start_time: string | null;
  end_time: string | null;
  total_time_min: number | string | null;
  assigned_to_team_leader: string | null;
  team_members: string[] | null;
  // Lock + chain navigation. Needed by ActionBar to decide whether to render
  // START vs DISPATCH-TO-NEXT vs CLOSE, mirroring JobCardDetailActivity.updateActionButton.
  // `locked_reason` powers the C3 LockBanner shown above every operational
  // form section (string returned by the server; null on legacy rows).
  is_locked?: boolean | null;
  locked_reason?: string | null;
  force_unlocked?: boolean | null;
  next_job_card_id?: number | null;
  prev_job_card_id?: number | null;
  dispatched_to_next_kg?: number | string | null;
  so_numbers?: string[] | null;
  primary_so_number?: string | null;

  section_1_product?: {
    so_numbers?: string[] | null;
    so_number?: string | null;
    so_date?: string | null;
    business_unit?: string | null;
    pack_size_kg?: number | null;
    bom_version?: number | null;
    net_wt_per_unit_kg?: number | null;
    expected_units?: number | null;
    batch_size_kg?: number | null;
    [k: string]: unknown;
  };
  section_5_output?: {
    fg_actual_kg?: number | string | null;
    fg_actual_units?: number | null;
    process_loss_kg?: number | string | null;
    rm_consumed_kg?: number | string | null;
    yield_pct?: number | string | null;
    created_at?: string | null;
  } | null;

  // C3-CRIT-2 + C3-H3 — the backend now surfaces the BOM-header's
  // allowed_balance_tolerance_pct on the JC detail payload (server default
  // 0.001 = 0.1 %, NOT the 0.5 % that the live-preview hardcoded before this
  // fix) along with the canonical R9 summary row written by
  // jc_accounting_v2.save_accounting. We re-fetch this block after a save
  // so the SummaryCard renders server-authoritative numbers; before the
  // first save, the live preview reproduces the server formulas locally.
  accounting?: {
    allowed_balance_tolerance_pct?: number | null;
    carried_in_kg?: number | string | null;
    // Authoritative R9 percentages written by the server. When present we
    // prefer these over the live-preview math.
    process_loss_pct?: number | string | null;
    invisible_loss_pct?: number | string | null;
    total_loss_pct?: number | string | null;
    other_loss_pct?: number | string | null;
    rejection_pct?: number | string | null;
    offgrade_pct?: number | string | null;
    ega_loss_pct?: number | string | null;
    balance_diff_kg?: number | string | null;
    balance_diff_pct?: number | string | null;
    is_balanced?: boolean | null;
    [k: string]: unknown;
  } | null;
  /** Migration 049: per-batch accounting rows. One entry per existing
   *  job_card_accounting_v2 row tagged with this JC. The SummaryCard's
   *  per-batch collapsibles read the matching row (by batch_id) so each
   *  batch's saved IS_BALANCED + percentages render directly without
   *  recomputing from the JC-level roll-up. NULL batch_id rows are
   *  pre-049 legacy rows kept under the COALESCE-0 sentinel. */
  accounting_per_batch?: Array<{
    batch_id?: number | null;
    is_balanced?: boolean | null;
    balance_difference_qty?: number | string | null;
    total_input_qty?: number | string | null;
    output_qty?: number | string | null;
    process_loss_qty?: number | string | null;
    wastage_qty?: number | string | null;
    extra_give_away_qty?: number | string | null;
    offgrade_total_qty?: number | string | null;
    control_sample_qty?: number | string | null;
    balance_material_qty?: number | string | null;
    process_loss_pct?: number | string | null;
    ega_loss_pct?: number | string | null;
    invisible_loss_pct?: number | string | null;
    total_loss_pct?: number | string | null;
    offgrade_pct?: number | string | null;
    rejection_pct?: number | string | null;
    allowed_balance_tolerance_pct?: number | null;
    [k: string]: unknown;
  }> | null;

  /** Qty carried in from the previous stage (only > 0 for stages 2+). Used
   *  by the server's loss formulas as part of `total_input = rm_issued +
   *  carried_in` — see jc_accounting_v2.save_accounting. */
  carried_qty_kg?: number | string | null;

  /** G4 — Bar-Line Process override. The backend surfaces these on the JC
   *  detail payload for bar-line VA products whose richer routing comes from
   *  the `Bar Line Process` string. `bar_line_process` is that full routing
   *  string; `bar_line_routed` flips TRUE once the G4 override actually rebuilt
   *  this FG's route from it. Both are ADDITIVE + OPTIONAL — they may be absent
   *  at runtime (built in a parallel backend slice), so every consumer must
   *  treat them defensively and render nothing when they're missing. */
  bar_line_process?: string | null;
  bar_line_routed?: boolean;

  rm_indents?: IndentLine[];
  pm_indents?: IndentLine[];
  outputs?: Array<Record<string, unknown>>;
  shift_log?: Array<Record<string, unknown>>;
  sign_offs?: Array<Record<string, unknown>>;
  bom_lines?: BomLine[];
  consumption_lines?: ConsumptionLine[];
  balance_materials?: BalanceMaterialRow[];
  byproducts?: ByproductRow[];
  /** Additive consumption rows — data-keeping only.  See
   *  job_card_additive_consumption_v2 + jc_additives_v2 service.  Not
   *  counted in the conservation identity. */
  additives?: AdditiveServerRow[];
  qc?: Record<string, unknown> | null;

  annexure_a_b_metal_detection?: AnnexureRow[];
  annexure_b_weight_checks?: AnnexureRow[];
  annexure_c_environment?: AnnexureRow[];
  annexure_d_loss_reconciliation?: AnnexureRow[];
  annexure_e_remarks?: AnnexureRow[];
};

// Tab order + labels mirror JobCardPagerAdapter.TAB_TITLES on Android:
//   Stage Chain · Overview · Output & Accounting · Quality · Sign-offs · Remarks
// Materials + Shifts (which existed on the web prototype) intentionally don't
// have Android counterparts; the equivalent info lives inside Accounting
// (BOM articles, consumption) and the toolbar/header time strip respectively.
type TabKey = "chain" | "rawmaterial" | "overview" | "accounting" | "output" | "quality" | "signoffs" | "remarks" | "sfgboxes" | "amendments";

const TABS: { key: TabKey; label: string }[] = [
  { key: "chain",      label: "Stage Chain" },
  { key: "rawmaterial", label: "Raw Material" },
  { key: "overview",   label: "Overview" },
  { key: "accounting", label: "Accounting" },
  { key: "output",     label: "Output" },
  { key: "quality",    label: "Quality" },
  { key: "signoffs",   label: "Sign-offs" },
  { key: "remarks",    label: "Remarks" },
  { key: "sfgboxes",   label: "SFG Boxes" },
  // Amendments tab hidden per operator request. The 'amendments' route
  // case is kept below so a stale ?tab=amendments URL doesn't 404, and
  // AmendmentsTab + the backend endpoints remain untouched — only the
  // tab strip entry is suppressed.
];

const STATUS_STYLES: Record<string, { bg: string; fg: string; ring: string }> = {
  locked:            { bg: "#fdf3f1", fg: "#b1361e", ring: "#f0c7be" },
  unlocked:          { bg: "#f4f4f4", fg: "#414d5c", ring: "#d5dbdb" },
  assigned:          { bg: "#fbeced", fg: "#9a393e", ring: "#e6bcbe" },
  material_received: { bg: "#eaf3ff", fg: "#9a393e", ring: "#bbd9f3" },
  in_progress:       { bg: "#eaf3ff", fg: "#9a393e", ring: "#bbd9f3" },
  completed:         { bg: "#eaf6ed", fg: "#1d8102", ring: "#b6dbb1" },
  closed:            { bg: "#f0eef8", fg: "#5752c4", ring: "#d2cef0" },
  cancelled:         { bg: "#f4f4f4", fg: "#687078", ring: "#d5dbdb" },
};

// Lifecycle lock — fields on Output & Accounting / Quality / Remarks are
// uneditable until the operator clicks START (status flips to in_progress).
// Returns true for the pre-start statuses, false for in_progress/completed/
// closed/cancelled. The "closed"/"cancelled" terminal states have their own
// lock semantics via lock.isLocked + admin override; this predicate is only
// concerned with the START gate.
function isLifecycleLocked(status: string | null | undefined): boolean {
  if (!status) return true;
  return status === "locked"
      || status === "unlocked"
      || status === "assigned"
      || status === "material_received";
}

// Factory for a blank off-grade row. Centralised so the default seed,
// the "+ Add another" handler, and any future reset code all start from
// the same shape (and adding a new field on RejectionRow updates one
// place instead of three).
function BLANK_REJECTION_ROW(): RejectionRow {
  return { category: "", bomLineId: null, materialName: "", qty: "", remarks: "" };
}

// ── Additives: data-keeping consumption for fully-consumed seasoning ──
//
// Operators record Salt / Sugar / Citric Acid / Oils / Cayenne Pepper /
// Gum Powder etc. that go INTO the batch but produce zero leftover. The
// rows are written to job_card_additive_consumption_v2 and surfaced in
// the Accounting Summary as a separate "Additives" total — they do NOT
// feed the conservation identity (would otherwise create false unbalance
// because there's no matching output column).
//
// A row uses either:
//   • sku_name   — picked from the additive dropdown (driven by all_sku
//                  particulars that match additive name patterns)
//   • custom_name — free-text when the operator selects "Others"
type AdditiveRow = {
  /** Selected from the dropdown.  "_other" is a sentinel meaning "use
   *  custom_name".  Empty string = nothing picked yet. */
  sku_name: string;
  /** Filled only when sku_name === "_other".  Surfaces in the saved
   *  row's material_name column. */
  custom_name: string;
  qty: string;
  remarks: string;
};

function BLANK_ADDITIVE_ROW(): AdditiveRow {
  return { sku_name: "", custom_name: "", qty: "", remarks: "" };
}

// Canonical additive category labels. Used both for the dropdown
// fallback (when no SKUs come back from /sku-lookup yet) and as the
// search seed when the page mounts.  The frontend issues one
// /sku-lookup search per category and unions the results into a
// deduped, sorted list of options.
const ADDITIVE_CATEGORIES = [
  "Salt",
  "Sugar",
  "Gum Powder",
  "Citric Acid",
  "Oil",
  "Cayenne Pepper",
  "Pepper",
] as const;

// ── R10 — per-batch summary computation ──────────────────────────────
// Module-scope helper used by AccountingSummaryCard's per-batch
// breakdown + the total roll-up. Mirrors the in-component `summary`
// useMemo but sources from the persisted detail arrays filtered by
// batch_id (instead of from live form state), so closed batches show
// snapshot-accurate values regardless of which batch is currently
// selected for editing. Also tolerant of nulls: a freshly-opened
// batch with no saved data returns zeros across the board.
type BatchSummaryArticle = {
  bom_line_id: number | null;
  material_sku_name: string;
  item_type: string;
  uom: string;
};
function _num(v: unknown): number {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}
function computeBatchSummary(
  batch: BatchRow,
  detail: JobCardDetail,
  articles: BatchSummaryArticle[],
): SummaryCardData {
  const batchId = batch.batch_id;
  // Migration 049 — every numeric field shown in the per-batch summary
  // (kg + percentages + IS_BALANCED) is derived from local state inside
  // this function: BatchRow snapshot (kg buckets) + detail rows filtered
  // by batch_id (consumption / byproducts / balance). NEVER mix in
  // server-stored percentages from accounting_per_batch — pre-049 the
  // server row was JC-level, so any per-batch percentages it carries
  // are leaked from whichever batch saved last. The screenshot symptom
  // was "Process Loss 0.00 kg | 6.00%" caused by exactly that mismatch.
  //
  // For batches saved AFTER migration 049 the saved percentages would
  // agree with the local recompute anyway (kg and pct were written from
  // the same form state in the same save). Trusting the local recompute
  // is then equivalent — but guarantees self-consistency on legacy data
  // too, where the saved pct may belong to a different batch.
  //
  // accounting_per_batch is still surfaced on the JobCardDetail type so
  // callers that want the raw server snapshot (e.g. debugging tools)
  // can read it; computeBatchSummary just doesn't use it.
  // Consumption rows (PM excluded — they don't convert into FG mass).
  const consumption = consumptionStateFromDetail(detail.consumption_lines, batchId);
  const articleByKey = new Map<string, BatchSummaryArticle>();
  for (const a of articles) {
    const key = a.bom_line_id != null ? `b${a.bom_line_id}` : `n${a.material_sku_name}`;
    articleByKey.set(key, a);
  }
  const isRmKey = (k: string) => {
    const a = articleByKey.get(k);
    return a ? (a.item_type || "").toUpperCase() !== "PM" : true;
  };
  const rmConsumedKg = Object.entries(consumption).reduce(
    (s, [k, v]) => s + (isRmKey(k) ? _num(v) : 0),
    0,
  );
  // Balance materials
  const balance = balanceStateFromDetail(detail.balance_materials, batchId);
  const balTotal = Object.values(balance).reduce((s, v) => s + _num(v), 0);
  // Off-grade (excluding wastage and control_sample) + wastage
  const rejections = rejectionsFromDetail(detail.byproducts, detail.balance_materials, batchId);
  const offgradeTotal = rejections.reduce(
    (s, r) => s + (r.category !== "wastage" ? _num(r.qty) : 0),
    0,
  );
  const wastageTotal = rejections.reduce(
    (s, r) => s + (r.category === "wastage" ? _num(r.qty) : 0),
    0,
  );
  // Additives — data-keeping; do NOT participate in the conservation
  // identity (no matching output column).
  const addRows = additivesFromDetail(detail.additives, batchId);
  const additivesKg = addRows.reduce((s, a) => s + _num(a.qty), 0);
  // Control sample
  const ctrlSample = _num(
    controlSampleFromDetail(detail.byproducts, detail.balance_materials, batchId),
  );
  // Batch-row stored fields (canonical snapshot for closed batches;
  // null for open batches → treated as 0).
  const fgOutKg = _num(batch.fg_actual_kg) || _num(batch.produced_qty_kg);
  const rawProcessLoss = _num(batch.process_loss_kg);
  const lossKg = rawProcessLoss + wastageTotal;
  const egaKg = _num(batch.extra_give_away_qty);
  // Per-batch input claim → falls back to summed consumption when the
  // operator opened the batch without entering an input qty.
  const claimedInput = _num(batch.input_qty_kg);
  const totalInput = claimedInput > 0 ? claimedInput : rmConsumedKg;
  const inputBasis: SummaryCardData["inputBasis"] =
    claimedInput > 0 ? "indent" : rmConsumedKg > 0 ? "consumption" : "none";
  // Conservation identity + balance check
  const totalAccounted =
    fgOutKg + rawProcessLoss + balTotal + offgradeTotal + ctrlSample + wastageTotal + egaKg;
  const balanceDiffSrv = batch.balance_difference_qty;
  const balanceDiffComputed = totalInput > 0 ? totalInput - totalAccounted : null;
  // Prefer server-stored value (set on close), compute live for open.
  const balanceDiff = balanceDiffSrv != null
    ? _num(balanceDiffSrv)
    : balanceDiffComputed;
  const balanceDiffPct = balanceDiff != null && totalInput > 0
    ? Math.abs(balanceDiff / totalInput) * 100
    : null;
  const isBalanced = batch.is_balanced != null
    ? batch.is_balanced
    : balanceDiff != null
      ? Math.abs(balanceDiff) < BALANCE_TOLERANCE_KG
        || (balanceDiffPct != null && balanceDiffPct <= 0.10)
      : null;
  // Loss percentages — denominator is FG output (operator rule).
  const denom = fgOutKg;
  const pct = (n: number) => denom > 0 ? (n / denom) * 100 : null;
  return {
    rmConsumedKg,
    fgOutKg,
    egaKg,
    additivesKg,
    lossKg,
    balTotal,
    offgradeTotal,
    ctrlSample,
    processLossPct: pct(lossKg),
    egaLossPct: denom > 0 && egaKg > 0 ? (egaKg / denom) * 100 : null,
    invisibleLossPct: denom > 0 ? ((lossKg + egaKg) / denom) * 100 : null,
    totalLossPct: denom > 0 ? ((lossKg + egaKg + offgradeTotal) / denom) * 100 : null,
    offgradePct: pct(offgradeTotal),
    balanceDiff,
    balanceDiffPct,
    isBalanced,
    tolerancePct: 0.10,
    inputBasis,
  };
}

// Off-Grade categories (renamed from "Rejection" per operator) — mirror
// OutputAccountingFragment.REJ_KEYS / REJ_LABELS. R10/C6 — control_sample
// is no longer an off-grade category; it has a dedicated "QC Sample" input
// on Output & Accounting that wires to byproducts (category='control_sample')
// directly.
const REJECTION_OPTIONS: { value: string; label: string }[] = [
  { value: "",                label: "— Select —" },
  { value: "tukda",           label: "Tukda (Broken)" },
  { value: "damaged",         label: "Damaged" },
  { value: "black_stained",   label: "Black Stained" },
  { value: "without_shell",   label: "Without Shell / Kernels" },
  { value: "empty_shells",    label: "Empty Shells" },
  { value: "dust",            label: "Dust" },
  { value: "rejection",       label: "Rejection" },
  // C3-H3 — wastage is a recognised byproduct bucket on the server
  // (jc_accounting_v2 routes it the same way as rejection / off-grade for
  // loss-pct accounting). Surfacing it here so operators don't have to
  // pick "Other" + free-text a wastage remark.
  { value: "wastage",         label: "Wastage" },
  { value: "other",           label: "Other" },
];

// R11/C7 — packing-stage detection mirrors the backend's is_packing_stage
// helper at server_replica/app/modules/production/services/job_card_v2.py:91.
// Only packing stages may record EGA (extra giveaway) or PM variance.
const PACKING_STAGE_TOKENS = ["packaging", "packing"] as const;

function isPackingStageJc(stage: string | null | undefined): boolean {
  if (!stage) return false;
  const s = stage.toLowerCase();
  return PACKING_STAGE_TOKENS.some((t) => s.includes(t));
}

// R11/C7 — PM variance categories. The backend's R11 work persists each of
// these as a byproducts row with category=pm_*; UoM is one of PCS/NOS/ROLL/
// SETS/BUNDLE (no KGS — PM variance is always counted, never weighed).
const PM_VARIANCE_CATEGORIES: { key: string; label: string }[] = [
  { key: "pm_torn",      label: "Torn" },
  { key: "pm_damaged",   label: "Damaged" },
  { key: "pm_misprint",  label: "Misprint" },
  { key: "pm_rejection", label: "Rejection" },
  { key: "pm_wasted",    label: "Wasted" },
];

const PM_VARIANCE_UOMS = ["PCS", "NOS", "ROLL", "SETS", "BUNDLE"] as const;

// R12/C8 — roles allowed to tick the QC Verification Passed checkbox. Mirrors
// the server-side gating on the /sign-off endpoint when role='qc_inspector'.
//
// W3-HIGH-3 — admin detection now matches the cost-gate pattern (see
// lib/cost-gate.ts extractRoleName): a role envelope can carry
// `is_admin: true` in addition to / instead of `code === 'admin'`.
// Without this an admin user whose `/me` payload only flagged the
// per-role envelope (but not the top-level is_admin) failed the QC gate
// and couldn't tick QC Verification Passed.
type MeShape = {
  is_admin?: boolean;
  role_name?: string;
  roles?: (string | { code?: string; role_name?: string; is_admin?: boolean })[];
};

function userIsAdmin(me: MeShape | null): boolean {
  if (!me) return false;
  if (me.is_admin === true) return true;
  const rs = Array.isArray(me.roles) ? me.roles : null;
  if (!rs) return false;
  return rs.some((r) => {
    if (typeof r === "string") return r === "admin";
    if (r?.is_admin === true) return true;
    const code = r?.code ?? r?.role_name ?? "";
    return code === "admin";
  });
}

function userIsQcOrAdmin(me: MeShape | null): boolean {
  if (!me) return false;
  if (userIsAdmin(me)) return true;
  if (me.role_name === "qc_inspector") return true;
  const rs = Array.isArray(me.roles) ? me.roles : null;
  if (!rs) return false;
  for (const r of rs) {
    const code = typeof r === "string" ? r : (r?.code ?? r?.role_name ?? "");
    if (code === "qc_inspector") return true;
  }
  return false;
}

const METAL_CHECK_TYPES: { value: string; label: string }[] = [
  { value: "pre_packaging",  label: "Pre-packaging" },
  { value: "post_packaging", label: "Post-packaging" },
];

const ENV_PARAMS: { key: string; label: string }[] = [
  { key: "brine_salinity", label: "Brine Salinity" },
  { key: "temp",           label: "Temperature" },
  { key: "humidity",       label: "Humidity" },
  { key: "magnet",         label: "Magnet Check" },
];

// Aliased from @/lib/constants.WEIGHT_SAMPLE_COUNT — kept as a const here
// so the JSX label stays short ("Samples ({WEIGHT_SAMPLES})").
const WEIGHT_SAMPLES = WEIGHT_SAMPLE_COUNT;

function fmtStatus(s?: string | null): string {
  return (s || "").replace(/_/g, " ");
}
function fmtKg(v: number | string | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = typeof v === "number" ? v : parseFloat(v);
  if (Number.isNaN(n)) return "—";
  return `${n.toLocaleString("en-IN")} kg`;
}
function fmtNum(v: number | string | null | undefined, digits = 2): string {
  if (v == null || v === "") return "—";
  const n = typeof v === "number" ? v : parseFloat(v);
  if (Number.isNaN(n)) return "—";
  return n.toFixed(digits);
}
function fmtDateTime(iso?: string | null): string {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
// R10 — full error-mapping catalog moved into @/lib/apiErrors so the
// same translations apply on planning / plan-list / SO pages. The local
// `friendlyJobCardError` alias preserves every existing call site
// without a rename churn.
const friendlyJobCardError = friendlyApiError;

function num(v: string | null | undefined): number {
  if (v == null) return 0;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

// C3-H1 + H2 — shared Force Unlock flow used by both the OverflowMenu and
// every LockBanner instance below. Hoisted to module scope so the banner CTA
// runs the EXACT same prompts + PUT /force-unlock call as the page-header
// menu (previously the banner only scroll-to-top'd, which sent the operator
// to the menu without actually triggering the flow). authority + reason are
// collected via window.prompt — matching the legacy Android dialog UX — and
// a successful unlock fires the caller's onReload so the JC payload refetches
// and `is_locked` flips off.
async function runForceUnlockJc(
  jobCardId: number,
  defaultAuthority: string,
  onReload: () => void,
): Promise<void> {
  const authority = window.prompt("Force unlock — authority (e.g. plant manager name):", defaultAuthority);
  if (authority == null || !authority.trim()) return;
  const reason = window.prompt("Force unlock — reason:");
  if (reason == null || !reason.trim()) return;
  try {
    const res = await apiFetch(`/api/v1/production/job-cards-v2/${jobCardId}/force-unlock`, {
      method: "PUT",
      body: JSON.stringify({ authority: authority.trim(), reason: reason.trim() }),
    });
    if (!res.ok) {
      // W4-HIGH-2 — share the canonical envelope reader so a JSON error body
      // ({message} / {error}) surfaces verbatim and a stray HTML response
      // falls back to the friendly default instead of being alert()-ed raw.
      const msg = await readApiErrorMessage(res, "Force-unlock failed");
      throw new Error(msg);
    }
    window.alert("Job card force-unlocked.");
    onReload();
  } catch (e) {
    window.alert(friendlyJobCardError(e));
  }
}

// ── Page ──────────────────────────────────────────────────────────────────

// W4-MED-3/M10 — wraps the body in <UserProvider> so every nested
// ActionButton / LockableButton / row helper consumes a single shared user
// snapshot via context instead of subscribing to userStore on every render.
export default function JobCardDetailPage() {
  return (
    <UserProvider>
      <JobCardDetailPageBody />
    </UserProvider>
  );
}

function JobCardDetailPageBody() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const jcId = Number(params?.id);

  const [detail, setDetail] = useState<JobCardDetail | null>(null);
  const [chain, setChain] = useState<ChainStep[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("chain");
  const initial = useUserInitial();

  // Manual reload counter — bumped from inside the tab content (Save Output,
  // Sign-off, etc.) to re-fetch detail + chain without remounting the page.
  // The fetch effect treats every change to `reloadKey` as "do another pass".
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((k) => k + 1);

  // Boot-time auth gate — drops the inline tokenStore check that used to
  // live at the top of the fetch effect.
  const authed = useRequireAuth(router.replace);

  // Fetch effect: depends directly on jcId + reloadKey so the same
  // anti-loop reasoning as the listing applies — no useCallback indirection,
  // no fresh function reference per render. AbortController cancels the
  // in-flight pair if the operator jumps to a different JC mid-flight; the
  // signal is also forwarded to fetch so the network request itself stops.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!authed) return;
    if (!Number.isFinite(jcId)) {
      // Defer past the synchronous effect body to satisfy the
      // react-hooks/set-state-in-effect rule.
      queueMicrotask(() => {
        setError("Invalid job card id.");
        setLoading(false);
      });
      return;
    }

    const controller = new AbortController();
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        // Detail first — if it 404s, we never bother downloading the chain.
        const detailRes = await apiFetch(
          `/api/v1/production/job-cards-v2/${jcId}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (detailRes.status === 401) return; // apiFetch already redirected
        if (detailRes.status === 404) { setError("Job card not found."); return; }
        if (!detailRes.ok) throw new Error(`Detail HTTP ${detailRes.status}`);

        // Server route: server_replica/app/modules/production/router.py:4806
        // (@router.get("/job-cards-v2/{job_card_id}/chain")). Distinct from
        // the legacy v1 chain (`/orders/{orderId}/job-card-chain`) which is
        // production-order-keyed; the v2 chain returns plan_line siblings.
        const chainRes = await apiFetch(
          `/api/v1/production/job-cards-v2/${jcId}/chain`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (chainRes.status === 401) return;
        if (!chainRes.ok) throw new Error(`Chain HTTP ${chainRes.status}`);

        const detailJson = (await detailRes.json()) as JobCardDetail;
        const chainJson  = (await chainRes.json())  as ChainStep[];
        if (controller.signal.aborted) return;
        setDetail(detailJson);
        setChain(chainJson);
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(friendlyApiError(e));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => {
      controller.abort();
    };
  }, [jcId, router, reloadKey, authed]);

  // C3-H5 — window-focus revalidation. When the operator tabs back to the
  // app (or the laptop wakes from sleep) we re-fetch the JC so the lock
  // banner reflects any out-of-band state change (a plant manager
  // force-unlocked from another device, the upstream stage dispatched and
  // flipped is_locked off, etc.). A soft 60s poll runs while the tab is
  // visible as a backstop — the listener fires `reload()` on focus, and a
  // visibility-driven setInterval picks up changes the user doesn't tab
  // away from. Both are no-ops when authed === false.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!authed) return;
    const onFocus = () => reload();
    window.addEventListener("focus", onFocus);
    let pollId: ReturnType<typeof setInterval> | null = null;
    const startPoll = () => {
      if (pollId != null) return;
      pollId = setInterval(() => {
        if (typeof document !== "undefined" && !document.hidden) reload();
      }, 60_000);
    };
    const stopPoll = () => {
      if (pollId != null) { clearInterval(pollId); pollId = null; }
    };
    const onVisibility = () => {
      if (typeof document === "undefined") return;
      if (document.hidden) stopPoll(); else startPoll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    if (typeof document !== "undefined" && !document.hidden) startPoll();
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      stopPoll();
    };
    // `reload` is a stable closure over setReloadKey — safe to depend on
    // `authed` only. Capturing reload itself would re-bind the listener
    // every render because setReloadKey returns a new identity each call.
  }, [authed]);

  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-6 gap-4">
        <BrandMark />
        <span className="text-[#d5dbdb] text-[13px] hidden sm:inline">Console</span>
        <nav className="text-[12px] text-[#d5dbdb] hidden md:flex items-center gap-2 ml-2">
          <button onClick={() => router.push("/modules")} className="hover:underline">Modules</button>
          <span>/</span>
          <button onClick={() => router.push("/modules/job-card")} className="hover:underline">Job Cards</button>
          <span>/</span>
          <span className="text-white">{detail?.job_card_id ?? jcId}</span>
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
        {/* Back row — router.back() preserves the listing's in-memory state
            via the session-storage cache (lib/jc-list-cache.ts) so filters,
            scroll position, and fetched rows survive the round trip. The
            BackLink falls back to a fresh listing route push when there's
            no history entry (operator opened the detail URL directly). */}
        <div className="mb-3">
          <BackLink parentHref="/modules/job-card" label="job cards" />
        </div>
        {loading && !detail ? (
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[var(--text-secondary)]">
            <span className="inline-flex items-center gap-2 text-[13px]">
              <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
              Loading job card…
            </span>
          </div>
        ) : error ? (
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-8 text-center">
            <p className="text-[var(--aws-error)] text-[14px] font-semibold mb-2">{error}</p>
            <button onClick={() => router.push("/modules/job-card")} className="text-[12px] text-[var(--aws-link)] hover:underline">
              Back to job cards
            </button>
          </div>
        ) : detail ? (
          <>
            <PageHeader
              detail={detail}
              chain={chain}
              onJump={(id) => router.push(`/modules/job-card/${id}`)}
              onReload={reload}
            />
            <ActionBar detail={detail} onReload={reload} reloading={loading} />
            {/* R10 — lifecycle hint: production hasn't started yet. The
                Overview tab stays editable so Assign Team + Start work;
                everything else is read-only until status flips to in_progress. */}
            {isLifecycleLocked(detail.status) ? (
              <div
                role="status"
                className="mb-3 px-3 py-2 rounded border text-[12px] bg-[#fbeced] border-[#e6bcbe] text-[#9a393e]"
              >
                <strong>Job card not started.</strong> Assign a team on the{" "}
                <em>Overview</em> tab and click <strong>START</strong> to enable
                Output, Accounting, Quality, and Remarks.
              </div>
            ) : null}
            {/* R13 — the batch-closure controls + table now live inside the
                Accounting Summary card (Output & Accounting tab), not here. */}
            <TabStrip value={tab} onChange={setTab} />
            <TabPanel
              detail={detail}
              chain={chain}
              tab={tab}
              onReload={reload}
              onJumpJc={(id) => router.push(`/modules/job-card/${id}`)}
            />
          </>
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

// ── Page header ───────────────────────────────────────────────────────────

function PageHeader({
  detail, chain, onJump, onReload,
}: {
  detail: JobCardDetail;
  chain: ChainStep[];
  onJump: (id: number) => void;
  onReload: () => void;
}) {
  const style = STATUS_STYLES[detail.status ?? ""] ?? STATUS_STYLES.unlocked;
  // Show the 8-digit JC number (job_card_id). The long PLAN-… job_card_number
  // reference stays on the tooltip for traceability.
  const jcNum = String(detail.job_card_id);
  const jcRef = detail.job_card_number || "";
  const sos = detail.section_1_product?.so_numbers ?? detail.so_numbers ?? [];
  const soDisplay = sos.length === 0 ? "—" : sos.length === 1 ? sos[0] : `${sos[0]} +${sos.length - 1}`;

  // Chain nav — find the current step's neighbours so we can render
  // ‹ Prev | Step X of Y | Next › the same way as the Android toolbar.
  const curIdx = chain.findIndex((c) => c.is_current);
  const cur = curIdx >= 0 ? chain[curIdx] : null;
  const prevStep = curIdx > 0 ? chain[curIdx - 1] : null;
  const nextStep = curIdx >= 0 && curIdx + 1 < chain.length ? chain[curIdx + 1] : null;

  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] p-5 mb-4">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="font-mono text-[12px] text-[var(--aws-link)] font-semibold mb-1" title={jcRef || jcNum}>{jcNum}</div>
          <h1 className="text-[22px] leading-[26px] font-semibold text-[var(--text-primary)]" title={detail.fg_sku_name ?? ""}>
            {detail.fg_sku_name || "—"}
          </h1>
          <p className="text-[13px] text-[var(--text-secondary)] mt-1">{detail.customer_name || "—"}</p>

          {/* G4 — Bar-Line Process override. Renders only when the backend
              surfaces a bar_line_process string (fields are additive/optional
              and may be absent at runtime — see JobCardDetail). */}
          <BarLineBadge detail={detail} />

          {/* Chain nav row — only when the JC is part of a chain. */}
          {cur && chain.length > 1 ? (
            <div className="flex items-center gap-2 mt-2 text-[12px]">
              {prevStep ? (
                <button
                  type="button"
                  onClick={() => onJump(prevStep.job_card_id)}
                  className="text-[var(--aws-orange)] font-bold hover:underline"
                  title={prevStep.process_name ?? ""}
                >
                  ‹ Prev
                </button>
              ) : (
                <span className="text-[var(--text-disabled)]">‹ Prev</span>
              )}
              <span className="text-[var(--text-secondary)]">
                Step {cur.step_number} of {chain.length}
              </span>
              {nextStep ? (
                <button
                  type="button"
                  onClick={() => onJump(nextStep.job_card_id)}
                  className="text-[var(--aws-orange)] font-bold hover:underline"
                  title={nextStep.process_name ?? ""}
                >
                  Next ›
                </button>
              ) : (
                <span className="text-[var(--text-disabled)]">Next ›</span>
              )}
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span
            className="inline-block text-[11px] font-semibold px-2 py-1 rounded-sm capitalize"
            style={{ background: style.bg, color: style.fg, border: `1px solid ${style.ring}` }}
          >
            {fmtStatus(detail.status) || "—"}
          </span>
          <OverflowMenu detail={detail} onReload={onReload} />
        </div>
      </div>
      <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-x-4 gap-y-2 text-[12px]">
        <HeaderMeta label="SO" value={soDisplay} title={sos.join(", ")} />
        <HeaderMeta label="Batch" value={detail.batch_number || "—"} />
        <HeaderMeta label="Qty" value={fmtKg(detail.planned_qty_kg)} />
        <HeaderMeta label="Plant" value={detail.factory || "—"} />
        <HeaderMeta label="Floor" value={detail.floor || "—"} />
        <HeaderMeta label="Plan" value={detail.plan_id ? `#${detail.plan_id}` : "—"} />
      </dl>
    </div>
  );
}

// ── G4 Bar-Line Process badge ─────────────────────────────────────────────
// Surfaces that this JC's FG is a bar-line VA product whose routing comes from
// the richer `Bar Line Process` string. Two states:
//   • bar_line_routed === true  → navy filled chip ("Bar Line"): the G4
//     override actually rebuilt this FG's route from the richer process.
//   • bar_line_process present but not routed → subtler outline chip
//     ("Bar Line · not applied"): the richer routing exists but hasn't been
//     applied yet, so ops can still see it.
// Fully defensive: renders nothing when bar_line_process is absent/empty.
// The full process string is exposed via the chip's `title` tooltip.
function BarLineBadge({ detail }: { detail: JobCardDetail }) {
  const process = detail.bar_line_process;
  if (!process) return null;
  const routed = detail.bar_line_routed === true;
  return (
    <span
      title={process}
      className={[
        "inline-flex items-center gap-1 mt-2 rounded-sm px-1.5 py-0.5 text-[11px] font-semibold font-mono",
        routed
          ? "bg-[var(--aws-navy)] text-white border border-[var(--aws-navy)]"
          : "bg-white text-[var(--aws-navy)] border border-[var(--aws-navy)] border-dashed",
      ].join(" ")}
    >
      Bar Line{routed ? "" : <span className="font-normal text-[var(--text-secondary)]"> · not applied</span>}
    </span>
  );
}

function HeaderMeta({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="min-w-0">
      <dt className="uppercase tracking-wide font-semibold text-[var(--text-muted)] text-[10px]">{label}</dt>
      <dd className="text-[13px] text-[var(--text-primary)] truncate" title={title ?? value}>{value}</dd>
    </div>
  );
}

// ── Action bar ───────────────────────────────────────────────────────────
//
// Mirrors JobCardDetailActivity.updateActionButton — a single context-
// sensitive button driven by status + lock + chain position:
//   assigned/material_received & !locked  → START          → PUT /start
//   in_progress                           → COMPLETE        → PUT /complete
//   completed & has next & remaining > 0  → DISPATCH TO NEXT→ POST /dispatch-to-next
//   completed & no remaining              → CLOSE JC        → PUT /close
//   anything else                         → bar hidden
// Each action runs a window.confirm step before firing — matches the Android
// AlertDialog. Dispatch additionally collects the qty via window.prompt so
// the operator can choose how much to push to the next stage.
function ActionBar({ detail, onReload, reloading = false }: { detail: JobCardDetail; onReload: () => void; reloading?: boolean }) {
  const [busy, setBusy] = useState(false);
  const status = detail.status ?? "";
  const isLocked = !!detail.is_locked && !detail.force_unlocked;

  async function callAction(opts: {
    confirmTitle: string;
    confirmMessage: string;
    method: "PUT" | "POST" | "DELETE";
    path: string;
    body?: unknown;
    okMessage: string;
  }) {
    if (!window.confirm(`${opts.confirmTitle}\n\n${opts.confirmMessage}`)) return;
    setBusy(true);
    try {
      const res = await apiFetch(opts.path, {
        method: opts.method,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      if (!res.ok) {
        // The backend returns lifecycle rejections as a structured envelope
        // ({"detail": {"error": ..., "message": ...}} on 409s). Parse it so the
        // operator sees the human message (e.g. "Can only complete in_progress
        // JCs (currently 'completed')") instead of a raw JSON blob.
        const msg = await readApiErrorMessage(res, `HTTP ${res.status}`);
        // A rejection almost always means this button was stale: the JC's
        // status advanced out-of-band (another device, an automated dispatch,
        // or this operator's own earlier click that already succeeded). Re-sync
        // the detail so the CTA corrects itself instead of letting the operator
        // re-fire the same doomed action against an already-advanced JC.
        onReload();
        throw new Error(msg);
      }
      window.alert(opts.okMessage);
      onReload();
    } catch (e) {
      window.alert(friendlyJobCardError(e));
    } finally {
      setBusy(false);
    }
  }

  // Decide which button to show.
  let label: string | null = null;
  let onClick: (() => void) | null = null;

  if ((status === "assigned" || status === "material_received") && !isLocked) {
    label = "START";
    onClick = () => callAction({
      confirmTitle: "Start Production",
      confirmMessage: "Start production for this job card? The timer will begin recording.",
      method: "PUT",
      path: `/api/v1/production/job-cards-v2/${detail.job_card_id}/start`,
      okMessage: "Production started — timer running.",
    });
  } else if (status === "in_progress") {
    label = "COMPLETE";
    onClick = () => callAction({
      confirmTitle: "Complete Production",
      confirmMessage: "Mark this job card as completed? End time will be recorded.",
      method: "PUT",
      path: `/api/v1/production/job-cards-v2/${detail.job_card_id}/complete`,
      okMessage: "Production completed.",
    });
  } else if (status === "completed") {
    const fgKg = num(String(detail.section_5_output?.fg_actual_kg ?? 0));
    const sentKg = num(String(detail.dispatched_to_next_kg ?? 0));
    const remaining = fgKg - sentKg;
    // 50 g tolerance — IEEE 754 noise + scale repeatability. Same constant
    // the Accounting Summary uses, so a JC that reads "balanced" in one
    // place can't simultaneously have a "Dispatch to next" button.
    if (detail.next_job_card_id && remaining > BALANCE_TOLERANCE_KG) {
      label = "DISPATCH TO NEXT";
      onClick = () => {
        const qtyStr = window.prompt(
          `Dispatch to next stage\n\nRemaining: ${remaining.toFixed(2)} kg\nEnter qty to dispatch (kg):`,
          remaining.toFixed(2),
        );
        if (qtyStr == null) return;
        const qty = parseFloat(qtyStr);
        if (!Number.isFinite(qty) || qty <= 0) {
          window.alert("Qty must be a positive number.");
          return;
        }
        if (qty > remaining + BALANCE_TOLERANCE_KG) {
          window.alert(`Qty exceeds remaining (${remaining.toFixed(2)} kg).`);
          return;
        }
        void callAction({
          confirmTitle: "Dispatch to next stage",
          confirmMessage: `Push ${qty.toFixed(2)} kg to the next stage?`,
          method: "POST",
          path: `/api/v1/production/job-cards-v2/${detail.job_card_id}/dispatch-to-next`,
          body: { qty_kg: qty },
          okMessage: "Dispatched.",
        });
      };
    } else {
      label = "CLOSE JC";
      onClick = () => callAction({
        confirmTitle: "Close Job Card",
        confirmMessage: "Close this job card after sign-offs? It will become read-only.",
        method: "PUT",
        path: `/api/v1/production/job-cards-v2/${detail.job_card_id}/close`,
        okMessage: "Job card closed.",
      });
    }
  }

  if (!label || !onClick) return null;

  // C10 (Wave 4) — migrated to LockableButton. Lock state goes through the
  // shared hook so the disabled / tooltip behaviour matches every other
  // action surface (force-unlock-capable users still get an interactive
  // button — the server is the authority). The action is hidden entirely
  // when status doesn't permit it via the early return above; here we just
  // honour the lock + busy gating.
  const lockState = { isLocked, lockedReason: detail.locked_reason ?? null };
  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] px-4 py-2 mb-4 flex justify-end">
      <LockableButton
        lockState={lockState}
        busy={busy}
        // Disabled while a refetch is in flight: during a reload the page keeps
        // showing the stale detail (loading only blanks the page on first load),
        // so without this the just-clicked CTA would stay live against an
        // about-to-change status — the classic double-submit "currently
        // 'completed'" rejection. Re-enables once fresh detail lands.
        disabled={reloading}
        onClick={onClick}
        variant="primary"
        className="h-9 px-4 text-[13px] font-bold tracking-wide"
      >
        {label}
      </LockableButton>
    </div>
  );
}

// ── R13/C9 Batch closure band ────────────────────────────────────────────
//
// Surfaces the current batch + history for the JC and exposes Open / Close
// batch controls.  Backed by:
//   GET  /job-cards-v2/{id}/batches
//   POST /job-cards-v2/{id}/batches/open
//   POST /job-cards-v2/{id}/batches/{batch_id}/close
//
// The auto-dispatch downstream (B9) is handled by the server on close — we
// just refresh the JC payload + the batch list after the modal confirms.
//
// (Renamed from "phase" in Stage 1 of the Batch redesign.  Functional
// changes — multi-open batches, per-batch accounting fields, IST
// timestamps — land in Stage 2.)

type BatchRow = {
  batch_id: number;
  batch_number: number;
  batch_date: string | null;
  status: string;
  planned_qty_kg: number | string | null;
  produced_qty_kg: number | string | null;
  rm_consumed_kg: number | string | null;
  extra_give_away_qty: number | string | null;
  opened_at: string | null;
  closed_at: string | null;
  ended_at: string | null;
  notes: string | null;
  // Stage 2 (migration 038): IST literals stamped at open / close.
  // Human-readable strings like "2026-06-04 14:32:15 IST".  TIMESTAMPTZ
  // siblings (opened_at, closed_at, ended_at) remain the canonical
  // ordering / math columns.
  opened_at_ist: string | null;
  closed_at_ist: string | null;
  ended_at_ist: string | null;
  // Stage 2 per-batch summary columns surfaced by the view.
  input_qty_kg: number | string | null;
  fg_actual_kg: number | string | null;
  fg_actual_units: number | string | null;
  process_loss_kg: number | string | null;
  control_sample_kg: number | string | null;
  is_balanced: boolean | null;
  balance_difference_qty: number | string | null;
  closure_remarks: string | null;
};

function BatchBand({ detail, onReload }: { detail: JobCardDetail; onReload: () => void }) {
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openingNotes, setOpeningNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [closeModal, setCloseModal] = useState<BatchRow | null>(null);

  const isPackingStage = isPackingStageJc(detail.stage);

  // W3-MED-6 — AbortController per call so a remount or rapid JC switch
  // doesn't leave a stale request racing the current one.  The current
  // controller is captured in a closure and the caller can cancel it on
  // unmount via the cleanup returned from useEffect.
  const refresh = useMemo(() => {
    const fn = async (signal?: AbortSignal) => {
      setLoading(true);
      setLoadError(null);
      try {
        const res = await apiFetch(
          `/api/v1/production/job-cards-v2/${detail.job_card_id}/batches`,
          { signal },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { batches?: BatchRow[] };
        setBatches(Array.isArray(data.batches) ? data.batches : []);
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        if (signal?.aborted) return;
        setBatches([]);
        setLoadError("failed to load batches");
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    };
    return fn;
  }, [detail.job_card_id]);

  useEffect(() => {
    const ctrl = new AbortController();
    queueMicrotask(() => { void refresh(ctrl.signal); });
    return () => ctrl.abort();
  }, [refresh]);

  const openBatch = batches.find((p) => p.status === "open") ?? null;
  const closedCount = batches.filter((p) => p.status === "closed").length;
  const totalCount = batches.length;

  // Column totals for the batchwise table footer.
  const batchTotals = useMemo(() => {
    let produced = 0, rm = 0, ega = 0;
    for (const p of batches) {
      produced += num(String(p.produced_qty_kg ?? ""));
      rm += num(String(p.rm_consumed_kg ?? ""));
      ega += num(String(p.extra_give_away_qty ?? ""));
    }
    return { produced, rm, ega };
  }, [batches]);

  // Open Today's Batch eligibility — the server itself enforces the
  // heavier rules; here we surface the button when no batch is currently
  // open AND the JC is in one of the statuses the backend accepts.
  // W3-MED-5 — allow-list so future terminal statuses (e.g. 'rejected')
  // don't leak the button through. Locked JCs must be unlocked first.
  const status = detail.status ?? "";
  const lockState = useLockState(detail);
  const canOpen =
    !openBatch &&
    (status === "assigned" || status === "material_received" || status === "in_progress") &&
    !lockState.isLocked;

  async function doOpenBatch() {
    setFeedback(null);
    setBusy(true);
    try {
      const body: Record<string, unknown> = {};
      if (openingNotes.trim()) body.notes = openingNotes.trim();
      const res = await apiFetch(`/api/v1/production/job-cards-v2/${detail.job_card_id}/batches/open`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let txt: string; try { txt = await res.text(); } catch { txt = `HTTP ${res.status}`; }
        throw new Error(txt || `HTTP ${res.status}`);
      }
      setOpeningNotes("");
      setFeedback({ kind: "ok", msg: "Batch opened." });
      await refresh();
      onReload();
    } catch (e) {
      setFeedback({ kind: "err", msg: friendlyJobCardError(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted)]">Batch</div>
          {loading ? (
            <div className="text-[12px] text-[var(--text-muted)] italic">Loading batches…</div>
          ) : loadError ? (
            <div className="text-[12px] text-[var(--aws-error)] flex items-center gap-2">
              <span>{loadError}</span>
              <button
                type="button"
                onClick={() => void refresh()}
                className="underline text-[var(--text-link)] hover:no-underline"
              >
                retry
              </button>
            </div>
          ) : openBatch ? (
            <div className="text-[13px] text-[var(--text-primary)]">
              <span className="font-semibold">Batch {openBatch.batch_number}</span>
              {openBatch.batch_date ? (
                <span className="ml-2 text-[var(--text-secondary)]">· {openBatch.batch_date}</span>
              ) : null}
              <span className="ml-2 text-[var(--text-muted)] text-[11px]">
                {closedCount} of {totalCount} closed
              </span>
            </div>
          ) : (
            <div className="text-[13px] text-[var(--text-secondary)]">
              No open batch
              {totalCount > 0 ? (
                <span className="ml-2 text-[var(--text-muted)] text-[11px]">
                  · {closedCount} of {totalCount} closed
                </span>
              ) : null}
            </div>
          )}
        </div>

        {/* Open / Close controls moved up to the Batch Context panel
            (top of the Output & Accounting form) so the operator's
            primary lifecycle actions sit next to the batch selector.
            BatchBand here keeps the history table below; no buttons. */}
      </div>

      {feedback ? (
        <div
          className={[
            "mt-2 text-[12px]",
            feedback.kind === "ok" ? "text-[var(--text-success)]" : "text-[var(--aws-error)]",
          ].join(" ")}
        >
          {feedback.msg}
        </div>
      ) : null}

      {/* Batchwise Output — detailed per-batch produced / RM / EGA + total. */}
      {batches.length > 0 ? (
        <div className="mt-3">
          <div className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted)] mb-1">
            Batchwise Output
          </div>
          <table className="w-full text-[12px] border-collapse">
            <thead className="bg-[var(--surface-subtle)]">
              <tr className="border-b border-[var(--aws-border)]">
                <th className="px-2 py-1 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">Batch</th>
                <th className="px-2 py-1 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">Date</th>
                <th className="px-2 py-1 text-right text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">Produced (kg)</th>
                <th className="px-2 py-1 text-right text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)] hidden sm:table-cell">RM (kg)</th>
                <th className="px-2 py-1 text-right text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)] hidden sm:table-cell">EGA</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((p) => (
                <tr key={p.batch_id} className="border-b border-[var(--aws-border)]">
                  <td className="px-2 py-1 font-semibold text-[var(--text-primary)]">
                    {p.batch_number}
                    {p.status === "open" ? (
                      <span className="ml-1 text-[10px] font-normal text-[var(--text-muted)]">(open)</span>
                    ) : null}
                  </td>
                  <td className="px-2 py-1 text-[var(--text-secondary)]">
                    <div>{fmtBatchDate(p.batch_date)}</div>
                    {/* Stage 2 IST literal — surfaced under the date so
                        the operator sees the floor's local clock-face
                        for the open or close event without doing TZ
                        math.  Falls back silently when the column is
                        empty (legacy rows pre-migration-038). */}
                    {p.status === "open" && p.opened_at_ist ? (
                      <div className="text-[10px] text-[var(--text-muted)]">
                        opened {p.opened_at_ist}
                      </div>
                    ) : null}
                    {p.status !== "open" && p.closed_at_ist ? (
                      <div className="text-[10px] text-[var(--text-muted)]">
                        closed {p.closed_at_ist}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-2 py-1 text-right font-mono">{fmtNum(p.produced_qty_kg)}</td>
                  <td className="px-2 py-1 text-right font-mono hidden sm:table-cell">{fmtNum(p.rm_consumed_kg)}</td>
                  <td className="px-2 py-1 text-right font-mono hidden sm:table-cell">{fmtNum(p.extra_give_away_qty)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-[var(--aws-border-strong)] font-semibold">
                <td className="px-2 py-1" colSpan={2}>Total</td>
                <td className="px-2 py-1 text-right font-mono">{fmtNum(batchTotals.produced)}</td>
                <td className="px-2 py-1 text-right font-mono hidden sm:table-cell">{fmtNum(batchTotals.rm)}</td>
                <td className="px-2 py-1 text-right font-mono hidden sm:table-cell">{fmtNum(batchTotals.ega)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : null}

      {closeModal ? (() => {
        // Compute the close-modal defaults + snapshot from JC detail.
        // What the server actually stores on /batches/{id}/close is small —
        // see the close_batch docstring in services/job_card_batch_v2.py.
        // The modal pre-populates from the operator's last Output save:
        //   - producedKg ← detail.section_5_output.fg_actual_kg
        //   - rmConsumedKg ← Σ detail.consumption_lines[].actual_consumed_qty
        //                     (only RM rows — PM doesn't convert into FG)
        //   - extraGiveAway ← accounting.extra_give_away_qty, with a
        //                     balance_materials fallback for JCs whose
        //                     accounting summary hasn't been saved yet
        //                     (PUT /accounting/summary is a separate
        //                     endpoint; today the Save Output button
        //                     doesn't auto-fire it, so accounting.* can
        //                     legitimately be NULL even after a save).
        const consLines = detail.consumption_lines ?? [];
        const balMats   = detail.balance_materials ?? [];
        const bps       = detail.byproducts ?? [];

        // Input-side consumption sum. Only PM is excluded — packaging doesn't
        // convert into FG mass; RM AND SFG/WIP opening inputs DO. (Slice 4: a
        // Stage-2 / pack-of-existing-SFG card's only input is the SFG, so it must
        // count here, matching the item_type !== 'PM' predicates elsewhere — else
        // this client-side balance fallback reports the whole SFG input as a loss.)
        const rmConsumedSum = consLines.reduce((acc, c) => {
          const isInput = (c.input_kind ?? "").toUpperCase() !== "PM";
          return acc + (isInput && c.actual_consumed_qty != null
            ? Number(c.actual_consumed_qty) : 0);
        }, 0);

        // EGA hydration — accounting first, balance_materials fallback.
        const egaFromAcct = detail.accounting?.extra_give_away_qty;
        const egaFromBal  = balMats.find(b => b.balance_type === "extra_given");
        const egaResolved =
          egaFromAcct != null && Number(egaFromAcct) > 0
            ? Number(egaFromAcct)
            : (egaFromBal?.qty_kg != null && Number(egaFromBal.qty_kg) > 0
                ? Number(egaFromBal.qty_kg)
                : null);

        // Snapshot fallback: compute Balance Diff + Is Balanced
        // client-side when the accounting row hasn't been saved.
        // Mirrors the AccountingTab preview formula so the operator
        // sees the same number in both places.
        const fgKg = detail.section_5_output?.fg_actual_kg != null
          ? Number(detail.section_5_output.fg_actual_kg) : null;
        const processLossKg = detail.section_5_output?.process_loss_kg != null
          ? Number(detail.section_5_output.process_loss_kg) : 0;
        const balMatTotal = balMats
          .filter(b => b.balance_type === "returned")
          .reduce((a, b) => a + (b.qty_kg != null ? Number(b.qty_kg) : 0), 0);
        const offgradeTotal = bps
          .filter(b => b.category && !["control_sample", "balance_material"].includes(b.category) && !b.category.startsWith("pm_") && b.category !== "wastage")
          .reduce((a, b) => a + (b.qty_kg != null ? Number(b.qty_kg) : 0), 0);
        const wastageKg = bps
          .filter(b => b.category === "wastage")
          .reduce((a, b) => a + (b.qty_kg != null ? Number(b.qty_kg) : 0), 0);
        const ctrlSampleKg = bps
          .filter(b => b.category === "control_sample")
          .reduce((a, b) => a + (b.qty_kg != null ? Number(b.qty_kg) : 0), 0);

        // Canonical input = RM issued (indents) + carried-in (chain SFG/WIP),
        // falling back to non-PM consumption only when neither exists (archetype-C
        // pack-of-existing-SFG). This matches the AccountingTab and avoids
        // double-counting the chain SFG (carried_in) with the audit-only synthetic
        // consumption row (Slice-5 review #4).
        const rmIssuedKgSnap = (detail.rm_indents ?? []).reduce((a, r) => a + Number(r.issued_qty ?? 0), 0);
        const carriedInSnap = Number(detail.carried_qty_kg ?? 0);
        const canonicalInputSnap = rmIssuedKgSnap + carriedInSnap;
        const totalInput = canonicalInputSnap > 0 ? canonicalInputSnap : rmConsumedSum;
        const totalAccounted = (fgKg ?? 0) + processLossKg + balMatTotal
                             + offgradeTotal + wastageKg + ctrlSampleKg
                             + (egaResolved ?? 0);
        const computedBalanceDiff = totalInput > 0
          ? totalInput - totalAccounted
          : null;
        const tolerancePct = detail.accounting?.allowed_balance_tolerance_pct != null
          ? Number(detail.accounting.allowed_balance_tolerance_pct) * 100
          : 0.10;
        const computedIsBalanced = computedBalanceDiff != null
          ? Math.abs(computedBalanceDiff) < 0.05
            || (totalInput > 0
                && (Math.abs(computedBalanceDiff) / totalInput) * 100 <= tolerancePct)
          : null;
        const computedTotalLossPct = fgKg && fgKg > 0
          ? ((processLossKg + wastageKg + (egaResolved ?? 0) + offgradeTotal) / fgKg) * 100
          : null;

        return (
          <BatchCloseModal
            batch={closeModal}
            jcId={detail.job_card_id}
            isPackingStage={isPackingStage}
            defaults={{
              producedKg: fgKg != null ? String(fgKg) : "",
              rmConsumedKg: rmConsumedSum > 0 ? rmConsumedSum.toFixed(3) : "",
              extraGiveAway: egaResolved != null ? String(egaResolved) : "",
            }}
            summarySnapshot={{
              fgActualKg:   fgKg,
              // Prefer server-saved values when present, else client-computed.
              balanceDiff:  detail.accounting?.balance_diff_kg != null
                ? Number(detail.accounting.balance_diff_kg) : computedBalanceDiff,
              isBalanced:   detail.accounting?.is_balanced ?? computedIsBalanced,
              tolerancePct,
              totalLossPct: detail.accounting?.total_loss_pct != null
                ? Number(detail.accounting.total_loss_pct) : computedTotalLossPct,
            }}
            onClose={() => setCloseModal(null)}
            onDone={async () => {
              setCloseModal(null);
              await refresh();
              onReload();
            }}
          />
        );
      })() : null}
    </div>
  );
}

function BatchCloseModal({
  batch, jcId, isPackingStage, defaults, summarySnapshot, onClose, onDone,
}: {
  batch: BatchRow;
  jcId: number;
  isPackingStage: boolean;
  /** Pre-fill values pulled from the JC detail (last saved output +
   *  consumption sum + persisted EGA). Empty strings show as blank
   *  placeholders. The operator can still type over them. */
  defaults: {
    producedKg: string;
    rmConsumedKg: string;
    extraGiveAway: string;
  };
  /** Compact accounting snapshot rendered above the form so the
   *  operator can re-check balance/tolerance before confirming the
   *  close. nulls render as "—" — same convention as the main
   *  AccountingSummaryCard. */
  summarySnapshot: {
    fgActualKg: number | null;
    balanceDiff: number | null;
    isBalanced: boolean | null;
    tolerancePct: number;
    totalLossPct: number | null;
  };
  onClose: () => void;
  onDone: () => Promise<void> | void;
}) {
  const [producedKg, setProducedKg] = useState(defaults.producedKg);
  const [rmConsumedKg, setRmConsumedKg] = useState(defaults.rmConsumedKg);
  const [extraGiveAway, setExtraGiveAway] = useState(defaults.extraGiveAway);
  // Stage 3 final: per-batch partial dispatch.  Defaults to the full
  // produced qty (the legacy behaviour) so a default Close still ships
  // everything downstream.  Operator can lower it to keep material at
  // this stage; server clamps to [0, producedKg].
  const [dispatchKg, setDispatchKg] = useState(defaults.producedKg);
  // Mirror dispatch default to producedKg whenever the operator edits
  // the produced field — unless they've already typed a custom dispatch.
  const dispatchTouched = useRef(false);
  useEffect(() => {
    if (!dispatchTouched.current) {
      setDispatchKg(producedKg);
    }
  }, [producedKg]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const produced = parseFloat(producedKg);
    if (!Number.isFinite(produced) || produced < 0) {
      setError("Produced qty (kg) is required.");
      return;
    }
    // W3-MED-7 — guard zero-production close. A 0-kg close is legitimate
    // (e.g. an aborted batch) but uncommon enough that we want the
    // operator to acknowledge it before the row writes through. Without
    // this the most common UX failure here was leaving the input blank,
    // parseFloat'ing "" → NaN, falling through the validation above as
    // "Produced qty is required" — but typing "0" by accident silently
    // closed the batch with zero output.
    if (produced === 0) {
      if (!window.confirm("Close this batch with produced_qty_kg = 0? This will mark the batch as closed with no output recorded.")) {
        return;
      }
    }
    const body: Record<string, unknown> = { produced_qty_kg: produced };
    if (rmConsumedKg.trim() !== "") {
      const v = parseFloat(rmConsumedKg);
      if (Number.isFinite(v)) body.rm_consumed_kg = v;
    }
    if (isPackingStage && extraGiveAway.trim() !== "") {
      const v = parseFloat(extraGiveAway);
      if (Number.isFinite(v)) body.extra_give_away_qty = v;
    }
    // Dispatch qty — server defaults to full produced when omitted, so
    // only send the field when the operator explicitly chose a lower
    // (or zero) amount.  This keeps wire payloads minimal for the
    // common full-dispatch case.
    if (dispatchKg.trim() !== "") {
      const v = parseFloat(dispatchKg);
      if (Number.isFinite(v) && v >= 0 && v !== produced) {
        body.dispatch_qty_kg = v;
      }
    }
    setBusy(true);
    try {
      const res = await apiFetch(`/api/v1/production/job-cards-v2/${jcId}/batches/${batch.batch_id}/close`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let txt: string; try { txt = await res.text(); } catch { txt = `HTTP ${res.status}`; }
        throw new Error(txt || `HTTP ${res.status}`);
      }
      await onDone();
    } catch (e) {
      setError(friendlyJobCardError(e));
    } finally {
      setBusy(false);
    }
  }

  // BatchCloseModal is rendered from inside BatchBand, which lives
  // inside the AccountingTab's <form>.  Nesting <form> elements is
  // invalid HTML (Next 16 emits a hydration error).  Portal the modal
  // to document.body so the inner <form> is a sibling of the outer
  // form rather than a descendant.  SSR-safe: only portal when window
  // exists; on the server render nothing (the modal only opens after
  // a client-side click anyway).
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <form
        onSubmit={submit}
        className="bg-white border border-[var(--aws-border)] rounded-md shadow-lg w-full max-w-md p-5"
      >
        <h3 className="text-[14px] font-semibold text-[var(--text-primary)] mb-3">
          Close Batch {batch.batch_number}
        </h3>

        {/* Re-check snapshot from the last saved accounting. Read-only.
            Lets the operator confirm balance + loss before committing
            the close — most-common "did I save everything?" check. */}
        <div className="mb-3 border border-[var(--aws-border)] rounded-md bg-[var(--surface-subtle)] px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)] mb-1.5">
            Saved Accounting Snapshot
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
            <div>
              <dt className="text-[var(--text-muted)]">FG Output</dt>
              <dd className="font-mono">
                {summarySnapshot.fgActualKg != null
                  ? `${summarySnapshot.fgActualKg.toFixed(2)} kg`
                  : <span className="italic text-[var(--text-muted)]">not saved</span>}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--text-muted)]">Balanced</dt>
              <dd>
                {summarySnapshot.isBalanced == null ? (
                  <span className="italic text-[var(--text-muted)]">—</span>
                ) : summarySnapshot.isBalanced ? (
                  <span className="text-[var(--text-success)] font-semibold">Yes</span>
                ) : (
                  <span className="text-[var(--aws-error)] font-semibold">No</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--text-muted)]">Balance Diff</dt>
              <dd className={`font-mono ${summarySnapshot.isBalanced === false ? "text-[var(--aws-error)] font-semibold" : ""}`}>
                {summarySnapshot.balanceDiff != null
                  ? `${summarySnapshot.balanceDiff.toFixed(2)} kg`
                  : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--text-muted)]">Tolerance</dt>
              <dd className="font-mono">{summarySnapshot.tolerancePct.toFixed(2)}%</dd>
            </div>
            <div className="col-span-2">
              <dt className="text-[var(--text-muted)]">Total Loss</dt>
              <dd className="font-mono">
                {summarySnapshot.totalLossPct != null
                  ? `${summarySnapshot.totalLossPct.toFixed(2)}%`
                  : "—"}
              </dd>
            </div>
          </dl>
          {summarySnapshot.isBalanced === false ? (
            <p className="mt-2 text-[10px] text-[var(--aws-error)]">
              Saved accounting is unbalanced — fix before closing or the /complete gate may reject.
            </p>
          ) : null}
        </div>

        <div className="space-y-3">
          <FormNumber
            label="Produced qty (kg) *"
            value={producedKg}
            onChange={setProducedKg}
            disabled={busy}
            placeholder="0.00"
          />
          <FormNumber
            label="RM consumed (kg)"
            value={rmConsumedKg}
            onChange={setRmConsumedKg}
            disabled={busy}
            placeholder="0.00"
          />
          {isPackingStage ? (
            <FormNumber
              label="Extra give-away qty"
              value={extraGiveAway}
              onChange={setExtraGiveAway}
              disabled={busy}
              placeholder="0.00"
            />
          ) : null}
          {/* Stage 3 final: partial dispatch.  Defaults to producedKg
              and follows it.  Operator can lower it to keep material
              at this stage (e.g. dispatch 80 of 100 kg; remainder
              available for a subsequent dispatch). */}
          <div>
            <FormNumber
              label="Dispatch qty to next stage (kg)"
              value={dispatchKg}
              onChange={(v) => {
                dispatchTouched.current = true;
                setDispatchKg(v);
              }}
              disabled={busy}
              placeholder="0.00"
            />
            {(() => {
              const p = parseFloat(producedKg);
              const d = parseFloat(dispatchKg);
              if (!Number.isFinite(p) || !Number.isFinite(d)) return null;
              const remainder = p - d;
              if (remainder <= 0.001) {
                return (
                  <p className="mt-1 text-[10px] text-[var(--text-muted)] italic">
                    Dispatching the full produced qty downstream.
                  </p>
                );
              }
              return (
                <p className="mt-1 text-[10px] text-[#8a5e10]">
                  {d.toFixed(2)} kg will ship downstream; {remainder.toFixed(2)} kg stays at this stage.
                </p>
              );
            })()}
          </div>
        </div>
        {error ? (
          <p className="mt-3 text-[12px] text-[var(--aws-error)]">{error}</p>
        ) : null}
        <div className="mt-4 flex flex-col sm:flex-row sm:justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="h-8 px-3 rounded-[2px] text-[12px] font-semibold border border-[var(--aws-border-strong)] bg-white hover:bg-[var(--surface-subtle)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className={[
              "h-8 px-3 rounded-[2px] text-[12px] font-bold border",
              busy
                ? "bg-[#c98f92] border-[#c98f92] cursor-not-allowed text-[var(--text-primary)]"
                : "bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white",
            ].join(" ")}
          >
            {busy ? "Closing…" : "Close Batch"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

// ── Overflow ⋮ menu ──────────────────────────────────────────────────────
//
// Mirrors JobCardDetailActivity.showHeaderMenu — items appear conditionally:
//   Edit header        ↦ when status NOT in {completed, closed, cancelled}
//   Close JC           ↦ when status == completed
//   Force unlock       ↦ when is_locked && is_admin
//   Cancel JC          ↦ when status in {locked, unlocked, assigned}
//   Manage Quality rows↦ always editable
// Force unlock + Cancel collect a reason via window.prompt; Edit header /
// Manage Quality rows open elaborate dialogs on Android (multi-field forms);
// the web stubs surface an explanatory alert until those screens land.
function OverflowMenu({ detail, onReload }: { detail: JobCardDetail; onReload: () => void }) {
  const [open, setOpen] = useState(false);
  // C1 (Wave 4) — switched from userStore.load() (one-shot, not reactive)
  // to useMe() (subscribes to userStore + storage events) so the menu
  // re-evaluates the Force-Unlock gate when /me refreshes mid-session.
  const me = useMe();
  const isAdmin = useIsAdmin();
  const status = detail.status ?? "";

  const editable    = status !== "completed" && status !== "closed" && status !== "cancelled";
  // R10 — Cancel JC is admin-only on the server (router gate added with
  // migration 043). Mirror that here so non-admin operators never see the
  // menu item; eliminates the "Cancel" → 403 surprise. Status range
  // unchanged: a JC past 'assigned' must be closed, not cancelled.
  const cancellable = (status === "locked" || status === "unlocked" || status === "assigned")
                       && isAdmin;
  const closeable   = status === "completed";
  // C3-H1 + H2 — use the shared util so the menu agrees with the LockBanner
  // CTA on who's allowed to force-unlock (admin / floor_manager /
  // plant_manager / inventory_manager). Previously this gated on `is_admin`
  // alone, so plant/floor/inventory managers saw the banner CTA but the
  // menu item was hidden — a confusing dead end.
  const showForceUnlock = !!detail.is_locked && userMayForceUnlock(me);

  const items: { label: string; enabled: boolean; onClick: () => void }[] = [];
  items.push({
    label: "Edit header",
    enabled: editable,
    onClick: () => window.alert("Edit header dialog is not implemented on web yet. Use the Android app to edit header fields."),
  });
  if (closeable) {
    items.push({
      label: "Close JC",
      enabled: true,
      onClick: () => closeJc(),
    });
  }
  if (showForceUnlock) {
    items.push({
      label: "Force unlock",
      enabled: true,
      onClick: () => forceUnlockJc(),
    });
  }
  if (cancellable) {
    items.push({
      label: "Cancel JC",
      enabled: true,
      onClick: () => cancelJc(),
    });
  }
  items.push({
    label: "Manage Quality rows",
    enabled: editable,
    onClick: () => window.alert("Manage Quality rows dialog is not implemented on web yet. Use the Quality tab to add rows, or the Android app to edit/delete existing ones."),
  });

  async function callApi(method: "PUT" | "POST" | "DELETE", path: string, body: unknown, okMsg: string) {
    try {
      const res = await apiFetch(path, { method, body: body !== undefined ? JSON.stringify(body) : undefined });
      if (!res.ok) {
        let detailText: string;
        try { detailText = await res.text(); } catch { detailText = `HTTP ${res.status}`; }
        throw new Error(detailText || `HTTP ${res.status}`);
      }
      window.alert(okMsg);
      onReload();
    } catch (e) {
      window.alert(friendlyJobCardError(e));
    }
  }

  function closeJc() {
    if (!window.confirm("Close Job Card\n\nClose this job card after sign-offs? It will become read-only.")) return;
    void callApi("PUT", `/api/v1/production/job-cards-v2/${detail.job_card_id}/close`, undefined, "Job card closed.");
  }
  function forceUnlockJc() {
    // Delegates to the module-scope shared runner so the LockBanner CTA
    // hits the SAME prompts + RPC path — no behavioural drift between the
    // two entry points (C3-H1 + H2).
    void runForceUnlockJc(detail.job_card_id, me?.full_name ?? "", onReload);
  }
  function cancelJc() {
    const reason = window.prompt("Cancel Job Card — reason:");
    if (reason == null || !reason.trim()) return;
    if (!window.confirm(`Cancel Job Card?\n\n"${reason.trim()}"`)) return;
    void callApi(
      "DELETE",
      `/api/v1/production/job-cards-v2/${detail.job_card_id}`,
      { reason: reason.trim() },
      "Job card cancelled.",
    );
  }

  // Close the menu on outside click.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      const t = e.target as HTMLElement;
      if (!t.closest("[data-overflow-menu]")) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <div className="relative" data-overflow-menu>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-7 h-7 rounded-sm hover:bg-[var(--surface-divider)] text-[var(--text-secondary)] flex items-center justify-center"
        aria-label="More actions"
        title="More actions"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
          <circle cx="12" cy="5"  r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="12" cy="19" r="2" />
        </svg>
      </button>
      {open ? (
        <div
          className={[
            // Anchored right (the trigger sits at the right of the page
            // header), but capped at viewport width minus a small margin so
            // the panel breaks to the narrower wrapped width rather than
            // bleeding off the screen when the viewport is too narrow to
            // fit 200px. Tall menus scroll vertically.
            "absolute right-0 z-10 mt-1 w-[200px] max-w-[calc(100vw-1rem)]",
            "max-h-[60vh] overflow-y-auto",
            "bg-white border border-[var(--aws-border)] rounded-md shadow-[0_4px_12px_rgba(0,28,36,0.18)] p-1",
          ].join(" ")}
        >
          {items.map((it, i) => (
            <button
              key={i}
              type="button"
              disabled={!it.enabled}
              onClick={() => { setOpen(false); it.onClick(); }}
              className={[
                "w-full text-left px-2 py-1.5 text-[13px] rounded-sm",
                it.enabled ? "text-[var(--text-primary)] hover:bg-[var(--surface-disabled)]" : "text-[var(--text-disabled)] cursor-not-allowed",
              ].join(" ")}
            >
              {it.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ── Stage Chain tab ───────────────────────────────────────────────────────
//
// Mirrors StageChainFragment on Android — a vertical list of every step on
// this JC's plan line. Each entry shows step number, process, stage, status,
// and the qty handoffs (carried in / dispatched out) so the operator can see
// where the material is in the chain at a glance. The current step is
// non-clickable; the others jump to their own detail page.

// Render one side of a step's material handoff. When a concrete SFG#### code is
// present (a real Slice-3 2-stage seam) show it in mono so the operator sees the
// code flowing JC1.output → JC2.input. Otherwise just show the kind — including a
// plain "SFG" for a non-seam intermediate (every non-first step defaults to
// input_kind='SFG' even on legacy multi-step chains that carry no code, so we
// must NOT render those as "SFG ?"). Null kind falls back to "?".
function SeamKind({ kind, code }: { kind: string | null; code: string | null }) {
  if (code && (kind || "").toUpperCase() === "SFG") {
    return <span className="font-mono font-semibold text-[var(--aws-navy)]">{code}</span>;
  }
  return <>{kind || "?"}</>;
}

// ── SFG inventory picker (Slice 5) ─────────────────────────────────────────
// On a Final-FG / pack-of-existing-SFG stage that consumes an SFG####, lists the
// AVAILABLE WIP/SFG batches (inventory_batch item_type='wip') its upstream
// Create-WIP stage materialised on close — in FIFO order with expiry. "Use"
// fills that batch's qty into the SFG consumption input (when the stage has an
// SFG bom_line to record against; chain consumers auto-record via carried-in).
type SfgBatch = {
  batch_id: string;
  sku_name: string | null;
  current_qty_kg: number | null;
  inward_date: string | null;
  expiry_date: string | null;
  floor_id: string | null;
  status: string | null;
};

function SfgInventoryPicker({ sfgCode, entity, onUse }: { sfgCode: string; entity: string | null; onUse?: (qty: number) => void }) {
  const [batches, setBatches] = useState<SfgBatch[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!sfgCode || !entity) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(
          `/api/v1/production/job-cards-v2/sfg-inventory?sku_name=${encodeURIComponent(sfgCode)}&entity=${encodeURIComponent(entity)}`,
        );
        if (res.status === 401) return; // apiFetch redirected
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { batches?: SfgBatch[] };
        if (!cancelled) setBatches(json.batches ?? []);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [sfgCode, entity]);

  const total = (batches ?? []).reduce((s, b) => s + (b.current_qty_kg ?? 0), 0);
  const todayIso = new Date().toISOString().slice(0, 10);

  return (
    <Panel title={`SFG inventory · ${sfgCode}`}>
      {err ? (
        <EmptyHint>Couldn’t load WIP stock ({err}).</EmptyHint>
      ) : batches === null ? (
        <EmptyHint>Loading WIP stock…</EmptyHint>
      ) : batches.length === 0 ? (
        <EmptyHint>No available WIP stock for {sfgCode} yet — it materialises when the upstream Create-WIP stage closes.</EmptyHint>
      ) : (
        <div className="space-y-1.5">
          <div className="text-[12px] text-[var(--text-secondary)]">
            {batches.length} batch{batches.length === 1 ? "" : "es"} · {fmtKg(total)} available (FIFO)
          </div>
          <ul className="space-y-1">
            {batches.map((b) => {
              const expired = !!b.expiry_date && b.expiry_date < todayIso;
              return (
                <li key={b.batch_id} className="flex items-center gap-2 rounded-md border border-[var(--aws-border)] bg-white p-2 text-[12px]">
                  <span className="font-mono text-[11px] text-[var(--text-muted)]">{b.batch_id}</span>
                  <span className="font-semibold">{fmtKg(b.current_qty_kg)}</span>
                  <span className="text-[var(--text-muted)]">in {b.inward_date || "—"}</span>
                  <span className={expired ? "text-[var(--text-danger)] font-medium" : "text-[var(--text-muted)]"}>
                    exp {b.expiry_date || "—"}{expired ? " (expired)" : ""}
                  </span>
                  <span className="text-[var(--text-muted)]">{b.floor_id || "—"}</span>
                  {onUse ? (
                    <button
                      type="button"
                      onClick={() => onUse(b.current_qty_kg ?? 0)}
                      className="ml-auto rounded border border-[var(--aws-navy)] px-2 py-0.5 text-[11px] text-[var(--aws-navy)] hover:bg-[var(--surface-divider)]"
                    >
                      Use
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Panel>
  );
}

function StageChainTab({ chain, detail, onJump }: { chain: ChainStep[]; detail: JobCardDetail; onJump: (id: number) => void }) {
  // G4 — split the richer Bar-Line Process string into a read-only token
  // sequence for reference. Defensive: only when the backend surfaced it.
  // bar_line_process tokens are '+'-separated (e.g. "Receiving + Sorting + Roasting
  // + …"), matching the backend's _split_process_category. Also tolerate >/→/,
  // just in case, but '+' is the real delimiter.
  const barLineTokens = (detail.bar_line_process || "")
    .split(/[+>→,]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  if (chain.length === 0) {
    return (
      <Panel>
        <EmptyHint>No stage chain available for this job card.</EmptyHint>
      </Panel>
    );
  }
  return (
    <Panel title={`Stage chain · ${chain.length} ${chain.length === 1 ? "step" : "steps"}`}>
      {barLineTokens.length > 0 ? (
        <div className="mb-3 rounded-md border border-[var(--aws-border)] bg-[var(--surface-divider)] p-2.5">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted)]">
              Bar Line Process
            </span>
            {detail.bar_line_routed === true ? (
              <span className="text-[10px] font-semibold text-[var(--aws-navy)]">applied</span>
            ) : (
              <span className="text-[10px] font-medium text-[var(--text-secondary)]">not applied</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1" title={detail.bar_line_process ?? ""}>
            {barLineTokens.map((tok, i) => (
              <span key={`${tok}-${i}`} className="inline-flex items-center gap-1">
                {i > 0 ? <span className="text-[var(--text-muted)] text-[11px]">→</span> : null}
                <span className="font-mono text-[11px] font-semibold text-[var(--aws-navy)] bg-white border border-[var(--aws-border)] rounded-sm px-1.5 py-0.5">
                  {tok}
                </span>
              </span>
            ))}
          </div>
        </div>
      ) : null}
      <ol className="space-y-2">
        {chain.map((step) => (
          <li key={step.job_card_id}>
            <button
              type="button"
              disabled={step.is_current}
              onClick={() => onJump(step.job_card_id)}
              className={[
                "w-full text-left rounded-md border p-3 transition",
                step.is_current
                  ? "border-[var(--aws-orange)] bg-[#fbeced] cursor-default ring-1 ring-[var(--aws-orange)]"
                  : "border-[var(--aws-border)] bg-white hover:border-[var(--aws-navy)] hover:shadow-[0_1px_4px_rgba(0,28,36,0.15)]",
              ].join(" ")}
            >
              <div className="flex items-center gap-3 mb-1">
                <span
                  className={[
                    "inline-flex items-center justify-center w-6 h-6 rounded-full text-[11px] font-bold shrink-0",
                    step.is_current ? "bg-[var(--aws-orange)] text-white" : "bg-[var(--surface-divider)] text-[var(--text-secondary)]",
                  ].join(" ")}
                >
                  {step.step_number}
                </span>
                <div className="flex-1 min-w-0">
                  <div className={["text-[14px] truncate", step.is_current ? "font-semibold text-[var(--text-primary)]" : "text-[var(--text-primary)]"].join(" ")}>
                    {step.process_name || "—"}
                  </div>
                  <div className="text-[12px] text-[var(--text-muted)] truncate">
                    {step.stage || "—"} ·{" "}
                    <SeamKind kind={step.input_kind} code={step.input_code} />
                    {" → "}
                    <SeamKind kind={step.output_kind} code={step.output_code} />
                    {" · "}
                    {step.floor || "—"}
                  </div>
                </div>
                <StatusPill status={step.status} />
              </div>
              <dl className="grid grid-cols-3 gap-x-3 text-[11px] mt-2">
                <Inline label="Planned" value={fmtKg(step.planned_qty_kg)} />
                <Inline label="Carried in" value={fmtKg(step.carried_qty_kg)} />
                <Inline label="Dispatched" value={fmtKg(step.dispatched_to_next_kg)} />
              </dl>
            </button>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function Inline({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <span className="uppercase tracking-wide font-semibold text-[var(--text-muted)] text-[10px] mr-1">{label}</span>
      <span className="text-[12px] text-[var(--text-primary)]">{value}</span>
    </div>
  );
}

function StatusPill({ status, small }: { status: string | null; small?: boolean }) {
  const style = STATUS_STYLES[status ?? ""] ?? STATUS_STYLES.unlocked;
  return (
    <span
      className={["inline-block font-semibold rounded-sm capitalize", small ? "text-[10px] px-1.5 py-0" : "text-[11px] px-2 py-0.5"].join(" ")}
      style={{ background: style.bg, color: style.fg, border: `1px solid ${style.ring}` }}
    >
      {fmtStatus(status) || "—"}
    </span>
  );
}

// ── Tab strip + panel ─────────────────────────────────────────────────────

function TabStrip({ value, onChange }: { value: TabKey; onChange: (t: TabKey) => void }) {
  return (
    // Adaptive across devices: the row scrolls horizontally when the tabs
    // overflow (phones) and lays out fully on wider screens. Tabs never shrink
    // so labels stay readable; the scrollbar is hidden for a clean strip and
    // touch momentum scrolling kicks in natively.
    <div
      role="tablist"
      className="border-b border-[var(--aws-border)] mb-4 flex flex-nowrap gap-1 overflow-x-auto [-webkit-overflow-scrolling:touch] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {TABS.map((t) => {
        const active = t.key === value;
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.key)}
            className={["shrink-0 px-3 sm:px-4 py-2 text-[12px] sm:text-[13px] font-medium whitespace-nowrap border-b-2 -mb-px transition", active ? "border-[var(--aws-orange)] text-[var(--text-primary)]" : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"].join(" ")}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function TabPanel({
  detail, chain, tab, onReload, onJumpJc,
}: {
  detail: JobCardDetail;
  chain: ChainStep[];
  tab: TabKey;
  onReload: () => void;
  onJumpJc: (id: number) => void;
}) {
  switch (tab) {
    case "chain":      return <StageChainTab chain={chain} detail={detail} onJump={onJumpJc} />;
    case "rawmaterial": return <RawMaterialTab jcId={detail.job_card_id} />;
    case "overview":   return <OverviewTab detail={detail} chain={chain} onReload={onReload} />;
    case "accounting": return <AccountingTab detail={detail} onReload={onReload} />;
    case "output":     return <OutputTab detail={detail} onReload={onReload} />;
    case "quality":    return <QualityTab detail={detail} onReload={onReload} />;
    case "signoffs":   return <SignOffsTab detail={detail} onReload={onReload} />;
    case "remarks":    return <RemarksTab detail={detail} onReload={onReload} />;
    case "sfgboxes":   return <SfgBoxesTab detail={detail} />;
    case "amendments": return <AmendmentsTab jcId={detail.job_card_id} />;
  }
}

// ── SFG Boxes tab (Slice 6) ───────────────────────────────────────────────
// Producer stages (output_kind SFG/WIP) split their net SFG into weighed boxes
// and print one QR label per box; consumer stages (input_kind SFG) scan those
// QRs to receive the SFG, with wrong-SFG / wrong-source / already-received boxes
// rejected. box_id is the 8-digit numeric QR payload.

type SfgBoxRow = {
  box_id: number;            // carton_id aliased AS box_id by the backend (mig 067)
  sfg_code: string | null;
  net_weight: number;
  gross_weight: number | null;
  status: string;
  received_into_job_card_id: number | null;
  // Optional / phase-7 genealogy additions. box_number/total_boxes/lot_number
  // were dropped from sfg_box in mig 067, so the backend no longer returns them.
  box_number?: number;
  total_boxes?: number;
  lot_number?: string | null;
  parent_box_id?: number | null;
};

// ── SFG genealogy (Phase 7) ───────────────────────────────────────────────
// Fixed contract from the backend agent — these endpoints may not exist yet at
// runtime, so every fetch is fully defensive (404 / empty ⇒ quiet "no data").
type GenealogyBox = {
  box_id: number;
  sfg_code: string;
  lot_number: string | null;
  parent_box_id: number | null;
  net_weight: number;
  status: string;
  source_inventory_batch_id: string | null;
  job_card_id: number;
  received_into_job_card_id: number | null;
  source_job_card_id?: number | null;
};

type JcGenealogy = {
  job_card_id: number;
  produced: GenealogyBox[];
  consumed: GenealogyBox[];
};

type ChainNode = {
  level: number;
  box_id: number | null;
  sfg_code: string | null;
  lot_number: string | null;
  parent_box_id: number | null;
  producer_job_card_id?: number | null;
  source_inventory_batch_id: string | null;
};

type BoxGenealogy = {
  box_id: number;
  chain: ChainNode[];
};

type SfgScanResult = {
  expected_sfg: string | null;
  boxes_accepted: number;
  boxes_rejected: number;
  total_received_kg: number;
  accepted_boxes: { box_id: number; sfg_code: string | null; net_weight: number }[];
  rejected_boxes: { box_id: number | string; reason: string }[];
};

function SfgBoxesTab({ detail }: { detail: JobCardDetail }) {
  const jcId = detail.job_card_id;
  const isProducer = ["SFG", "WIP"].includes((detail.output_kind ?? "").toUpperCase());
  const isConsumer = (detail.input_kind ?? "").toUpperCase() === "SFG";

  const [boxes, setBoxes] = useState<SfgBoxRow[]>([]);
  const [weights, setWeights] = useState<string[]>([""]);
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [scanText, setScanText] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<SfgScanResult | null>(null);
  const [scanErr, setScanErr] = useState<string | null>(null);

  const loadBoxes = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/v1/production/job-cards-v2/${jcId}/wip-boxes`);
      if (!res.ok) { setLoadErr(await readApiErrorMessage(res, "Could not load boxes")); return; }
      const data = (await res.json()) as { boxes?: SfgBoxRow[] };
      setBoxes(data.boxes ?? []);
      setLoadErr(null);
    } catch (e) {
      setLoadErr(friendlyJobCardError(e));
    }
  }, [jcId]);

  useEffect(() => {
    // Deferred past the synchronous effect body (react-hooks/set-state-in-effect)
    // — the same queueMicrotask idiom used by useSeesCost / useMe in lib/.
    queueMicrotask(() => { void loadBoxes(); });
  }, [loadBoxes]);

  const plannedNet = useMemo(
    () => weights.reduce((s, w) => (Number(w) > 0 ? s + Number(w) : s), 0),
    [weights],
  );

  async function openLabels() {
    try {
      const res = await apiFetch(`/api/v1/production/job-cards-v2/${jcId}/wip-boxes/labels.pdf`);
      if (!res.ok) { setCreateErr(await readApiErrorMessage(res, "Could not open labels PDF")); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      // noopener (matches the rest of the codebase). Popup blockers may stop a
      // deferred open — the "Re-print labels" button is the direct-gesture path.
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      setCreateErr(friendlyJobCardError(e));
    }
  }

  async function createBoxes() {
    const parsed = weights.map((w) => Number(w)).filter((n) => Number.isFinite(n) && n > 0);
    if (parsed.length === 0) { setCreateErr("Enter at least one box weight (> 0)."); return; }
    setCreating(true);
    setCreateErr(null);
    try {
      const res = await apiFetch(`/api/v1/production/job-cards-v2/${jcId}/wip-boxes`, {
        method: "POST",
        body: JSON.stringify({ boxes: parsed.map((n) => ({ net_weight: n })) }),
      });
      if (!res.ok) { setCreateErr(await readApiErrorMessage(res, "Could not create boxes")); return; }
      await loadBoxes();
      setWeights([""]);
      await openLabels();
    } catch (e) {
      setCreateErr(friendlyJobCardError(e));
    } finally {
      setCreating(false);
    }
  }

  async function scanBoxes() {
    const ids = scanText
      .split(/[\s,]+/)
      .map((t) => Number(t.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (ids.length === 0) { setScanErr("Enter one or more numeric box ids."); return; }
    setScanning(true);
    setScanErr(null);
    setScanResult(null);
    try {
      const res = await apiFetch(`/api/v1/production/job-cards-v2/${jcId}/scan-sfg-boxes`, {
        method: "POST",
        body: JSON.stringify({ box_ids: ids }),
      });
      if (!res.ok) { setScanErr(await readApiErrorMessage(res, "Scan failed")); return; }
      setScanResult((await res.json()) as SfgScanResult);
      setScanText("");
    } catch (e) {
      setScanErr(friendlyJobCardError(e));
    } finally {
      setScanning(false);
    }
  }

  const btnCls =
    "h-7 px-3 rounded-[2px] text-[12px] font-semibold border bg-[var(--aws-orange)] " +
    "border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white " +
    "disabled:opacity-50 disabled:cursor-not-allowed";

  return (
    <div className="space-y-4">
      {!isProducer && !isConsumer && (
        <EmptyHint>This stage neither produces nor consumes SFG — no boxes apply.</EmptyHint>
      )}

      {loadErr && (
        <div className="text-[12px] text-[var(--aws-error)]">{loadErr}</div>
      )}

      {isProducer && (
        <Panel title="Produce boxes & print QR labels">
          <p className="text-[12px] text-[var(--text-secondary)] mb-3">
            Split this stage&apos;s net SFG into weighed boxes. Each box gets an 8-digit QR id;
            labels open as a PDF to print. Σ box weights should match the net SFG produced.
          </p>
          {boxes.length > 0 ? (
            <div className="text-[13px] text-[var(--text-primary)] space-y-1">
              <div className="font-semibold">
                {boxes.length} box(es) · Σ {boxes.reduce((s, b) => s + Number(b.net_weight), 0).toFixed(3)} kg
              </div>
              <div className="grid grid-cols-12 gap-2 text-[11px] text-[var(--text-muted)] font-semibold">
                <div className="col-span-4">Box ID</div>
                <div className="col-span-3">Net kg</div>
                <div className="col-span-2">Parent</div>
                <div className="col-span-3">Status</div>
              </div>
              {boxes.map((b) => (
                <div key={b.box_id} className="grid grid-cols-12 gap-2 text-[12px] items-center">
                  <div className="col-span-4 font-mono">{b.box_id}</div>
                  <div className="col-span-3">{Number(b.net_weight).toFixed(3)}</div>
                  <div className="col-span-2 font-mono">
                    {b.parent_box_id != null ? b.parent_box_id : <span className="text-[var(--text-muted)]">—</span>}
                  </div>
                  <div className="col-span-3 truncate">{b.status}</div>
                </div>
              ))}
              <button type="button" className={`${btnCls} mt-2`} onClick={() => void openLabels()}>
                Re-print labels
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {weights.map((w, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-[12px] text-[var(--text-muted)] w-14">Box {i + 1}</span>
                  <input
                    type="number"
                    step="any"
                    inputMode="decimal"
                    placeholder="net kg"
                    className={`${inputCls} w-32`}
                    value={w}
                    onChange={(e) =>
                      setWeights((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))
                    }
                  />
                  {weights.length > 1 && (
                    <button
                      type="button"
                      className="text-[12px] text-[var(--aws-error)] hover:underline"
                      onClick={() => setWeights((prev) => prev.filter((_, j) => j !== i))}
                    >
                      remove
                    </button>
                  )}
                </div>
              ))}
              <div className="flex items-center gap-3 pt-1">
                <button
                  type="button"
                  className="text-[12px] text-[var(--aws-link)] hover:underline"
                  onClick={() => setWeights((prev) => [...prev, ""])}
                >
                  + add box
                </button>
                <span className="text-[12px] text-[var(--text-muted)]">
                  Σ {plannedNet.toFixed(3)} kg
                </span>
              </div>
              {createErr && <div className="text-[12px] text-[var(--aws-error)]">{createErr}</div>}
              <button type="button" className={btnCls} disabled={creating} onClick={() => void createBoxes()}>
                {creating ? "Creating…" : "Create boxes & print labels"}
              </button>
            </div>
          )}
        </Panel>
      )}

      {isConsumer && (
        <Panel title="Scan SFG boxes in">
          <p className="text-[12px] text-[var(--text-secondary)] mb-3">
            Scan or enter the box QR ids arriving from the previous stage. A box is rejected if its
            SFG or source job card doesn&apos;t match, or it was already received.
          </p>
          <textarea
            className={`${inputCls} w-full h-20`}
            placeholder="Box ids — space, comma or newline separated"
            value={scanText}
            onChange={(e) => setScanText(e.target.value)}
          />
          {scanErr && <div className="text-[12px] text-[var(--aws-error)] mt-1">{scanErr}</div>}
          <button type="button" className={`${btnCls} mt-2`} disabled={scanning} onClick={() => void scanBoxes()}>
            {scanning ? "Scanning…" : "Scan boxes"}
          </button>
          {scanResult && (
            <div className="mt-3 text-[12px] space-y-1">
              <div className="text-[var(--text-primary)] font-semibold">
                {scanResult.boxes_accepted} accepted · {scanResult.boxes_rejected} rejected ·{" "}
                {scanResult.total_received_kg.toFixed(3)} kg in
              </div>
              {scanResult.accepted_boxes.map((a) => (
                <div key={a.box_id} className="text-[var(--text-success)]">
                  ✓ {a.box_id} · {a.sfg_code} · {a.net_weight.toFixed(3)} kg
                </div>
              ))}
              {scanResult.rejected_boxes.map((r, i) => (
                <div key={`${r.box_id}-${i}`} className="text-[var(--aws-error)]">
                  ✗ {r.box_id} — {r.reason}
                </div>
              ))}
            </div>
          )}
        </Panel>
      )}

      <SfgGenealogyPanel jcId={jcId} />
    </div>
  );
}

// ── SFG genealogy panel (Phase 7) ─────────────────────────────────────────
// Box→box→lot traceability for WIP SFG boxes. Two groups ("Produced here" /
// "Consumed here") plus a per-box "Trace" expander that walks the upstream
// chain. Fully defensive: a missing/empty endpoint shows a quiet hint, never
// throws — the backend endpoints land in parallel and may 404 at runtime.

function LotChip({ lot }: { lot: string }) {
  return (
    <span className="font-mono text-[11px] font-semibold text-[var(--aws-navy)] bg-[var(--surface-divider)] rounded-sm px-1.5 py-0.5">
      {lot}
    </span>
  );
}

function SfgGenealogyPanel({ jcId }: { jcId: number }) {
  const [data, setData] = useState<JcGenealogy | null>(null);
  const [loading, setLoading] = useState(true);
  // No visible error UI: a 404/parse failure simply resolves to the "no
  // genealogy yet" empty state (the endpoint may not exist yet).
  const [unavailable, setUnavailable] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/v1/production/job-cards-v2/${jcId}/sfg-genealogy`);
      if (!res.ok) { setUnavailable(true); setData(null); return; }
      const json = (await res.json()) as Partial<JcGenealogy> | null;
      setData({
        job_card_id: jcId,
        produced: Array.isArray(json?.produced) ? json!.produced : [],
        consumed: Array.isArray(json?.consumed) ? json!.consumed : [],
      });
      setUnavailable(false);
    } catch {
      setUnavailable(true);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [jcId]);

  useEffect(() => {
    queueMicrotask(() => { void load(); });
  }, [load]);

  const produced = data?.produced ?? [];
  const consumed = data?.consumed ?? [];
  const empty = !loading && (unavailable || (produced.length === 0 && consumed.length === 0));

  return (
    <Panel title="Lot & box genealogy">
      <p className="text-[12px] text-[var(--text-secondary)] mb-3">
        Traceability for SFG boxes flowing through this job card — boxes produced
        here and boxes consumed here, each traceable upstream box → lot → source
        batch → producing job card.
      </p>

      {loading && <EmptyHint>Loading genealogy…</EmptyHint>}

      {empty && <EmptyHint>No genealogy yet.</EmptyHint>}

      {!loading && !empty && (
        <div className="space-y-4">
          <GenealogyGroup title="Produced here" boxes={produced} showSource={false} />
          <GenealogyGroup title="Consumed here" boxes={consumed} showSource />
        </div>
      )}
    </Panel>
  );
}

function GenealogyGroup({
  title, boxes, showSource,
}: { title: string; boxes: GenealogyBox[]; showSource: boolean }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide font-semibold text-[var(--text-muted)] mb-1">
        {title} · {boxes.length}
      </div>
      {boxes.length === 0 ? (
        <EmptyHint>None.</EmptyHint>
      ) : (
        <div className="space-y-1">
          {boxes.map((b) => (
            <GenealogyBoxRow key={b.box_id} box={b} showSource={showSource} />
          ))}
        </div>
      )}
    </div>
  );
}

function GenealogyBoxRow({ box, showSource }: { box: GenealogyBox; showSource: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-[var(--aws-border)] rounded-md p-2 bg-white">
      <div className="flex items-center gap-2 flex-wrap text-[12px]">
        <span className="font-mono text-[var(--aws-link)] font-semibold">{box.box_id}</span>
        <SfgCodeChip code={box.sfg_code} />
        {box.lot_number ? <LotChip lot={box.lot_number} /> : null}
        <span className="text-[var(--text-secondary)]">{Number(box.net_weight).toFixed(3)} kg</span>
        <span className="text-[var(--text-muted)]">· {box.status}</span>
        {showSource && box.source_job_card_id != null && (
          <span className="text-[var(--text-muted)]">· from JC {box.source_job_card_id}</span>
        )}
        <button
          type="button"
          className="ml-auto text-[12px] text-[var(--aws-link)] hover:underline"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide trace" : "Trace"}
        </button>
      </div>
      {open && <BoxTrace boxId={box.box_id} />}
    </div>
  );
}

function SfgCodeChip({ code }: { code: string | null }) {
  if (!code) return <span className="text-[var(--text-muted)]">—</span>;
  return <span className="font-mono font-semibold text-[var(--aws-navy)]">{code}</span>;
}

function BoxTrace({ boxId }: { boxId: number }) {
  const [chain, setChain] = useState<ChainNode[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/v1/production/sfg-boxes/${boxId}/genealogy`);
      if (!res.ok) { setUnavailable(true); setChain(null); return; }
      const json = (await res.json()) as { chain?: ChainNode[] } | null;
      setChain(Array.isArray(json?.chain) ? json!.chain : []);
      setUnavailable(false);
    } catch {
      setUnavailable(true);
      setChain(null);
    } finally {
      setLoading(false);
    }
  }, [boxId]);

  useEffect(() => {
    queueMicrotask(() => { void load(); });
  }, [load]);

  if (loading) {
    return <div className="mt-2 pl-2 text-[12px] text-[var(--text-muted)] italic">Tracing…</div>;
  }
  if (unavailable || !chain || chain.length === 0) {
    return <div className="mt-2 pl-2 text-[12px] text-[var(--text-muted)] italic">No upstream lineage yet.</div>;
  }

  return (
    <ol className="mt-2 border-t border-[var(--surface-divider)] pt-2 space-y-1">
      {chain.map((node, i) => (
        <li
          key={`${node.level}-${node.box_id ?? "x"}-${i}`}
          className="text-[12px] flex items-center gap-2 flex-wrap"
          // Level-based indent: each step upstream nests one notch deeper.
          style={{ paddingLeft: `${Math.max(0, node.level) * 14}px` }}
        >
          <span className="text-[var(--text-muted)]">{node.level === 0 ? "•" : "↳"}</span>
          {node.box_id != null && (
            <span className="font-mono text-[var(--aws-link)] font-semibold">{node.box_id}</span>
          )}
          <SfgCodeChip code={node.sfg_code} />
          {node.lot_number ? <LotChip lot={node.lot_number} /> : null}
          {node.source_inventory_batch_id && (
            <span className="font-mono text-[11px] text-[var(--text-muted)]">
              batch {node.source_inventory_batch_id}
            </span>
          )}
          {node.producer_job_card_id != null && (
            <span className="text-[var(--text-muted)]">· JC {node.producer_job_card_id}</span>
          )}
        </li>
      ))}
    </ol>
  );
}

// ── Read-only tabs ────────────────────────────────────────────────────────

function Panel({ children, title, action }: { children: React.ReactNode; title?: string; action?: React.ReactNode }) {
  // Padding scales with viewport so mobile doesn't waste ~40 % of width
  // on chrome; overflow-x-hidden is the no-horizontal-scroll guarantee
  // — any rogue inner grid that overflows gets clipped instead of
  // forcing the page to scroll sideways.
  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] p-3 sm:p-4 lg:p-5 mb-4 overflow-x-hidden">
      {title || action ? (
        <div className="flex items-center justify-between mb-3 gap-2">
          {title ? <h3 className="text-[12px] uppercase tracking-wide font-semibold text-[var(--text-secondary)] truncate">{title}</h3> : <span />}
          {action ?? null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

function KV({ label, value, mono }: { label: React.ReactNode; value: React.ReactNode; mono?: boolean }) {
  // label accepts ReactNode so callers can render multi-line labels
  // (e.g. "Process Loss" with a smaller "incl. wastage" subline) without
  // truncating critical context. The `truncate` on the value keeps
  // overlong numeric strings from forcing horizontal scroll on mobile.
  return (
    <div className="min-w-0">
      <div className="uppercase tracking-wide font-semibold text-[var(--text-muted)] text-[10px]">{label}</div>
      <div className={`text-[13px] text-[var(--text-primary)] truncate ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return <p className="text-[12px] text-[var(--text-muted)] italic">{children}</p>;
}

// Create-WIP operation checklist (Slice 2). Shown only on a Create-WIP stage
// (stage_bucket === 'Create WIP'); hidden on inline (Sorting) and terminal
// (Final FG / Packaging) stages. Lists the practical operation for this stage
// and the raw process step(s) that fold into it (combine-aware via the chain),
// for the operator to confirm. Local tick state (confirmation aid).
function CreateWipChecklist({ detail, chain }: { detail: JobCardDetail; chain: ChainStep[] }) {
  const [ticked, setTicked] = useState<Record<number, boolean>>({});

  // Gate on the SERVER's truth first: this JC must be a genuine WIP/SFG producer
  // (output_kind), mirroring the Boxes producer test. This avoids a false
  // positive for the real "X (Bulk Packaging" tokens, which the client classifier
  // reads as a transform but the backend treats as a terminal FG (output_kind='FG').
  const isProducer = ["SFG", "WIP"].includes((detail.output_kind ?? "").toUpperCase());

  const { myClass, items } = useMemo(() => {
    const names = chain.map((c) => c.process_name);
    const classes = classifySteps(names);
    const idx = chain.findIndex((c) => c.job_card_id === detail.job_card_id);
    const mc = idx >= 0 ? classes[idx] : classifyProcess(detail.process_name);
    // Raw chain steps that fold into THIS practical operation (e.g. Roasting +
    // Flavouring → "Roast & Flavour/Salt"); fall back to this JC's own step.
    // Keyed by job_card_id so duplicate process_names don't collide.
    let composed: { id: number; name: string }[] =
      idx >= 0 && mc.practicalOperation
        ? chain
            .filter((c, i) => classes[i].practicalOperation === mc.practicalOperation
                              && classes[i].stageBucket === STAGE_CREATE_WIP && !!c.process_name)
            .map((c) => ({ id: c.job_card_id, name: c.process_name as string }))
        : [];
    if (composed.length === 0 && detail.process_name) {
      composed = [{ id: detail.job_card_id, name: detail.process_name }];
    }
    return { myClass: mc, items: composed };
  }, [chain, detail.job_card_id, detail.process_name]);

  if (!isProducer || myClass.stageBucket !== STAGE_CREATE_WIP) return null;

  return (
    <Panel title={`Create-WIP operation: ${myClass.practicalOperation ?? "—"}`}>
      <p className="text-[12px] text-[var(--text-secondary)] mb-2">
        Confirm the practical operation(s) combined at this stage before recording output.
      </p>
      <div className="space-y-1">
        {items.map((it) => (
          <label key={it.id} className="flex items-center gap-2 text-[13px] text-[var(--text-primary)]">
            <input
              type="checkbox"
              checked={!!ticked[it.id]}
              onChange={(e) => setTicked((p) => ({ ...p, [it.id]: e.target.checked }))}
            />
            {it.name}
          </label>
        ))}
      </div>
    </Panel>
  );
}

function OverviewTab({ detail, chain, onReload }: { detail: JobCardDetail; chain: ChainStep[]; onReload: () => void }) {
  const sec = detail.section_1_product ?? {};
  const completedSteps = chain.filter((c) => c.status === "completed" || c.status === "closed").length;
  return (
    <>
      <CreateWipChecklist detail={detail} chain={chain} />
      <Panel title="Sales order">
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3">
          <KV label="SO #" value={sec.so_number || detail.primary_so_number || "—"} />
          <KV label="SO Date" value={sec.so_date || "—"} />
          <KV label="Business unit" value={sec.business_unit || "—"} />
          <KV label="BOM version" value={sec.bom_version != null ? String(sec.bom_version) : "—"} />
        </dl>
      </Panel>
      <Panel title="Stage progress">
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3">
          <KV label="This step" value={`Step ${detail.step_number ?? "—"} · ${detail.process_name || "—"}`} />
          <KV label="Stage" value={detail.stage || "—"} />
          <KV label="Chain progress" value={`${completedSteps} / ${chain.length} completed`} />
          <KV label="Time on JC" value={detail.total_time_min ? `${detail.total_time_min} min` : "—"} />
        </dl>
      </Panel>
      <TeamPanel detail={detail} onReload={onReload} />
    </>
  );
}

// Mirrors OverviewFragment's Team card + Assign/Edit dialog. The button
// disappears outside the assignable status range (unlocked / assigned /
// material_received / in_progress) and the title flips between
// "Assign Team" and "Edit Team" depending on whether a leader is already
// recorded. POSTs {team_leader, team_members[]} to /job-cards-v2/{id}/assign.
function TeamPanel({ detail, onReload }: { detail: JobCardDetail; onReload: () => void }) {
  const status = detail.status ?? "";
  const canAssign =
    status === "unlocked" || status === "assigned" ||
    status === "material_received" || status === "in_progress";
  const hasTeam = !!(detail.assigned_to_team_leader && detail.assigned_to_team_leader.trim());
  const buttonLabel = hasTeam ? "Edit Team" : "Assign Team";

  const [open, setOpen] = useState(false);
  const [leader, setLeader] = useState(detail.assigned_to_team_leader ?? "");
  const [members, setMembers] = useState<string[]>(detail.team_members ?? []);
  const [pending, setPending] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  // Re-sync local state when the detail reloads (e.g. after a successful
  // POST /assign refetches the JC). Deferred past the synchronous effect
  // body — the react-hooks/set-state-in-effect rule (correctly) flags an
  // immediate setState as a cascading render.
  useEffect(() => {
    queueMicrotask(() => {
      setLeader(detail.assigned_to_team_leader ?? "");
      setMembers(detail.team_members ?? []);
    });
  }, [detail.assigned_to_team_leader, detail.team_members]);

  function addPending() {
    // Mirror the Android chip input: a comma-separated paste like
    // "asha, bilal, charu" turns into three chips, not one giant chip.
    const parts = pending.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) setMembers((m) => [...m, ...parts]);
    setPending("");
  }

  function removeMember(idx: number) {
    setMembers((m) => m.filter((_, i) => i !== idx));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);
    const trimmedLeader = leader.trim();
    if (!trimmedLeader) {
      setFeedback({ kind: "err", msg: "Team leader is required." });
      return;
    }
    // Drain any pending name the operator typed but didn't press
    // Enter / comma on — Android does the same to avoid silently dropping it.
    const trailing = pending.trim();
    const finalMembers = trailing ? [...members, trailing] : members;

    setSubmitting(true);
    try {
      const res = await apiFetch(`/api/v1/production/job-cards-v2/${detail.job_card_id}/assign`, {
        method: "PUT",
        body: JSON.stringify({
          team_leader: trimmedLeader,
          team_members: finalMembers.length > 0 ? finalMembers : null,
        }),
      });
      if (!res.ok) {
        let txt: string;
        try { txt = await res.text(); } catch { txt = `HTTP ${res.status}`; }
        throw new Error(txt || `HTTP ${res.status}`);
      }
      setFeedback({ kind: "ok", msg: hasTeam ? "Team updated." : "Team assigned." });
      setOpen(false);
      setPending("");
      onReload();
    } catch (err) {
      setFeedback({ kind: "err", msg: friendlyApiError(err) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Panel
      title="Team"
      action={
        canAssign ? (
          <button
            type="button"
            onClick={() => { setOpen((v) => !v); setFeedback(null); }}
            className="h-7 px-3 rounded-[2px] text-[12px] font-semibold border bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white"
          >
            {open ? "Cancel" : buttonLabel}
          </button>
        ) : null
      }
    >
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3 mb-3">
        <KV label="Team leader" value={detail.assigned_to_team_leader || "—"} />
        <KV
          label="Team members"
          value={detail.team_members && detail.team_members.length > 0 ? detail.team_members.join(", ") : "—"}
        />
        <KV label="Started" value={fmtDateTime(detail.start_time)} />
        <KV label="Ended" value={fmtDateTime(detail.end_time)} />
      </dl>

      {open ? (
        <form onSubmit={onSubmit} className="border-t border-[var(--aws-border)] pt-3 mt-2">
          <h4 className="text-[13px] font-semibold text-[var(--text-primary)] mb-3">
            {hasTeam ? "Edit Team" : "Assign Team"}
          </h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
            <FormText label="Team leader" value={leader} onChange={setLeader} disabled={submitting} placeholder="Leader's full name" />
            <div>
              <FormLabel>Add team member</FormLabel>
              <div className="flex gap-2">
                <input
                  type="text"
                  className={inputCls}
                  value={pending}
                  onChange={(e) => setPending(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      addPending();
                    }
                  }}
                  disabled={submitting}
                  placeholder="Name, then Enter or comma"
                />
                <button
                  type="button"
                  onClick={addPending}
                  disabled={submitting || !pending.trim()}
                  className="h-8 px-3 text-[12px] font-semibold rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] disabled:opacity-50"
                >
                  Add
                </button>
              </div>
            </div>
          </div>
          {members.length > 0 ? (
            <div className="flex flex-wrap gap-2 mb-3">
              {members.map((m, i) => (
                <span key={i} className="inline-flex items-center gap-1 bg-[#eaf3ff] border border-[#bbd9f3] text-[#9a393e] text-[12px] rounded-full px-2 py-0.5">
                  {m}
                  <button
                    type="button"
                    onClick={() => removeMember(i)}
                    disabled={submitting}
                    className="ml-1 leading-none hover:text-[var(--aws-error)]"
                    aria-label={`Remove ${m}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="text-[12px] text-[var(--text-muted)] italic mb-3">No members added yet.</p>
          )}
          <FormFooter feedback={feedback} submitting={submitting} submitLabel={hasTeam ? "Save Changes" : "Assign"} />
        </form>
      ) : null}
    </Panel>
  );
}

// Materials + Shifts tabs intentionally absent — Android has no equivalents.
// RM/PM info lives inside Accounting (BOM articles); the shift timer lives
// in the header time strip / overflow actions.

// ── Remarks tab — list + add ──────────────────────────────────────────────
//
// Mirrors RemarksFragment on Android: shows every annexure_e remark and lets
// the operator append a new one. v2 backend takes { remark_type, content,
// recorded_by? } on POST /remarks. remark_type is one of:
//   observation / deviation / corrective_action
// (Same enum as the Android RemarkRequest model — server-enforced.)

const REMARK_TYPES: { value: string; label: string }[] = [
  { value: "observation",        label: "Observation" },
  { value: "deviation",          label: "Deviation" },
  { value: "corrective_action", label: "Corrective action" },
];

function RemarksTab({ detail, onReload }: { detail: JobCardDetail; onReload: () => void }) {
  const rows = detail.annexure_e_remarks ?? [];
  const [remarkType, setRemarkType] = useState<string>("observation");
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  // C3: lock gate. /remarks 409s when JC is locked — disable inputs + submit.
  // R10 — also gated by lifecycle: no remarks until START is clicked.
  const lock = useLockState(detail);
  const lifecycleLocked = isLifecycleLocked(detail.status);
  const inputsDisabled = submitting || lock.isLocked || lifecycleLocked;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);
    if (!content.trim()) {
      setFeedback({ kind: "err", msg: "Remark content is required." });
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch(`/api/v1/production/job-cards-v2/${detail.job_card_id}/remarks`, {
        method: "POST",
        body: JSON.stringify({ remark_type: remarkType, content: content.trim() }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setFeedback({ kind: "ok", msg: "Remark added." });
      setContent("");
      onReload();
    } catch (e2) {
      setFeedback({ kind: "err", msg: e2 instanceof Error ? e2.message : "Failed to add remark." });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Panel title={`Remarks · ${rows.length}`}>
        {rows.length === 0 ? (
          <EmptyHint>No remarks recorded yet.</EmptyHint>
        ) : (
          <RowTable
            rows={rows}
            columns={[
              { key: "recorded_at",  label: "When", render: (v) => fmtDateTime(String(v ?? "")), hideBelow: "sm" },
              { key: "remark_type",  label: "Type", render: (v) => String(v ?? "").replace(/_/g, " "), hideBelow: "sm" },
              { key: "content",      label: "Content" },
              { key: "recorded_by",  label: "By", hideBelow: "md" },
            ]}
          />
        )}
      </Panel>
      <Panel title="Add remark">
        <LockBanner
          isLocked={lock.isLocked}
          lockedReason={lock.lockedReason}
          status={lock.status}
          jcId={detail.job_card_id}
          // C3-H1 — clicking the banner CTA runs the same prompts +
          // PUT /force-unlock the page-header OverflowMenu uses.
          onForceUnlockClick={() => void runForceUnlockJc(
            detail.job_card_id,
            userStore.load()?.full_name ?? "",
            onReload,
          )}
        />
        <form onSubmit={onSubmit}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
            <FormSelect label="Type" value={remarkType} onChange={setRemarkType} disabled={inputsDisabled} options={REMARK_TYPES} />
          </div>
          <FormText label="Content" value={content} onChange={setContent} disabled={inputsDisabled} />
          {/* C3-MED-6 — disable Save when lock OR submit is in flight. */}
          <FormFooter feedback={feedback} submitting={submitting} submitLabel="Add remark" disabled={inputsDisabled} />
        </form>
      </Panel>
    </>
  );
}

// Per the 2026-05 ops decision (see SignoffsFragment docstring), only the
// Production Head sign-off gates JC close. Floor In-Charge and QC Inspector
// roles still exist server-side but neither is collected here. The Sign
// button is gated by JC status: disabled until "completed", hidden once
// already signed.
const SIGNOFF_ROLE = "production_head";

function SignOffsTab({ detail, onReload }: { detail: JobCardDetail; onReload: () => void }) {
  const rows = detail.sign_offs ?? [];
  // W3-MED-4 — sort the production-head candidates by signed_at DESC,
  // secondary by sign_off_id, before picking the head row. Same rationale
  // as qcSignOff in QualityTab: a re-signed JC otherwise surfaced the OLD
  // signature.
  const headCandidates = rows.filter((r) => {
    const role = String(r["role"] ?? "");
    // Match the canonical role first, then the legacy slot names that some
    // older JCs were signed under (production_manager / warehouse_incharge),
    // mirroring Section6Signoffs.getProductionHead on Android.
    return role === SIGNOFF_ROLE || role === "production_manager" || role === "warehouse_incharge";
  });
  const headSorted = [...headCandidates].sort((a, b) => {
    const at = String(a["signed_at"] ?? "");
    const bt = String(b["signed_at"] ?? "");
    if (at !== bt) return at < bt ? 1 : -1;
    const aid = Number(a["sign_off_id"] ?? 0);
    const bid = Number(b["sign_off_id"] ?? 0);
    return bid - aid;
  });
  const headEntry = headSorted[0];
  const signedBy = headEntry ? String(headEntry["signed_by"] ?? "") : "";
  const signedAt = headEntry ? String(headEntry["signed_at"] ?? "") : "";
  const isSigned = !!signedBy.trim();
  const status = detail.status ?? "";
  const canSign = status === "completed";

  // C1 (Wave 4) — useMe() so the cached name re-renders the form when
  // /me refreshes (admin renamed the operator, etc.).
  const me = useMe();
  const defaultName = me?.full_name?.trim() ?? "";

  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  async function promptAndSign() {
    const name = window.prompt("Sign off as Production Head — your name:", defaultName);
    if (name == null) return;
    if (!name.trim()) {
      setFeedback({ kind: "err", msg: "Name is required." });
      return;
    }
    setSubmitting(true);
    setFeedback(null);
    try {
      const res = await apiFetch(`/api/v1/production/job-cards-v2/${detail.job_card_id}/sign-off`, {
        method: "POST",
        // SignOffRequest field is `signed_by_name` (NOT `signed_by`) — backend
        // ignores unknown fields silently, so sending the wrong key would
        // discard the operator's typed name and fall back to the JWT user.
        body: JSON.stringify({ role: SIGNOFF_ROLE, signed_by_name: name.trim() }),
      });
      if (!res.ok) {
        let txt: string;
        try { txt = await res.text(); } catch { txt = `HTTP ${res.status}`; }
        throw new Error(txt || `HTTP ${res.status}`);
      }
      setFeedback({ kind: "ok", msg: "Signed." });
      onReload();
    } catch (err) {
      setFeedback({ kind: "err", msg: friendlyApiError(err) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Panel title="Production Head">
        <div
          className={[
            "rounded-md border p-4",
            isSigned ? "bg-[#eaf6ed] border-[#b6dbb1]" : "bg-[var(--surface-subtle)] border-[var(--aws-border)]",
          ].join(" ")}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              {isSigned ? (
                <>
                  <div className="text-[14px] font-semibold text-[var(--text-success)]">{signedBy}</div>
                  {signedAt ? (
                    <div className="text-[11px] text-[var(--text-secondary)] mt-0.5">Signed {fmtDateTime(signedAt)}</div>
                  ) : null}
                </>
              ) : (
                <>
                  <div className="text-[14px] font-semibold text-[var(--text-secondary)]">Pending sign-off</div>
                  <div className="text-[11px] text-[var(--text-muted)] mt-0.5">
                    {canSign
                      ? "Production has been completed — ready to sign."
                      : "Production must be completed before sign-off."}
                  </div>
                </>
              )}
            </div>
            {!isSigned ? (
              // C10 (Wave 4) — Sign-off via ActionButton. canSign already
              // encodes status === "completed"; we keep that as the
              // disabled gate so the button stays visible (but inert) when
              // production hasn't completed yet.
              <ActionButton
                busy={submitting}
                busyLabel="Signing…"
                disabled={!canSign}
                onClick={promptAndSign}
              >
                Sign
              </ActionButton>
            ) : null}
          </div>
        </div>
        {feedback ? (
          <p className={["mt-3 text-[12px]", feedback.kind === "ok" ? "text-[var(--text-success)]" : "text-[var(--aws-error)]"].join(" ")}>
            {feedback.msg}
          </p>
        ) : null}
      </Panel>

      {rows.length > 0 ? (
        <Panel title={`All sign-offs · ${rows.length}`}>
          <RowTable
            rows={rows}
            columns={[
              { key: "role",      label: "Role" },
              { key: "signed_by", label: "Signed by" },
              { key: "signed_at", label: "Signed at", render: (v) => fmtDateTime(String(v ?? "")), hideBelow: "sm" },
              { key: "notes",     label: "Notes", hideBelow: "md" },
            ]}
          />
        </Panel>
      ) : null}
    </>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
//  ACCOUNTING TAB — mirrors OutputAccountingFragment exactly.
//
//  Single Save Output POST → /job-cards-v2/{id}/outputs with body shape from
//  OutputV2Request.java:
//    fg_actual_kg, fg_actual_units, fg_expected_kg, fg_expected_units,
//    rm_consumed[], pm_consumed[], process_loss_kg, byproducts[],
//    balance_materials[]
//
//  Layout:
//    Card 1 (FG Output) — expected (RO), RM issued (RO), actual (units/kg),
//                         consumption (one input per RM+PM BOM line),
//                         rejection rows (dynamic, "+ Add another"),
//                         process loss + computed loss %, extra-giveaway
//                         (final stage only).
//    Card 2 (Balance Material) — one row per BOM article, defaults to 0.
//    Card 3 (Accounting Summary) — read-only reconciliation.
// ═════════════════════════════════════════════════════════════════════════════

function AccountingTab({ detail, onReload }: { detail: JobCardDetail; onReload: () => void }) {
  // C3: lock gate. When isLocked, every operational input + the SAVE OUTPUT
  // button below take `disabled = submitting || lock.isLocked`. The save
  // path remains untouched — if a stale form is somehow submitted, the
  // server still 409s and we surface the message via the existing feedback
  // pipeline.
  const lock = useLockState(detail);

  // ── Stage 3: per-batch form binding ─────────────────────────────────
  // Fetches all batches for this JC so the BatchSelector dropdown can
  // populate (and so we can resolve the default selected batch when the
  // operator lands).  When the user picks a different batch, the
  // *FromServer memos below re-filter and the resync effect repopulates
  // every input — the form becomes a view onto that batch's persisted
  // accounting state.
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [batchesLoading, setBatchesLoading] = useState(false);
  // R10 — fetch helper extracted so user-initiated batch actions
  // (doOpenBatch, BatchCloseModal save) can refetch deterministically
  // without depending on the 60s auto-poll's re-render cascade. The
  // previous [detail] dependency caused every auto-poll to refetch
  // batches → new array reference → perBatchSummaries recompute →
  // collapsibles flash + auto-pick effect re-evaluate → silent
  // selectedBatchId switches. Deps below stay on the JC id so a
  // navigation between JCs still loads fresh batches.
  const refetchBatches = useCallback(async (signal?: AbortSignal) => {
    setBatchesLoading(true);
    try {
      const res = await apiFetch(
        `/api/v1/production/job-cards-v2/${detail.job_card_id}/batches`,
        signal ? { signal } : undefined,
      );
      if (!res.ok) return;
      const j = (await res.json()) as { batches?: BatchRow[] };
      if (signal?.aborted) return;
      setBatches(Array.isArray(j.batches) ? j.batches : []);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      // Defensive: a 5xx (e.g. migration 038 missing) shouldn't break
      // the page.  The selector just shows an empty list and the
      // save path falls back to server-side default resolution.
    } finally {
      if (!signal?.aborted) setBatchesLoading(false);
    }
  }, [detail.job_card_id]);
  useEffect(() => {
    const ctrl = new AbortController();
    void refetchBatches(ctrl.signal);
    return () => ctrl.abort();
    // Re-fetch only when the JC id changes (navigation between JCs).
    // Auto-poll re-fetches detail every 60s but NOT batches — those
    // are refreshed explicitly by doOpenBatch + the close modal so
    // the perBatchSummaries memo / collapsibles don't flash on every
    // poll. refetchBatches() itself is stable as long as job_card_id
    // doesn't change.
  }, [detail.job_card_id, refetchBatches]);

  // Selected batch — drives form hydration + the POST body's batch_id.
  // Default to the highest-numbered open batch on first load; falls
  // back to the highest-numbered closed batch when no open exists; null
  // means "legacy / pre-batch" (form hydrates from rows with batch_id
  // IS NULL).
  const [selectedBatchId, setSelectedBatchId] = useState<number | null>(null);
  useEffect(() => {
    // Reset on detail reload so navigating between JCs doesn't carry
    // a stale selection across.  When batches arrive, pick the best
    // default and surface it.
    //
    // R10 — multi-open support: with concurrent open batches per JC
    // (one per production line / shift), opening a NEW batch must NOT
    // yank the operator off the one they were already typing into. So
    // auto-pick only fires when:
    //   1. selectedBatchId is null (initial load), OR
    //   2. the previously-selected batch is no longer in the list
    //      (was cancelled or removed).
    // Otherwise we keep the existing selection — the operator switches
    // batches manually via the dropdown when they're ready.
    if (batches.length === 0) {
      setSelectedBatchId(null);
      return;
    }
    if (selectedBatchId != null
        && batches.some((b) => b.batch_id === selectedBatchId)) {
      return;
    }
    const sorted = [...batches].sort((a, b) => b.batch_number - a.batch_number);
    const open = sorted.find((b) => b.status === "open");
    const fallback = sorted[0];
    setSelectedBatchId((open ?? fallback).batch_id);
  }, [batches, selectedBatchId]);

  const selectedBatch = useMemo(
    () => batches.find((b) => b.batch_id === selectedBatchId) ?? null,
    [batches, selectedBatchId],
  );
  // Stage 3: form is read-only when no batch picked, or the picked
  // batch is closed/cancelled.  Operator opens a fresh batch to record.
  const batchIsOpen = selectedBatch?.status === "open";

  // ── Stage 3 final: across-batches rollup ────────────────────────
  // Sums the per-batch summary columns from every batch row.  Read-
  // only display strip rendered inside the Batch Context panel so the
  // operator can see the JC's total throughput at a glance without
  // visiting the legacy BatchBand history table.
  const batchRollup = useMemo(() => {
    const num = (v: number | string | null | undefined): number => {
      if (v == null || v === "") return 0;
      const n = typeof v === "number" ? v : parseFloat(String(v));
      return Number.isFinite(n) ? n : 0;
    };
    let openCount = 0, closedCount = 0, cancelledCount = 0;
    let producedTotal = 0;
    let inputTotal = 0;
    let processLossTotal = 0;
    let egaTotal = 0;
    let controlSampleTotal = 0;
    // R10 — closed-only totals: feed the "remaining FG to produce"
    // hint on the next batch so the operator sees what's still owed,
    // not the JC's original planned figure. In-flight (open) batches
    // are excluded because their qty is still being typed; cancelled
    // batches are excluded because they never produced anything.
    let closedProducedKg = 0;
    let closedProducedUnits = 0;
    for (const b of batches) {
      if (b.status === "open") openCount += 1;
      else if (b.status === "closed") closedCount += 1;
      else cancelledCount += 1;
      producedTotal      += num(b.produced_qty_kg);
      inputTotal         += num(b.input_qty_kg);
      processLossTotal   += num(b.process_loss_kg);
      egaTotal           += num(b.extra_give_away_qty);
      controlSampleTotal += num(b.control_sample_kg);
      if (b.status === "closed") {
        closedProducedKg    += num(b.fg_actual_kg)    || num(b.produced_qty_kg);
        closedProducedUnits += num(b.fg_actual_units);
      }
    }
    return {
      total: batches.length,
      openCount, closedCount, cancelledCount,
      producedTotal, inputTotal, processLossTotal,
      egaTotal, controlSampleTotal,
      closedProducedKg, closedProducedUnits,
    };
  }, [batches]);

  // ── R10 — diff-on-save: dirty-section mask ──────────────────────────
  // The Edit Batch flow sends ONLY the sections the operator actually
  // touched, so unrelated fields on the server are never overwritten
  // with stale values. Each section's onChange call site invokes
  // markSectionDirty(section). doSave (in onSubmit further down) reads
  // dirtyMaskRef.current to decide which keys to include in the body.
  // Cleared on successful save AND on selectedBatchId change so
  // switching batches starts with a clean slate.
  //
  // Distinct from the form-level `markDirty()` further down — that
  // guard (formDirty ref) only blocks the auto-poll resync; this mask
  // controls which sections appear in the POST body.
  type DirtySection =
    | "output_qty"
    | "consumption"
    | "byproducts"
    | "balance"
    | "additives"
    | "control_sample";
  const dirtyMaskRef = useRef<Set<DirtySection>>(new Set());
  const markSectionDirty = useCallback((section: DirtySection) => {
    dirtyMaskRef.current.add(section);
  }, []);

  // ── Catalogue: every RM+PM article on the BOM. Primary source is the
  // backend's bom_lines (surfaced on every stage); fallback is the per-JC
  // indent rows (rm_indents + pm_indents) — same fallback the Java code
  // uses when bom_lines is empty.
  const articles: { bom_line_id: number | null; material_sku_name: string; item_type: string; uom: string }[] =
    useMemo(() => {
      const bom = detail.bom_lines ?? [];
      let out: { bom_line_id: number | null; material_sku_name: string; item_type: string; uom: string }[];
      if (bom.length > 0) {
        out = bom.map((b) => ({
          bom_line_id: b.bom_line_id,
          material_sku_name: b.material_sku_name,
          // W3-CRIT-1 — normalise to canonical UPPERCASE so the EGA-RM
          // filter (rmArticles) and the rm/pm consumption split below
          // both agree. A lowercase 'pm' from the backend used to fall
          // through the `=== 'PM'` test and silently route into
          // rm_consumed, corrupting the variance / cost split.
          item_type: (b.item_type || "RM").toUpperCase(),
          uom: b.uom || "kg",
        }));
      } else {
        out = [];
        for (const r of detail.rm_indents ?? []) out.push({ bom_line_id: r.bom_line_id ?? null, material_sku_name: r.material_sku_name ?? "Unknown", item_type: "RM", uom: r.uom || "kg" });
        for (const p of detail.pm_indents ?? []) out.push({ bom_line_id: p.bom_line_id ?? null, material_sku_name: p.material_sku_name ?? "Unknown", item_type: "PM", uom: p.uom || "kg" });
      }
      // Slice 4: bom_lines surface on every stage (same bom_id), so the SFG/WIP
      // input line also rides onto the SFG-PRODUCING stage (Create-WIP), where
      // the SFG is the OUTPUT — not a consumable input. Drop it from the
      // consumption catalogue on producer stages (output_kind SFG/WIP) so it
      // can't be typed, returned, or counted as input there. The consumer stage
      // (output_kind FG / pack-of-existing-SFG) keeps it. Mirrors the isProducer
      // test used by the Boxes/Create-WIP panels.
      const isProducer = ["SFG", "WIP"].includes((detail.output_kind ?? "").toUpperCase());
      if (isProducer) {
        out = out.filter((a) => a.item_type !== "SFG" && a.item_type !== "WIP");
      }
      return out;
    }, [detail]);

  // ── Initial state — R10 per-batch scoped.  Previously sourced from
  // section_5_output (JC-level), which carried Batch 1's saved FG /
  // process-loss values into Batch 2 the moment it was opened. The
  // operator opened a fresh batch and immediately saw 540 kg / 1.00 kg
  // already filled in — leading to the per-batch summary double-counting
  // FG and reporting nonsense Total losses.
  //
  // Resolution order per field:
  //   1. Closed batch: BatchRow snapshot (canonical, set on close).
  //   2. Open batch with saved output rows: latest job_card_output_v2
  //      row for THIS batch (preserves operator's typed value across
  //      reloads while the batch is still open).
  //   3. Freshly-opened batch / no batch selected: empty (operator
  //      enters fresh).
  // The legacy section_5_output fallback is kept only for pre-batch
  // JCs that never opened a batch row.
  // Consolidated batch-scoped FG / process-loss defaults. One useMemo
  // returning a struct keeps the React Compiler's memoization
  // preservation check happy (vs. three separate useMemos sharing the
  // same upstream refs).
  const batchScopedDefaults = useMemo(() => {
    const sec5 = detail.section_5_output;
    const sec5Kg    = sec5?.fg_actual_kg    != null ? String(sec5.fg_actual_kg)    : "";
    const sec5Units = sec5?.fg_actual_units != null ? String(sec5.fg_actual_units) : "";
    const sec5Loss  = sec5?.process_loss_kg != null ? String(sec5.process_loss_kg) : "";
    if (!selectedBatch) {
      return { fgKg: sec5Kg, fgUnits: sec5Units, loss: sec5Loss };
    }
    // Primary source: the BatchRow (job_card_batch_v2 view). For closed
    // batches this is the canonical snapshot; for open batches it's
    // typically null until close.
    let fgKg = selectedBatch.fg_actual_kg != null ? String(selectedBatch.fg_actual_kg) : "";
    let fgUnits = selectedBatch.fg_actual_units != null ? String(selectedBatch.fg_actual_units) : "";
    let loss = selectedBatch.process_loss_kg != null ? String(selectedBatch.process_loss_kg) : "";
    // Fallback: latest job_card_output_v2 row for THIS batch. Was
    // previously gated on `status === "open"` so closed batches with a
    // null BatchRow.process_loss_kg never recovered the value the output
    // detail row already had — symptom: form re-opens with an empty
    // Process Loss field even though the value persisted to DB. Two
    // scenarios make this necessary:
    //   (a) job_card_batch_v2 is a view over job_card_phase_v2 (migration
    //       036), and migration 038 (which extends the view with
    //       process_loss_kg / fg_actual_kg / fg_actual_units / etc.) may
    //       not be applied on every environment yet. The view then
    //       returns those columns as undefined.
    //   (b) close_batch was previously buggy on the sibling output INSERT
    //       (server_replica 9f14e47): output_v2.process_loss_kg defaulted
    //       to 0 even though batch_v2.process_loss_kg had the real value.
    //       Old closed rows still carry that divergence — the fallback
    //       now repairs the displayed value at read time without
    //       requiring a DB backfill.
    if (Array.isArray(detail.outputs)) {
      let latest: Record<string, unknown> | null = null;
      let latestId = -Infinity;
      for (const o of detail.outputs) {
        const row = o as Record<string, unknown>;
        const bid = row.batch_id;
        if (bid == null || Number(bid) !== selectedBatch.batch_id) continue;
        const oid = Number(row.output_id ?? 0);
        if (oid > latestId) {
          latest = row;
          latestId = oid;
        }
      }
      if (latest) {
        if (!fgKg    && latest.output_qty_kg    != null) fgKg    = String(latest.output_qty_kg);
        if (!fgUnits && latest.output_qty_units != null) fgUnits = String(latest.output_qty_units);
        if (!loss    && latest.process_loss_kg  != null) loss    = String(latest.process_loss_kg);
      }
    }
    return { fgKg, fgUnits, loss };
  }, [
    selectedBatch,
    detail.outputs,
    detail.section_5_output,
  ]);
  const fgKgFromServer    = batchScopedDefaults.fgKg;
  const fgUnitsFromServer = batchScopedDefaults.fgUnits;
  const lossFromServer    = batchScopedDefaults.loss;

  const [fgActualUnits, setFgActualUnits] = useState(fgUnitsFromServer);
  const [fgActualKg,    setFgActualKg]    = useState(fgKgFromServer);
  const [processLoss,   setProcessLoss]   = useState(lossFromServer);

  // formDirty guards the auto-poll / focus-refetch path: the page-level
  // window-focus listener + 60s visibility poll re-fetch the JC detail
  // for fresh lock-state. Each fetch rebuilds the *FromServer memos
  // below, which previously fired the resync effects and clobbered any
  // input the operator was mid-typing. The dirty flag lets us skip the
  // form-state portion of the resync while still letting the rest of
  // the page (lock banner, status badges, sign-offs, header KVs) update.
  //
  // useRef instead of useState — we don't want re-renders, we want a
  // read-during-effect sentinel. Cleared at the END of every successful
  // save handler, just before onReload() fires.
  const formDirty = useRef(false);
  const markDirty = useCallback(() => { formDirty.current = true; }, []);

  // Stage 3: switching batches is a deliberate user action that
  // *should* override the form-dirty guard.  If the operator has
  // unsaved typing, confirm before discarding.  Clearing formDirty
  // before setSelectedBatchId lets the existing resync useEffect
  // refresh the form to the new batch's persisted state.
  const changeBatch = useCallback((nextId: number | null) => {
    if (nextId === selectedBatchId) return;
    if (formDirty.current) {
      const ok = window.confirm(
        "You have unsaved changes on this batch. Discard and switch?",
      );
      if (!ok) return;
    }
    formDirty.current = false;
    setSelectedBatchId(nextId);
  }, [selectedBatchId]);

  // ── Admin override (closed-batch editing) ─────────────────────────
  // A closed batch is normally read-only.  Admins can flip this flag
  // to re-edit the output snapshot in-place; the save POSTs an
  // `admin_override: true` body which the server validates against
  // the caller's role before writing.  Reset whenever the operator
  // navigates to a different batch (so the override doesn't silently
  // leak across batches).
  const isAdmin = useIsAdmin();
  const [adminOverride, setAdminOverride] = useState(false);
  useEffect(() => {
    setAdminOverride(false);
    // R10 — switching batches resets BOTH dirty flags so an unrelated
    // batch's pending edits don't leak into the next one's save body.
    //
    // CRITICAL: formDirty.current must also be cleared here, not just
    // by the changeBatch dropdown handler. The auto-pick effect at
    // line ~2450 (which fires when a new batch is opened or the
    // batches array reshuffles) also mutates selectedBatchId — without
    // this reset, the form-state resync effects further down would see
    // formDirty=true and SKIP, leaving the previous batch's typed
    // values in scope. The next "Save Batch" click would then write
    // those stale values into the newly-selected batch_id, silently
    // corrupting per-batch data. dirtyMaskRef + formDirty MUST be
    // cleared together; the resync effects re-seed every visible field
    // from the server snapshot for the new batch.
    dirtyMaskRef.current.clear();
    formDirty.current = false;
  }, [selectedBatchId]);

  // ── Open / Close batch actions (moved up from BatchBand) ──────────
  // Buttons live alongside the selector in the Batch Context panel so
  // the operator's eye doesn't have to jump between sections.  The
  // legacy BatchBand inside AccountingSummaryCard keeps the history
  // table; its inline buttons hide when these are visible.
  const [batchActionBusy, setBatchActionBusy] = useState(false);
  const [batchActionMsg, setBatchActionMsg] = useState<
    { kind: "ok" | "err"; msg: string } | null
  >(null);
  const [closeBatchModal, setCloseBatchModal] = useState<BatchRow | null>(null);

  const doOpenBatch = useCallback(async () => {
    setBatchActionMsg(null);
    setBatchActionBusy(true);
    try {
      const res = await apiFetch(
        `/api/v1/production/job-cards-v2/${detail.job_card_id}/batches/open`,
        { method: "POST", body: JSON.stringify({}) },
      );
      if (!res.ok) {
        throw new Error(
          await readApiErrorMessage(res, `HTTP ${res.status}`),
        );
      }
      setBatchActionMsg({ kind: "ok", msg: "Batch opened." });
      // R10 — explicit refresh; the [detail.job_card_id]-only batches
      // effect won't pick up the new batch otherwise. Run both: the
      // parent reload refreshes the JC detail (consumption_lines etc.
      // for the new batch_id appear) and refetchBatches updates the
      // selector + per-batch summary list.
      await refetchBatches();
      onReload();
    } catch (e) {
      setBatchActionMsg({ kind: "err", msg: friendlyJobCardError(e) });
    } finally {
      setBatchActionBusy(false);
    }
  }, [detail.job_card_id, onReload, refetchBatches]);

  // Re-sync on detail reload. Skipped when the operator has unsaved
  // input (formDirty.current === true) so an auto-poll doesn't wipe the
  // form mid-entry. Save handlers reset formDirty before reload, so a
  // post-save reload resyncs cleanly.
  useEffect(() => {
    if (formDirty.current) return;
    queueMicrotask(() => {
      setFgActualKg(fgKgFromServer);
      setFgActualUnits(fgUnitsFromServer);
      setProcessLoss(lossFromServer);
    });
  }, [fgKgFromServer, fgUnitsFromServer, lossFromServer]);

  // EGA hydration — R10 per-batch scoped (was JC-level via
  // detail.accounting.extra_give_away_qty, which leaked Batch 1's
  // closure EGA into Batch 2's form when the operator opened a fresh
  // batch). Order:
  //   1. Closed batch: BatchRow snapshot (set on close).
  //   2. Open batch: the consolidated balance_materials row tagged
  //      with THIS batch_id and balance_type='extra_given'.
  //   3. Freshly-opened batch / no batch: empty.
  // Legacy JC-level fallback only when no batch is selected at all
  // (pre-batch JCs that never opened a batch row).
  const egaFromServer = useMemo(() => {
    if (selectedBatch?.extra_give_away_qty != null) {
      const v = Number(selectedBatch.extra_give_away_qty);
      if (Number.isFinite(v) && v > 0) return String(v);
    }
    if (selectedBatch != null) {
      const fromBal = (detail.balance_materials ?? []).find((b) => {
        if (b.balance_type !== "extra_given") return false;
        const bid = (b as Record<string, unknown>).batch_id;
        return bid != null && Number(bid) === selectedBatch.batch_id;
      });
      if (fromBal && fromBal.qty_kg != null && Number(fromBal.qty_kg) > 0) {
        return String(fromBal.qty_kg);
      }
      return "";
    }
    // Legacy fallback — pre-batch JCs only.
    const fromAcct = detail.accounting?.extra_give_away_qty;
    if (fromAcct != null && fromAcct !== "" && Number(fromAcct) > 0) {
      return String(fromAcct);
    }
    const fromBalLegacy = (detail.balance_materials ?? []).find(
      (b) => b.balance_type === "extra_given",
    );
    if (fromBalLegacy && fromBalLegacy.qty_kg != null && Number(fromBalLegacy.qty_kg) > 0) {
      return String(fromBalLegacy.qty_kg);
    }
    return "";
  }, [selectedBatch, detail.accounting?.extra_give_away_qty, detail.balance_materials]);
  const [extraGiveawayQty, setExtraGiveawayQty] = useState(egaFromServer);
  useEffect(() => {
    if (formDirty.current) return;
    queueMicrotask(() => {
      setExtraGiveawayQty(egaFromServer);
    });
  }, [egaFromServer]);

  // Per-line inputs re-hydrated from the saved detail, the same way the scalar
  // FG fields above are. Without this, a successful save followed by onReload()
  // left these inputs blank even though the values persisted — the operator
  // saw their Material Consumption / Balance / Rejection entries vanish on the
  // refresh. Derived with useMemo so the re-sync effect below only fires when
  // the server data actually changes (a fresh detail fetch), not per keystroke.
  // One consumption qty per BOM article (actual_consumed_qty); empty ⇒ not
  // recorded. One balance qty per BOM article (returned rows; defaults to 0 on
  // save when blank). Rejection rows = off-grade byproducts + control_sample.
  const consumptionFromServer = useMemo(
    () => consumptionStateFromDetail(detail.consumption_lines, selectedBatchId),
    [detail.consumption_lines, selectedBatchId],
  );
  // C3-MED-7 — track which keys have a saved consumption row on the
  // server so the VarianceChip can stay quiet when the operator has
  // typed nothing AND nothing's persisted yet (avoids the "BOM X kg ·
  // actual —" hint screaming on a fresh JC that hasn't started).
  const hasSavedConsumptionByKey = useMemo<Record<string, boolean>>(() => {
    const out: Record<string, boolean> = {};
    for (const k of Object.keys(consumptionFromServer)) {
      out[k] = consumptionFromServer[k]?.trim() !== "";
    }
    return out;
  }, [consumptionFromServer]);
  const balanceFromServer = useMemo(
    () => balanceStateFromDetail(detail.balance_materials, selectedBatchId),
    [detail.balance_materials, selectedBatchId],
  );
  const rejectionsFromServer = useMemo(
    () => rejectionsFromDetail(detail.byproducts, detail.balance_materials, selectedBatchId),
    [detail.byproducts, detail.balance_materials, selectedBatchId],
  );

  const [consumption, setConsumption] = useState<Record<string, string>>(consumptionFromServer);
  const [balance, setBalance] = useState<Record<string, string>>(balanceFromServer);
  // Operator-stated: keep an empty Off-Grade row visible by default so
  // the operator doesn't have to click "+ Add another" to start entering
  // a single off-grade record. If server-side rows exist, use those;
  // otherwise seed one blank row.
  const [rejections, setRejections] = useState<RejectionRow[]>(
    rejectionsFromServer.length > 0 ? rejectionsFromServer : [BLANK_REJECTION_ROW()],
  );

  // Additives — data-keeping rows that DO NOT participate in the
  // conservation identity. Server-side rows arrive on detail.additives
  // (added by jc_additives_v2). Default-seed a single blank row so the
  // operator can start typing without clicking "+ Add another".
  const additivesFromServer = useMemo<AdditiveRow[]>(
    () => additivesFromDetail(detail.additives, selectedBatchId),
    [detail.additives, selectedBatchId],
  );
  const [additives, setAdditives] = useState<AdditiveRow[]>(
    additivesFromServer.length > 0 ? additivesFromServer : [BLANK_ADDITIVE_ROW()],
  );

  // R10/C6 — dedicated QC Sample input. Wire value is always kg; the
  // displayUnit toggle is state-only and flips between kg ↔ g for the
  // input field. Saved as a byproducts row category='control_sample' on
  // submit (matches the backend save path unchanged).
  const controlSampleFromServer = useMemo(
    () => controlSampleFromDetail(detail.byproducts, detail.balance_materials, selectedBatchId),
    [detail.byproducts, detail.balance_materials, selectedBatchId],
  );
  const [controlSampleKg, setControlSampleKg] = useState<string>(controlSampleFromServer);
  const [qcSampleDisplayUnit, setQcSampleDisplayUnit] = useState<"kg" | "g">("kg");

  // R11/C7 — PM Variance categories (pm_torn etc.). Each maps to a
  // byproducts row with category=pm_* and uom=<chosen pcs uom>. Filtered
  // out of the generic rejections list by rejectionsFromDetail.
  const pmVarianceFromServer = useMemo(
    () => pmVarianceFromDetail(detail.byproducts, "PCS", selectedBatchId),
    [detail.byproducts, selectedBatchId],
  );
  const [pmVariance, setPmVariance] = useState<PmVarianceState>(pmVarianceFromServer);

  // Re-sync on detail reload. Deferred past the effect body so the
  // react-hooks/set-state-in-effect rule doesn't fire on the cascading
  // setStates (matches the FG-field effect above).
  useEffect(() => {
    // Same dirty-guard as the FG state effect above — skip the resync
    // when the operator is mid-entry so the auto-poll doesn't wipe
    // typed-but-unsaved consumption / off-grade / control-sample / PM
    // variance values.
    if (formDirty.current) return;
    queueMicrotask(() => {
      setConsumption(consumptionFromServer);
      setBalance(balanceFromServer);
      // Keep the default-blank-row behaviour on reload too — if the
      // server has nothing for off-grade, surface a single empty row.
      setRejections(
        rejectionsFromServer.length > 0
          ? rejectionsFromServer
          : [BLANK_REJECTION_ROW()],
      );
      setControlSampleKg(controlSampleFromServer);
      setPmVariance(pmVarianceFromServer);
      setAdditives(
        additivesFromServer.length > 0
          ? additivesFromServer
          : [BLANK_ADDITIVE_ROW()],
      );
    });
  }, [
    consumptionFromServer, balanceFromServer, rejectionsFromServer,
    controlSampleFromServer, pmVarianceFromServer, additivesFromServer,
  ]);

  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  // C3-H3 — server-canonical R9 row, populated after a successful save by
  // re-fetching GET /accounting. Preferred over detail.accounting (which
  // comes from the broader JC detail payload) when present because it
  // reflects post-save server math without waiting for the page-level
  // refetch to round-trip. Reset whenever the JC payload changes so a
  // navigation between JCs doesn't carry stale numbers across.
  const [serverAccounting, setServerAccounting] = useState<NonNullable<JobCardDetail["accounting"]> | null>(null);
  useEffect(() => {
    queueMicrotask(() => setServerAccounting(null));
  }, [detail.job_card_id]);
  const effectiveAccounting = serverAccounting ?? detail.accounting ?? null;

  // Helpers ─────────────────────────────────────────────────────────────────
  const expectedUnits = detail.section_1_product?.expected_units ?? null;
  const expectedKg    = detail.section_1_product?.batch_size_kg ?? null;
  const netWtPerUnit  = detail.section_1_product?.net_wt_per_unit_kg ?? null;

  // R10 — remaining FG to produce, net of what already-closed batches
  // booked. Once batch 1 closes with 500 kg of a 1000 kg JC, batch 2
  // should see "Expected 500 kg" not "Expected 1000 kg". Open batches
  // are excluded (their qty is still being typed); cancelled batches
  // are excluded (zero contribution). Falls back to the JC-level
  // expected when no batches have closed yet, and clamps at 0 so an
  // over-produced JC doesn't render a negative number.
  const remainingExpectedKg = useMemo(() => {
    if (expectedKg == null) return null;
    const remaining = Number(expectedKg) - batchRollup.closedProducedKg;
    return Math.max(0, remaining);
  }, [expectedKg, batchRollup.closedProducedKg]);
  const remainingExpectedUnits = useMemo(() => {
    if (expectedUnits == null) return null;
    const remaining = Number(expectedUnits) - batchRollup.closedProducedUnits;
    return Math.max(0, remaining);
  }, [expectedUnits, batchRollup.closedProducedUnits]);

  // RM Issued (kg): sum of rm_indents.issued_qty. Stages 2+ stay at 0
  // because RM is only issued on stage 1 — same accounting as the Android.
  const rmIssuedKg = useMemo(() => {
    return (detail.rm_indents ?? []).reduce((acc, r) => acc + num(String(r.issued_qty ?? 0)), 0);
  }, [detail.rm_indents]);

  // R10 — RM-only consumption total from the operator's typed Output &
  // Accounting form. Mirrors the rmConsumptionSum derivation inside
  // onSubmit + the BatchBand BatchCloseModal default; lifted here so the
  // Batch Context panel's Close Batch modal can pre-fill RM consumed
  // instead of leaving it blank. PM articles excluded because they
  // don't convert into FG mass (same rule as the Accounting Summary).
  const rmConsumedTypedKg = useMemo(() => {
    const byKey = new Map<string, typeof articles[number]>();
    for (const a of articles) {
      const key = a.bom_line_id != null ? `b${a.bom_line_id}` : `n${a.material_sku_name}`;
      byKey.set(key, a);
    }
    const isRmKey = (k: string) => {
      const a = byKey.get(k);
      return a ? (a.item_type || "").toUpperCase() !== "PM" : true;
    };
    return Object.entries(consumption).reduce(
      (s, [k, v]) => s + (isRmKey(k) ? num(v) : 0),
      0,
    );
  }, [articles, consumption]);

  // Per-BOM-line prescribed qty for the variance chip (qty only — no
  // cost). Mirrors the server computation in
  // server_replica/app/modules/production/services/jc_accounting_v2.py
  // (resolve_bom_multiplier + multiplier × quantity_per_unit).
  //
  // Multiplier source: FG ACTUAL output (live as the operator types),
  // falling back to FG planned/expected when no actual is entered yet.
  // Variance is meaningful against the qty you ACTUALLY produced — "for
  // that output, BOM says you should have used X, you used Y".
  //
  // Units-vs-kg basis: all_sku.uom is the per-unit kg of the FG SKU.
  // When uom != 1.000 (per-piece SKU, e.g. 500 gm pouch with uom = 0.5),
  // bom_line.quantity_per_unit is interpreted as 'per FG unit' and the
  // multiplier is FG units. When uom == 1.000 (1 piece = 1 kg) or uom is
  // missing, units and kg are numerically equal, so either yields the
  // same prescribed qty; we use kg as the back-compat default.
  const bomPrescribedByKey = useMemo<Record<string, number | null>>(() => {
    const out: Record<string, number | null> = {};
    const skuUom = netWtPerUnit != null ? Number(netWtPerUnit) : null;
    const plannedKg = num(String(detail.planned_qty_kg ?? 0));
    const plannedUnits =
      expectedUnits != null
        ? Number(expectedUnits)
        : skuUom != null && skuUom > 0
        ? plannedKg / skuUom
        : null;
    // Prefer actual FG output when the operator has entered/saved any;
    // fall back to planned when fresh.
    const actualKg    = num(fgActualKg);
    const actualUnits = num(fgActualUnits);
    const effKg    = actualKg    > 0 ? actualKg    : plannedKg;
    const effUnits = actualUnits > 0 ? actualUnits : plannedUnits;
    // uom != 1 AND we have a units value → per-FG-unit basis. Else fall
    // back to per-kg-of-FG basis.
    const usesUnits =
      skuUom != null
      && skuUom > 0
      && Math.abs(skuUom - 1.0) > 1e-9
      && effUnits != null
      && effUnits > 0;
    const multiplier = usesUnits ? (effUnits as number) : effKg;
    for (const bl of detail.bom_lines ?? []) {
      const key = bl.bom_line_id != null ? `b${bl.bom_line_id}` : `n${bl.material_sku_name}`;
      const qpu = bl.quantity_per_unit != null ? Number(bl.quantity_per_unit) : null;
      if (qpu == null || !Number.isFinite(qpu) || multiplier <= 0) {
        out[key] = null;
        continue;
      }
      out[key] = qpu * multiplier;
    }
    return out;
  }, [
    detail.bom_lines,
    detail.planned_qty_kg,
    netWtPerUnit,
    expectedUnits,
    fgActualKg,
    fgActualUnits,
  ]);

  // Auto-fill kg when the operator enters units (Android: autoCalcFgActualKg).
  function onChangeUnits(v: string) {
    markDirty();
    markSectionDirty("output_qty");
    setFgActualUnits(v);
    if (netWtPerUnit && netWtPerUnit > 0) {
      const u = parseInt(v, 10);
      if (Number.isFinite(u)) setFgActualKg((u * netWtPerUnit).toFixed(2));
    }
  }
  // R10 — bidirectional FG kg ↔ FG units auto-calc. The units → kg
  // direction lives in onChangeUnits above; this is the mirror image
  // (operator types kg, units back-fill via kg / netWtPerUnit, rounded
  // to the nearest whole unit). Mirrors Android's autoCalcFgActualUnits.
  // No-op when netWtPerUnit is missing or zero (per-piece SKUs without
  // a configured unit weight just stay manual).
  const onChangeFgActualKg = useCallback((v: string) => {
    markSectionDirty("output_qty");
    setFgActualKg(v);
    if (netWtPerUnit && netWtPerUnit > 0) {
      const kg = parseFloat(v);
      if (Number.isFinite(kg)) {
        setFgActualUnits(String(Math.round(kg / netWtPerUnit)));
      }
    }
  }, [markSectionDirty, netWtPerUnit]);
  const onChangeProcessLoss = useCallback((v: string) => {
    markSectionDirty("output_qty");
    setProcessLoss(v);
  }, [markSectionDirty]);

  // Operator-stated: Process Loss % should read off FG Actual Kg, not
  // rm_issued + carried_in. The previous total-input denominator went to
  // "—" whenever the JC had no RM indent (common when testing), which the
  // operator read as "the field isn't calculating". Anchoring on the FG
  // output gives a meaningful loss % the moment the operator records FG
  // qty, regardless of upstream indent state.
  const processLossPct = useMemo(() => {
    const pl = num(processLoss);
    const fgKg = num(fgActualKg);
    if (fgKg <= 0 || !pl) return null;
    return (pl / fgKg) * 100;
  }, [processLoss, fgActualKg]);

  // Accounting Summary computed totals ─────────────────────────────────────
  // C3-H3 — rewrites the live preview to byte-for-byte match the server
  // formulas in jc_accounting_v2.save_accounting:
  //
  //   total_input        = rm_issued_kg + carried_in_kg     (NOT rm alone)
  //   process_loss_pct   = process_loss / total_input * 100
  //   ega_loss_pct       = ega_loss / total_input * 100     (from /accounting)
  //   invisible_loss_pct = process_loss_pct + ega_loss_pct
  //   total_loss_pct     = (process + ega + rejection + offgrade) / total_input * 100
  //                        (NOTE: NO wastage, NO balance, NO control_sample)
  //
  // Balance-tolerance also comes from the server now (C3-CRIT-2): the
  // backend exposes accounting.allowed_balance_tolerance_pct (BOM-header
  // setting, default 0.001 = 0.1 %). The hardcoded 0.5 % the previous
  // implementation used was wrong by 5×. BALANCE_TOLERANCE_KG (50 g)
  // remains the absolute floor for very small batches.
  //
  // Two-phase rendering:
  //   1. Before a save, the preview reproduces these formulas locally
  //      (operator sees a faithful estimate as they type).
  //   2. After a save, AccountingTab refetches GET /accounting and we
  //      prefer the server's authoritative R9 row whenever it's present
  //      in detail.accounting.
  const tolerancePctFromServer =
    effectiveAccounting?.allowed_balance_tolerance_pct != null
      ? Number(effectiveAccounting.allowed_balance_tolerance_pct)
      : null;
  // Server stores tolerance as a fraction (0.001 = 0.1 %). Fall back to
  // 0.001 when the backend hasn't surfaced it yet; convert to %-units for
  // comparison against balanceDiffPct.
  const allowedToleranceFrac =
    tolerancePctFromServer != null && Number.isFinite(tolerancePctFromServer)
      ? tolerancePctFromServer
      : 0.001;
  const allowedTolerancePctUnits = allowedToleranceFrac * 100;

  const carriedInKg = num(String(effectiveAccounting?.carried_in_kg ?? detail.carried_qty_kg ?? 0));
  const egaLossPctFromServer =
    effectiveAccounting?.ega_loss_pct != null ? num(String(effectiveAccounting.ega_loss_pct)) : 0;

  const summary = useMemo(() => {
    // R10/C6 — control_sample is no longer a rejection category; it has its
    // own input. Wastage is still a rejection-category bucket.
    const rejTotal = rejections.reduce(
      (acc, r) => acc + (r.category !== "wastage" ? num(r.qty) : 0),
      0,
    );
    const ctrlSample = num(controlSampleKg);
    const wastageTotal = rejections.reduce(
      (acc, r) => acc + (r.category === "wastage" ? num(r.qty) : 0),
      0,
    );
    const balTotal = Object.values(balance).reduce((acc, v) => acc + num(v), 0);
    const offgradeTotal = rejTotal; // off-grade = non-control, non-wastage rejections
    const fgOutKg = num(fgActualKg);
    const rawProcessLoss = num(processLoss);
    // Operator-stated: wastage rolls into Process Loss as a display
    // aggregate. Storage stays split (wastage_qty + process_loss_qty
    // remain separate columns server-side for the conservation
    // identity), but the summary card shows a single combined number.
    const lossKg = rawProcessLoss + wastageTotal;

    // total_input — the conservation denominator. Canonical source is
    // (rm_issued + carried_in) per the server. But operators frequently
    // skip the indent flow and type consumption directly into the
    // Material Consumption grid, leaving rm_issued = 0 → the previous
    // code surfaced "—" for Is Balanced and Balance Difference.
    //
    // Fallback: when canonical input is 0, sum the typed RM consumption
    // as the stand-in. Operator-stated rule: PM rows are packaging —
    // they don't convert into FG mass, so they MUST NOT count toward
    // the conservation identity. Only item_type='rm' lines are summed.
    const articleByKey = new Map<string, typeof articles[number]>();
    for (const a of articles) {
      const key = a.bom_line_id != null
        ? `b${a.bom_line_id}`
        : `n${a.material_sku_name}`;
      articleByKey.set(key, a);
    }
    const isRmKey = (key: string) => {
      const a = articleByKey.get(key);
      // Defensive: when an article isn't found in the BOM catalog,
      // treat as RM (older JCs may carry off-BOM rows). PM-tagged rows
      // are the only ones explicitly excluded.
      if (!a) return true;
      return (a.item_type || "").toUpperCase() !== "PM";
    };
    const rmConsumptionTotal = Object.entries(consumption).reduce(
      (acc, [key, v]) => acc + (isRmKey(key) ? num(v) : 0),
      0,
    );
    const canonicalInput = rmIssuedKg + carriedInKg;
    const totalInput = canonicalInput > 0 ? canonicalInput : rmConsumptionTotal;
    const inputBasis: "indent" | "consumption" | "none" =
      canonicalInput > 0 ? "indent" : rmConsumptionTotal > 0 ? "consumption" : "none";

    // EGA — operator's typed value is the truth source while the
    // accounting summary row remains absent (PUT /accounting/summary
    // isn't wired into Save Output yet, so server-side ega_loss_pct is
    // NULL on most JCs). Fall back to the server projection only when
    // the operator hasn't typed an EGA yet.
    const egaTypedKg = num(extraGiveawayQty);
    const egaAbsKg =
      egaTypedKg > 0
        ? egaTypedKg
        : (egaLossPctFromServer > 0 && totalInput > 0
            ? (egaLossPctFromServer / 100) * totalInput
            : 0);

    // Conservation identity. EGA was previously missing from the
    // output side, so a JC with EGA = 3 kg silently looked "balanced"
    // even when the typed-but-unsaved EGA value exceeded the 0.1 %
    // tolerance. Adding it here closes the gap. Raw process_loss +
    // wastage still tracked separately so the math matches the server
    // byte-for-byte; the display aggregate (`lossKg`) doesn't
    // double-count.
    const totalAccounted = fgOutKg + rawProcessLoss + balTotal + offgradeTotal + ctrlSample + wastageTotal + egaAbsKg;
    const balanceDiff = totalInput > 0 ? totalInput - totalAccounted : null;
    const balanceDiffPct = balanceDiff != null && totalInput > 0
      ? Math.abs(balanceDiff / totalInput) * 100
      : null;
    const isBalanced = balanceDiff != null
      ? Math.abs(balanceDiff) < BALANCE_TOLERANCE_KG
        || (balanceDiffPct != null && balanceDiffPct <= allowedTolerancePctUnits)
      : null;

    // Loss percentages anchor on FG Actual Kg (operator rule).
    // egaAbsKg above is the truth source — used by both the % strip
    // numerators and the conservation identity, so the two are
    // self-consistent.
    const lossDenom = fgOutKg;
    // lossKg already includes wastage (rolled into Process Loss above),
    // so the loss-pct numerators just reuse it directly. Off-grade is
    // counted ONCE in total_loss_pct (rejection / off-grade are the
    // same operational bucket). "Other Loss" is retired entirely.
    const pct = (n: number) => lossDenom > 0 ? (n / lossDenom) * 100 : null;
    const localProcessLossPct = pct(lossKg);
    const localInvisibleLossPct = lossDenom > 0
      ? ((lossKg + egaAbsKg) / lossDenom) * 100
      : null;
    const localTotalLossPct = lossDenom > 0
      ? ((lossKg + egaAbsKg + offgradeTotal) / lossDenom) * 100
      : null;

    // R10 / Bug 1 fix — the LIVE preview for the currently-selected batch
    // must NOT mix sources. Previously kg buckets were recomputed from
    // form state but percentages and balance signals preferred the
    // server-stored `effectiveAccounting` row. That row was JC-level
    // (one per JC before migration 049 — and even after 049, the form
    // state can diverge from any saved batch's row while the operator
    // is typing). Mixing produced the screenshot's "Process Loss 0.00 kg
    // | 6.00%" — kg from live state, % from a stale prior save with a
    // different process_loss number.
    //
    // The live `summary` now derives EVERY field from local state. The
    // SummaryCard's per-batch collapsibles for *other* batches still read
    // from the persisted server snapshot via computeBatchSummary, which
    // is internally consistent. The total roll-up sums per-batch
    // snapshots + the live summary for the selected batch, so it stays
    // accurate too.
    const localEgaLossPct = lossDenom > 0 && egaAbsKg > 0
      ? (egaAbsKg / lossDenom) * 100
      : null;

    // Additives qty (data-keeping bucket). Set further below once the
    // additives state hook exists; default to 0 here so the SummaryCard
    // can render even on fresh JCs that haven't recorded any additives.
    const additivesKgTotal = additives.reduce((acc, a) => acc + num(a.qty), 0);

    return {
      // RM consumed surfaces operator's typed RM total (excludes PM) —
      // used by the qty strip "RM Consumed" KV and as the conservation
      // input when the canonical indent flow was skipped.
      rmConsumedKg: canonicalInput > 0 ? canonicalInput : rmConsumptionTotal,
      fgOutKg,
      // EGA qty — surfaced explicitly in the summary so the operator
      // sees the kg value alongside the EGA Loss % strip below.
      egaKg: egaAbsKg,
      additivesKg: additivesKgTotal,
      lossKg, balTotal, offgradeTotal, ctrlSample,
      // R9 percentages — derived from the SAME local state as the kg
      // buckets above so kg/% always agree. (Bug 1 fix: previously these
      // preferred server-stored values, producing kg-vs-% mismatches when
      // the operator's typed state diverged from the last persisted save.)
      processLossPct:   localProcessLossPct,
      egaLossPct:       localEgaLossPct,
      invisibleLossPct: localInvisibleLossPct,
      totalLossPct:     localTotalLossPct,
      offgradePct:      pct(offgradeTotal),
      balanceDiff,
      balanceDiffPct,
      isBalanced,
      tolerancePct:     allowedTolerancePctUnits,
      inputBasis,
    };
  }, [
    fgActualKg, processLoss, balance, rejections, controlSampleKg, rmIssuedKg,
    carriedInKg, egaLossPctFromServer, allowedTolerancePctUnits, effectiveAccounting,
    consumption, extraGiveawayQty, additives,
  ]);

  // R10 — Per-batch accounting summaries.  computeBatchSummary
  // sources each batch's metrics from the persisted detail arrays
  // (consumption_lines / balance_materials / byproducts / additives)
  // filtered by batch_id, plus the BatchRow's stored snapshot fields
  // (fg_actual_kg, process_loss_kg, control_sample_kg, is_balanced,
  // balance_difference_qty).  For the currently-selected batch we
  // substitute the LIVE in-component `summary` (which folds in the
  // operator's typed-but-unsaved edits) so the per-batch card + the
  // total roll-up reflect what's about to be saved, not the stale
  // server snapshot.
  const perBatchSummaries = useMemo(
    () => batches.map((b) => ({
      batch: b,
      summary: b.batch_id === selectedBatchId
        ? summary
        : computeBatchSummary(b, detail, articles),
    })),
    [batches, selectedBatchId, summary, detail, articles],
  );
  // Roll-up: sum mass buckets across batches and re-derive percentages
  // + the global is_balanced from the aggregate denominators.
  const totalSummary = useMemo<SummaryCardData>(() => {
    let rmConsumedKg = 0, fgOutKg = 0, egaKg = 0, additivesKg = 0;
    let lossKg = 0, balTotal = 0, offgradeTotal = 0, ctrlSample = 0;
    let totalInput = 0;
    for (const { batch, summary: s } of perBatchSummaries) {
      rmConsumedKg  += s.rmConsumedKg;
      fgOutKg       += s.fgOutKg;
      egaKg         += s.egaKg;
      additivesKg   += s.additivesKg;
      lossKg        += s.lossKg;
      balTotal      += s.balTotal;
      offgradeTotal += s.offgradeTotal;
      ctrlSample    += s.ctrlSample;
      const claimed = num(String(batch.input_qty_kg ?? 0));
      totalInput += claimed > 0 ? claimed : s.rmConsumedKg;
    }
    const totalAccounted =
      fgOutKg + lossKg + balTotal + offgradeTotal + ctrlSample + egaKg;
    const balanceDiff = totalInput > 0 ? totalInput - totalAccounted : null;
    const balanceDiffPct = balanceDiff != null && totalInput > 0
      ? Math.abs(balanceDiff / totalInput) * 100
      : null;
    const isBalanced = balanceDiff != null
      ? Math.abs(balanceDiff) < BALANCE_TOLERANCE_KG
        || (balanceDiffPct != null && balanceDiffPct <= allowedTolerancePctUnits)
      : null;
    const denom = fgOutKg;
    const pct = (n: number) => denom > 0 ? (n / denom) * 100 : null;
    return {
      rmConsumedKg, fgOutKg, egaKg, additivesKg,
      lossKg, balTotal, offgradeTotal, ctrlSample,
      processLossPct: pct(lossKg),
      egaLossPct: denom > 0 && egaKg > 0 ? (egaKg / denom) * 100 : null,
      invisibleLossPct: denom > 0 ? ((lossKg + egaKg) / denom) * 100 : null,
      totalLossPct: denom > 0 ? ((lossKg + egaKg + offgradeTotal) / denom) * 100 : null,
      offgradePct: pct(offgradeTotal),
      balanceDiff,
      balanceDiffPct,
      isBalanced,
      tolerancePct: allowedTolerancePctUnits,
      inputBasis: totalInput > 0 ? "indent" : "none",
    };
  }, [perBatchSummaries, allowedTolerancePctUnits]);

  // Off-Grade row mutators ─────────────────────────────────────────────────
  // markDirty() guards the auto-poll resync; markSectionDirty("byproducts")
  // flags the section for diff-on-save inclusion. Off-grade rows persist
  // into job_card_byproducts_v2 via the "byproducts" payload key.
  function addRejection() {
    markDirty();
    markSectionDirty("byproducts");
    setRejections((rs) => [...rs, BLANK_REJECTION_ROW()]);
  }
  function updateRejection(i: number, patch: Partial<RejectionRow>) {
    markDirty();
    markSectionDirty("byproducts");
    setRejections((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }
  function removeRejection(i: number) {
    markDirty();
    markSectionDirty("byproducts");
    setRejections((rs) => rs.filter((_, j) => j !== i));
  }

  // Additive row mutators ──────────────────────────────────────────────────
  function addAdditive() {
    markDirty();
    markSectionDirty("additives");
    setAdditives((as) => [...as, BLANK_ADDITIVE_ROW()]);
  }
  function updateAdditive(i: number, patch: Partial<AdditiveRow>) {
    markDirty();
    markSectionDirty("additives");
    setAdditives((as) => as.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  }
  function removeAdditive(i: number) {
    markDirty();
    markSectionDirty("additives");
    setAdditives((as) => as.filter((_, j) => j !== i));
  }

  // Additive dropdown options — pulled from /sku-lookup once per
  // additive category and deduped client-side.  Falls back to the
  // canonical category labels when the catalog fetch hasn't landed yet
  // (or when the endpoint is unavailable), so the dropdown always has
  // *something* even on a fresh dev DB.
  const [additiveOptions, setAdditiveOptions] = useState<string[]>(
    [...ADDITIVE_CATEGORIES],
  );
  useEffect(() => {
    // One pass of /sku-lookup searches at mount.  Each query goes
    // through the same fetch as the SO sku-lookup picker — the server
    // matches `particulars` with case + space tolerance, so "salt"
    // returns "Salt Powdered", "Iodised Salt", etc.
    let cancelled = false;
    void (async () => {
      const seen = new Set<string>();
      const merged: string[] = [];
      for (const cat of ADDITIVE_CATEGORIES) {
        try {
          const res = await apiFetch(
            `/api/v1/so/sku-lookup?search=${encodeURIComponent(cat)}`,
          );
          if (!res.ok) continue;
          // Server returns SKULookupResponse: `{options: {particulars: string[], ...}}`.
          // The previous shape read `.results[].particulars` which didn't
          // exist; the dropdown was silently falling back to the
          // hardcoded ADDITIVE_CATEGORIES list every time.
          const j = (await res.json()) as {
            options?: { particulars?: string[] };
          };
          for (const name of j.options?.particulars ?? []) {
            const trimmed = (name ?? "").trim();
            if (!trimmed) continue;
            const key = trimmed.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(trimmed);
          }
        } catch {
          /* network blip — keep walking the other categories */
        }
      }
      if (cancelled) return;
      // Always offer the canonical categories as a fallback at the top
      // of the list — even when the catalog returns nothing useful,
      // the operator can still pick a category name and save.
      const out: string[] = [];
      const seenFinal = new Set<string>();
      for (const cat of ADDITIVE_CATEGORIES) {
        if (!seenFinal.has(cat.toLowerCase())) {
          seenFinal.add(cat.toLowerCase());
          out.push(cat);
        }
      }
      for (const name of merged) {
        if (!seenFinal.has(name.toLowerCase())) {
          seenFinal.add(name.toLowerCase());
          out.push(name);
        }
      }
      out.sort((a, b) => a.localeCompare(b));
      setAdditiveOptions(out);
    })();
    return () => { cancelled = true; };
  }, []);

  // Submit ─────────────────────────────────────────────────────────────────
  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);

    // Stage 3 guard: refuse to submit when no open batch is selected.
    // Admin override (closed batch + checkbox toggled) bypasses this
    // check — the POST body's admin_override flag tells the server to
    // accept the save against a closed batch.  Server still validates
    // the caller is admin before honouring it.
    if (selectedBatchId == null) {
      setFeedback({
        kind: "err",
        msg: "Pick a batch before saving output.",
      });
      return;
    }
    if (!batchIsOpen && !adminOverrideActive) {
      setFeedback({
        kind: "err",
        msg: "Open a batch (or enable admin override) before saving output.",
      });
      return;
    }

    // null vs 0 distinction:
    //   - blank input → null (operator hasn't recorded yet)
    //   - typed "0"   → 0 (legitimate zero-output batch)
    // The previous `num(fgActualKg) || null` dropped a legitimate 0
    // because `0 || null` is null. Check the string for emptiness first.
    const body: Record<string, unknown> = {
      // Stage 3: tag this save with the selected batch so the server
      // routes every row (consumption / byproducts / balance /
      // additives) to that batch_id.  When omitted, server falls back
      // to its single-open-batch default; explicit beats default.
      batch_id:          selectedBatchId,
      // Admin override flag — only set when the picked batch is closed
      // AND the operator has checked the override box AND they're an
      // admin.  Server gates on user.is_admin before honouring it.
      ...(adminOverrideActive ? { admin_override: true } : {}),
      fg_actual_kg:      fgActualKg.trim()    === "" ? null : num(fgActualKg),
      fg_actual_units:   fgActualUnits.trim() === "" ? null : parseInt(fgActualUnits, 10),
      fg_expected_kg:    expectedKg,
      fg_expected_units: expectedUnits,
      // Match the null-on-blank convention used by fg_actual_kg above.
      // Previously this defaulted to 0 when the field was blank, but the
      // backend's has_output_payload guard treats `process_loss_kg is not
      // None` as a signal that the operator wants to insert an output
      // row — so sending 0 forced record_output() to fire even when the
      // operator was only saving consumption / off-grade rows. With FG
      // Actual Kg also blank, record_output then returned missing_qty
      // and the whole save 400'd. Sending null lets has_output_payload
      // skip the output row and persist just the consumption / byproducts
      // the operator actually typed.
      process_loss_kg:   processLoss.trim()   === "" ? null : num(processLoss),
    };

    // Per-line consumption — split RM vs PM by article.item_type.
    const rmCons: Array<Record<string, unknown>> = [];
    const pmCons: Array<Record<string, unknown>> = [];
    for (const a of articles) {
      const key = a.bom_line_id != null ? `b${a.bom_line_id}` : `n${a.material_sku_name}`;
      const v = num(consumption[key]);
      if (v <= 0) continue;
      // Slice 4: carry the row's own input_kind so an SFG/WIP opening-input
      // line is persisted as input_kind='SFG'/'WIP' (not 'RM'). The /outputs
      // handler defaults the bucket kind but honours this per-entry override, so
      // the SFG#### consumption is correctly typed + kept out of RM variance.
      const entry = { bom_line_id: a.bom_line_id, material_sku_name: a.material_sku_name, consumed_qty: v, uom: a.uom, input_kind: a.item_type };
      // Case-insensitive PM test, consistent with every mass-balance predicate
      // (lines ~427/3184/3381/3947). SFG/FG fall on the non-PM (rm_consumed)
      // canonical-input side — same bucket as RM, but now self-labelled.
      if ((a.item_type || "").toUpperCase() === "PM") pmCons.push(entry); else rmCons.push(entry);
    }
    body.rm_consumed = rmCons;
    body.pm_consumed = pmCons;

    // Rejections → byproducts. R10/C6: control_sample is no longer carried
    // here; it's recorded via the dedicated QC Sample input and pushed below
    // as a single byproducts row category='control_sample'. R11/C7: pm_*
    // categories aren't in this list either — they ship from `pmVariance`.
    //
    // W3-MED-8 — wire-field note: the byproducts row's quantity field is
    // ALWAYS `qty_kg` on the wire, regardless of the row's UoM (which can
    // be 'kg', 'PCS', 'NOS', 'ROLL', 'SETS', 'BUNDLE'). The name is a
    // historical artefact (the table originally only held kg-denominated
    // wastage/control_sample rows). The server stores the raw quantity
    // and treats `uom` as the unit; it does NOT convert via density or
    // pack size. Do not rename this field client-side — the server
    // schema is what callers must match.
    const byproducts: Array<Record<string, unknown>> = [];
    const balanceMaterials: Array<Record<string, unknown>> = [];
    for (const r of rejections) {
      const q = num(r.qty);
      if (!r.category || q <= 0) continue;
      // Migration 034 — persist the article picked in the dropdown so
      // the row round-trips on reload. material_name is what the unique
      // index keys off (NULL collapsed to ''); bom_line_id is the FK
      // when available. Both nullable: a rejection without a chosen
      // article still saves cleanly.
      byproducts.push({
        category:      r.category,
        qty_kg:        q,
        remarks:       r.remarks || null,
        material_name: r.materialName || null,
        bom_line_id:   r.bomLineId ?? null,
      });
    }

    // R10/C6 — control sample byproduct row. Submitted only when > 0; a 0
    // input clears the previous row (server replace-style write).
    //
    // W3-CRIT-2 — additionally, if the operator CLEARED a previously-saved
    // control_sample (server had a value, the input now reads empty or 0),
    // emit an explicit zero row so save_byproducts upserts qty_kg=0 instead
    // of leaving the stale row on the server. The previous code only
    // pushed a row when > 0, so a clear was silently dropped.
    const ctrlSampleKg = num(controlSampleKg);
    const prevCtrlKg = num(controlSampleFromServer);
    if (ctrlSampleKg > 0) {
      byproducts.push({ category: "control_sample", qty_kg: ctrlSampleKg, uom: "kg", remarks: null });
    } else if (prevCtrlKg > 0) {
      byproducts.push({ category: "control_sample", qty_kg: 0, uom: "kg", remarks: null });
    }

    // R11/C7 — PM variance rows. Each pm_* category becomes a byproducts row
    // tagged with the chosen pcs UoM. Only emitted on packing stages.
    //
    // W3-CRIT-2 — same clear-semantics as control_sample: if a pm_* row had
    // a prior saved value and the operator has cleared it (qty <= 0), emit
    // qty_kg=0 so save_byproducts upserts the zero instead of orphaning the
    // server row. Without this the row stays on the JC forever once typed.
    const isPackingStage = isPackingStageJc(detail.stage);
    if (isPackingStage) {
      for (const cat of PM_VARIANCE_CATEGORIES) {
        const row = pmVariance[cat.key];
        const q = row ? num(row.qty) : 0;
        const prevRow = pmVarianceFromServer[cat.key];
        const prevQ = prevRow ? num(prevRow.qty) : 0;
        const uom = row?.uom || prevRow?.uom || "PCS";
        if (q > 0) {
          byproducts.push({ category: cat.key, qty_kg: q, uom, remarks: null });
        } else if (prevQ > 0) {
          byproducts.push({ category: cat.key, qty_kg: 0, uom, remarks: null });
        }
      }
    }

    body.byproducts = byproducts;

    // Balance materials: one entry per BOM article (empty → 0), balance_type="returned".
    for (const a of articles) {
      const key = a.bom_line_id != null ? `b${a.bom_line_id}` : `n${a.material_sku_name}`;
      const v = balance[key]?.trim() === "" ? 0 : num(balance[key]);
      balanceMaterials.push({ bom_line_id: a.bom_line_id, balance_type: "returned", material_name: a.material_sku_name, qty_kg: v, remarks: null });
    }

    // Extra giveaway (EGA) — R11/C7: packing stages only. Mirrors the
    // backend's is_packing_stage gate at job_card_v2.py:107.
    //
    // Per-article attribution is unknowable post-run, so EGA submits a
    // single consolidated row with the sentinel material_name the server
    // recognises (job_card_v2.EGA_CONSOLIDATED_SENTINEL). bom_line_id
    // stays null. The packing-stage gate is the only check the server
    // runs for this row; the per-material item_type gate is skipped.
    if (isPackingStage) {
      const extraKg = num(extraGiveawayQty);
      if (extraKg > 0) {
        balanceMaterials.push({
          bom_line_id: null,
          balance_type: "extra_given",
          material_name: "CONSOLIDATED",
          qty_kg: extraKg,
          remarks: null,
        });
      }
    }
    // `balance_materials` is a first-class field on the v2 outputs endpoint
    // (RecordOutputV2Request at server_replica/app/modules/production/
    // router.py:5248) — persisted to job_card_balance_material_v2 via
    // replace_balance_materials (router.py:5391-5402). The Android
    // OutputV2Request model is the one that's incomplete; the web sends
    // what the server actually expects, not what Android's Retrofit class
    // happens to declare.
    body.balance_materials = balanceMaterials;

    // Additives — data-keeping rows.  Server route persists each row to
    // job_card_additive_consumption_v2 and the GET /accounting response
    // surfaces a rolled-up total alongside the rest of the summary.
    // Drop blank rows so we don't write empty placeholders.
    body.additives = additives
      .filter((a) => num(a.qty) > 0 && (a.sku_name || a.custom_name))
      .map((a) => ({
        sku_name: a.sku_name === "_other" ? null : a.sku_name || null,
        material_name: a.sku_name === "_other"
          ? (a.custom_name || null)
          : null,
        qty_kg: num(a.qty),
        remarks: a.remarks || null,
      }));

    // R10 — Edit Batch diff-on-save: prune sections the operator didn't
    // touch so unchanged data on the server is preserved untouched.
    // First-save (no batchHasData yet) sends everything as before.
    // The backend now treats an omitted section as "leave alone" — see
    // server_replica/app/modules/production/router.py RecordOutputV2Request
    // None-defaults and the matching `is not None` guards.
    if (batchHasData) {
      const dirty = dirtyMaskRef.current;
      if (!dirty.has("output_qty")) {
        // Only strip the SERVER-DERIVED fields. fg_expected_* come from the
        // JC plan, not from operator input, so omitting them is safe (the
        // backend already has the planned values).
        delete body.fg_expected_kg;
        delete body.fg_expected_units;
        // fg_actual_kg, fg_actual_units, process_loss_kg are OPERATOR-VISIBLE
        // scalars rendered in the form. Previously stripped here when
        // output_qty wasn't dirty — but the displayed value can drift from
        // what the server stored (e.g. operator opened the batch, didn't
        // re-type process_loss, edited only consumption). The backend's
        // `is not None` gate then leaves the stale row alone, so the
        // refreshed UI shows the still-old persisted value and the
        // operator's intent is silently lost. Always sending these three
        // scalars costs ~3 floats per save and removes the silent-drop
        // class entirely.
      }
      if (!dirty.has("consumption")) {
        delete body.rm_consumed;
        delete body.pm_consumed;
      }
      // Wire-side: control_sample is persisted as a byproducts row
      // (category='control_sample'), so a dirty control_sample needs the
      // byproducts payload included too — and vice versa. Include the
      // section only when neither key is dirty AND we drop it.
      if (!dirty.has("byproducts") && !dirty.has("control_sample")) {
        delete body.byproducts;
      }
      if (!dirty.has("balance")) {
        delete body.balance_materials;
      }
      if (!dirty.has("additives")) {
        delete body.additives;
      }
      const hasAnyChange =
        dirty.has("output_qty")     || dirty.has("consumption")
        || dirty.has("byproducts")  || dirty.has("balance")
        || dirty.has("additives")   || dirty.has("control_sample");
      if (!hasAnyChange) {
        setFeedback({ kind: "err", msg: "Nothing changed — edit a field before saving." });
        return;
      }
    }

    setSubmitting(true);
    try {
      const res = await apiFetch(`/api/v1/production/job-cards-v2/${detail.job_card_id}/outputs`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok || (data && (data as { error?: string }).error)) {
        const msg = (data && ((data as { message?: string }).message || (data as { error?: string }).error)) || `HTTP ${res.status}`;
        throw new Error(String(msg));
      }
      setFeedback({ kind: "ok", msg: "Output saved." });
      // ── Persist the accounting summary row ────────────────────────
      // Without this, job_card_accounting_v2 stays NULL on every JC
      // and the /complete endpoint's R9 balance check returns
      // {error: 'no_accounting'} → 400 when the operator hits Complete.
      // Building the body from the same local state the SummaryCard
      // uses keeps server-saved is_balanced / balance_diff_kg /
      // *_loss_pct in lockstep with the live preview.
      //
      // total_input_qty rule mirrors the SummaryCard: canonical
      // rm_issued + carried_in when present, else RM-only consumption
      // sum (PM rows excluded — they don't convert into FG mass).
      try {
        // Recompute the same totals the summary card derives so the
        // server-saved row matches what the operator saw before hitting
        // Save. Order matches the AccountingSummaryRequest schema in
        // router.py (AccountingSummaryRequest at ~5185).
        const fgKg = num(fgActualKg);
        const _articleByKey = new Map<string, typeof articles[number]>();
        for (const a of articles) {
          const key = a.bom_line_id != null ? `b${a.bom_line_id}` : `n${a.material_sku_name}`;
          _articleByKey.set(key, a);
        }
        const _isRmKey = (k: string) => {
          const a = _articleByKey.get(k);
          return a ? (a.item_type || "").toUpperCase() !== "PM" : true;
        };
        const rmConsumptionSum = Object.entries(consumption)
          .reduce((s, [k, v]) => s + (_isRmKey(k) ? num(v) : 0), 0);
        const carriedInVal = num(String(effectiveAccounting?.carried_in_kg ?? detail.carried_qty_kg ?? 0));
        const canonical = rmIssuedKg + carriedInVal;
        const totalInputForSave = canonical > 0 ? canonical : rmConsumptionSum;
        const offgradeForSave = rejections.reduce(
          (acc, r) => acc + (r.category && r.category !== "wastage" ? num(r.qty) : 0),
          0,
        );
        const wastageForSave = rejections.reduce(
          (acc, r) => acc + (r.category === "wastage" ? num(r.qty) : 0),
          0,
        );
        const balForSave = Object.values(balance).reduce((a, v) => a + num(v), 0);
        const fgUnitsVal = fgActualUnits.trim() === "" ? null : parseInt(fgActualUnits, 10);
        // Guard against the silent zero-input class of bugs: when
        // total_input_qty is 0 AND any output-side field is non-zero
        // (FG actual / process loss / EGA / balance / byproducts / sample),
        // the IS_BALANCED math will declare the batch unbalanced for the
        // wrong reason — the operator never filled RM Issued / per-line
        // consumption. Surface a non-blocking warning so they know to go
        // back and fill RM, without blocking the save itself (the output
        // row + sibling consumption are already persisted by the prior
        // POST /outputs call, and re-saving will refresh the summary).
        const outputSideTotal =
          fgKg + num(processLoss) + num(extraGiveawayQty)
          + balForSave + offgradeForSave + wastageForSave + num(controlSampleKg);
        if (totalInputForSave <= 0 && outputSideTotal > 0) {
          setFeedback({
            kind: "err",
            msg: "Output saved, but no RM Issued / consumption was filled — the IS_BALANCED summary will show as unbalanced until you record the input quantity.",
          });
        }
        const summaryBody: Record<string, unknown> = {
          total_input_qty:      totalInputForSave,
          input_uom:            "KGS",
          output_qty:           fgKg,
          output_uom:           "KGS",
          output_qty_units:     fgUnitsVal != null && Number.isFinite(fgUnitsVal) ? fgUnitsVal : null,
          process_loss_qty:     num(processLoss),
          extra_give_away_qty:  num(extraGiveawayQty),
          balance_material_qty: balForSave,
          offgrade_total_qty:   offgradeForSave,
          rejection_qty:        0,  // off-grade and rejection are one bucket per operator policy
          wastage_qty:          wastageForSave,
          control_sample_qty:   num(controlSampleKg),
          // Migration 049 — tag the summary row with the picked batch so
          // multiple batches on the same JC each persist their own
          // IS_BALANCED / percentages instead of stomping a single
          // JC-level row. Older servers ignore the unknown field.
          batch_id:             selectedBatchId,
        };
        const sumRes = await apiFetch(
          `/api/v1/production/job-cards-v2/${detail.job_card_id}/accounting/summary`,
          {
            method: "PUT",
            body: JSON.stringify(summaryBody),
          },
        );
        if (sumRes.ok) {
          const sumJson = (await sumRes.json().catch(() => null)) as
            | Record<string, unknown>
            | null;
          // Server envelope varies across the v2 history: some routes
          // return {saved: row}, some return {row}, some return the row
          // directly. Pick whichever shape is present; non-null means
          // accounting.* is now populated for /complete's balance gate.
          const accFromSummary =
            (sumJson && typeof sumJson === "object" && sumJson.saved && typeof sumJson.saved === "object"
              ? (sumJson.saved as NonNullable<JobCardDetail["accounting"]>)
              : null)
            ?? (sumJson && typeof sumJson === "object" && sumJson.row && typeof sumJson.row === "object"
              ? (sumJson.row as NonNullable<JobCardDetail["accounting"]>)
              : null)
            ?? (sumJson as NonNullable<JobCardDetail["accounting"]> | null);
          if (accFromSummary) setServerAccounting(accFromSummary);
        } else {
          // Surface the failure instead of swallowing — without this,
          // /complete will still 400 with "no_accounting" and the
          // operator has no idea why their save "succeeded" but
          // Complete still fails.
          let msg = `HTTP ${sumRes.status}`;
          try {
            const j = await sumRes.json();
            msg = (j && (j.message || j.detail || j.error)) || msg;
          } catch { /* non-JSON */ }
          console.warn("[save-output] /accounting/summary failed:", msg, summaryBody);
          setFeedback({
            kind: "err",
            msg: `Output saved, but the accounting summary save failed (${msg}). Complete will be blocked — please retry Save Output.`,
          });
        }
      } catch (err) {
        console.warn("[save-output] /accounting/summary threw:", err);
        setFeedback({
          kind: "err",
          msg: `Output saved, but the accounting summary call threw: ${friendlyApiError(err)}. Complete will be blocked.`,
        });
      }
      // C3-H3 — backup GET /accounting in case the summary PUT above
      // failed (older server, non-2xx, etc.). Skipped silently on
      // failure; the live preview keeps rendering.
      //
      // Pass the selected batch so consumption / byproducts come back
      // scoped to it instead of pooled across every batch on this JC.
      // The accounting summary row itself is JC-level so it's unaffected
      // by the filter — but limiting consumption / byproducts here keeps
      // the response payload focused and matches the frontend's
      // matchesBatch() filter semantics.
      try {
        const accQs = selectedBatchId != null ? `?batch_id=${selectedBatchId}` : "";
        const accRes = await apiFetch(`/api/v1/production/job-cards-v2/${detail.job_card_id}/accounting${accQs}`);
        if (accRes.ok) {
          const accJson = (await accRes.json().catch(() => null)) as
            | NonNullable<JobCardDetail["accounting"]>
            | null;
          if (accJson) setServerAccounting(accJson);
        }
      } catch {
        /* preview keeps rendering — non-fatal */
      }
      // Clear the dirty guard BEFORE onReload so the upcoming detail
      // fetch resyncs the form state from the server (operator's edits
      // are now persisted, the server response is canonical).
      formDirty.current = false;
      // R10 — reset the section dirty mask too; future edits start fresh
      // and the Edit Batch button correctly reflects "no pending changes"
      // until the operator types again.
      dirtyMaskRef.current.clear();
      // Refresh the batches array BEFORE onReload so the BatchRow snapshot
      // (fg_actual_kg, fg_actual_units, process_loss_kg, batchHasData
      // derivation, the "EDIT BATCH" submit label) reflects the values
      // we just saved. Mirrors doOpenBatch (~line 2902) and the
      // BatchCloseModal save (~line 4791); the omission here let the
      // selector stay stale and made subsequent edits look like fresh
      // saves on a batch that already had data.
      await refetchBatches();
      onReload();
    } catch (err) {
      setFeedback({ kind: "err", msg: friendlyJobCardError(err) });
    } finally {
      setSubmitting(false);
    }
  }

  // R11/C7 — EGA only renders on packing stages. PM Variance block also
  // gated on packing-stage detection (PM stocks are only consumed there).
  // EGA is now consolidated (no per-article picker), so the rmArticles
  // memo that previously filtered for the dropdown is gone.
  const isPackingStage = isPackingStageJc(detail.stage);
  // C3: any operational input is disabled when locked. We compute this
  // OR with submitting so the save-in-flight state still wins (you can't
  // edit mid-flight either).
  // Stage 3: also disabled when no batch is selected or the selected
  // batch isn't open — closed/cancelled batches are read-only views
  // of their persisted accounting state.  Admin override flips a
  // closed batch back to editable so admins can correct mistakes
  // post-close (the save POSTs admin_override=true and the server
  // gates that against the caller's role).
  const noBatchPicked = selectedBatchId == null;
  const adminOverrideActive = adminOverride && isAdmin && !!selectedBatch && !batchIsOpen;
  const formGatedByBatch = noBatchPicked || (!batchIsOpen && !adminOverrideActive);
  // R10 — Lifecycle gate: every field stays read-only until the operator
  // clicks START (status flips to in_progress). Admin override does NOT
  // bypass this — the override is for closed-batch edits, not pre-start.
  const lifecycleLocked = isLifecycleLocked(detail.status);
  const inputsDisabled = submitting || lock.isLocked || formGatedByBatch || lifecycleLocked;
  // R10 — Has the selected batch ever been saved? Used to label the submit
  // button as "Save Batch" (first save) vs "Edit Batch" (subsequent edits).
  // produced_qty_kg is the canonical "Save Output ran" signal — set by the
  // /outputs endpoint, untouched by open_batch (open_batch only sets
  // input_qty_kg, so checking input_qty_kg would mislabel a freshly-opened
  // batch as already-saved).
  const batchHasData = !!selectedBatch && (
    selectedBatch.produced_qty_kg != null ||
    selectedBatch.fg_actual_kg    != null
  );
  // R10 — submit-button label state machine:
  //   has data           → EDIT BATCH    (subsequent edit save)
  //   batch open, no data → SAVE BATCH   (first save of this batch)
  //   else                → SAVE OUTPUT  (legacy / disabled fallback when
  //                                       no editable batch exists)
  const submitLabel = batchHasData
    ? "EDIT BATCH"
    : (batchIsOpen || adminOverrideActive) ? "SAVE BATCH" : "SAVE OUTPUT";
  // C3-MED-1 — stable banner id for inputs to point aria-describedby at.
  const bannerId = lockBannerId(detail.job_card_id);
  const describedBy = inputsDisabled && lock.isLocked ? bannerId : undefined;

  return (
    <form
      onSubmit={onSubmit}
      // Catch-all dirty marker — every input/select/textarea inside the
      // form bubbles its native `input` event up here. Setting one ref
      // covers FG fields, consumption, balance, off-grade, control
      // sample, PM variance, EGA, process loss — no need to thread
      // markDirty() into 20+ individual onChange handlers.
      onInput={markDirty}
    >
      {/* C3 lock banner — explains why the form is read-only. Renders only
          when `lock.isLocked`; invisible otherwise. The CTA runs the same
          force-unlock flow as the OverflowMenu (C3-H1). */}
      <LockBanner
        isLocked={lock.isLocked}
        lockedReason={lock.lockedReason}
        status={lock.status}
        jcId={detail.job_card_id}
        onForceUnlockClick={() => void runForceUnlockJc(
          detail.job_card_id,
          userStore.load()?.full_name ?? "",
          onReload,
        )}
      />
      {/* ── Stage 3: batch context selector ──────────────────────────────
          Shown above FG Output so the form's "what am I editing" is
          unambiguous.  Picks the active batch (form rebinds to it
          on change).  When no batch is selected / picked batch is
          closed, the entire form below is read-only and Save Output
          is disabled with a clear message. */}
      <Panel title="Batch context">
        {/* Stage 3 final: across-batches rollup strip.  Sums the per-
            batch summary columns so the operator sees the JC's total
            throughput without leaving the form. */}
        {batches.length > 0 ? (
          <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-x-3 sm:gap-x-4 gap-y-2 mb-3 pb-3 border-b border-[var(--aws-border)]">
            <KV
              label={
                <span className="block leading-tight">
                  Batches
                  <span className="block text-[8px] normal-case font-normal text-[var(--text-muted)] tracking-normal mt-0">
                    {batchRollup.openCount} open · {batchRollup.closedCount} closed
                    {batchRollup.cancelledCount > 0 ? ` · ${batchRollup.cancelledCount} cancelled` : ""}
                  </span>
                </span>
              }
              value={<span><strong>{batchRollup.total}</strong></span>}
            />
            <KV
              label="Total Produced"
              value={<span><span>{fmtNum(batchRollup.producedTotal)}</span><span className="text-[10px] text-[var(--text-muted)] ml-1">kg</span></span>}
            />
            <KV
              label="Total Input"
              value={<span><span>{fmtNum(batchRollup.inputTotal)}</span><span className="text-[10px] text-[var(--text-muted)] ml-1">kg</span></span>}
            />
            <KV
              label="Process Loss"
              value={<span><span>{fmtNum(batchRollup.processLossTotal)}</span><span className="text-[10px] text-[var(--text-muted)] ml-1">kg</span></span>}
            />
            <KV
              label="EGA"
              value={<span><span>{fmtNum(batchRollup.egaTotal)}</span><span className="text-[10px] text-[var(--text-muted)] ml-1">kg</span></span>}
            />
            <KV
              label="QC Sample"
              value={<span><span>{fmtNum(batchRollup.controlSampleTotal)}</span><span className="text-[10px] text-[var(--text-muted)] ml-1">kg</span></span>}
            />
          </dl>
        ) : null}
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 mb-2 flex-wrap">
          <label className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)] sm:w-[110px]">
            Recording for
          </label>
          {batchesLoading && batches.length === 0 ? (
            <span className="text-[12px] text-[var(--text-muted)] italic">
              loading batches…
            </span>
          ) : batches.length === 0 ? (
            <span className="text-[12px] text-[var(--text-secondary)]">
              No batches yet — click <strong>Open Batch</strong> to create the first one.
            </span>
          ) : (
            <select
              value={selectedBatchId ?? ""}
              onChange={(e) => {
                const raw = e.target.value;
                changeBatch(raw === "" ? null : parseInt(raw, 10));
              }}
              disabled={submitting || lock.isLocked}
              className={`${inputCls} max-w-full sm:max-w-[420px] flex-1 min-w-[200px]`}
              aria-label="Select batch for recording"
            >
              {[...batches]
                .sort((a, b) => b.batch_number - a.batch_number)
                .map((b) => {
                  const status = b.status === "open"
                    ? "open"
                    : b.status === "closed" ? "closed" : "cancelled";
                  const istHint = b.status === "open"
                    ? (b.opened_at_ist ? ` · opened ${b.opened_at_ist}` : "")
                    : (b.closed_at_ist ? ` · closed ${b.closed_at_ist}` : "");
                  return (
                    <option key={b.batch_id} value={b.batch_id}>
                      Batch {b.batch_number} ({status}){istHint}
                    </option>
                  );
                })}
            </select>
          )}
          {/* Open / Close buttons — single source of truth for batch
              lifecycle.  BatchBand below still shows the history table
              but its inline Open/Close buttons are suppressed when these
              are visible (avoiding duplicate controls).
              R10 — once the JC is marked completed, non-admin operators
              can no longer open new batches or close existing ones; only
              admin keeps the affordance for post-complete corrections.
              Admin override checkbox below (visible only on closed
              batches) is unaffected — it remains the canonical way to
              edit a sealed batch's data. */}
          {detail.status !== "completed" || isAdmin ? (
            <div className="flex items-center gap-2 sm:ml-auto">
              <button
                type="button"
                onClick={() => void doOpenBatch()}
                disabled={batchActionBusy || submitting || lock.isLocked || lifecycleLocked}
                title={lifecycleLocked ? "Start the job card first" : undefined}
                className="h-7 px-3 text-[11px] font-semibold rounded-[2px] border bg-[var(--aws-orange)] border-[var(--aws-orange-active)] text-white hover:bg-[var(--aws-orange-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {batchActionBusy ? "…" : "Open Batch"}
              </button>
              {/* Close Batch moved to sit next to the Save/Edit Batch
                  submit at the bottom of the form (FormFooter extraActions)
                  so the "save then close" flow lives in one row instead of
                  scrolling up to the Batch Context panel. */}
            </div>
          ) : null}
        </div>
        {batchActionMsg ? (
          <div
            role="status"
            className={[
              "text-[12px] px-2 py-1.5 rounded border mb-2",
              batchActionMsg.kind === "ok"
                ? "bg-[#eaf6ed] border-[#b6dbb1] text-[#1d8102]"
                : "bg-[#fdf3f1] border-[#f0c7be] text-[#b1361e]",
            ].join(" ")}
          >
            {batchActionMsg.msg}
          </div>
        ) : null}
        {/* Status banners — closed batch with admin override toggle for
            admins, plain warning for non-admins.  When admin override is
            on, the form below becomes editable and Save Output posts
            admin_override=true. */}
        {selectedBatch && !batchIsOpen ? (
          isAdmin ? (
            <div
              role="status"
              className="text-[12px] px-2 py-1.5 rounded border bg-[#fff7e6] border-[#f0d099] text-[#8a5e10] flex flex-col sm:flex-row sm:items-center gap-2"
            >
              <span className="flex-1">
                Batch {selectedBatch.batch_number} is {selectedBatch.status}.{" "}
                {adminOverrideActive ? (
                  <strong>Admin override active</strong>
                ) : (
                  <>Editing is disabled by default.</>
                )}
              </span>
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={adminOverride}
                  onChange={(e) => setAdminOverride(e.target.checked)}
                  className="accent-[var(--aws-orange)]"
                />
                <span className="text-[11px] font-semibold">
                  Admin override — edit closed batch
                </span>
              </label>
            </div>
          ) : (
            <div
              role="status"
              className="text-[12px] px-2 py-1.5 rounded border bg-[#fff7e6] border-[#f0d099] text-[#8a5e10]"
            >
              Batch {selectedBatch.batch_number} is {selectedBatch.status}. The form below is read-only — only admins can edit closed batches.
            </div>
          )
        ) : selectedBatch == null && batches.length > 0 ? (
          <div
            role="status"
            className="text-[12px] px-2 py-1.5 rounded border bg-[#fff7e6] border-[#f0d099] text-[#8a5e10]"
          >
            Pick a batch above to load its recorded output.
          </div>
        ) : null}
      </Panel>

      {/* ── FG Output ───────────────────────────────────────────────────── */}
      <Panel title="FG Output">
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3 mb-4">
          {/* R10 — once one or more batches have closed, the Expected
              labels surface what's still owed to the JC (planned minus
              already-produced) instead of the JC-level total, so the
              operator targeting batch N+1 sees the right ceiling. The
              backend body still POSTs the JC-level expected via
              `fg_expected_kg` / `fg_expected_units` (server-side
              accounting math unchanged). */}
          <KV
            label={batchRollup.closedCount > 0 ? "FG Remaining Units" : "FG Expected Units"}
            value={remainingExpectedUnits != null ? String(remainingExpectedUnits) : "—"}
          />
          <KV
            label={batchRollup.closedCount > 0 ? "FG Remaining Kg" : "FG Expected Kg"}
            value={remainingExpectedKg != null ? fmtKg(remainingExpectedKg) : "—"}
          />
          <KV label="RM Issued (kg)"    value={fmtKg(rmIssuedKg)} />
        </dl>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
          <FormNumber label="FG Actual Units" value={fgActualUnits} onChange={onChangeUnits} disabled={inputsDisabled} />
          <FormNumber label="FG Actual Kg"    value={fgActualKg}    onChange={onChangeFgActualKg}    disabled={inputsDisabled} />
        </div>

        {/* Slice 5: SFG inventory picker — only on a consuming stage (this JC
            doesn't produce SFG) that has an SFG#### to issue (chain input_code
            or an SFG bom_line). Lists the WIP batches its upstream stage made. */}
        {(() => {
          const isProducer = ["SFG", "WIP"].includes((detail.output_kind ?? "").toUpperCase());
          if (isProducer) return null;
          const sfgArticle = articles.find((a) => a.item_type === "SFG" || a.item_type === "WIP");
          const sfgCode = detail.input_code || sfgArticle?.material_sku_name || null;
          if (!sfgCode) return null;
          const sfgKey = sfgArticle
            ? (sfgArticle.bom_line_id != null ? `b${sfgArticle.bom_line_id}` : `n${sfgArticle.material_sku_name}`)
            : null;
          return (
            <div className="mb-4">
              <SfgInventoryPicker
                sfgCode={sfgCode}
                entity={detail.entity}
                onUse={sfgKey ? (qty) => { markSectionDirty("consumption"); setConsumption((c) => ({ ...c, [sfgKey]: String(qty) })); } : undefined}
              />
            </div>
          );
        })()}

        {/* Material Consumption — one row per BOM article */}
        <SubsectionLabel>Material Consumption</SubsectionLabel>
        {articles.length === 0 ? (
          <EmptyHint>No BOM articles attached to this job card.</EmptyHint>
        ) : (
          <div className="space-y-2 mb-4">
            {articles.map((a) => {
              const key = a.bom_line_id != null ? `b${a.bom_line_id}` : `n${a.material_sku_name}`;
              return (
                <div key={key} className="grid grid-cols-12 gap-2 items-center">
                  <div className="col-span-7 lg:col-span-5 text-[13px] text-[var(--text-primary)] truncate" title={a.material_sku_name}>
                    {a.material_sku_name} <span className={`text-[11px] ${a.item_type === "SFG" || a.item_type === "WIP" ? "text-[var(--text-success)] font-medium" : "text-[var(--text-muted)]"}`}>({a.item_type})</span>
                  </div>
                  <input
                    type="number" step="any" placeholder={`Qty (${a.uom})`}
                    className={`${inputCls} col-span-3 lg:col-span-2`}
                    value={consumption[key] ?? ""}
                    onChange={(e) => { markSectionDirty("consumption"); setConsumption((c) => ({ ...c, [key]: e.target.value })); }}
                    onWheel={(e) => (e.currentTarget as HTMLInputElement).blur()}
                    disabled={inputsDisabled}
                    aria-disabled={inputsDisabled}
                    aria-describedby={describedBy}
                  />
                  <span className="col-span-2 lg:col-span-1 text-[11px] text-[var(--text-muted)]">{a.uom}</span>
                  {/* C5: per-material variance chip — wraps to its own line
                      on mobile (col-span-12 forces a full new row) and
                      inlines next to the uom on lg:+ where there's room. */}
                  <div className="col-span-12 lg:col-span-4 mt-1 lg:mt-0">
                    <VarianceChip
                      materialName={a.material_sku_name}
                      bomPrescribedQty={bomPrescribedByKey[key] ?? null}
                      actualQty={num(consumption[key] ?? "")}
                      uom={a.uom}
                      hasSavedConsumption={!!hasSavedConsumptionByKey[key]}
                      plannedKg={num(String(detail.planned_qty_kg ?? 0))}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Additives — data-keeping consumption for fully-consumed
            seasoning (Salt, Sugar, Citric Acid, Oils, etc.).  Optional;
            does NOT participate in the conservation identity. Rows
            persist to job_card_additive_consumption_v2 via the same
            POST /outputs body. */}
        <SubsectionLabel>
          Additives
          <span className="block sm:inline ml-0 sm:ml-2 text-[10px] font-normal text-[var(--text-muted)] normal-case tracking-normal">
            data-keeping · not counted in balance
          </span>
        </SubsectionLabel>
        <div className="space-y-2 mb-4">
          {additives.map((a, i) => (
            <div key={i} className="grid grid-cols-12 gap-2 items-start">
              <select
                className={`${inputCls} col-span-12 sm:col-span-4`}
                value={a.sku_name}
                onChange={(e) => updateAdditive(i, {
                  sku_name: e.target.value,
                  // Drop any custom_name the moment the operator picks
                  // a real SKU so we never persist mismatched values.
                  custom_name: e.target.value === "_other" ? a.custom_name : "",
                })}
                disabled={inputsDisabled}
                aria-disabled={inputsDisabled}
                aria-describedby={describedBy}
              >
                <option value="">— Select additive —</option>
                {additiveOptions.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
                <option value="_other">Others (free-text)</option>
              </select>
              {a.sku_name === "_other" ? (
                // Global-SKU typeahead — searches all_sku via the same
                // /sku-lookup endpoint the category dropdown uses, but
                // unconstrained to the additive category list so the
                // operator can attach any registered material.  Free-
                // typed text is still preserved as a fallback for off-
                // catalog names.
                <AdditiveOtherPicker
                  value={a.custom_name}
                  onChange={(v) => updateAdditive(i, { custom_name: v })}
                  disabled={inputsDisabled}
                  className="col-span-12 sm:col-span-3"
                />
              ) : (
                <div className="hidden sm:block sm:col-span-3" />
              )}
              <input
                type="number"
                step="any"
                placeholder="Qty (kg)"
                className={`${inputCls} col-span-6 sm:col-span-2`}
                value={a.qty}
                onChange={(e) => updateAdditive(i, { qty: e.target.value })}
                onWheel={(e) => (e.currentTarget as HTMLInputElement).blur()}
                disabled={inputsDisabled}
                aria-disabled={inputsDisabled}
                aria-describedby={describedBy}
              />
              <input
                type="text"
                placeholder="Remarks (optional)"
                className={`${inputCls} col-span-5 sm:col-span-2`}
                value={a.remarks}
                onChange={(e) => updateAdditive(i, { remarks: e.target.value })}
                disabled={inputsDisabled}
                aria-disabled={inputsDisabled}
                aria-describedby={describedBy}
              />
              <button
                type="button"
                onClick={() => removeAdditive(i)}
                disabled={inputsDisabled}
                aria-label="Remove additive row"
                className="col-span-1 inline-flex items-center justify-center h-9 text-[var(--aws-error)] disabled:opacity-30"
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={addAdditive}
            disabled={inputsDisabled}
            className="text-[11px] text-[var(--aws-link)] hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
          >
            + Add another
          </button>
        </div>

        {/* Off-Grade — dynamic rows. A blank row is always seeded so the
            operator can enter a single off-grade record without first
            clicking "+ Add another". */}
        <SubsectionLabel>Off-Grade</SubsectionLabel>
        {rejections.length === 0 ? (
          <EmptyHint>No off-grade entries. Click + Add another to record one.</EmptyHint>
        ) : (
          <div className="space-y-2 mb-2">
            {rejections.map((r, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 items-start">
                <select
                  className={`${inputCls} col-span-12 sm:col-span-3`}
                  value={r.category}
                  onChange={(e) => updateRejection(i, { category: e.target.value })}
                  disabled={inputsDisabled}
                  aria-disabled={inputsDisabled}
                  aria-describedby={describedBy}
                >
                  {REJECTION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                {(() => {
                  const selectedValue =
                    r.bomLineId != null
                      ? `b${r.bomLineId}`
                      : (r.materialName ? `n${r.materialName}` : "");
                  // Defensive: if the saved row carries an article that
                  // no longer appears in the BOM catalog (a BOM
                  // revision dropped it, or the row was saved on a
                  // different BOM version), render an extra synthetic
                  // option so the dropdown still surfaces the saved
                  // value instead of silently falling back to
                  // "— Article —" and losing the attribution on the
                  // next save.
                  const hasSelectedInCatalog =
                    selectedValue === "" ||
                    articles.some(
                      (a) =>
                        (a.bom_line_id != null
                          ? `b${a.bom_line_id}`
                          : `n${a.material_sku_name}`) === selectedValue,
                    );
                  return (
                    <select
                      className={`${inputCls} col-span-12 sm:col-span-4`}
                      value={selectedValue}
                      onChange={(e) => {
                        const v = e.target.value;
                        const a = articles.find(
                          (x) =>
                            (x.bom_line_id != null
                              ? `b${x.bom_line_id}`
                              : `n${x.material_sku_name}`) === v,
                        );
                        updateRejection(i, {
                          bomLineId: a?.bom_line_id ?? null,
                          materialName: a?.material_sku_name ?? "",
                        });
                      }}
                      disabled={inputsDisabled}
                      aria-disabled={inputsDisabled}
                      aria-describedby={describedBy}
                    >
                      <option value="">— Article —</option>
                      {!hasSelectedInCatalog && r.materialName ? (
                        <option value={selectedValue}>
                          {r.materialName} (saved — not in current BOM)
                        </option>
                      ) : null}
                      {articles.map((a) => {
                        const v = a.bom_line_id != null ? `b${a.bom_line_id}` : `n${a.material_sku_name}`;
                        return <option key={v} value={v}>{a.material_sku_name}</option>;
                      })}
                    </select>
                  );
                })()}
                <input
                  type="number" step="any" placeholder="Qty (kg)"
                  className={`${inputCls} col-span-6 sm:col-span-2`}
                  value={r.qty}
                  onChange={(e) => updateRejection(i, { qty: e.target.value })}
                  onWheel={(e) => (e.currentTarget as HTMLInputElement).blur()}
                  disabled={inputsDisabled}
                  aria-disabled={inputsDisabled}
                  aria-describedby={describedBy}
                />
                <input
                  type="text" placeholder="Remarks"
                  className={`${inputCls} col-span-5 sm:col-span-2`}
                  value={r.remarks}
                  onChange={(e) => updateRejection(i, { remarks: e.target.value })}
                  disabled={inputsDisabled}
                  aria-disabled={inputsDisabled}
                  aria-describedby={describedBy}
                />
                <button
                  type="button"
                  onClick={() => removeRejection(i)}
                  disabled={inputsDisabled}
                  aria-disabled={inputsDisabled}
                  aria-describedby={describedBy}
                  className="col-span-1 h-8 text-[12px] text-[var(--aws-error)] hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Remove row"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={addRejection}
          disabled={inputsDisabled}
          aria-disabled={inputsDisabled}
          aria-describedby={describedBy}
          className="text-[12px] text-[var(--aws-link)] hover:underline mb-4 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          + Add another
        </button>

        {/* Process Loss + computed % */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
          <FormNumber label="Process Loss (kg)" value={processLoss} onChange={onChangeProcessLoss} disabled={inputsDisabled} />
          <div>
            <FormLabel>Process Loss %</FormLabel>
            <div className={`${inputCls} bg-[var(--surface-subtle)] flex items-center`}>
              {processLossPct != null ? `${processLossPct.toFixed(2)}%` : "—"}
            </div>
          </div>
        </div>

        {/* Extra Giveaway (EGA) — R11/C7: packing stages only.
            Consolidated capture (operator-stated): per-RM attribution is
            unknowable post-run, so the dropdown is removed and the qty
            posts as a single sentinel row to the server. */}
        {isPackingStage ? (
          <>
            <SubsectionLabel className="mt-4">Extra Giveaway (EGA)</SubsectionLabel>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <FormNumber label="Qty (kg)" value={extraGiveawayQty} onChange={setExtraGiveawayQty} disabled={inputsDisabled} />
            </div>
            <p className="mt-1 text-[10px] text-[var(--text-muted)] italic">
              Consolidated across RM articles — per-material attribution isn&apos;t captured.
            </p>
          </>
        ) : (
          <p className="mt-4 text-[11px] text-[var(--text-muted)] italic">
            EGA only on packing stages.
          </p>
        )}
      </Panel>

      {/* ── Balance Material ────────────────────────────────────────────── */}
      <Panel title="Balance Material">
        {/* R10/C6 — QC Sample subsection. Wire value is always kg; the
            g↔kg toggle is state-only (the input displays × 1000 in g mode).
            Persisted on save as a byproducts row category='control_sample'. */}
        <SubsectionLabel>QC Sample</SubsectionLabel>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
          <div>
            <FormLabel>Control Sample ({qcSampleDisplayUnit})</FormLabel>
            <div className="flex items-center gap-2">
              <input
                type="number"
                step="any"
                placeholder="0"
                className={inputCls}
                value={
                  // Display raw typed value in kg mode (the source of
                  // truth IS kg). Reformatting on every keystroke broke
                  // entry of values like 0.5 — toFixed(3) jumped to 0.500
                  // mid-typing and stranded the cursor. In g mode we still
                  // show integer grams (state is held as kg, so multiply
                  // by 1000 and round to integer for display).
                  //
                  // Round-trip integrity is preserved by parseFloat in
                  // onChange; we never persist the formatted view.
                  controlSampleKg === ""
                    ? ""
                    : qcSampleDisplayUnit === "kg"
                      ? controlSampleKg
                      : String(Math.round(num(controlSampleKg) * 1000))
                }
                onChange={(e) => {
                  const v = e.target.value;
                  markSectionDirty("control_sample");
                  if (v.trim() === "") {
                    setControlSampleKg("");
                    return;
                  }
                  const n = parseFloat(v);
                  if (!Number.isFinite(n)) return;
                  setControlSampleKg(
                    qcSampleDisplayUnit === "kg" ? v : String(n / 1000),
                  );
                }}
                onWheel={(e) => (e.currentTarget as HTMLInputElement).blur()}
                disabled={inputsDisabled}
                aria-disabled={inputsDisabled}
                aria-describedby={describedBy}
              />
              <button
                type="button"
                onClick={() =>
                  setQcSampleDisplayUnit((u) => (u === "kg" ? "g" : "kg"))
                }
                disabled={inputsDisabled}
                aria-disabled={inputsDisabled}
                aria-describedby={describedBy}
                title={`Toggle display unit (currently ${qcSampleDisplayUnit})`}
                className="h-8 px-2 rounded-[2px] text-[11px] font-semibold border border-[var(--aws-border-strong)] bg-white hover:bg-[var(--surface-subtle)] disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
              >
                g↔kg
              </button>
            </div>
            <p className="mt-1 text-[10px] text-[var(--text-muted)] italic">
              Saved as kg{qcSampleDisplayUnit === "g" && controlSampleKg !== "" ? ` — wire value ${num(controlSampleKg)} kg` : ""}.
            </p>
          </div>
        </div>

        <SubsectionLabel>Returned to store</SubsectionLabel>
        {articles.length === 0 ? (
          <EmptyHint>No BOM articles attached to this job card.</EmptyHint>
        ) : (
          <div className="space-y-2">
            {articles.map((a) => {
              const key = a.bom_line_id != null ? `b${a.bom_line_id}` : `n${a.material_sku_name}`;
              return (
                <div key={key} className="grid grid-cols-12 gap-2 items-center">
                  <div className="col-span-7 sm:col-span-8 text-[13px] text-[var(--text-primary)] truncate" title={a.material_sku_name}>
                    {a.material_sku_name} <span className={`text-[11px] ${a.item_type === "SFG" || a.item_type === "WIP" ? "text-[var(--text-success)] font-medium" : "text-[var(--text-muted)]"}`}>({a.item_type})</span>
                  </div>
                  <input
                    type="number" step="any" placeholder="0"
                    className={`${inputCls} col-span-4 sm:col-span-3`}
                    value={balance[key] ?? ""}
                    onChange={(e) => { markSectionDirty("balance"); setBalance((b) => ({ ...b, [key]: e.target.value })); }}
                    onWheel={(e) => (e.currentTarget as HTMLInputElement).blur()}
                    disabled={inputsDisabled}
                    aria-disabled={inputsDisabled}
                    aria-describedby={describedBy}
                  />
                  <span className="col-span-1 text-[11px] text-[var(--text-muted)]">{a.uom}</span>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      {/* ── PM Variance (R11/C7) — packing stages only ──────────────────── */}
      {isPackingStage ? (
        <Panel title="PM Variance">
          <p className="text-[11px] text-[var(--text-muted)] italic mb-3">
            Packaging material variance categories. Each is recorded as a
            byproducts row with the chosen unit (no kg — PM is always counted).
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {PM_VARIANCE_CATEGORIES.map((cat) => {
              const row = pmVariance[cat.key] ?? { qty: "", uom: "PCS" };
              return (
                <div key={cat.key}>
                  <FormLabel>{cat.label}</FormLabel>
                  <input
                    type="number"
                    step="any"
                    placeholder="0"
                    className={`${inputCls} mb-1`}
                    value={row.qty}
                    onChange={(e) =>
                      setPmVariance((s) => ({
                        ...s,
                        [cat.key]: { qty: e.target.value, uom: row.uom },
                      }))
                    }
                    onWheel={(e) => (e.currentTarget as HTMLInputElement).blur()}
                    disabled={inputsDisabled}
                    aria-disabled={inputsDisabled}
                    aria-describedby={describedBy}
                  />
                  <select
                    className={inputCls}
                    value={row.uom}
                    onChange={(e) =>
                      setPmVariance((s) => ({
                        ...s,
                        [cat.key]: { qty: row.qty, uom: e.target.value },
                      }))
                    }
                    disabled={inputsDisabled}
                    aria-disabled={inputsDisabled}
                    aria-describedby={describedBy}
                  >
                    {PM_VARIANCE_UOMS.map((u) => (
                      <option key={u} value={u}>{u}</option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
        </Panel>
      ) : null}

      {/* ── Accounting Summary ──────────────────────────────────────────── */}
      <AccountingSummaryCard
        summary={summary}
        perBatchSummaries={perBatchSummaries}
        totalSummary={totalSummary}
        selectedBatchId={selectedBatchId}
        detail={detail}
        onReload={onReload}
      />

      <FormFooter
        feedback={feedback}
        submitting={submitting}
        submitLabel={submitLabel}
        // C3-MED-6 — disable on lock OR submit. FormFooter ORs with
        // `submitting` internally too but passing the merged flag keeps
        // the aria-describedby story consistent with the inputs above.
        disabled={inputsDisabled}
        // Close Batch sits beside the Save/Edit Batch submit so the
        // operator's "save then close" flow lives in one row. Gating
        // mirrors the original Batch Context panel button: visible when
        // the JC is editable for this role, enabled only when a batch
        // is open. Modal pre-fill + post-close refresh are unchanged
        // — only the trigger's location moved.
        extraActions={
          (detail.status !== "completed" || isAdmin) && selectedBatch ? (
            <button
              type="button"
              onClick={() => setCloseBatchModal(selectedBatch)}
              disabled={
                batchActionBusy || submitting || lock.isLocked || lifecycleLocked ||
                !batchIsOpen
              }
              title={lifecycleLocked ? "Start the job card first" : undefined}
              className="h-9 px-4 text-[13px] font-bold tracking-wide rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[var(--text-primary)] hover:border-[var(--aws-orange)] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Close Batch
            </button>
          ) : null
        }
      />
      {/* Close Batch modal driven by the bottom-row Close Batch button.
          Same component BatchBand uses inside AccountingSummaryCard;
          rendered here so the close flow lives next to its trigger. */}
      {closeBatchModal ? (
        <BatchCloseModal
          batch={closeBatchModal}
          jcId={detail.job_card_id}
          isPackingStage={isPackingStageJc(detail.stage)}
          defaults={{
            producedKg: fgActualKg,
            // R10 — pre-fill from the operator's typed RM consumption
            // (RM-only, PM excluded) so Close Batch doesn't surface an
            // empty field when the data was already entered in the form
            // above. Match the BatchBand-version default's behaviour.
            rmConsumedKg: rmConsumedTypedKg > 0 ? rmConsumedTypedKg.toFixed(3) : "",
            extraGiveAway: extraGiveawayQty,
          }}
          summarySnapshot={{
            fgActualKg: num(fgActualKg) || null,
            balanceDiff: null,
            isBalanced: null,
            tolerancePct: 0.10,
            totalLossPct: null,
          }}
          onClose={() => setCloseBatchModal(null)}
          onDone={async () => {
            setCloseBatchModal(null);
            // R10 — explicit batches refresh paired with onReload so
            // the per-batch summary list picks up the newly-closed
            // batch's snapshot fields immediately. Auto-poll no longer
            // refreshes batches on its own (see refetchBatches above).
            await refetchBatches();
            onReload();
          }}
        />
      ) : null}
    </form>
  );
}

// R11/C7 — `isFinalStageJc` was retired; EGA now keys on packing-stage
// detection (`isPackingStageJc`) so non-final packing stages also accept
// extra-giveaway entries, and final non-packing stages don't.

// ── C5: Accounting Summary card + variance chip ──────────────────────────
//
// SummaryCard mirrors the server's R9 persisted summary row (process_loss_pct,
// invisible_loss_pct, total_loss_pct, other_loss_pct, rejection / off-grade
// pct, balance_difference qty + %, is_balanced). When unbalanced beyond the
// 0.5 % tolerance, a red banner urges the operator to resolve before closing.
//
// Responsive: single column on mobile (< sm), two columns at sm:, three at lg:.
// Status banner spans the full grid on every viewport.

type SummaryCardData = {
  /** RM consumption mass (kg). Prefers canonical (rm_issued +
   *  carried_in) when the indent flow ran; falls back to sum of typed
   *  RM consumption_lines when the operator entered values directly.
   *  PM rows are NEVER counted — they're packaging, not RM-to-FG mass.
   *  Drives the "RM Consumed" KV and the balance-difference denominator. */
  rmConsumedKg: number;
  fgOutKg: number;
  /** EGA qty (kg).  Operator's typed value when present, otherwise
   *  reconstructed from the server's ega_loss_pct × total_input fallback.
   *  Mirrors the egaAbsKg value used by the conservation identity so the
   *  card and the balance check stay in lock-step. */
  egaKg: number;
  /** Additives consumption total (kg).  Display-only — flagged in the
   *  summary as a "data-keeping" loss bucket that does NOT feed the
   *  conservation identity (additives are 100 % consumed by intent, so
   *  they would otherwise create artificial imbalance). */
  additivesKg: number;
  lossKg: number;
  balTotal: number;
  offgradeTotal: number;
  ctrlSample: number;
  processLossPct: number | null;
  /** EGA Loss % anchored on FG output. Server emits ega_loss_pct
   *  against total_input; we prefer the server value when present,
   *  otherwise reconstruct on FG-output basis to match the rest of
   *  the local preview. */
  egaLossPct: number | null;
  invisibleLossPct: number | null;
  totalLossPct: number | null;
  offgradePct: number | null;
  balanceDiff: number | null;
  balanceDiffPct: number | null;
  isBalanced: boolean | null;
  /** Closure tolerance (%-units). Server stores 0.001 = 0.1 %; we
   *  surface it as a number like 0.10 so the SummaryCard can render
   *  "Tolerance: 0.10 %" alongside Is Balanced. */
  tolerancePct: number;
  /** Which input source the balance check is using. "indent" =
   *  canonical rm_issued + carried_in. "consumption" = operator-typed
   *  sum of RM consumption_lines (fallback when no indent). "none" =
   *  insufficient data, balance check skipped. */
  inputBasis: "indent" | "consumption" | "none";
};

// Deterministic DD Mon YYYY for a batch_date ('YYYY-MM-DD' string). Avoids
// locale/timezone-dependent Date formatting. Returns "—" when absent.
const _BATCH_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtBatchDate(d: string | null | undefined): string {
  if (!d) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
  if (!m) return String(d);
  const mi = parseInt(m[2], 10) - 1;
  return mi >= 0 && mi <= 11 ? `${m[3]} ${_BATCH_MONTHS[mi]} ${m[1]}` : String(d);
}

// R10 — KV grid + percentages strip extracted from AccountingSummaryCard
// so the TOTAL roll-up and each per-batch collapsible can share the same
// layout. Pure presentational — `summary` is the only input.
function SummaryGrid({ summary }: { summary: SummaryCardData }) {
  return (
    <>
      <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8 gap-x-3 sm:gap-x-4 gap-y-3 mb-3">
        <KV label="RM Consumed"
            value={<span><span>{fmtNum(summary.rmConsumedKg)}</span><span className="text-[10px] text-[var(--text-muted)] ml-1">kg</span></span>} />
        <KV label="FG Output"
            value={<span><span>{fmtNum(summary.fgOutKg)}</span><span className="text-[10px] text-[var(--text-muted)] ml-1">kg</span></span>} />
        <KV
          label={
            <span className="block leading-tight">
              Process Loss
              <span className="block text-[8px] normal-case font-normal text-[var(--text-muted)] tracking-normal mt-0">
                incl. wastage
              </span>
            </span>
          }
          value={<span><span>{fmtNum(summary.lossKg)}</span><span className="text-[10px] text-[var(--text-muted)] ml-1">kg</span></span>}
        />
        <KV label="Extra Giveaway (EGA)"
            value={<span><span>{fmtNum(summary.egaKg)}</span><span className="text-[10px] text-[var(--text-muted)] ml-1">kg</span></span>} />
        <KV label="Balance Material"
            value={<span><span>{fmtNum(summary.balTotal)}</span><span className="text-[10px] text-[var(--text-muted)] ml-1">kg</span></span>} />
        <KV label="Off-grade Total"
            value={<span><span>{fmtNum(summary.offgradeTotal)}</span><span className="text-[10px] text-[var(--text-muted)] ml-1">kg</span></span>} />
        <KV label="Control Sample"
            value={<span><span>{fmtNum(summary.ctrlSample)}</span><span className="text-[10px] text-[var(--text-muted)] ml-1">kg</span></span>} />
        <KV
          label={
            <span className="block leading-tight">
              Additives
              <span className="block text-[8px] normal-case font-normal text-[var(--text-muted)] tracking-normal mt-0">
                data only · not in balance
              </span>
            </span>
          }
          value={<span><span>{fmtNum(summary.additivesKg)}</span><span className="text-[10px] text-[var(--text-muted)] ml-1">kg</span></span>}
        />
      </dl>
      <dl className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-x-3 sm:gap-x-4 gap-y-3 pt-3 border-t border-[var(--aws-border)]">
        <KV label="Process Loss %"      value={lossPctChip(summary.processLossPct, 1.5)} />
        <KV label="EGA Loss %"          value={lossPctChip(summary.egaLossPct,     1.0)} />
        <KV label="PL+EGA Loss %"       value={lossPctChip(summary.invisibleLossPct, 2.5)} />
        <KV label="Off-grade %"         value={lossPctChip(summary.offgradePct,    1.0)} />
        <KV label="Total Loss %"        value={lossPctChip(summary.totalLossPct,   3.0)} />
      </dl>
    </>
  );
}

function AccountingSummaryCard({
  summary,
  perBatchSummaries,
  totalSummary,
  selectedBatchId,
  detail,
  onReload,
}: {
  /** Live summary for the currently-selected batch (reflects unsaved
   *  form edits). Retained for backwards-compat with the legacy single-
   *  summary header chip; the new layout reads from totalSummary instead. */
  summary: SummaryCardData;
  /** One entry per batch (selected batch's entry uses the live summary
   *  so unsaved edits surface in its collapsible). Drives the per-batch
   *  collapsible sections rendered below the TOTAL. */
  perBatchSummaries: { batch: BatchRow; summary: SummaryCardData }[];
  /** Sum across batches, recomputed from perBatchSummaries (so the
   *  selected batch's live edits also propagate into the total). */
  totalSummary: SummaryCardData;
  selectedBatchId: number | null;
  /** Full JC detail + reload — passed to the embedded BatchBand, which owns
   *  the batchwise table + Open/Close batch controls (moved here from the
   *  former top-of-page band) and the /batches open + close wiring. */
  detail: JobCardDetail;
  onReload: () => void;
}) {
  // R10 — header headlines now describe the TOTAL across batches so the
  // operator sees the JC-wide balance status. Per-batch is_balanced /
  // balance_difference stay inside each collapsible section.
  void summary;
  const unbalanced = totalSummary.isBalanced === false;
  const balanceDiffAbs = totalSummary.balanceDiff != null ? Math.abs(totalSummary.balanceDiff) : 0;

  // Render the headline IS BALANCED chip with a tick / cross glyph.
  // R10 — driven by totalSummary (across all batches), not the
  // previously-passed `summary` (which was selected-batch only).
  const renderBalancedChip = (s: SummaryCardData) =>
    s.isBalanced == null ? (
      <span className="text-[var(--text-muted)]">—</span>
    ) : s.isBalanced ? (
      <span className="inline-flex items-center gap-1 text-[var(--text-success)] font-semibold">
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="currentColor">
          <path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
        </svg>
        Balanced
      </span>
    ) : (
      <span className="inline-flex items-center gap-1 text-[var(--aws-error)] font-semibold">
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="currentColor">
          <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
        </svg>
        Not balanced
      </span>
    );

  const renderHeadlines = (s: SummaryCardData, unbalancedForHeader: boolean) => (
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 sm:gap-x-4 gap-y-3 mb-3 pb-3 border-b border-[var(--aws-border)]">
      <KV label="Is Balanced" value={renderBalancedChip(s)} />
      <KV
        label="Balance Difference"
        value={
          s.balanceDiff == null
            ? (
              <span className="text-[var(--text-muted)] italic text-[11px]">
                no input recorded
              </span>
            )
            : (
              <span className={unbalancedForHeader ? "text-[var(--aws-error)] font-semibold" : ""}>
                {s.balanceDiff.toFixed(2)} kg
                {s.balanceDiffPct != null ? (
                  <span className="text-[var(--text-muted)] ml-1 font-normal">
                    ({s.balanceDiffPct.toFixed(2)}%)
                  </span>
                ) : null}
              </span>
            )
        }
      />
    </dl>
  );

  return (
    <Panel title="Accounting Summary">
      {unbalanced ? (
        <div
          role="alert"
          className={[
            "mb-3 rounded-md border px-3 py-2 sm:px-4 sm:py-3",
            "bg-[#fdf3f1] border-[#f0c7be] text-[#b1361e]",
            "text-[13px]",
          ].join(" ")}
        >
          <span className="font-semibold">
            Total unbalanced by {balanceDiffAbs.toFixed(2)} kg
          </span>
          {totalSummary.balanceDiffPct != null ? (
            <span className="ml-1">({totalSummary.balanceDiffPct.toFixed(2)}%)</span>
          ) : null}
          <span className="ml-1">— resolve before closing this job card.</span>
        </div>
      ) : null}

      {/* ── Batchwise output + controls (R13) — the batch status, Open/Close
          buttons, close modal, and the per-batch produced / RM / EGA table,
          moved here from the former top-of-page band. BatchBand owns the
          /batches fetch and the /batches/open + /batches/{id}/close wiring. */}
      <div className="mb-3 pb-3 border-b border-[var(--aws-border)]">
        <BatchBand detail={detail} onReload={onReload} />
      </div>

      {/* ── TOTAL roll-up (R10) — always visible, non-collapsible.
          Headlines (Is Balanced / Balance Difference) + the same KV grid
          + percentages strip used per batch below. The operator sees the
          JC-wide aggregate at a glance without expanding any batch. */}
      <div className="mb-3 pb-3 border-b border-[var(--aws-border)]">
        <div className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted)] mb-2">
          Total · across {perBatchSummaries.length}{" "}
          {perBatchSummaries.length === 1 ? "batch" : "batches"}
        </div>
        {renderHeadlines(totalSummary, unbalanced)}
        <SummaryGrid summary={totalSummary} />
      </div>

      {/* ── Per-batch collapsible sections (R10).  Each batch's saved
          metrics get their own card; the currently-selected batch
          starts expanded (so the operator sees the one they're editing),
          others start collapsed. Closed batches surface BatchRow
          snapshot values; the open batch surfaces the LIVE form state
          (substituted in perBatchSummaries upstream). */}
      {perBatchSummaries.map(({ batch, summary: bs }) => {
        const isSelected = batch.batch_id === selectedBatchId;
        const batchUnbalanced = bs.isBalanced === false;
        return (
          <details
            key={batch.batch_id}
            open={isSelected}
            className="mb-2 border border-[var(--aws-border)] rounded-md"
          >
            <summary className="cursor-pointer select-none px-3 py-2 text-[12px] font-semibold text-[var(--text-primary)] flex items-center gap-2 hover:bg-[var(--aws-bg-tint)]">
              <span>Batch {batch.batch_number}</span>
              <span className="text-[10px] font-normal text-[var(--text-muted)]">
                · {batch.status}
                {batch.opened_at_ist ? ` · opened ${batch.opened_at_ist}` : ""}
                {batch.closed_at_ist ? ` · closed ${batch.closed_at_ist}` : ""}
              </span>
              {bs.isBalanced != null ? (
                <span
                  className={[
                    "ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded",
                    bs.isBalanced
                      ? "bg-[#eaf6ed] text-[#1d8102]"
                      : "bg-[#fdf3f1] text-[#b1361e]",
                  ].join(" ")}
                >
                  {bs.isBalanced ? "Balanced" : "Not balanced"}
                </span>
              ) : null}
            </summary>
            <div className="px-3 pb-3 pt-2 border-t border-[var(--aws-border)]">
              {renderHeadlines(bs, batchUnbalanced)}
              <SummaryGrid summary={bs} />
            </div>
          </details>
        );
      })}
    </Panel>
  );
}

// ── Additive "Others" picker — live typeahead against /sku-lookup ─────
//
// Mounted only when the additive row has sku_name === "_other". Lets
// the operator search the global all_sku catalog (not just the curated
// additive category list) so any registered material can be tracked.
// Free-typed text is still preserved if the operator wants an off-
// catalog name — the dropdown is a suggestion, not a constraint.
function AdditiveOtherPicker({
  value, onChange, disabled, className,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [opts, setOpts] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const q = value.trim();
    if (q.length < 2) {
      setOpts([]);
      setOpen(false);
      setActive(-1);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await apiFetch(
          `/api/v1/so/sku-lookup?search=${encodeURIComponent(q)}`,
        );
        if (!res.ok) return;
        const j = (await res.json()) as {
          options?: { particulars?: string[] };
        };
        const list = (j.options?.particulars ?? [])
          .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
          .slice(0, 25);
        if (cancelled) return;
        setOpts(list);
        // Auto-open only when we actually have suggestions to show —
        // avoids an empty popover hanging around on a no-match query.
        setOpen(list.length > 0);
        setActive(-1);
      } catch {
        /* network blip — leave the dropdown alone; the typed text
           remains valid as a free-text custom material name. */
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [value]);

  function pick(name: string) {
    onChange(name);
    setOpen(false);
    setActive(-1);
  }

  return (
    <div className={`relative ${className ?? ""}`}>
      <input
        type="text"
        placeholder="Search SKU…"
        className={inputCls}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => {
          if (opts.length > 0) setOpen(true);
        }}
        onBlur={() => {
          // Delay close so a mousedown on an option still fires.  The
          // ref-stored timer is cleared on unmount so a fast-typing
          // operator doesn't keep the dropdown open after the picker
          // unmounts (sku_name flipped off "_other").
          blurTimer.current = setTimeout(() => setOpen(false), 150);
        }}
        onKeyDown={(e) => {
          if (!open || opts.length === 0) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => Math.min(opts.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter" && active >= 0) {
            e.preventDefault();
            pick(opts[active]);
          } else if (e.key === "Escape") {
            setOpen(false);
            setActive(-1);
          }
        }}
        disabled={disabled}
        aria-disabled={disabled}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
      />
      {open && opts.length > 0 ? (
        <ul
          role="listbox"
          className="absolute z-10 top-full left-0 right-0 mt-0.5 max-h-56 overflow-y-auto bg-white border border-[var(--aws-border-strong)] rounded-[2px] shadow-lg text-[12px]"
        >
          {opts.map((o, idx) => (
            <li key={o}>
              <button
                type="button"
                role="option"
                aria-selected={idx === active}
                onMouseDown={(e) => {
                  // Pre-empt blur so the click lands before the
                  // 150 ms close timer fires above.
                  e.preventDefault();
                  if (blurTimer.current) clearTimeout(blurTimer.current);
                  pick(o);
                }}
                className={[
                  "w-full text-left px-2 py-1.5 hover:bg-[var(--surface-subtle)]",
                  idx === active ? "bg-[var(--surface-subtle)]" : "",
                ].join(" ")}
              >
                {o}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function pctOrDash(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(2)}%`;
}

// Threshold-aware loss-pct chip. Returns a coloured / bold span when
// the value exceeds `threshold`, plain text otherwise. Display-only —
// the /complete closure gate uses is_balanced, not these thresholds.
//
// Caller passes the threshold in %-units (e.g. 1.5 for "1.5 %"); rule
// is strict-greater-than so a value sitting AT the threshold stays
// neutral (e.g. exactly 1.50 % Process Loss is still in band).
function lossPctChip(
  v: number | null | undefined,
  threshold: number,
): React.ReactNode {
  if (v == null || !Number.isFinite(v)) {
    return <span className="text-[var(--text-muted)]">—</span>;
  }
  const over = v > threshold;
  return (
    <span
      className={over ? "text-[var(--aws-error)] font-semibold" : ""}
      title={over ? `Exceeds operator threshold of ${threshold.toFixed(2)} %` : undefined}
    >
      {v.toFixed(2)}%
    </span>
  );
}

// VarianceChip — small inline chip per consumption row showing BOM vs actual.
// Colour bands (asymmetric on purpose — see framework spec C3-H4):
//   |variance%| ≤ 5  → neutral grey  (within expected operating noise)
//   diff > 0 & ≤ 15  → amber          (over-consumed, worth a look)
//   diff > 0 & > 15  → red            (over-consumed, likely needs investigation)
//   diff < 0         → neutral grey   (under-consumption is informational only)
// Under-consumption is intentionally left neutral: the operator may have
// genuinely measured short (legitimate yield win, or pre-tare on the scale)
// and the variance chip is a QTY-only informational widget per the framework
// spec — it must NOT imply a quality / costing alarm. Costing concerns sit
// elsewhere (see memory: consumption-variance-staging). Qty-only — no
// currency. The tooltip below explains the asymmetric colour choice.
function VarianceChip({
  materialName, bomPrescribedQty, actualQty, uom, hasSavedConsumption, plannedKg,
}: {
  materialName: string;
  bomPrescribedQty: number | null;
  actualQty: number;
  uom: string;
  /** True when the server already has a consumption_lines row for this
   *  material. Used to suppress the "BOM X · actual —" hint on fresh JCs
   *  where the operator hasn't typed anything yet AND nothing's saved
   *  (C3-MED-7). */
  hasSavedConsumption: boolean;
  /** planned_qty_kg on the JC. When this is 0 / missing the server can't
   *  compute a prescribed qty either, so we surface a more specific hint
   *  than "no BOM variance available" (C3-MED-8). */
  plannedKg: number;
}) {
  // C3-MED-8 — distinguish the two reasons the chip can't show variance:
  //   (a) planned_qty_kg on the JC is missing / zero (BOM math has no
  //       multiplier)
  //   (b) the BOM line is missing quantity_per_unit altogether
  // The previous unified message hid an actionable signal — a missing
  // planned_qty is fixable from the SO / plan, but a missing BOM
  // quantity_per_unit needs a BOM amendment.
  if (bomPrescribedQty == null || !Number.isFinite(bomPrescribedQty) || bomPrescribedQty <= 0) {
    const hint = plannedKg <= 0
      ? "planned qty missing"
      : "no BOM variance available";
    return (
      <span className="inline-block text-[10px] text-[var(--text-muted)] italic">
        {hint}
      </span>
    );
  }
  // C3-MED-7 — operator hasn't typed anything AND nothing's saved on the
  // server. Suppress the chip entirely; it would otherwise read "BOM X kg
  // · actual —" on every consumption row of a freshly-opened JC.
  if (!Number.isFinite(actualQty) || actualQty <= 0) {
    if (!hasSavedConsumption) return null;
    return (
      <span className="inline-block text-[10px] text-[var(--text-muted)] italic">
        BOM {bomPrescribedQty.toFixed(2)} {uom} · actual —
      </span>
    );
  }
  const diff = actualQty - bomPrescribedQty;
  const pct = (diff / bomPrescribedQty) * 100;
  const sign = diff > 0 ? "+" : "";
  const absPct = Math.abs(pct);

  // Colour band — under-consumption (diff < 0) is always neutral. See the
  // tooltip below for the rationale.
  let cls = "bg-[#f4f4f4] border-[#d5dbdb] text-[var(--text-secondary)]";
  if (diff > 0 && absPct > 15) {
    cls = "bg-[#fdf3f1] border-[#f0c7be] text-[#b1361e]";
  } else if (diff > 0 && absPct > 5) {
    cls = "bg-[#fff4e5] border-[#f4d4a0] text-[#9a5b00]";
  }

  // C3-H4 — the asymmetric tooltip clarifies WHY under-consumption stays
  // neutral. Visible on hover + announced by AT (title is read after a
  // brief delay on most screen readers). Keeps the rule discoverable
  // without bloating the chip itself.
  const asymmetryNote = diff < 0
    ? " · under-consumption is informational only (no colour band)"
    : "";

  return (
    <span
      title={`${materialName} · BOM ${bomPrescribedQty.toFixed(2)} ${uom} · Actual ${actualQty.toFixed(2)} ${uom}${asymmetryNote}`}
      className={[
        "inline-block text-[10px] sm:text-[11px] rounded-full border px-2 py-0.5 leading-tight whitespace-normal",
        cls,
      ].join(" ")}
    >
      <span className="font-semibold">BOM</span> {bomPrescribedQty.toFixed(2)} {uom}
      <span className="mx-1 text-[var(--text-muted)]">·</span>
      <span className="font-semibold">Actual</span> {actualQty.toFixed(2)} {uom}
      <span className="mx-1 text-[var(--text-muted)]">·</span>
      <span className="font-semibold">{sign}{diff.toFixed(2)} {uom}</span>
      <span className="ml-1">({sign}{pct.toFixed(1)}%)</span>
    </span>
  );
}

function SubsectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`text-[11px] uppercase tracking-wide font-semibold text-[var(--text-secondary)] mt-2 mb-2 ${className ?? ""}`}>
      {children}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
//  QUALITY TAB — mirrors QualityFragment exactly.
//
//  Five sections:
//    1. Metal Detection records (read-only list)
//    2. Add Metal Check form        → POST /metal-detection (button per click)
//    3. Weight Checks (target/tolerance + 20 samples; net/gross/leak)
//    4. Environment (4 fixed params)
//    5. QC Sample Consumed (sample weight)
//    6. QC Verification (passed + findings)
//
//  Bottom Save Quality dispatches chained POSTs:
//    weight samples (one per sample) → environment params (one per param)
//    → QC verification (as a remark on v2: addRemark with structured content)
// ═════════════════════════════════════════════════════════════════════════════

function QualityTab({ detail, onReload }: { detail: JobCardDetail; onReload: () => void }) {
  const metalRecords = detail.annexure_a_b_metal_detection ?? [];
  const envRecords   = detail.annexure_c_environment ?? [];
  // C3: lock gate. /metal-detection /weight-checks /environment /remarks all
  // 409 when locked. Combine with the per-section busy flags so the existing
  // submit-in-flight UI keeps working unchanged when the JC is unlocked.
  const lock = useLockState(detail);

  // ── Metal Detection (single-add form) ──────────────────────────────────
  const [mdCheckType, setMdCheckType] = useState<string>(METAL_CHECK_TYPES[1].value); // post_packaging default
  const [mdFe, setMdFe] = useState<boolean | null>(null);
  const [mdNfe, setMdNfe] = useState<boolean | null>(null);
  const [mdSs, setMdSs] = useState<boolean | null>(null);
  const [mdSeal, setMdSeal] = useState<boolean | null>(null);
  const [mdWt, setMdWt] = useState<boolean | null>(null);
  const [mdFailed, setMdFailed] = useState("");
  const [mdDough, setMdDough] = useState("");
  const [mdOven, setMdOven] = useState("");
  const [mdBaking, setMdBaking] = useState("");
  const [mdRemarks, setMdRemarks] = useState("");
  const [addingMetal, setAddingMetal] = useState(false);

  // ── Weight Checks ──────────────────────────────────────────────────────
  const [targetWt, setTargetWt] = useState("");
  const [tolerance, setTolerance] = useState("");
  const [samples, setSamples] = useState(
    Array.from({ length: WEIGHT_SAMPLES }, () => ({ net: "", gross: "", leak: false })),
  );
  function updateSample(i: number, patch: Partial<{ net: string; gross: string; leak: boolean }>) {
    setSamples((arr) => arr.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  }

  // ── Environment ────────────────────────────────────────────────────────
  const [envValues, setEnvValues] = useState<Record<string, string>>({});

  // ── QC Sample Consumed ────────────────────────────────────────────────
  // R10/C6 — replaced with a read-only summary pulled from the saved
  // byproducts (category='control_sample'). The single source of truth
  // for the value is the Output & Accounting tab.
  const controlSampleKgSaved = useMemo(
    () => controlSampleFromDetail(detail.byproducts, detail.balance_materials),
    [detail.byproducts, detail.balance_materials],
  );

  // ── QC Verification ────────────────────────────────────────────────────
  const [qcPassed, setQcPassed] = useState<boolean | null>(null);
  const [qcFindings, setQcFindings] = useState("");

  // R12/C8 — server-stamped QC sign-off. job_card_sign_off_v2 holds the
  // role='qc_inspector' row written when QC ticks the box; we surface it
  // read-only here so the operator can see who verified and when.
  //
  // W3-MED-4 — sort by signed_at DESC, secondary by sign_off_id, before
  // picking [0]. Without this we'd surface whichever qc_inspector row
  // happened to land first in the array — for re-verified JCs that's the
  // OLD sign-off, not the latest one.
  const qcSignOff = useMemo(() => {
    const rows = (detail.sign_offs ?? []).filter((r) => {
      const role = String((r as Record<string, unknown>)["role"] ?? "");
      return role === "qc_inspector";
    });
    if (rows.length === 0) return null;
    const sorted = [...rows].sort((a, b) => {
      const ar = a as Record<string, unknown>;
      const br = b as Record<string, unknown>;
      const at = String(ar["signed_at"] ?? "");
      const bt = String(br["signed_at"] ?? "");
      if (at !== bt) return at < bt ? 1 : -1;
      const aid = Number(ar["sign_off_id"] ?? 0);
      const bid = Number(br["sign_off_id"] ?? 0);
      return bid - aid;
    });
    const r = sorted[0] as Record<string, unknown>;
    return {
      signedBy: String(r["signed_by"] ?? ""),
      signedAt: String(r["signed_at"] ?? ""),
    };
  }, [detail.sign_offs]);

  // R12/C8 — role-gating for the QC Verification Passed checkbox.
  // C1 (Wave 4) — useMe() so a role change mid-session flips the gate
  // without a reload.
  const me = useMe();
  const canVerifyQc = userIsQcOrAdmin(me);

  // R12/C8 — "Notify QC" CTA only renders on completed JCs.
  //
  // W3-HIGH-4 — `notifyFeedback` is namespaced separately from the shared
  // `feedback` slot used by Save Quality. Without this they fought each
  // other (a Notify QC success transient overwrote a Save Quality error
  // and vice-versa).
  // W3-HIGH-2 — parse the JSON response. The backend returns
  // { dispatched, failed, warning? }; when no QC inspector is scoped to
  // the JC the route returns 200 with warning='no_qc_recipients_in_scope'
  // (no rows actually dispatched). We surface that distinctly as an
  // orange/warn toast rather than a generic green "notified" so the
  // operator escalates instead of assuming QC was paged.
  const [notifyingQc, setNotifyingQc] = useState(false);
  const [notifyFeedback, setNotifyFeedback] = useState<{ kind: "ok" | "err" | "warn"; msg: string } | null>(null);
  async function notifyQc() {
    setNotifyFeedback(null);
    setNotifyingQc(true);
    try {
      const res = await apiFetch(`/api/v1/production/job-cards-v2/${detail.job_card_id}/notify-qc`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => null)) as
        | { dispatched?: number; failed?: number; warning?: string; message?: string; error?: string }
        | null;
      if (!res.ok) {
        const msg = (data && (data.message || data.error)) || `HTTP ${res.status}`;
        throw new Error(String(msg));
      }
      const dispatched = typeof data?.dispatched === "number" ? data.dispatched : 0;
      const failed     = typeof data?.failed     === "number" ? data.failed     : 0;
      if (data?.warning === "no_qc_recipients_in_scope") {
        setNotifyFeedback({
          kind: "warn",
          msg: "Notification sent but no QC inspector is scoped to this JC.",
        });
      } else {
        setNotifyFeedback({
          kind: "ok",
          msg: `Notify QC: ${dispatched} dispatched, ${failed} failed`,
        });
      }
    } catch (e) {
      setNotifyFeedback({
        kind: "err",
        msg: friendlyApiError(e),
      });
    } finally {
      setNotifyingQc(false);
    }
  }

  const [savingQuality, setSavingQuality] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  // ── Add metal-check (standalone POST) ──────────────────────────────────
  async function addMetalCheck() {
    setFeedback(null);
    const body: Record<string, unknown> = {
      check_type: mdCheckType || "post_packaging",
      failed_units: mdFailed ? parseInt(mdFailed, 10) : 0,
    };
    if (mdFe  !== null) body.fe_pass  = mdFe;
    if (mdNfe !== null) body.nfe_pass = mdNfe;
    if (mdSs  !== null) body.ss_pass  = mdSs;
    if (mdRemarks.trim()) body.remarks = mdRemarks.trim();
    // Seal/Wt/Dough/Oven/Baking aren't on the v2 schema (see comment in
    // QualityFragment.saveMetalDetection). Captured in the form for parity
    // but not transmitted on v2.

    setAddingMetal(true);
    try {
      const res = await apiFetch(`/api/v1/production/job-cards-v2/${detail.job_card_id}/metal-detection`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setFeedback({ kind: "ok", msg: "Metal check saved." });
      // Reset just the metal form
      setMdFe(null); setMdNfe(null); setMdSs(null); setMdSeal(null); setMdWt(null);
      setMdFailed(""); setMdDough(""); setMdOven(""); setMdBaking(""); setMdRemarks("");
      onReload();
    } catch (e) {
      setFeedback({ kind: "err", msg: friendlyApiError(e) });
    } finally {
      setAddingMetal(false);
    }
  }

  // ── Save Quality (chained) ─────────────────────────────────────────────
  // Mirrors saveQuality → submitWeightChecksChained → submitEnvironmentChained
  // → saveQcVerificationChained from QualityFragment.java. Each phase POSTs
  // one row at a time and surfaces a "saving X of N" progress hint between
  // requests. A failure mid-chain aborts and leaves earlier successful
  // writes intact on the server (operator can retry the failed phase).
  //
  // W3-MED-2 — read the server's JSON error envelope on !ok. The QC routes
  // return { error, message } on a 403 (qc_scope_mismatch). Surfacing the
  // message verbatim is materially better than "HTTP 403" because it
  // tells the operator exactly which scope is mismatched.
  async function readErrMsg(res: Response, fallback: string): Promise<string> {
    try {
      const data = (await res.json()) as { message?: string; error?: string } | null;
      if (data && (data.message || data.error)) {
        return String(data.message || data.error);
      }
    } catch { /* fall through */ }
    return fallback;
  }
  async function saveQuality() {
    setFeedback(null);
    setSavingQuality(true);
    try {
      // ── Weight samples ─────────────────────────────────────────────
      const samplesToSend = samples
        .map((s, i) => ({ idx: i + 1, ...s }))
        .filter((s) => s.net.trim() !== "" || s.gross.trim() !== "");
      for (let k = 0; k < samplesToSend.length; k++) {
        setProgress(`Saving sample ${k + 1} of ${samplesToSend.length}…`);
        const s = samplesToSend[k];
        const body: Record<string, unknown> = {
          sample_number: s.idx,
          leak_test_pass: !!s.leak,
        };
        if (s.net.trim())   body.net_weight   = parseFloat(s.net);
        if (s.gross.trim()) body.gross_weight = parseFloat(s.gross);
        const res = await apiFetch(`/api/v1/production/job-cards-v2/${detail.job_card_id}/weight-checks`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const msg = await readErrMsg(res, `HTTP ${res.status}`);
          throw new Error(`Sample ${s.idx} failed: ${msg}`);
        }
      }

      // ── Environment params ────────────────────────────────────────
      // EnvironmentAddRequest.value is `str | None` on the backend — same
      // as the Android EnvironmentRequest.Param.value field — so we send
      // the raw operator input as a string instead of parsing to float.
      // Brine salinity / temperature etc. are sometimes recorded as
      // ranges ("18-22") that wouldn't survive parseFloat.
      const envEntries = Object.entries(envValues).filter(([, v]) => v.trim() !== "");
      for (let k = 0; k < envEntries.length; k++) {
        const [paramKey, val] = envEntries[k];
        setProgress(`Saving environment ${k + 1} of ${envEntries.length}…`);
        const body: Record<string, unknown> = {
          parameter_name: paramKey,
          value: val.trim(),
        };
        const res = await apiFetch(`/api/v1/production/job-cards-v2/${detail.job_card_id}/environment`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const msg = await readErrMsg(res, `HTTP ${res.status}`);
          throw new Error(`Environment "${paramKey}" failed: ${msg}`);
        }
      }

      // ── QC Verification (recorded as a remark on v2) ──────────────
      const hasFindings = qcFindings.trim().length > 0;
      const failed = qcPassed === false;
      if (hasFindings || failed) {
        setProgress("Finalising QC verification…");
        const remark = `[QC verdict: ${failed ? "FAIL" : qcPassed ? "PASS" : "—"}] ${hasFindings ? qcFindings.trim() : "(no findings recorded)"}`;
        const body = {
          remark_type: failed ? "deviation" : "corrective_action",
          content: remark,
        };
        const res = await apiFetch(`/api/v1/production/job-cards-v2/${detail.job_card_id}/remarks`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const msg = await readErrMsg(res, `HTTP ${res.status}`);
          throw new Error(`QC verdict remark failed: ${msg}`);
        }
      }

      setFeedback({ kind: "ok", msg: "Quality saved." });
      onReload();
    } catch (e) {
      setFeedback({ kind: "err", msg: friendlyApiError(e) });
    } finally {
      setProgress(null);
      setSavingQuality(false);
    }
  }

  // Per-section disabled flags — combined with the lock state + R10
  // lifecycle gate (fields stay read-only until START is clicked).
  const lifecycleLocked = isLifecycleLocked(detail.status);
  const metalDisabled = addingMetal || lock.isLocked || lifecycleLocked;
  const qualityDisabled = savingQuality || lock.isLocked || lifecycleLocked;

  return (
    <>
      {/* C3 lock banner — sits above every Quality form below. Only renders
          when the JC is operationally locked. The CTA runs the same
          force-unlock flow as the OverflowMenu (C3-H1). */}
      <LockBanner
        isLocked={lock.isLocked}
        lockedReason={lock.lockedReason}
        status={lock.status}
        jcId={detail.job_card_id}
        onForceUnlockClick={() => void runForceUnlockJc(
          detail.job_card_id,
          userStore.load()?.full_name ?? "",
          onReload,
        )}
      />

      {/* R12/C8 — Notify QC CTA. Only renders when the JC is completed
          (the backend rejects this on any other status). The route
          POST /notify-qc fans out the in-app notification to QC users.
          W3-HIGH-4 — `notifyFeedback` is rendered next to the button so it
          doesn't clobber the shared `feedback` slot used by Save Quality. */}
      {detail.status === "completed" ? (
        <div className="mb-4 flex flex-col sm:flex-row sm:items-center sm:justify-end gap-2">
          {notifyFeedback ? (
            <p
              className={[
                "text-[12px]",
                notifyFeedback.kind === "ok"
                  ? "text-[var(--text-success)]"
                  : notifyFeedback.kind === "warn"
                    ? "text-[var(--aws-orange-active)]"
                    : "text-[var(--aws-error)]",
              ].join(" ")}
            >
              {notifyFeedback.msg}
            </p>
          ) : null}
          {/* C10 (Wave 4) — Notify QC via LockableButton. Lock disables for
              non-force-unlock users; admin / floor_manager / plant_manager /
              inventory_manager still see an enabled button. */}
          <LockableButton
            lockState={lock}
            busy={notifyingQc}
            busyLabel="Notifying…"
            onClick={() => void notifyQc()}
            title="Notify the QC team that this job card is ready for verification."
          >
            Notify QC
          </LockableButton>
        </div>
      ) : null}

      {/* ── 1. Metal Detection records ──────────────────────────────────── */}
      <Panel title={`Metal Detection · ${metalRecords.length} record${metalRecords.length === 1 ? "" : "s"}`}>
        {metalRecords.length === 0 ? (
          <EmptyHint>No metal-detection checks recorded yet.</EmptyHint>
        ) : (
          <RowTable
            rows={metalRecords}
            columns={[
              { key: "recorded_at",  label: "When", render: (v) => fmtDateTime(String(v ?? "")) },
              { key: "check_type",   label: "Type", hideBelow: "sm" },
              { key: "fe_pass",      label: "Fe",  render: (v) => renderPass(v) },
              { key: "nfe_pass",     label: "NFe", render: (v) => renderPass(v) },
              { key: "ss_pass",      label: "SS",  render: (v) => renderPass(v) },
              { key: "failed_units", label: "Failed", hideBelow: "sm" },
              { key: "remarks",      label: "Remarks", hideBelow: "md" },
            ]}
          />
        )}
      </Panel>

      {/* ── 2. Add Metal Check ──────────────────────────────────────────── */}
      <Panel title="Add Metal Check">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-3">
          <FormSelect label="Check type" value={mdCheckType} onChange={setMdCheckType} disabled={metalDisabled} options={METAL_CHECK_TYPES} />
        </div>
        <div className="grid grid-cols-3 gap-3 mb-3">
          <FormCheckbox label="Fe"  value={mdFe}  onChange={setMdFe}  disabled={metalDisabled} />
          <FormCheckbox label="NFe" value={mdNfe} onChange={setMdNfe} disabled={metalDisabled} />
          <FormCheckbox label="SS"  value={mdSs}  onChange={setMdSs}  disabled={metalDisabled} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
          <FormNumber label="Failed units" value={mdFailed} onChange={setMdFailed} disabled={metalDisabled} />
          <FormCheckbox label="Seal Check" value={mdSeal} onChange={setMdSeal} disabled={metalDisabled} />
          <FormCheckbox label="Wt Check"   value={mdWt}   onChange={setMdWt}   disabled={metalDisabled} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
          <FormNumber label="Dough Temp (°C)"  value={mdDough}  onChange={setMdDough}  disabled={metalDisabled} />
          <FormNumber label="Oven Temp (°C)"   value={mdOven}   onChange={setMdOven}   disabled={metalDisabled} />
          <FormNumber label="Baking Temp (°C)" value={mdBaking} onChange={setMdBaking} disabled={metalDisabled} />
        </div>
        <FormText label="Remarks" value={mdRemarks} onChange={setMdRemarks} disabled={metalDisabled} />
        <div className="mt-3 flex items-center justify-end">
          {/* C10 (Wave 4) — Add metal check via LockableButton. */}
          <LockableButton
            lockState={lock}
            busy={addingMetal}
            busyLabel="Saving…"
            disabled={addingMetal}
            onClick={addMetalCheck}
          >
            Add metal check
          </LockableButton>
        </div>
      </Panel>

      {/* ── 3. Weight Checks ────────────────────────────────────────────── */}
      <Panel title="Weight Checks">
        <p className="text-[11px] text-[var(--text-muted)] italic mb-3">
          Target weight and tolerance are operator-reference only — the v2
          backend stores the samples but not the target/tolerance header.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
          <FormNumber label="Target wt (g)" value={targetWt} onChange={setTargetWt} disabled={qualityDisabled} />
          <FormNumber label="Tolerance (±g)" value={tolerance} onChange={setTolerance} disabled={qualityDisabled} />
        </div>
        <SubsectionLabel>Samples ({WEIGHT_SAMPLES})</SubsectionLabel>
        {/* Mobile-friendly samples — narrow viewports hide gross column, the
            net + leak still fit. Net carries the gross value in its title
            attribute so it isn't lost. */}
        <div>
          <table className="w-full text-[12px]">
            <thead className="text-[10px] uppercase text-[var(--text-muted)]">
              <tr>
                <th className="text-left px-2 py-1">#</th>
                <th className="text-left px-2 py-1">Net (g)</th>
                <th className="text-left px-2 py-1 hidden sm:table-cell">Gross (g)</th>
                <th className="text-left px-2 py-1">Leak</th>
              </tr>
            </thead>
            <tbody>
              {samples.map((s, i) => (
                <tr key={i} className="border-b border-[var(--aws-border)]">
                  <td className="px-2 py-1 text-[var(--text-secondary)]">{i + 1}</td>
                  <td className="px-2 py-1">
                    <input type="number" step="any" className={inputCls} value={s.net} onChange={(e) => updateSample(i, { net: e.target.value })} onWheel={(e) => (e.currentTarget as HTMLInputElement).blur()} disabled={qualityDisabled} aria-disabled={qualityDisabled} />
                  </td>
                  <td className="px-2 py-1 hidden sm:table-cell">
                    <input type="number" step="any" className={inputCls} value={s.gross} onChange={(e) => updateSample(i, { gross: e.target.value })} onWheel={(e) => (e.currentTarget as HTMLInputElement).blur()} disabled={qualityDisabled} aria-disabled={qualityDisabled} />
                  </td>
                  <td className="px-2 py-1">
                    <input type="checkbox" className="accent-[var(--aws-orange)] w-4 h-4 disabled:opacity-50 disabled:cursor-not-allowed" checked={s.leak} onChange={(e) => updateSample(i, { leak: e.target.checked })} disabled={qualityDisabled} aria-disabled={qualityDisabled} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* ── 4. Environment ──────────────────────────────────────────────── */}
      <Panel title={`Environment · ${envRecords.length} previous reading${envRecords.length === 1 ? "" : "s"}`}>
        {envRecords.length > 0 ? (
          <div className="mb-3">
            <RowTable
              rows={envRecords}
              columns={[
                { key: "recorded_at",    label: "When", render: (v) => fmtDateTime(String(v ?? "")), hideBelow: "sm" },
                { key: "parameter_name", label: "Parameter" },
                { key: "value",          label: "Value" },
                { key: "unit",           label: "Unit" },
              ]}
            />
          </div>
        ) : null}
        <SubsectionLabel>New readings</SubsectionLabel>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {ENV_PARAMS.map((p) => (
            <FormText
              key={p.key}
              label={p.label}
              value={envValues[p.key] ?? ""}
              onChange={(v) => setEnvValues((m) => ({ ...m, [p.key]: v }))}
              disabled={qualityDisabled}
              placeholder="value"
            />
          ))}
        </div>
      </Panel>

      {/* ── 5. QC Sample (read-only summary; R10/C6) ──────────────────── */}
      <Panel title="QC Sample">
        <p className="text-[11px] text-[var(--text-muted)] italic mb-3">
          Recorded on the Accounting tab. Read-only here.
        </p>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
          <KV
            label="Control Sample (kg)"
            value={
              controlSampleKgSaved.trim() === ""
                ? "—"
                : `${num(controlSampleKgSaved).toFixed(3)} kg`
            }
          />
        </dl>
      </Panel>

      {/* ── 6. QC Verification (R12/C8) ─────────────────────────────────── */}
      <Panel title="QC Verification">
        {/* Server-stamped sign-off card. Visible once the QC team has
            ticked the verification on the backend. */}
        <div className="mb-3 rounded-md border border-[var(--aws-border)] bg-[var(--surface-subtle)] p-3">
          <FormLabel>Verified by</FormLabel>
          {qcSignOff && qcSignOff.signedBy.trim() ? (
            <div className="text-[13px] text-[var(--text-primary)]">
              Verified by <span className="font-semibold">{qcSignOff.signedBy}</span>
              {qcSignOff.signedAt ? (
                <> at <span className="font-mono text-[12px]">{qcSignOff.signedAt}</span></>
              ) : null}
            </div>
          ) : (
            <div className="text-[12px] text-[var(--text-muted)] italic">
              Not yet verified.
            </div>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
          <div title={!canVerifyQc ? "Only QC team can verify this JC." : undefined}>
            <FormCheckbox
              label="QC Verification Passed"
              value={qcPassed}
              onChange={setQcPassed}
              disabled={qualityDisabled || !canVerifyQc}
            />
            {!canVerifyQc ? (
              <p className="mt-1 text-[10px] text-[var(--text-muted)] italic">
                Only QC team can verify this JC.
              </p>
            ) : null}
          </div>
        </div>
        <FormText label="Findings / remarks" value={qcFindings} onChange={setQcFindings} disabled={qualityDisabled} />
      </Panel>

      {/* ── Save Quality ────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-6">
        {/* C10 (Wave 4) — Save Quality via LockableButton. Keeps the
            chained-POST progress + feedback handling next to the button. */}
        <LockableButton
          lockState={lock}
          busy={savingQuality}
          busyLabel="Saving…"
          disabled={savingQuality}
          onClick={saveQuality}
          variant="primary"
          className="h-9 px-4 text-[13px] font-bold tracking-wide"
        >
          SAVE QUALITY
        </LockableButton>
        {progress ? (
          <span className="text-[12px] text-[var(--text-secondary)]">{progress}</span>
        ) : feedback ? (
          <span className={["text-[12px]", feedback.kind === "ok" ? "text-[var(--text-success)]" : "text-[var(--aws-error)]"].join(" ")}>
            {feedback.msg}
          </span>
        ) : null}
      </div>
    </>
  );
}

function renderPass(v: unknown): React.ReactNode {
  if (v === true || v === "true") return <span className="text-[var(--text-success)] font-semibold">Pass</span>;
  if (v === false || v === "false") return <span className="text-[var(--aws-error)] font-semibold">Fail</span>;
  return "—";
}

// ── Form primitives ───────────────────────────────────────────────────────

function FormLabel({ children }: { children: React.ReactNode }) {
  return <span className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">{children}</span>;
}

const inputCls =
  "w-full h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] disabled:bg-[var(--surface-disabled)] disabled:text-[#879596]";

function FormText({ label, value, onChange, disabled, placeholder }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean; placeholder?: string }) {
  return (
    <label className="block">
      <FormLabel>{label}</FormLabel>
      <input type="text" className={inputCls} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} placeholder={placeholder} />
    </label>
  );
}
function FormNumber({ label, value, onChange, disabled, placeholder }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean; placeholder?: string }) {
  // onWheel→blur: <input type="number"> increments on mouse-wheel by
  // default, so scrolling past a row of inputs randomly mutates values.
  // Blurring the focused field on wheel disables that behaviour without
  // breaking explicit click-then-scroll editing — the operator can
  // re-focus to nudge a value if they truly want to.
  return (
    <label className="block">
      <FormLabel>{label}</FormLabel>
      <input
        type="number"
        step="any"
        className={inputCls}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onWheel={(e) => (e.currentTarget as HTMLInputElement).blur()}
        disabled={disabled}
        placeholder={placeholder}
      />
    </label>
  );
}
function FormSelect({ label, value, onChange, disabled, options }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean; options: { value: string; label: string }[] }) {
  return (
    <label className="block">
      <FormLabel>{label}</FormLabel>
      <select className={inputCls} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

function FormCheckbox({ label, value, onChange, disabled }: { label: string; value: boolean | null; onChange: (v: boolean | null) => void; disabled?: boolean }) {
  // Three-state Pass / Fail / —. Matches the Android tri-state captured by
  // the various pass checkboxes (cbFePass etc.) where null means "not
  // recorded" rather than "fail".
  function cycle() {
    if (value === null) onChange(true);
    else if (value === true) onChange(false);
    else onChange(null);
  }
  const display = value === null ? "—" : value ? "Pass" : "Fail";
  const color =
    value === null ? "bg-white text-[var(--text-secondary)]" :
    value ? "bg-[#eaf6ed] text-[var(--text-success)] border-[#b6dbb1]" :
    "bg-[#fdf3f1] text-[#b1361e] border-[#f0c7be]";
  return (
    <div className="block">
      <FormLabel>{label}</FormLabel>
      <button type="button" onClick={cycle} disabled={disabled} className={["w-full h-8 px-2 text-[13px] rounded-[2px] border text-left", color].join(" ")}>
        {display}
      </button>
    </div>
  );
}

function FormFooter({
  feedback, submitting, submitLabel, disabled, extraActions,
}: {
  feedback: { kind: "ok" | "err"; msg: string } | null;
  submitting: boolean;
  submitLabel: string;
  /** C3: extra disable flag (e.g. JC is locked). When true, the submit
   *  button is disabled with an aria-disabled hint even outside the
   *  submitting state. */
  disabled?: boolean;
  /** Optional siblings rendered immediately after the submit button so
   *  callers can colocate related actions (e.g. Close Batch next to
   *  Save/Edit Batch) without rebuilding the layout. */
  extraActions?: React.ReactNode;
}) {
  // C10 (Wave 4) — submit button delegated to ActionButton. type="submit"
  // keeps the native form-submit pathway intact so the existing onSubmit
  // handlers (saveOutput / addRemark / assignTeam) keep working unchanged.
  // No role gate here — the form-submit button itself is open to any
  // signed-in user; the JC lock + submit-in-flight + caller-supplied
  // `disabled` cover the per-form gating. Lock-aware variants live in
  // the call sites that need them (Save Quality, Notify QC, ActionBar).
  return (
    <div className="mt-2 mb-6 flex flex-col sm:flex-row sm:items-center gap-3">
      <ActionButton
        type="submit"
        busy={submitting}
        busyLabel="Saving…"
        disabled={!!disabled}
        variant="primary"
        className="h-9 px-4 text-[13px] font-bold tracking-wide"
      >
        {submitLabel}
      </ActionButton>
      {extraActions}
      {feedback ? (
        <span className={["text-[12px]", feedback.kind === "ok" ? "text-[var(--text-success)]" : "text-[var(--aws-error)]"].join(" ")}>
          {feedback.msg}
        </span>
      ) : null}
    </div>
  );
}

// ── Row table ─────────────────────────────────────────────────────────────

type Column = {
  key: string;
  label: string;
  render?: (v: unknown, row: Record<string, unknown>) => React.ReactNode;
  /** Drop this column below the given breakpoint — mobile-first column
   *  hiding per the repo responsive convention (no horizontal scroll). */
  hideBelow?: "sm" | "md" | "lg";
};

// Literal class strings so Tailwind's scanner keeps them in the build.
const COL_HIDE_CLS: Record<NonNullable<Column["hideBelow"]>, string> = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
};

function RowTable({ rows, columns }: { rows: Array<Record<string, unknown>>; columns: Column[] }) {
  return (
    <div>
      <table className="w-full text-[13px] border-collapse">
        <thead className="bg-[var(--surface-subtle)]">
          <tr className="border-b border-[var(--aws-border)]">
            {columns.map((c) => (
              <th key={c.key} className={`px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-[var(--text-secondary)] ${c.hideBelow ? COL_HIDE_CLS[c.hideBelow] : ""}`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-[var(--aws-border)]">
              {columns.map((c) => {
                const raw = row[c.key];
                const display = c.render ? c.render(raw, row) : raw == null || raw === "" ? "—" : String(raw);
                return (
                  <td key={c.key} className={`px-3 py-2 align-top max-w-[160px] sm:max-w-[260px] truncate ${c.hideBelow ? COL_HIDE_CLS[c.hideBelow] : ""}`} title={typeof display === "string" ? display : undefined}>
                    {display}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
