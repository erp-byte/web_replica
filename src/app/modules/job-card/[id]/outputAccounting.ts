// Pure re-hydration helpers for the Output / Accounting form.
//
// Extracted so the save -> reload -> display round-trip is unit-testable
// without React. The web Output tab used to initialise the per-line inputs
// empty and only re-synced the scalar FG fields, so saved Material
// Consumption / Balance / Rejection values blanked on reload even though they
// persisted in the DB. These helpers rebuild the form state from the JC detail
// payload (job_card_v2.get_job_card), mirroring the Electron client's prefill
// (frontend_replica .../job-card-detail.js: actual_consumed_qty round-trip).
//
// Key scheme MUST match the input grid in page.tsx:
//   a.bom_line_id != null ? `b${bom_line_id}` : `n${material name}`

export type RejectionRow = {
  category: string;
  bomLineId: number | null;
  materialName: string;
  qty: string;
  remarks: string;
};

export type ConsumptionLineLike = {
  bom_line_id?: number | null;
  material_sku_name?: string | null;
  actual_consumed_qty?: number | string | null;
  // Slice 4: RM | PM | SFG | WIP. Re-hydration keys by bom_line_id/name so it
  // already round-trips SFG rows; carried on the type so callers can classify
  // input-vs-PM consistently with the grid's mass-balance predicates.
  input_kind?: string | null;
  // Stage 2: migration 038 tags every row with the batch it belongs to.
  // Legacy rows surface NULL until they're re-saved under a batch.
  batch_id?: number | null;
};

export type BalanceRowLike = {
  bom_line_id?: number | null;
  material_name?: string | null;
  balance_type?: string | null;
  qty_kg?: number | string | null;
  remarks?: string | null;
  batch_id?: number | null;
};

export type ByproductRowLike = {
  category?: string | null;
  qty_kg?: number | string | null;
  uom?: string | null;
  remarks?: string | null;
  // Migration 034: per-row article attribution. Both nullable —
  // control_sample / pm_* / dust etc. don't carry an article.
  material_name?: string | null;
  bom_line_id?: number | null;
  batch_id?: number | null;
};

/** Stage 3 batch filter sentinel.
 *  - A number       → include only rows whose batch_id equals it.
 *  - The literal null → include only legacy rows whose batch_id IS NULL.
 *  - undefined      → no filter (show everything; used by the rollup view).
 *
 *  Filtering happens in the FromDetail helpers below so the form state
 *  always reflects the picked batch in the selector dropdown. */
export type BatchFilter = number | null | undefined;

function matchesBatch<T extends { batch_id?: number | null }>(
  row: T,
  filter: BatchFilter,
): boolean {
  if (filter === undefined) return true;
  if (filter === null) return row.batch_id == null;
  // Defense in depth — rows with batch_id=NULL should always surface under
  // the currently selected batch instead of vanishing. Three real sources
  // of null batch_id we want to tolerate gracefully:
  //   1. Legacy rows written before migration 036 added the column (rare
  //      now, but still on prod for old JCs).
  //   2. record_output rows written before the recent service fix that
  //      added batch_id to the INSERT (server_replica 7482956). The
  //      backfill migration 046 catches most of these, but JCs whose
  //      batches were all closed before the output's recorded_at can't
  //      be resolved by the started_at/closed_at heuristic.
  //   3. Any future write path that forgets to thread batch_id through
  //      (caught here instead of silently blanking the operator's form).
  // The save path always tags NEW writes with the selected batch_id, so
  // including null-batch rows here only surfaces legacy data we want
  // surfaced anyway.
  return row.batch_id == null || row.batch_id === filter;
}

function lineKey(bomLineId: number | null | undefined, name: string | null | undefined): string {
  return bomLineId != null ? `b${bomLineId}` : `n${name ?? ""}`;
}

/** Material Consumption inputs, keyed like the grid. Reads the operator's
 *  recorded `actual_consumed_qty` (job_card_material_consumption_v2). */
export function consumptionStateFromDetail(
  lines: ConsumptionLineLike[] | undefined | null,
  batchFilter: BatchFilter = undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of lines ?? []) {
    if (!matchesBatch(c, batchFilter)) continue;
    const q = c.actual_consumed_qty;
    if (q == null || q === "") continue;
    out[lineKey(c.bom_line_id, c.material_sku_name)] = String(q);
  }
  return out;
}

/** Balance Material per-article inputs. Only the per-article `returned` rows
 *  feed this grid; control_sample / extra_given are surfaced elsewhere. */
export function balanceStateFromDetail(
  rows: BalanceRowLike[] | undefined | null,
  batchFilter: BatchFilter = undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of rows ?? []) {
    if (!matchesBatch(b, batchFilter)) continue;
    if (b.balance_type !== "returned") continue;
    if (b.qty_kg == null || b.qty_kg === "") continue;
    out[lineKey(b.bom_line_id, b.material_name)] = String(b.qty_kg);
  }
  return out;
}

/** Rejection / Off-grade rows = off-grade byproducts only.
 *  R10/C6 — control_sample is filtered out: it now has a dedicated input on
 *  the Output & Accounting tab and is no longer a rejection category.
 *  R11/C7 — pm_* byproducts (pm_torn, pm_damaged, pm_misprint, pm_rejection,
 *  pm_wasted) are also filtered out; they have their own PM Variance block.
 *  `balanceRows` is still accepted for back-compat with older JCs whose
 *  control_sample row was historically saved under balance_materials. */
export function rejectionsFromDetail(
  byproducts: ByproductRowLike[] | undefined | null,
  _balanceRows: BalanceRowLike[] | undefined | null,
  batchFilter: BatchFilter = undefined,
): RejectionRow[] {
  const rows: RejectionRow[] = [];
  for (const bp of byproducts ?? []) {
    if (!matchesBatch(bp, batchFilter)) continue;
    const cat = bp.category ?? "";
    if (cat === "control_sample") continue;
    if (cat.startsWith("pm_")) continue;
    rows.push({
      category: cat,
      // Migration 034 — article attribution persisted server-side.
      // Older rows that pre-date the migration carry NULLs; the
      // dropdown then renders as "— Article —" until the operator
      // picks one and saves again.
      bomLineId: bp.bom_line_id ?? null,
      materialName: bp.material_name ?? "",
      qty: bp.qty_kg != null ? String(bp.qty_kg) : "",
      remarks: bp.remarks ?? "",
    });
  }
  return rows;
}

/** R10/C6 — pull the saved control_sample qty (kg) from the JC detail
 *  payload. Reads from byproducts first (canonical post-C6 path), falls
 *  back to balance_materials for older JCs where it was historically stored
 *  there. Returns "" when none recorded.
 *
 *  W3-HIGH-1 — when the value sources from the legacy balance_materials
 *  fallback we emit a one-time console.warn so we can spot un-migrated JCs
 *  in the field (the next save normalises it back into byproducts). The
 *  legacy rejection-row case (category='control_sample' surfaced via the
 *  generic Rejections list) is filtered out by rejectionsFromDetail above
 *  and auto-classified into the QC Sample input here so the operator sees
 *  it in the new home instead of an empty input. */
export function controlSampleFromDetail(
  byproducts: ByproductRowLike[] | undefined | null,
  balanceRows: BalanceRowLike[] | undefined | null,
  batchFilter: BatchFilter = undefined,
): string {
  for (const bp of byproducts ?? []) {
    if (!matchesBatch(bp, batchFilter)) continue;
    if (bp.category === "control_sample" && bp.qty_kg != null && bp.qty_kg !== "") {
      // Canonical path — byproducts row. No warning.
      return String(bp.qty_kg);
    }
  }
  for (const b of balanceRows ?? []) {
    if (!matchesBatch(b, batchFilter)) continue;
    if (b.balance_type === "control_sample" && b.qty_kg != null && b.qty_kg !== "") {
      if (typeof console !== "undefined") {
        console.warn(
          "controlSampleFromDetail: legacy balance_materials row detected " +
            "(balance_type='control_sample'). The next Save Output will " +
            "migrate this into byproducts(category='control_sample').",
        );
      }
      return String(b.qty_kg);
    }
  }
  return "";
}

/** Additive consumption (data-keeping bucket) — pull rows persisted
 *  to job_card_additive_consumption_v2. A row with a non-empty sku_name
 *  was picked from the dropdown; rows with no sku_name + a material_name
 *  came in via the "Others" free-text path. */
export type AdditiveDetailRow = {
  sku_name?: string | null;
  material_name?: string | null;
  qty_kg?: number | string | null;
  remarks?: string | null;
  batch_id?: number | null;
};

export type AdditiveStateRow = {
  sku_name: string;
  custom_name: string;
  qty: string;
  remarks: string;
};

export function additivesFromDetail(
  rows: AdditiveDetailRow[] | undefined | null,
  batchFilter: BatchFilter = undefined,
): AdditiveStateRow[] {
  const out: AdditiveStateRow[] = [];
  for (const r of rows ?? []) {
    if (!matchesBatch(r, batchFilter)) continue;
    const sku = (r.sku_name ?? "").trim();
    const custom = (r.material_name ?? "").trim();
    out.push({
      // When a sku_name is present, use it; otherwise the row originated
      // from "Others" — restore that path so the operator can edit the
      // custom name without re-entering it.
      sku_name: sku ? sku : (custom ? "_other" : ""),
      custom_name: sku ? "" : custom,
      qty: r.qty_kg != null ? String(r.qty_kg) : "",
      remarks: r.remarks ?? "",
    });
  }
  return out;
}

/** R11/C7 — pull each PM variance category's qty + uom from byproducts. */
export type PmVarianceState = Record<string, { qty: string; uom: string }>;

export function pmVarianceFromDetail(
  byproducts: ByproductRowLike[] | undefined | null,
  defaultUom: string,
  batchFilter: BatchFilter = undefined,
): PmVarianceState {
  const out: PmVarianceState = {};
  for (const bp of byproducts ?? []) {
    if (!matchesBatch(bp, batchFilter)) continue;
    const cat = bp.category ?? "";
    if (!cat.startsWith("pm_")) continue;
    out[cat] = {
      qty: bp.qty_kg != null ? String(bp.qty_kg) : "",
      uom: (bp as { uom?: string | null }).uom ?? defaultUom,
    };
  }
  return out;
}
