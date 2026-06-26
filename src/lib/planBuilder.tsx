"use client";

// Shared plan-builder ("Selected for Plan") module.
//
// Extracted from the Planning page (app/modules/production/planning/page.tsx)
// so the SO-Creation page can host the same per-article plan-builder with
// full parity — per-card pack count / quantity / deadline / factory picker,
// drag-reorder/merge/add/refresh process-steps editor, read-only BOM
// materials list, and a Create-Plan path that posts the operator's overrides
// to /plans-v2.
//
// Behaviour is byte-identical to the planning page's plan-builder; only the
// import sources changed and the page-coupled `toggleSelection` was split
// into a caller-driven `selectRow(row)` / `deselect(id)` pair so a consumer
// that owns the selection elsewhere (the SO-Creation article checkboxes)
// can feed rows in.
//
// Planning still owns its own copy for now (DO NOT modify it) — it will
// adopt this module in a later step. Keeping the two in sync until then is
// deliberate: extracting without touching planning avoids regressions.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type FulfillmentRow,
  createPlan,
  fetchFulfillmentDetail,
  fmtKg,
  fmtUnits,
  fmtDeadline,
  deadlineTone,
} from "@/lib/fulfillment";
import { PROCESS_OPTIONS, canonProcess, stageFromProcess } from "@/lib/processCatalog";
import { userHasAnyWarehouse } from "@/lib/warehouseScope";
import { lookupSku } from "@/lib/so";
import { friendlyApiError } from "@/lib/apiErrors";
import type { UserScope } from "@/lib/user";

// ── Factory + floor masters ─────────────────────────────────────────────
//
// Hard-coded per business rules (mirrors fulfillment.js:1234-1242). The
// canonical place for these is a backend master in a later iteration; for
// now the values match the Electron client byte-for-byte so plans created
// here look identical downstream.

export const FACTORY_TO_WAREHOUSE = { W202: "W-202", A185: "A-185" } as const;
export type FactoryCode = keyof typeof FACTORY_TO_WAREHOUSE;

export const FLOORS_BY_FACTORY: Record<FactoryCode, readonly string[]> = {
  W202: [
    "Lower Basement", "Upper Basement",
    "First Floor", "First Floor Mezz",
    "Second Floor", "Second Floor Mezz",
    "Terrace",
  ],
  A185: [
    "Roasting Area", "Mezzanine", "Sorting Area", "Printing Area",
    "Dmart Production Area", "Dmart Packing Area",
    "Cheese Floor", "FG store", "FFS Packing Area",
  ],
};

// Intersect the master with the user's scope. Admin or empty scope ⇒ no
// restriction. Mirrors fulfillment.js:1264 / 1271.  Uses the shared
// warehouseScope matcher so admin-typed variants ("W-202" vs "W202"
// vs "w-202") all resolve cleanly.
export function allowedFactoryCodes(scope: UserScope): FactoryCode[] {
  const all = Object.keys(FACTORY_TO_WAREHOUSE) as FactoryCode[];
  if (scope.isAdmin) return all;
  if (!scope.warehouses.length) return all;
  return all.filter((code) =>
    userHasAnyWarehouse(scope.warehouses, [
      FACTORY_TO_WAREHOUSE[code],  // "W-202"
      code,                        // "W202"
    ]),
  );
}

export function allowedFloorsFor(scope: UserScope, factory: FactoryCode | undefined): string[] {
  if (!factory) return [];
  const base = FLOORS_BY_FACTORY[factory] ?? [];
  if (scope.isAdmin) return [...base];
  if (!scope.floors.length) return [...base];
  return base.filter((fl) => scope.floors.includes(fl));
}

// ── Per-card configuration (Selected Articles panel) ────────────────────

export interface PlanStep {
  process_name: string | null;
  stage: string | null;
  floor: string | null;
  std_time_min: number | null;
  loss_pct: number | null;
}

// Subset of fulfillment_v2's BOM line shape (services/fulfillment_v2.py
// _build_line) — we display material / qty-per-unit / uom / loss% / item-type
// on the planning card. Other fields (gross_requirement_kg, inventory_status,
// shortage_kg, etc.) come back too but planning leaves shortage/inventory
// rendering to the Plan-Detail page where the operator can act on it.
export interface BomLineRow {
  material_sku_name: string | null;
  item_type: string | null;
  quantity_per_unit: number | null;
  loss_pct: number | null;
  uom: string | null;
  is_removed?: boolean | null;
}

// Operator overrides that flow into the plan body on Create Plan.
// `steps` are seeded from the BOM's process_routes on first expand and can
// be reordered + assigned a floor by the operator.
export interface CardOverride {
  qty_kg?: number;
  qty_units?: number;
  deadline_date?: string;        // YYYY-MM-DD
  factory?: FactoryCode;
  steps?: PlanStep[];
  stepsLoaded?: boolean;
  stepsLoading?: boolean;
  bomNote?: string | null;
  bomId?: number | null;
  /** BOM materials list (read-only on the planning card). Loaded alongside
   *  process steps in ensureStepsLoaded. Empty array when no BOM exists. */
  bomLines?: BomLineRow[];
}

// ── Helpers ──────────────────────────────────────────────────────────────

function toNum(v: number | string | null | undefined): number {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

// ── Hook ────────────────────────────────────────────────────────────────
//
// Holds the selection + per-card override state and every card handler.
// The consumer owns when a row is selected (selectRow) / deselected
// (deselect); everything else mirrors the planning page's in-component
// handlers exactly.

export interface UsePlanBuilder {
  selectedIds: Set<number>;
  cardCfg: Map<number, CardOverride>;
  selectedRowsCache: Map<number, FulfillmentRow>;
  expandedCardId: number | null;
  creatingPlan: boolean;
  factoryOpts: FactoryCode[];
  isSelected: (id: number) => boolean;
  selectRow: (row: FulfillmentRow) => void;
  deselect: (id: number) => void;
  clearAllSelection: () => void;
  setExpandedCardId: React.Dispatch<React.SetStateAction<number | null>>;
  patchCardOverride: (id: number, patch: Partial<CardOverride>) => void;
  resetCardOverride: (id: number) => void;
  moveCardStep: (id: number, fromIdx: number, toIdx: number) => void;
  setCardStepFloor: (id: number, idx: number, floor: string | null) => void;
  addCardStep: (id: number) => void;
  setCardStepProcess: (id: number, idx: number, name: string | null) => void;
  removeCardStep: (id: number, idx: number) => void;
  mergeCardSteps: (id: number, idxs: number[]) => void;
  setCardFactory: (id: number, factory: FactoryCode | undefined) => void;
  ensureStepsLoaded: (id: number, force?: boolean) => Promise<void>;
  refreshCardSteps: (id: number) => void;
  /** Resolves to true when a plan was created (selection cleared), false on a
   *  validation early-return or API failure — lets callers mirror the clear. */
  onCreatePlan: () => Promise<boolean>;
}

export function usePlanBuilder(opts: {
  entity: "" | "cfpl" | "cdpl";
  scope: UserScope;
  onToast: (msg: string) => void;
}): UsePlanBuilder {
  const { entity, scope, onToast } = opts;
  const factoryOpts = useMemo(() => allowedFactoryCodes(scope), [scope]);

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  // Per-card overrides for the selected-articles panel: each entry can hold
  // a custom qty_kg, qty_units, and deadline_date that replace the row's
  // defaults when the operator hits Create Plan. Mirrors `cardCfgMap` in
  // frontend_replica/.../fulfillment.js:1228.
  const [cardCfg, setCardCfg] = useState<Map<number, CardOverride>>(new Map());
  // Snapshot of every selected article's row data, keyed by fulfillment_id.
  // Decouples the Selected Articles panel from the LIST view — populated on
  // selection, dropped on deselection / Clear all.
  const [selectedRowsCache, setSelectedRowsCache] = useState<Map<number, FulfillmentRow>>(new Map());
  const [expandedCardId, setExpandedCardId] = useState<number | null>(null);
  const [creatingPlan, setCreatingPlan] = useState(false);

  const isSelected = useCallback((id: number) => selectedIds.has(id), [selectedIds]);

  // selectRow — add path of planning's toggleSelection, but the CALLER
  // supplies the row (the SO-Creation page resolves the fulfillment row
  // from the checked so_line). Snapshots the row so the card survives a
  // filter change that removes this article from the list view.
  const selectRow = useCallback((row: FulfillmentRow) => {
    const id = row.fulfillment_id;
    setSelectedIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    setSelectedRowsCache((m) => {
      const nm = new Map(m);
      nm.set(id, row);
      return nm;
    });
  }, []);

  // deselect — remove path of planning's toggleSelection. Drops the
  // per-card override, collapses the card if it was expanded, and drops
  // the row from the cache so the panel stops rendering it.
  const deselect = useCallback((id: number) => {
    setSelectedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setCardCfg((m) => {
      if (!m.has(id)) return m;
      const nm = new Map(m);
      nm.delete(id);
      return nm;
    });
    setExpandedCardId((c) => (c === id ? null : c));
    setSelectedRowsCache((m) => {
      if (!m.has(id)) return m;
      const nm = new Map(m);
      nm.delete(id);
      return nm;
    });
  }, []);

  const clearAllSelection = useCallback(() => {
    setSelectedIds(new Set());
    setCardCfg(new Map());
    setSelectedRowsCache(new Map());
    setExpandedCardId(null);
  }, []);

  const patchCardOverride = useCallback((id: number, patch: Partial<CardOverride>) => {
    setCardCfg((m) => {
      const nm = new Map(m);
      const cur = nm.get(id) ?? {};
      const merged = { ...cur, ...patch };
      // Drop empty entries so the map stays small — but only when NO override
      // dimension is set. A chosen factory and a hand-edited step route are
      // real operator overrides too, so clearing just the qty/deadline fields
      // must not silently discard a card that already carries a factory or a
      // configured route. (Deselection removes the entry via deselect/
      // clearAllSelection, so this pruning is purely for cleared fields.)
      const isEmpty =
        merged.qty_kg == null &&
        merged.qty_units == null &&
        (merged.deadline_date == null || merged.deadline_date === "") &&
        merged.factory == null &&
        (merged.steps == null || merged.steps.length === 0);
      if (isEmpty) nm.delete(id); else nm.set(id, merged);
      return nm;
    });
  }, []);

  const resetCardOverride = useCallback((id: number) => {
    setCardCfg((m) => {
      if (!m.has(id)) return m;
      const nm = new Map(m);
      nm.delete(id);
      return nm;
    });
  }, []);

  // Reorder a card's step list (operator drags / clicks up-down). Both
  // indices are checked against the current array length so a stale UI
  // event can't silently corrupt state.
  const moveCardStep = useCallback((id: number, fromIdx: number, toIdx: number) => {
    setCardCfg((m) => {
      const cur = m.get(id);
      if (!cur?.steps) return m;
      if (
        fromIdx < 0 || fromIdx >= cur.steps.length ||
        toIdx   < 0 || toIdx   >= cur.steps.length ||
        fromIdx === toIdx
      ) return m;
      const next = cur.steps.slice();
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      const nm = new Map(m);
      nm.set(id, { ...cur, steps: next });
      return nm;
    });
  }, []);

  const setCardStepFloor = useCallback((id: number, idx: number, floor: string | null) => {
    setCardCfg((m) => {
      const cur = m.get(id);
      if (!cur?.steps || idx < 0 || idx >= cur.steps.length) return m;
      const next = cur.steps.slice();
      next[idx] = { ...next[idx], floor };
      const nm = new Map(m);
      nm.set(id, { ...cur, steps: next });
      return nm;
    });
  }, []);

  // Append a blank step at the end. The operator picks a process name
  // (or leaves it blank for later), assigns a floor, and optionally
  // edits std_time_min / loss_pct via the existing per-step UI. The
  // step inherits no defaults from the BOM — it's a true add.
  const addCardStep = useCallback((id: number) => {
    setCardCfg((m) => {
      const cur = m.get(id) ?? {};
      const next: PlanStep[] = [
        ...(cur.steps ?? []),
        {
          process_name: null,
          stage: null,
          floor: null,
          std_time_min: null,
          loss_pct: null,
        },
      ];
      const nm = new Map(m);
      nm.set(id, { ...cur, steps: next });
      return nm;
    });
  }, []);

  // Change a single step's process_name. Canon'd through canonProcess()
  // so picking "De-Seeding" out of the dropdown stores it as the
  // canonical "De-seeding". stage auto-derives from the chosen process
  // because job_card_v2.stage is NOT NULL — keeping them in sync here
  // means the downstream JC creation doesn't 500 when a custom-added
  // step makes it to /approve.
  const setCardStepProcess = useCallback((id: number, idx: number, name: string | null) => {
    setCardCfg((m) => {
      const cur = m.get(id);
      if (!cur?.steps || idx < 0 || idx >= cur.steps.length) return m;
      const canoned = canonProcess(name);
      const next = cur.steps.slice();
      next[idx] = {
        ...next[idx],
        process_name: canoned,
        stage: stageFromProcess(canoned),
      };
      const nm = new Map(m);
      nm.set(id, { ...cur, steps: next });
      return nm;
    });
  }, []);

  // Remove a single step from a card. Bounded by 1 so the operator can't
  // accidentally empty the step list — if they really want to start over
  // they can use Refresh which reloads the BOM defaults.
  const removeCardStep = useCallback((id: number, idx: number) => {
    setCardCfg((m) => {
      const cur = m.get(id);
      if (!cur?.steps || idx < 0 || idx >= cur.steps.length) return m;
      if (cur.steps.length <= 1) return m;
      const next = cur.steps.slice();
      next.splice(idx, 1);
      const nm = new Map(m);
      nm.set(id, { ...cur, steps: next });
      return nm;
    });
  }, []);

  // Combine a set of selected step indices into a single step. Mirrors
  // fulfillment.js:1883 mergeSelected:
  //   • process_name  → joined with " + " so the operator can still tell
  //                     which sub-processes rolled up
  //   • stage         → keep the first selected (concat is too noisy)
  //   • floor         → first non-null wins; conflict → null so the
  //                     operator picks deliberately
  //   • std_time_min  → SUM (steps run sequentially after the merge)
  //   • loss_pct      → MAX (summing can overshoot 100% for two lossy steps)
  //
  // The merged step takes the FIRST selected slot; remaining selections are
  // dropped. Returns silently if fewer than 2 valid indices were passed —
  // the toolbar already guards the button state.
  const mergeCardSteps = useCallback((id: number, idxs: number[]) => {
    setCardCfg((m) => {
      const cur = m.get(id);
      if (!cur?.steps) return m;
      const sorted = [...new Set(idxs)].sort((a, b) => a - b);
      const valid = sorted.filter((i) => i >= 0 && i < cur.steps!.length);
      if (valid.length < 2) return m;

      const picked = valid.map((i) => cur.steps![i]);
      const floors = picked.map((s) => s.floor).filter((f): f is string => !!f);
      const uniqueFloors = new Set(floors);
      const mergedFloor = uniqueFloors.size === 1 ? [...uniqueFloors][0] : null;
      const anyTime = picked.some((s) => Number.isFinite(Number(s.std_time_min)));
      const totalTime = anyTime
        ? picked.reduce(
            (acc, s) =>
              acc + (Number.isFinite(Number(s.std_time_min)) ? Number(s.std_time_min) : 0),
            0,
          )
        : null;
      const anyLoss = picked.some((s) => Number.isFinite(Number(s.loss_pct)));
      const maxLoss = anyLoss
        ? picked.reduce(
            (acc, s) =>
              Number.isFinite(Number(s.loss_pct)) ? Math.max(acc, Number(s.loss_pct)) : acc,
            0,
          )
        : null;

      // Stage selection: if ANY of the picked steps is a packing stage,
      // promote the merged step to that packing stage — otherwise keep
      // the first one as the comment above describes. Without this, a
      // {Sorting, Packaging} merge took picked[0].stage='sorting' and
      // EGA / PM Variance / wastage attribution silently disappeared
      // because both the frontend (isPackingStageJc) and the backend
      // (is_packing_stage in job_card_v2.py) classify stages by the
      // "packing" / "packaging" tokens in the stage string. The merged
      // process_name keeps "+ Packaging" so the operator sees the right
      // label even when sorting comes first; only the canonical `stage`
      // needed promotion.
      const PACKING_TOKENS = ["packaging", "packing"];
      const isPackingStage = (st: string | null | undefined) =>
        !!st && PACKING_TOKENS.some((t) => st.toLowerCase().includes(t));
      const packingPick = picked.find((s) => isPackingStage(s.stage));
      const merged: PlanStep = {
        process_name: picked.map((s) => s.process_name || "—").join(" + "),
        stage: packingPick?.stage ?? picked[0].stage ?? null,
        floor: mergedFloor,
        std_time_min: totalTime,
        loss_pct: maxLoss,
      };

      const [firstIdx, ...restIdxs] = valid;
      const next = cur.steps.slice();
      // Remove trailing duplicates first (right-to-left so earlier indices
      // remain stable while we splice).
      [...restIdxs].reverse().forEach((i) => next.splice(i, 1));
      next[firstIdx] = merged;

      const nm = new Map(m);
      nm.set(id, { ...cur, steps: next });
      return nm;
    });
  }, []);

  // Changing factory invalidates floors that aren't valid for the new one.
  // Mirrors fulfillment.js:1704 — quietly drop any floor that's no longer
  // in the allowed set rather than surface a confusing toast.
  const setCardFactory = useCallback((id: number, factory: FactoryCode | undefined) => {
    setCardCfg((m) => {
      const cur = m.get(id) ?? {};
      const allowed = factory ? new Set(allowedFloorsFor(scope, factory)) : null;
      let steps = cur.steps;
      if (steps && allowed) {
        steps = steps.map((s) =>
          s.floor && !allowed.has(s.floor) ? { ...s, floor: null } : s,
        );
      } else if (steps && factory === undefined) {
        // Factory cleared → no floors are valid until a factory is picked.
        steps = steps.map((s) => (s.floor ? { ...s, floor: null } : s));
      }
      const nm = new Map(m);
      nm.set(id, { ...cur, factory, steps });
      return nm;
    });
  }, [scope]);

  // Fetch the BOM's process_routes ONCE per card and snapshot them as
  // editable PlanSteps. Cached via stepsLoaded so re-expanding the card
  // doesn't re-fetch. Mirrors fulfillment.js:1736 ensureStepsLoaded().
  //
  // `force=true` is the refresh path: clears the existing steps + loaded
  // flags FIRST so the fetch always runs. Used by the per-card refresh
  // button when the operator wants to undo a step-removal by reloading
  // the BOM defaults. Floor / time / loss assignments on the affected
  // card are lost (that's the point of refresh); other cards keep their
  // state because each card's cfg is independent.
  const cardCfgRef = useRef(cardCfg);
  cardCfgRef.current = cardCfg;
  const ensureStepsLoaded = useCallback(async (id: number, force = false) => {
    const cur = cardCfgRef.current.get(id);
    if (!force && (cur?.stepsLoaded || cur?.stepsLoading)) return;
    setCardCfg((m) => {
      const nm = new Map(m);
      const prev = m.get(id) ?? {};
      nm.set(id, {
        ...prev,
        stepsLoading: true,
        ...(force ? { steps: undefined, stepsLoaded: false, bomNote: null, bomLines: undefined } : {}),
      });
      return nm;
    });
    try {
      const data = await fetchFulfillmentDetail(id);
      const routes = data.bom?.process_routes ?? [];
      const sorted = [...routes].sort(
        (a, b) => (a.step_number ?? 0) - (b.step_number ?? 0),
      );
      const steps: PlanStep[] = sorted.map((r) => ({
        process_name: r.process_name ?? null,
        stage: r.stage ?? null,
        floor: null,
        std_time_min: r.std_time_min ?? null,
        loss_pct: r.loss_pct ?? null,
      }));
      const rawLines = (data.bom?.lines ?? []) as Array<Record<string, unknown>>;
      const bomLines: BomLineRow[] = rawLines
        .filter((l) => !(l.is_removed === true))
        .map((l) => ({
          material_sku_name: (l.material_sku_name as string | null) ?? null,
          item_type: (l.item_type as string | null) ?? null,
          quantity_per_unit:
            typeof l.quantity_per_unit === "number"
              ? l.quantity_per_unit
              : l.quantity_per_unit != null
                ? Number(l.quantity_per_unit) || null
                : null,
          loss_pct:
            typeof l.loss_pct === "number"
              ? l.loss_pct
              : l.loss_pct != null
                ? Number(l.loss_pct) || null
                : null,
          uom: (l.uom as string | null) ?? null,
          is_removed: (l.is_removed as boolean | null) ?? false,
        }));
      setCardCfg((m) => {
        const nm = new Map(m);
        const prev = m.get(id) ?? {};
        nm.set(id, {
          ...prev,
          steps,
          stepsLoaded: true,
          stepsLoading: false,
          bomNote: data.bom?.bom_note ?? null,
          bomId: data.bom?.bom_id ?? null,
          bomLines,
        });
        return nm;
      });
    } catch (e) {
      setCardCfg((m) => {
        const nm = new Map(m);
        const prev = m.get(id) ?? {};
        nm.set(id, {
          ...prev,
          steps: [],
          stepsLoaded: true,
          stepsLoading: false,
          bomNote: `Failed to load BOM: ${friendlyApiError(e)}`,
          bomLines: [],
        });
        return nm;
      });
    }
  }, []);

  // Reload a single card's steps from the BOM, leaving every other card's
  // state alone. Used by the per-card refresh button when the operator
  // wants to recover after removing a step by mistake.
  const refreshCardSteps = useCallback((id: number) => {
    void ensureStepsLoaded(id, true);
  }, [ensureStepsLoaded]);

  // Stable refs so onCreatePlan stays referentially constant while always
  // reading the latest selection / overrides.
  const selectedRowsCacheRef = useRef(selectedRowsCache);
  selectedRowsCacheRef.current = selectedRowsCache;
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;

  const onCreatePlan = useCallback(async () => {
    if (selectedIdsRef.current.size === 0) {
      onToast("Select at least one article.");
      return false;
    }
    // The hook doesn't own a page `rows` array — iterate the snapshot cache
    // (every selected row was cached on selection).
    const selectedRows = Array.from(selectedRowsCacheRef.current.values());
    // Plan entity comes from the SELECTED ROWS, not the entity selector — the
    // selector is just a listing filter, so selection survives an entity switch.
    // A plan is scoped to ONE entity (CFPL/CDPL); a mixed selection is rejected
    // rather than silently POSTing one entity linked to the other entity's
    // fulfillment rows (the cross-entity corruption SO-1 guarded against). Falls
    // back to the selector only if the rows carry no entity of their own.
    const rowEntities = new Set(
      selectedRows.map((r) => (r.entity || "").toLowerCase()).filter(Boolean),
    );
    if (rowEntities.size > 1) {
      onToast("Selected articles span CFPL and CDPL — create a separate plan per entity.");
      return false;
    }
    const planEntity = rowEntities.size === 1 ? [...rowEntities][0] : entity;
    // Server's PlanV2Create requires `entity` as a non-null scalar (a plan is
    // scoped to one entity). With "All" selected AND rows without an entity,
    // there's nothing to scope to — tell the operator.
    if (!planEntity) {
      onToast("Pick an entity (CFPL or CDPL) before creating a plan.");
      return false;
    }
    // Factory consistency: every selected card must have a factory set, and
    // all of them must agree (a plan is scoped to one warehouse). Mirrors
    // fulfillment.js:1976-1993.
    const factories = new Set<FactoryCode>();
    let missingFactory = 0;
    for (const r of selectedRows) {
      const f = cardCfgRef.current.get(r.fulfillment_id)?.factory;
      if (!f) missingFactory += 1; else factories.add(f);
    }
    if (missingFactory > 0) {
      onToast(`Pick a factory for ${missingFactory} card${missingFactory === 1 ? "" : "s"} before creating the plan.`);
      return false;
    }
    if (factories.size > 1) {
      onToast(`All selected articles must use the same factory (got: ${[...factories].join(", ")}).`);
      return false;
    }
    const chosenFactory = [...factories][0];
    const warehouse = FACTORY_TO_WAREHOUSE[chosenFactory];

    // Client-side qty validation — saves a 400 round-trip and points at
    // the offending SKU. Mirrors the same check at fulfillment.js:2003.
    const validationErrs: string[] = [];
    for (const r of selectedRows) {
      const cfg = cardCfgRef.current.get(r.fulfillment_id) ?? {};
      const pendKg = toNum(r.pending_qty_kg);
      const pendUnits = r.pending_qty_units != null ? toNum(r.pending_qty_units) : null;
      const reqKg = cfg.qty_kg != null && cfg.qty_kg > 0 ? cfg.qty_kg : pendKg;
      const reqUnits = cfg.qty_units != null && cfg.qty_units > 0 ? cfg.qty_units : (pendUnits ?? 0);
      if (reqKg <= 0) {
        validationErrs.push(`${r.fg_sku_name}: qty must be > 0 (pending is ${fmtKg(pendKg)} kg)`);
        continue;
      }
      if (reqKg > pendKg + 0.001) {
        validationErrs.push(`${r.fg_sku_name}: requested ${fmtKg(reqKg)} kg > pending ${fmtKg(pendKg)} kg`);
      } else if (pendUnits != null && reqUnits > pendUnits + 0.001) {
        validationErrs.push(`${r.fg_sku_name}: requested ${fmtUnits(reqUnits)} pcs > pending ${fmtUnits(pendUnits)} pcs`);
      }
    }
    if (validationErrs.length) {
      onToast(
        `${validationErrs[0]}${validationErrs.length > 1 ? ` (+${validationErrs.length - 1} more)` : ""}`,
      );
      return false;
    }

    setCreatingPlan(true);
    try {
      // Use the operator's LOCAL date for plan_date — toISOString() returns
      // UTC, which silently rolls over to tomorrow's date when an IST
      // operator hits Create after ~18:30 UTC (= 00:00 IST). Building the
      // YYYY-MM-DD string from local Date getters avoids the cross-midnight
      // off-by-one without pulling in a date library.
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const lines = selectedRows.map((r) => {
        const cfg = cardCfgRef.current.get(r.fulfillment_id) ?? {};
        const defaultKg = toNum(r.pending_qty_kg);
        const defaultUnits = toNum(r.pending_qty_units);
        const qtyKg = cfg.qty_kg != null && cfg.qty_kg > 0 ? cfg.qty_kg : defaultKg;
        const qtyUnitsRaw = cfg.qty_units != null && cfg.qty_units > 0
          ? cfg.qty_units
          : defaultUnits;
        const deadline = cfg.deadline_date && cfg.deadline_date !== ""
          ? cfg.deadline_date
          : (r.delivery_deadline ? String(r.delivery_deadline).slice(0, 10) : null);

        // Steps the operator configured. Only forward when at least one
        // step has a floor — otherwise the server snapshots from
        // bom_process_route on its own, which is the cleaner default.
        const userSteps = cfg.steps?.filter(Boolean) ?? [];
        const anyFloored = userSteps.some((s) => !!s.floor);
        const stepsPayload = anyFloored
          ? userSteps.map((s) => ({
              process_name: s.process_name,
              stage: s.stage,
              floor: s.floor || null,
              std_time_min: s.std_time_min,
              loss_pct: s.loss_pct,
            }))
          : undefined;
        // Surface the first floored step's floor on the line-level `area`
        // column so non-step-aware readers see something useful.
        const firstFloored = userSteps.find((s) => !!s.floor);

        return {
          fg_sku_name: r.fg_sku_name ?? "",
          customer_name: r.customer_name ?? null,
          planned_qty_kg: qtyKg,
          // production_plan_line_v2.planned_qty_units is NOT NULL CHECK (> 0)
          // (009_planning_v2.sql:160), so we must always send a positive count.
          // When the operator entered no units and the fulfillment row carries
          // none (typically by-weight SKUs), fall back to a kg-derived integer
          // purely to satisfy that constraint.
          //
          // Do NOT "fix" this to send null/0 — that violates the constraint and
          // create_plan rejects the whole plan. The genuinely-correct unit count
          // for a per-piece SKU is qty_kg / all_sku.uom, which the backend's
          // resolve_bom_multiplier already derives — but only when
          // planned_qty_units is NULL, which this column forbids. Making the
          // column nullable + deferring to that derivation is a schema change
          // tracked with the Create-Job-Card backend work.
          planned_qty_units: qtyUnitsRaw > 0 ? Math.round(qtyUnitsRaw) : Math.max(1, Math.round(qtyKg)),
          linked_so_fulfillment_ids: [r.fulfillment_id],
          deadline_date: deadline ?? undefined,
          ...(stepsPayload ? { steps: stepsPayload } : {}),
          ...(firstFloored?.floor ? { area: firstFloored.floor } : {}),
        };
      });
      // Plan window: date_to is the latest per-line deadline (or today if
      // none exist). Backend's CHECK enforces date_to >= date_from.
      const deadlines = lines
        .map((l) => l.deadline_date)
        .filter((d): d is string => !!d)
        .sort();
      const latest = deadlines.length ? deadlines[deadlines.length - 1] : today;
      const dateTo = latest >= today ? latest : today;
      const resp = await createPlan({
        entity: planEntity,
        warehouse,
        plan_type: "daily",
        plan_date: today,
        date_from: today,
        date_to: dateTo,
        lines,
      });
      onToast(resp.plan_id ? `Plan ${resp.plan_id} created.` : "Plan created.");
      clearAllSelection();
      return true;
    } catch (e) {
      onToast(`Create plan failed: ${friendlyApiError(e)}`);
      return false;
    } finally {
      setCreatingPlan(false);
    }
  }, [entity, onToast, clearAllSelection]);

  return {
    selectedIds,
    cardCfg,
    selectedRowsCache,
    expandedCardId,
    creatingPlan,
    factoryOpts,
    isSelected,
    selectRow,
    deselect,
    clearAllSelection,
    setExpandedCardId,
    patchCardOverride,
    resetCardOverride,
    moveCardStep,
    setCardStepFloor,
    addCardStep,
    setCardStepProcess,
    removeCardStep,
    mergeCardSteps,
    setCardFactory,
    ensureStepsLoaded,
    refreshCardSteps,
    onCreatePlan,
  };
}

// ── Selected articles panel ──────────────────────────────────────────────
//
// Sits between the filter toolbar and the table when there's at least one
// row checked. Each selected article gets a compact card; tapping a card
// expands its qty / deadline editor. Edits flow back through the parent's
// cardCfg map and are read by onCreatePlan when the operator hits Create
// Plan in the header.
//
// Responsive layout — single column on phones, 2 cols at sm, 3 at lg. The
// expanded card spans the full row width via grid `col-span-full` so the
// form has room to breathe without forcing the others narrower.

export function SelectedArticlesPanel({
  selectedIds, rowsCache, cardCfg, expandedCardId, scope, factoryOpts,
  onToggleExpand, onPatch, onReset, onRemove, onClearAll,
  onSetFactory, onSetStepFloor, onSetStepProcess, onMoveStep, onMergeSteps,
  onAddStep,
  onRemoveStep, onRefreshSteps,
  showSteps = true,
}: {
  selectedIds: Set<number>;
  rowsCache: Map<number, FulfillmentRow>;
  cardCfg: Map<number, CardOverride>;
  expandedCardId: number | null;
  scope: UserScope;
  factoryOpts: FactoryCode[];
  onToggleExpand: (id: number) => void;
  onPatch: (id: number, patch: Partial<CardOverride>) => void;
  onReset: (id: number) => void;
  onRemove: (id: number) => void;
  onClearAll: () => void;
  onSetFactory: (id: number, factory: FactoryCode | undefined) => void;
  onSetStepFloor: (id: number, idx: number, floor: string | null) => void;
  onSetStepProcess: (id: number, idx: number, name: string | null) => void;
  onMoveStep: (id: number, from: number, to: number) => void;
  onMergeSteps: (id: number, idxs: number[]) => void;
  onAddStep: (id: number) => void;
  onRemoveStep: (id: number, idx: number) => void;
  onRefreshSteps: (id: number) => void;
  // Show the editable Process Steps (process route) section on each card. The
  // SO-Creation plan-builder passes false — routing there comes from the SFG
  // stage, not a hand-edited route. Defaults true so planning-style callers
  // keep the full editor.
  showSteps?: boolean;
}) {
  // Cards rendered in selection order via the snapshot cache so a filter
  // change that removes an article from the LIST below doesn't strip the
  // card from the panel. Set insertion order is preserved across ES2015+.
  const ids = Array.from(selectedIds);
  const selectedRows = ids
    .map((id) => rowsCache.get(id))
    .filter((r): r is FulfillmentRow => !!r);

  if (selectedRows.length === 0) return null;

  return (
    <section className="mb-3" aria-label="Selected articles">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-sm bg-[var(--aws-orange)] text-white text-[10px] font-bold shrink-0">
            {selectedIds.size}
          </span>
          <span className="text-[11px] uppercase tracking-wide font-bold text-[var(--text-secondary)]">
            Selected for plan
          </span>
          <span className="text-[11px] text-[var(--text-muted)] hidden md:inline truncate">
            {showSteps
              ? "· tap a card to customise qty, deadline, factory, or floor"
              : "· tap a card to customise qty, deadline, or factory"}
          </span>
        </div>
        <button
          type="button"
          onClick={onClearAll}
          className="h-7 px-2.5 text-[11px] rounded-full border border-[var(--aws-border)] text-[var(--text-secondary)] bg-white hover:border-[var(--aws-error)] hover:text-[var(--aws-error)]"
        >
          Clear
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
        {selectedRows.map((r) => (
          <SelectedCard
            key={r.fulfillment_id}
            row={r}
            cfg={cardCfg.get(r.fulfillment_id) ?? {}}
            isExpanded={expandedCardId === r.fulfillment_id}
            scope={scope}
            factoryOpts={factoryOpts}
            onToggleExpand={() => onToggleExpand(r.fulfillment_id)}
            onPatch={(patch) => onPatch(r.fulfillment_id, patch)}
            onReset={() => onReset(r.fulfillment_id)}
            onRemove={() => onRemove(r.fulfillment_id)}
            onSetFactory={(f) => onSetFactory(r.fulfillment_id, f)}
            onSetStepFloor={(idx, floor) => onSetStepFloor(r.fulfillment_id, idx, floor)}
            onSetStepProcess={(idx, name) => onSetStepProcess(r.fulfillment_id, idx, name)}
            onMoveStep={(from, to) => onMoveStep(r.fulfillment_id, from, to)}
            onMergeSteps={(idxs) => onMergeSteps(r.fulfillment_id, idxs)}
            onAddStep={() => onAddStep(r.fulfillment_id)}
            onRemoveStep={(idx) => onRemoveStep(r.fulfillment_id, idx)}
            onRefreshSteps={() => onRefreshSteps(r.fulfillment_id)}
            showSteps={showSteps}
          />
        ))}
      </div>
    </section>
  );
}

function SelectedCard({
  row, cfg, isExpanded, scope, factoryOpts,
  onToggleExpand, onPatch, onReset, onRemove,
  onSetFactory, onSetStepFloor, onSetStepProcess, onMoveStep, onMergeSteps,
  onAddStep, onRemoveStep, onRefreshSteps, showSteps = true,
}: {
  row: FulfillmentRow;
  cfg: CardOverride;
  isExpanded: boolean;
  scope: UserScope;
  factoryOpts: FactoryCode[];
  onToggleExpand: () => void;
  onPatch: (patch: Partial<CardOverride>) => void;
  onReset: () => void;
  onRemove: () => void;
  onSetFactory: (factory: FactoryCode | undefined) => void;
  onSetStepFloor: (idx: number, floor: string | null) => void;
  onSetStepProcess: (idx: number, name: string | null) => void;
  onMoveStep: (from: number, to: number) => void;
  onMergeSteps: (idxs: number[]) => void;
  onAddStep: () => void;
  onRemoveStep: (idx: number) => void;
  onRefreshSteps: () => void;
  showSteps?: boolean;
}) {
  const defaultKg = toNum(row.pending_qty_kg);
  const defaultUnits = toNum(row.pending_qty_units);
  const defaultDeadline = row.delivery_deadline ? String(row.delivery_deadline).slice(0, 10) : "";

  const qtyKg = cfg.qty_kg ?? defaultKg;
  const qtyUnits = cfg.qty_units ?? defaultUnits;
  const deadline = cfg.deadline_date ?? defaultDeadline;
  const factory = cfg.factory;
  const steps = cfg.steps ?? [];
  const allowedFloors = useMemo(() => allowedFloorsFor(scope, factory), [scope, factory]);
  const flooredCount = steps.filter((s) => !!s.floor).length;

  // Per-unit kg derived from the SO line's own pending qtys — this is
  // the same ratio that ultimately lives in all_sku.uom for the
  // canonical SKU, so using it here keeps qty (pcs) and qty (kg) on
  // the planning card linked the same way R2 specifies.
  //
  // Operator typing into pcs → kg auto-computes; typing kg → pcs
  // auto-computes. Either field still accepts a direct manual value
  // (operator can override the link by editing the other field
  // immediately after).
  //
  // ── Source of truth: all_sku master (NOT the SO-line ratio) ──
  // The per-line pending_qty_kg / pending_qty_units ratio is a
  // *data-state* derivative — a wrongly-entered SO line ("2,350 kg /
  // 14,883 pcs" → 0.158 kg/pc on a SKU whose actual pack is 200 g)
  // would propagate the error into every plan made off that row.
  // The all_sku `uom` column is the pack weight in kg (0.200 for a
  // 200 g pack) and is the only authoritative source. Fetched on
  // expand so we don't pay one round-trip per row at initial render.
  const [skuUomFromMaster, setSkuUomFromMaster] = useState<number | null>(null);
  useEffect(() => {
    if (!isExpanded || !row.fg_sku_name) return;
    const ctrl = new AbortController();
    void (async () => {
      try {
        const data = await lookupSku(
          { particulars: row.fg_sku_name as string },
          ctrl.signal,
        );
        const uom = data.selected_item?.uom;
        if (ctrl.signal.aborted) return;
        if (uom == null) {
          setSkuUomFromMaster(null);
          return;
        }
        const n = typeof uom === "number" ? uom : parseFloat(String(uom));
        if (Number.isFinite(n) && n > 0) setSkuUomFromMaster(n);
      } catch {
        // Silent — the operator can still type both fields manually
        // (they stay unlinked when master isn't available).
      }
    })();
    return () => ctrl.abort();
  }, [isExpanded, row.fg_sku_name]);

  // Strict: only the all_sku master drives interlinking. If the
  // master fetch hasn't completed (or the SKU isn't in the table)
  // the two fields stay unlinked and the operator types both.
  const skuUomKg: number | null = skuUomFromMaster;

  // Both setters clamp to the available pending qty (item 6). The typed field
  // is already clamped by NumberField's `max`, but the DERIVED field needs its
  // own clamp: skuUomKg is the master pack-weight, which can differ from the
  // line's own pending kg/pcs ratio, so e.g. (max pcs × master uom) can land
  // above the available kg. Clamp the computed counterpart too so neither
  // field can ever exceed what's actually pending.
  function patchQtyUnits(n: number | undefined) {
    if (n == null || !Number.isFinite(n)) {
      onPatch({ qty_units: undefined, qty_kg: undefined });
      return;
    }
    const units = defaultUnits > 0 ? Math.min(n, defaultUnits) : n;
    if (skuUomKg != null) {
      let kg = Number((units * skuUomKg).toFixed(3));
      if (defaultKg > 0 && kg > defaultKg) kg = defaultKg;
      onPatch({ qty_units: units, qty_kg: kg });
    } else {
      onPatch({ qty_units: units });
    }
  }
  function patchQtyKg(n: number | undefined) {
    if (n == null || !Number.isFinite(n)) {
      onPatch({ qty_kg: undefined, qty_units: undefined });
      return;
    }
    const kg = defaultKg > 0 ? Math.min(n, defaultKg) : n;
    if (skuUomKg != null && skuUomKg > 0) {
      let units = Math.round(kg / skuUomKg);
      if (defaultUnits > 0 && units > defaultUnits) units = Math.round(defaultUnits);
      onPatch({ qty_kg: kg, qty_units: units });
    } else {
      onPatch({ qty_kg: kg });
    }
  }

  const customised =
    cfg.qty_kg != null || cfg.qty_units != null ||
    (cfg.deadline_date != null && cfg.deadline_date !== "") ||
    cfg.factory != null ||
    flooredCount > 0;

  const sku = row.fg_sku_name || "—";

  return (
    <div
      className={[
        "relative bg-white border rounded-md transition-colors",
        // Left accent strip when customised — quieter than the full crimson border.
        customised && !isExpanded
          ? "border-[var(--aws-border)] border-l-[3px] border-l-[var(--aws-orange)]"
          : isExpanded
            ? "border-[var(--aws-orange)] shadow-[0_2px_8px_rgba(154,57,62,0.08)] sm:col-span-2 lg:col-span-3"
            : "border-[var(--aws-border)] hover:border-[var(--aws-navy)]",
      ].join(" ")}
    >
      {/* ── Compact header row ─────────────────────────────────────── */}
      <div className="flex items-center gap-1.5 p-2">
        <button
          type="button"
          onClick={onToggleExpand}
          aria-expanded={isExpanded}
          aria-label={isExpanded ? "Collapse" : "Expand"}
          className="shrink-0 inline-flex items-center justify-center w-6 h-6 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-subtle)] rounded-sm"
        >
          <svg
            viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2}
            style={{ transform: isExpanded ? "rotate(90deg)" : "none", transition: "transform .15s" }}
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onToggleExpand}
          className="flex-1 min-w-0 text-left"
        >
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted)] truncate">
            <span className="truncate" title={row.customer_name ?? ""}>{row.customer_name || "—"}</span>
            {row.so_number ? (
              <>
                <span className="opacity-50">·</span>
                <span className="font-mono normal-case tracking-normal text-[var(--aws-link)]">{row.so_number}</span>
              </>
            ) : null}
          </div>
          <div className="text-[13px] font-semibold text-[var(--text-primary)] truncate leading-tight" title={sku}>
            {sku}
          </div>
          <div className="flex items-center flex-wrap gap-x-2 gap-y-0.5 mt-1 text-[11px]">
            <span className="font-semibold text-[var(--text-primary)]">
              {fmtKg(qtyKg)} kg
            </span>
            {qtyUnits > 0 ? (
              <span className="text-[var(--text-muted)]">{fmtUnits(qtyUnits)} pcs</span>
            ) : null}
            {deadline ? (
              <span className={[
                "px-1.5 py-0 rounded-sm border font-medium",
                deadlineTone(deadline) === "overdue" ? "text-[#b1361e] bg-[#fdf3f1] border-[#f0c7be]"
                : deadlineTone(deadline) === "soon"    ? "text-[#9a393e] bg-[#fbeced] border-[#e6bcbe]"
                                                       : "text-[var(--text-secondary)] bg-white border-[var(--aws-border)]",
              ].join(" ")}>
                {fmtDeadline(deadline)}
              </span>
            ) : null}
            {factory ? (
              <span className="px-1.5 py-0 rounded-sm border border-[#bbd9f3] bg-[#eaf3ff] text-[var(--aws-link)] font-semibold">
                {factory}
              </span>
            ) : null}
            {cfg.stepsLoaded && steps.length > 0 ? (
              <span
                className={[
                  "px-1.5 py-0 rounded-sm border font-medium",
                  flooredCount === steps.length
                    ? "text-[#1d8102] bg-[#eaf6ed] border-[#b6dbb1]"
                    : "text-[var(--text-secondary)] bg-[var(--surface-subtle)] border-[var(--aws-border)]",
                ].join(" ")}
              >
                {flooredCount}/{steps.length} floors
              </span>
            ) : null}
          </div>
        </button>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove from selection"
          title="Remove"
          className="shrink-0 w-9 h-9 sm:w-6 sm:h-6 flex items-center justify-center rounded-sm text-[var(--text-muted)] hover:text-[var(--aws-error)] hover:bg-[var(--surface-subtle)]"
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* ── Expanded editor ──────────────────────────────────────── */}
      {isExpanded ? (
        <div className="border-t border-[var(--aws-border)] p-3 bg-white rounded-b-md">
          {/* Row 1: quantity + deadline */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
            <NumberField
              label="Pack count (pcs)"
              value={cfg.qty_units ?? ""}
              placeholder={defaultUnits > 0 ? String(Math.round(defaultUnits)) : "—"}
              onChange={patchQtyUnits}
              max={defaultUnits > 0 ? defaultUnits : null}
              hint={
                defaultUnits > 0
                  ? `Available: ${Math.round(defaultUnits)} pcs`
                  : undefined
              }
            />
            <NumberField
              label="Quantity (kg)"
              value={cfg.qty_kg ?? ""}
              placeholder={defaultKg > 0 ? String(defaultKg) : "—"}
              onChange={patchQtyKg}
              max={defaultKg > 0 ? defaultKg : null}
              hint={
                defaultKg > 0
                  ? `Available: ${defaultKg.toFixed(3)} kg`
                  : undefined
              }
            />
            <label className="block">
              <span className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">Deadline</span>
              <input
                type="date"
                value={cfg.deadline_date ?? defaultDeadline}
                onChange={(e) => onPatch({ deadline_date: e.target.value || undefined })}
                className="w-full h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
              />
            </label>
          </div>

          {/* Row 2: factory selector */}
          <div className="mb-3">
            <label className="block">
              <span className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">
                Factory <span className="text-[var(--aws-error)]">*</span>
              </span>
              <select
                value={factory ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  onSetFactory(v === "" ? undefined : (v as FactoryCode));
                }}
                className="w-full sm:w-[220px] h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
              >
                <option value="">— Pick factory —</option>
                {factoryOpts.map((f) => (
                  <option key={f} value={f}>
                    {f} ({FACTORY_TO_WAREHOUSE[f]})
                  </option>
                ))}
              </select>
            </label>
            {factoryOpts.length === 0 ? (
              <p className="mt-1 text-[11px] text-[var(--aws-error)]">
                No factories are assigned to your account.{" "}
                {scope.warehouses.length > 0 ? (
                  <>
                    Your account has <span className="font-mono">{scope.warehouses.join(", ")}</span>
                    , but planning expects one of{" "}
                    <span className="font-mono">
                      {(Object.keys(FACTORY_TO_WAREHOUSE) as FactoryCode[])
                        .map((c) => `${c} / ${FACTORY_TO_WAREHOUSE[c]}`)
                        .join(", ")}
                    </span>
                    . Ask an admin to align your <span className="font-mono">allowed_warehouses</span> with one of those exact values.
                  </>
                ) : (
                  <>Ask an admin to grant warehouse access.</>
                )}
              </p>
            ) : null}
          </div>

          {/* Row 3: process steps (the editable process route). Hidden when
              showSteps is false — the SO-Creation plan-builder derives routing
              from the SFG stage, not a hand-edited route, so this section is
              omitted there. Loads lazily from the BOM via ensureStepsLoaded()
              in the parent. */}
          {showSteps ? (
            <StepsSection
              stepsLoaded={!!cfg.stepsLoaded}
              stepsLoading={!!cfg.stepsLoading}
              steps={steps}
              allowedFloors={allowedFloors}
              factory={factory}
              bomNote={cfg.bomNote}
              onSetStepFloor={onSetStepFloor}
              onSetStepProcess={onSetStepProcess}
              onMoveStep={onMoveStep}
              onMergeSteps={onMergeSteps}
              onAddStep={onAddStep}
              onRemoveStep={onRemoveStep}
              onRefreshSteps={onRefreshSteps}
            />
          ) : null}

          {/* Row 3b: BOM materials (read-only). Mirrors StepsSection's load
              gating so the operator sees a single source of truth for both
              process route AND material list while configuring the plan. */}
          <BomMaterialsSection
            loaded={!!cfg.stepsLoaded}
            loading={!!cfg.stepsLoading}
            lines={cfg.bomLines ?? []}
            bomNote={cfg.bomNote}
          />

          {/* Row 4: actions */}
          <div className="flex flex-wrap gap-2 justify-end mt-3">
            {customised ? (
              <button
                type="button"
                onClick={onReset}
                className="h-7 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]"
              >
                Reset to default
              </button>
            ) : null}
            <button
              type="button"
              onClick={onToggleExpand}
              className="h-7 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]"
            >
              Done
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── Steps section ──────────────────────────────────────────────────────
//
// HTML5 drag-and-drop reorder + accessible ↑/↓ buttons for keyboard and
// touch. Floor dropdown per step pulls from `allowedFloors` (the factory's
// floor set intersected with the user's auth scope). Empty = "any floor".
//
// State lives in the parent; we only emit move + setFloor events back up.

function StepsSection({
  stepsLoaded, stepsLoading, steps, allowedFloors, factory, bomNote,
  onSetStepFloor, onSetStepProcess, onMoveStep, onMergeSteps,
  onAddStep, onRemoveStep, onRefreshSteps,
}: {
  stepsLoaded: boolean;
  stepsLoading: boolean;
  steps: PlanStep[];
  allowedFloors: string[];
  factory: FactoryCode | undefined;
  bomNote: string | null | undefined;
  onSetStepFloor: (idx: number, floor: string | null) => void;
  onSetStepProcess: (idx: number, name: string | null) => void;
  onMoveStep: (from: number, to: number) => void;
  onMergeSteps: (idxs: number[]) => void;
  onAddStep: () => void;
  onRemoveStep: (idx: number) => void;
  onRefreshSteps: () => void;
}) {
  // Drag state stays local — the parent only sees committed reorders.
  const dragFromRef = useRef<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  // Merge-checkbox selection state. Lives entirely in the section (merge
  // is one-shot — once applied, the indices shift and the selection is no
  // longer meaningful). Auto-clears whenever the step list length changes,
  // matching the post-merge re-render behavior of frontend_replica's DOM-
  // backed selection.
  const [selectedIdxs, setSelectedIdxs] = useState<Set<number>>(new Set());
  useEffect(() => {
    // Deferred past the sync effect body so the
    // react-hooks/set-state-in-effect rule stays happy — matches the
    // queueMicrotask pattern used elsewhere in this codebase.
    queueMicrotask(() => setSelectedIdxs(new Set()));
  }, [steps.length]);

  function toggleSelect(i: number) {
    setSelectedIdxs((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  }
  function selectAll(on: boolean) {
    setSelectedIdxs(on ? new Set(steps.map((_, i) => i)) : new Set());
  }
  function fireMerge() {
    if (selectedIdxs.size < 2) return;
    const idxs = [...selectedIdxs];
    setSelectedIdxs(new Set());
    onMergeSteps(idxs);
  }

  const mergeable = steps.length >= 2;
  const allSelected = mergeable && selectedIdxs.size === steps.length;
  const anySelected = selectedIdxs.size > 0;

  if (stepsLoading) {
    return (
      <div className="text-[12px] text-[var(--text-secondary)] flex items-center gap-2 py-2">
        <span className="inline-block w-3 h-3 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
        Loading process steps from BOM…
      </div>
    );
  }
  if (!stepsLoaded) {
    return null;
  }
  // Empty-state hint shown inline above the (empty) step list when no
  // BOM route exists. The manual "Add step" button below is the operator's
  // path forward in this case — keep it reachable for every article so
  // the workflow is uniform whether or not a BOM route is configured.
  const emptyHint = steps.length === 0
    ? (bomNote
        ? bomNote
        : "No BOM process route found for this SKU — use “Add step” below to build the route manually.")
    : null;

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1.5 px-0.5">
        <span className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)]">
          Process steps · {steps.length}
        </span>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-[var(--text-muted)] hidden md:inline">
            Drag to reorder · × to remove
          </span>
          <button
            type="button"
            onClick={onRefreshSteps}
            title="Reload the BOM process route for this article (other articles aren't affected)"
            className="inline-flex items-center gap-1 h-6 px-1.5 text-[10px] rounded-[2px] border border-[var(--aws-border)] bg-white hover:border-[var(--aws-navy)] text-[var(--text-secondary)]"
          >
            <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
            Refresh
          </button>
        </div>
      </div>

      {/* ── Merge toolbar — only when there are 2+ steps. Mirrors
          fulfillment.js:1393. Select-all + count hint + Merge button.
          Wraps to two rows on phones via flex-wrap; CTA stays usable. */}
      {mergeable ? (
        <div className="flex flex-wrap items-center gap-2 mb-1.5 px-2 py-1.5 bg-[var(--surface-subtle)] border border-[var(--aws-border)] rounded">
          <label className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)] cursor-pointer">
            <input
              type="checkbox"
              checked={allSelected}
              ref={(el) => {
                if (el) el.indeterminate = anySelected && !allSelected;
              }}
              onChange={(e) => selectAll(e.target.checked)}
              className="accent-[var(--aws-orange)]"
            />
            <span>Select all</span>
          </label>
          <span className="text-[11px] text-[var(--text-muted)]">·</span>
          <span className="text-[11px] text-[var(--text-secondary)]">
            <strong className="text-[var(--text-primary)]">{selectedIdxs.size}</strong> selected
          </span>
          <div className="flex-1" />
          <button
            type="button"
            disabled={selectedIdxs.size < 2}
            onClick={fireMerge}
            title="Combine the selected steps into a single step · time SUM, name joined with +"
            className={[
              "h-7 px-2.5 text-[11px] rounded-[2px] font-semibold border inline-flex items-center gap-1.5",
              selectedIdxs.size < 2
                ? "bg-[var(--surface-disabled)] border-[var(--aws-border)] text-[var(--text-disabled)] cursor-not-allowed"
                : "bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white",
            ].join(" ")}
          >
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <polyline points="8 12 3 12 8 7" />
              <polyline points="16 12 21 12 16 17" />
              <line x1="3" y1="12" x2="21" y2="12" />
            </svg>
            Merge selected
          </button>
        </div>
      ) : null}

      {emptyHint ? (
        <p
          className={
            "mb-1.5 px-2 py-1.5 text-[11px] italic rounded border " + (
              // Only the catch-block path ("Failed to load BOM: …") is a real
              // error and gets red styling. Informational notes from the
              // backend ("RM SO — no BOM expected" for RM SOs, "No BOM found"
              // when nothing's configured yet) are expected states — render
              // them as a calm info hint so operators don't read them as a
              // failure.
              bomNote?.startsWith("Failed to load BOM")
                ? "text-[var(--aws-error)] border-[var(--aws-border)] bg-[#fdf0f1]"
                : "text-[var(--text-muted)] border-dashed border-[var(--aws-border)] bg-[var(--surface-subtle)]"
            )
          }
        >
          {emptyHint}
        </p>
      ) : null}

      <ol className="space-y-1">
        {steps.map((s, i) => {
          const isDragOver = dragOverIdx === i;
          return (
            <li
              key={`${s.process_name ?? ""}-${i}`}
              draggable
              onDragStart={(e) => {
                dragFromRef.current = i;
                e.dataTransfer.effectAllowed = "move";
                // Some browsers require setData for the drag to fire.
                e.dataTransfer.setData("text/plain", String(i));
              }}
              onDragEnd={() => {
                dragFromRef.current = null;
                setDragOverIdx(null);
              }}
              onDragOver={(e) => {
                if (dragFromRef.current == null) return;
                e.preventDefault();
                setDragOverIdx(i);
              }}
              onDragLeave={() => {
                setDragOverIdx((cur) => (cur === i ? null : cur));
              }}
              onDrop={(e) => {
                e.preventDefault();
                const from = dragFromRef.current;
                if (from == null || from === i) return;
                onMoveStep(from, i);
                dragFromRef.current = null;
                setDragOverIdx(null);
              }}
              className={[
                "border rounded bg-white px-2 py-1.5 flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-2",
                isDragOver
                  ? "border-[var(--aws-orange)] bg-[#fdf0f1]"
                  : "border-[var(--aws-border)]",
              ].join(" ")}
            >
              {/* Row 1 on phones / left half on sm+: checkbox · handle · num · name. */}
              <div className="flex items-center gap-2 flex-1 min-w-0">
                {/* Merge-selection checkbox — only when 2+ steps. */}
                {mergeable ? (
                  <label
                    className="shrink-0 inline-flex items-center justify-center w-7 h-7 -m-1 cursor-pointer"
                    title="Select to merge"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={selectedIdxs.has(i)}
                      onChange={() => toggleSelect(i)}
                      className="accent-[var(--aws-orange)]"
                    />
                  </label>
                ) : null}
                <span
                  aria-hidden
                  title="Drag to reorder"
                  className="shrink-0 inline-flex items-center justify-center w-7 h-7 -m-1 text-[var(--text-muted)] cursor-grab active:cursor-grabbing touch-none"
                >
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
                    <circle cx="9"  cy="6"  r="1.4" />
                    <circle cx="15" cy="6"  r="1.4" />
                    <circle cx="9"  cy="12" r="1.4" />
                    <circle cx="15" cy="12" r="1.4" />
                    <circle cx="9"  cy="18" r="1.4" />
                    <circle cx="15" cy="18" r="1.4" />
                  </svg>
                </span>
                <span className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full bg-[var(--aws-navy)] text-white text-[10px] font-bold">
                  {i + 1}
                </span>
                <div className="flex-1 min-w-0">
                  {/* Process picker: canonical PROCESS_OPTIONS values plus
                      a synthetic option for any BOM-supplied name that
                      isn't in the catalog (defensive — keeps legacy
                      values visible instead of silently resetting). */}
                  {(() => {
                    const current = s.process_name ?? "";
                    const inCatalog =
                      current === "" ||
                      PROCESS_OPTIONS.some(
                        (p) => p.toLowerCase() === current.toLowerCase(),
                      );
                    return (
                      <select
                        value={current}
                        onChange={(e) => onSetStepProcess(i, e.target.value || null)}
                        title="Pick the process for this step"
                        className="w-full h-7 px-1.5 text-[12px] font-semibold rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] text-[var(--text-primary)]"
                      >
                        <option value="">— Process —</option>
                        {!inCatalog && current ? (
                          <option value={current}>
                            {current} (custom)
                          </option>
                        ) : null}
                        {PROCESS_OPTIONS.map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </select>
                    );
                  })()}
                  <div className="flex items-center gap-1.5 text-[10px] text-[var(--text-muted)] flex-wrap mt-0.5">
                    {s.stage ? <span>{s.stage}</span> : null}
                    {s.std_time_min != null ? <span>· {s.std_time_min} min</span> : null}
                    {s.loss_pct != null && s.loss_pct > 0 ? <span>· {s.loss_pct}% loss</span> : null}
                  </div>
                </div>
              </div>
              {/* Row 2 on phones / right half on sm+: floor select + up/down.
                  Floor flexes to fill the row on phones, fixed width on sm+. */}
              <div className="flex items-center gap-2 sm:shrink-0">
                <select
                  value={s.floor ?? ""}
                  onChange={(e) => onSetStepFloor(i, e.target.value || null)}
                  disabled={!factory}
                  title={!factory ? "Pick a factory first" : "Assign a floor"}
                  className="h-9 sm:h-7 flex-1 sm:flex-none sm:w-[180px] px-2 text-[12px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] disabled:bg-[var(--surface-disabled)] disabled:text-[var(--text-disabled)]"
                >
                  <option value="">{factory ? "— Any floor —" : "— Pick factory —"}</option>
                  {allowedFloors.map((fl) => (
                    <option key={fl} value={fl}>{fl}</option>
                  ))}
                </select>
                <div className="flex items-center gap-0.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => onMoveStep(i, i - 1)}
                    disabled={i === 0}
                    aria-label="Move step up"
                    className="w-9 h-9 sm:w-7 sm:h-7 inline-flex items-center justify-center rounded-sm text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)] disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 15 12 9 18 15" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => onMoveStep(i, i + 1)}
                    disabled={i === steps.length - 1}
                    aria-label="Move step down"
                    className="w-9 h-9 sm:w-7 sm:h-7 inline-flex items-center justify-center rounded-sm text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)] disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                  {/* Remove this step. Disabled when only one step remains
                      — a card needs at least one row; "start over" is what
                      the per-card Refresh button is for. */}
                  <button
                    type="button"
                    onClick={() => onRemoveStep(i)}
                    disabled={steps.length <= 1}
                    aria-label="Remove step"
                    title={steps.length <= 1 ? "At least one step is required" : "Remove this step"}
                    className="w-9 h-9 sm:w-7 sm:h-7 inline-flex items-center justify-center rounded-sm text-[var(--text-muted)] hover:text-[var(--aws-error)] hover:bg-[var(--surface-subtle)] disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {/* Append a fresh blank step. Operator picks a process from the
          dropdown and (optionally) a floor. The step inherits no BOM
          defaults — it's a true insertion. */}
      <div className="mt-2 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onAddStep}
          className="inline-flex items-center gap-1 h-7 px-2.5 text-[11px] font-semibold rounded-[2px] border border-dashed border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-orange)] hover:text-[var(--aws-orange)] text-[var(--text-secondary)]"
        >
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Add step
        </button>
        {bomNote && steps.length > 0 ? (
          <p className="text-[11px] text-[var(--text-muted)] italic">{bomNote}</p>
        ) : null}
      </div>
    </div>
  );
}

// ── BOM materials (read-only) ────────────────────────────────────────────
// Loaded alongside the process route on first expand (same fetch). For RM
// SOs / SKUs without a BOM the list is empty and the bomNote drives the
// empty-state copy. Read-only here — overrides happen on the Plan-Detail
// page once the plan is created.
function BomMaterialsSection({
  loaded, loading, lines, bomNote,
}: {
  loaded: boolean;
  loading: boolean;
  lines: BomLineRow[];
  bomNote: string | null | undefined;
}) {
  if (loading) {
    return (
      <div className="mt-3 text-[12px] text-[var(--text-secondary)] flex items-center gap-2 py-2">
        <span className="inline-block w-3 h-3 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
        Loading BOM materials…
      </div>
    );
  }
  if (!loaded) return null;

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between gap-2 mb-1.5 px-0.5">
        <span className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)]">
          BOM materials · {lines.length}
        </span>
      </div>
      {lines.length === 0 ? (
        <p
          className={
            "mb-1.5 px-2 py-1.5 text-[11px] italic rounded border " + (
              bomNote?.startsWith("Failed to load BOM")
                ? "text-[var(--aws-error)] border-[var(--aws-border)] bg-[#fdf0f1]"
                : "text-[var(--text-muted)] border-dashed border-[var(--aws-border)] bg-[var(--surface-subtle)]"
            )
          }
        >
          {bomNote ?? "No BOM materials configured for this SKU."}
        </p>
      ) : (
        <div className="overflow-hidden border border-[var(--aws-border)] rounded">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="bg-[var(--surface-subtle)] text-left text-[var(--text-secondary)]">
                <th className="px-2 py-1 font-semibold">Material</th>
                <th className="px-2 py-1 font-semibold w-[60px]">Type</th>
                <th className="px-2 py-1 font-semibold w-[90px] text-right">Qty / unit</th>
                <th className="px-2 py-1 font-semibold w-[50px]">UoM</th>
                <th className="px-2 py-1 font-semibold w-[60px] text-right">Loss %</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr
                  key={`${l.material_sku_name ?? "x"}-${i}`}
                  className="border-t border-[var(--surface-divider)]"
                >
                  <td className="px-2 py-1 text-[var(--text-primary)]">{l.material_sku_name ?? "—"}</td>
                  <td className="px-2 py-1 uppercase text-[var(--text-secondary)]">{l.item_type ?? "—"}</td>
                  <td className="px-2 py-1 text-right font-mono">
                    {l.quantity_per_unit != null ? l.quantity_per_unit : "—"}
                  </td>
                  <td className="px-2 py-1 text-[var(--text-secondary)]">{l.uom ?? "—"}</td>
                  <td className="px-2 py-1 text-right font-mono text-[var(--text-secondary)]">
                    {l.loss_pct != null ? l.loss_pct : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Small numeric input that flips undefined ↔ number through a string field.
// Empty string clears the override (returns undefined to parent).
function NumberField({
  label, value, placeholder, onChange, max, hint,
}: {
  label: string;
  value: number | string;
  placeholder?: string;
  onChange: (n: number | undefined) => void;
  /** Optional upper bound — values above max are clamped on input.
   *  Useful for binding "available qty" limits on the planning card. */
  max?: number | null;
  /** Optional helper text rendered below the field; goes red when value
   *  exceeds max (only meaningful when max is set). */
  hint?: string;
}) {
  const display = value === undefined || value === null ? "" : String(value);
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && value !== ""
        ? parseFloat(value)
        : NaN;
  const overMax =
    max != null && max > 0 && Number.isFinite(numericValue) && numericValue > max;
  return (
    <label className="block">
      <span className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">{label}</span>
      <input
        type="number"
        min={0}
        max={max != null && max > 0 ? max : undefined}
        step="any"
        inputMode="decimal"
        value={display}
        placeholder={placeholder}
        // Mouse-wheel over a focused number input silently increments the
        // value — blur on wheel so an accidental scroll can't corrupt the
        // pack count / qty. The .no-spinner class hides the up/down arrows.
        onWheel={(e) => e.currentTarget.blur()}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") { onChange(undefined); return; }
          const n = parseFloat(raw);
          if (!Number.isFinite(n)) { onChange(undefined); return; }
          // Clamp to max when supplied — bound to the SO line's available
          // pending qty so operators can't over-plan (item 6).
          const clamped = max != null && max > 0 && n > max ? max : n;
          onChange(clamped);
        }}
        className={[
          "no-spinner w-full h-8 px-2 text-[13px] rounded-[2px] bg-white border outline-none focus:shadow-[0_0_0_1px_#9a393e]",
          overMax
            ? "border-[var(--aws-error)] focus:border-[var(--aws-error)]"
            : "border-[var(--aws-border-strong)] focus:border-[#9a393e]",
        ].join(" ")}
      />
      {hint ? (
        <span
          className={[
            "block mt-1 text-[10px]",
            overMax ? "text-[var(--aws-error)] font-semibold" : "text-[var(--text-muted)]",
          ].join(" ")}
        >
          {hint}
        </span>
      ) : null}
    </label>
  );
}
