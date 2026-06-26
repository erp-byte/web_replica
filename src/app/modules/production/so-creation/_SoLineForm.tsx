"use client";

// Shared per-line editor used by both the Manual Entry page (creating a
// new SO from scratch) and the Manual Update page (editing an existing
// SO's lines). Mirrors the four-subsection card from manual-entry.html:
// SKU lookup, Quantity & pricing, Tax & charges, Actions.
//
// SKU lookup is debounced + abortable per line. Auto-compute fires on
// every numeric edit using lib/so.computeLineTotals (matches the Electron
// client's parseFloat(value.toFixed(3)) before-send rounding).

import { useEffect, useRef, useState } from "react";
import { computeLineTotals, lookupSku, round3, type SkuLookupResponse } from "@/lib/so";
import { useSeesCost } from "@/lib/cost-gate";

export interface LineRow {
  // The wire shape mirrors lib/so.SoLine; we store strings for inputs so
  // partial typed values ("12.") work, then round on submit.
  line_number?: number | null;
  sku_name: string;
  item_category: string;
  sub_category: string;
  uom: string;
  grp_code: string;
  quantity: string;        // pack count
  quantity_units: string;  // weight (auto)
  rate_inr: string;
  amount_inr: string;      // auto
  igst_amount: string;
  sgst_amount: string;
  cgst_amount: string;
  apmc_amount: string;
  packing_amount: string;
  freight_amount: string;
  processing_amount: string;
  total_amount_inr: string; // auto
  rate_type?: string;
  item_type?: string;
  sales_group?: string;
}

export function emptyLine(): LineRow {
  return {
    sku_name: "", item_category: "", sub_category: "", uom: "", grp_code: "",
    quantity: "", quantity_units: "", rate_inr: "", amount_inr: "",
    igst_amount: "", sgst_amount: "", cgst_amount: "",
    apmc_amount: "", packing_amount: "", freight_amount: "", processing_amount: "",
    total_amount_inr: "",
    rate_type: "", item_type: "", sales_group: "",
  };
}

export function lineFromExisting(l: import("@/lib/so").SoLine): LineRow {
  const s = (v: number | string | null | undefined) =>
    v == null || v === "" ? "" : String(v);
  return {
    line_number: l.line_number ?? null,
    sku_name: s(l.sku_name), item_category: s(l.item_category),
    sub_category: s(l.sub_category), uom: s(l.uom),
    grp_code: s(l.grp_code),
    quantity: s(l.quantity), quantity_units: s(l.quantity_units),
    rate_inr: s(l.rate_inr), amount_inr: s(l.amount_inr),
    igst_amount: s(l.igst_amount), sgst_amount: s(l.sgst_amount),
    cgst_amount: s(l.cgst_amount), apmc_amount: s(l.apmc_amount),
    packing_amount: s(l.packing_amount), freight_amount: s(l.freight_amount),
    processing_amount: s(l.processing_amount), total_amount_inr: s(l.total_amount_inr),
    rate_type: s(l.rate_type), item_type: s(l.item_type), sales_group: s(l.sales_group),
  };
}

export function lineToWire(l: LineRow): import("@/lib/so").SoLine {
  return {
    line_number: l.line_number ?? undefined,
    sku_name: l.sku_name || null,
    item_category: l.item_category || null,
    sub_category: l.sub_category || null,
    uom: l.uom || null,
    grp_code: l.grp_code || null,
    quantity:          round3(l.quantity),
    quantity_units:    round3(l.quantity_units),
    rate_inr:          round3(l.rate_inr),
    amount_inr:        round3(l.amount_inr),
    igst_amount:       round3(l.igst_amount),
    sgst_amount:       round3(l.sgst_amount),
    cgst_amount:       round3(l.cgst_amount),
    apmc_amount:       round3(l.apmc_amount),
    packing_amount:    round3(l.packing_amount),
    freight_amount:    round3(l.freight_amount),
    processing_amount: round3(l.processing_amount),
    total_amount_inr:  round3(l.total_amount_inr),
    rate_type: l.rate_type || null,
    item_type: l.item_type || null,
    sales_group: l.sales_group || null,
  };
}

// C12-fix H3: when the operator is in a deny-list role, the cost-bearing
// fields on a LineRow may still hold stale values — either left over from
// a previous edit session by an allow-listed teammate (drafts persist
// across users on the same device, e.g. a shared kiosk), or because the
// auto-compute effect populated `amount_inr` / `total_amount_inr` off a
// zeroed-out rate. Stripping at the boundary keeps those values from ever
// leaving the page and prevents the server's create/update endpoints from
// recording numbers the operator can't actually see.
//
// Drained fields mirror the cost-gate's COST_BEARING_FIELDS subset that
// LineRow exposes — rate_inr, amount_inr, total_amount_inr, and every
// `*_amount` tax/charge column.
const LINE_COST_KEYS = [
  "rate_inr", "amount_inr", "total_amount_inr",
  "igst_amount", "sgst_amount", "cgst_amount",
  "apmc_amount", "packing_amount", "freight_amount", "processing_amount",
] as const;

export function stripLineCostFields(l: LineRow): LineRow {
  const next: LineRow = { ...l };
  for (const k of LINE_COST_KEYS) next[k] = "";
  return next;
}

// ── SKU lookup helpers ───────────────────────────────────────────────────

interface LookupState {
  options: NonNullable<SkuLookupResponse["options"]>;
  loading: boolean;
}

function useSkuLookup(line: LineRow) {
  // One AbortController per line so a fast typist doesn't have stale
  // requests resolving on top of newer ones.
  const [state, setState] = useState<LookupState>({ options: {}, loading: false });
  const ctrlRef = useRef<AbortController | null>(null);

  const refresh = (params: import("@/lib/so").SkuLookupParams) => {
    if (ctrlRef.current) ctrlRef.current.abort();
    const c = new AbortController();
    ctrlRef.current = c;
    setState((s) => ({ ...s, loading: true }));
    lookupSku(params, c.signal).then(
      (r) => {
        if (c.signal.aborted) return;
        setState({ options: r.options ?? {}, loading: false });
      },
      () => {
        if (c.signal.aborted) return;
        setState((s) => ({ ...s, loading: false }));
      },
    );
  };

  // Initial population — every dropdown empty. Deferred past the
  // synchronous effect body because `refresh` calls setState internally
  // before its first await, which the lint rule catches.
  useEffect(() => {
    queueMicrotask(() => {
      refresh({
        item_type:  line.item_type,
        item_group: line.item_category || undefined,
        sub_group:  line.sub_category  || undefined,
        sales_group: line.sales_group  || undefined,
      });
    });
    // Only refresh when the cascade keys change. Particulars search debounce
    // is wired separately below.
  }, [line.item_type, line.item_category, line.sub_category, line.sales_group]);

  return { state, refresh };
}

// ── Per-line editor ──────────────────────────────────────────────────────

export function SoLineEditor({
  line, index, onChange, onRemove, disabled,
}: {
  line: LineRow;
  index: number;
  onChange: (next: LineRow) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const { state, refresh } = useSkuLookup(line);
  const { seesCost } = useSeesCost();

  // Particulars autocomplete — 350 ms debounce, mirrors the original.
  const [particularSuggestions, setParticularSuggestions] = useState<string[]>([]);
  const sugCtrl = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!line.sku_name) {
      // Defer past the synchronous effect body — react-hooks/set-state-in-effect.
      queueMicrotask(() => setParticularSuggestions([]));
      return;
    }
    const t = setTimeout(() => {
      if (sugCtrl.current) sugCtrl.current.abort();
      const c = new AbortController();
      sugCtrl.current = c;
      lookupSku(
        {
          item_type:  line.item_type,
          item_group: line.item_category || undefined,
          sub_group:  line.sub_category  || undefined,
          sales_group: line.sales_group  || undefined,
          search:     line.sku_name,
        },
        c.signal,
      ).then(
        (r) => {
          if (c.signal.aborted) return;
          setParticularSuggestions(r.options?.particulars ?? []);
        },
        () => {
          if (c.signal.aborted) return;
        },
      );
    }, 350);
    return () => clearTimeout(t);
  }, [line.sku_name, line.item_type, line.item_category, line.sub_category, line.sales_group]);

  // Auto-compute derived numerics whenever any input that feeds into them
  // changes. quantity_units is computed off `quantity * uom_value` but
  // since we don't have a per-UoM weight on the front-end we treat the
  // operator's quantity_units field as authoritative when they edit it
  // directly. This mirrors the Electron client's two-input pattern.
  useEffect(() => {
    const t = computeLineTotals({
      quantity: line.quantity,
      uom_value: parseFloat(line.uom) || 1,
      rate: line.rate_inr,
      igst: line.igst_amount,
      sgst: line.sgst_amount,
      cgst: line.cgst_amount,
      apmc: line.apmc_amount,
      packing: line.packing_amount,
      freight: line.freight_amount,
      processing: line.processing_amount,
    });
    // Don't overwrite quantity_units if the operator typed something
    // there — only auto-fill when the field is empty.
    const next: LineRow = { ...line };
    let dirty = false;
    if (!line.quantity_units.trim() && t.quantityUnits > 0) {
      next.quantity_units = String(t.quantityUnits); dirty = true;
    }
    const computedAmount = round3(parseFloat(next.quantity_units || "0") * round3(line.rate_inr));
    if (String(computedAmount) !== next.amount_inr) { next.amount_inr = String(computedAmount); dirty = true; }
    if (String(t.total) !== next.total_amount_inr) { next.total_amount_inr = String(t.total); dirty = true; }
    if (dirty) onChange(next);
    // We intentionally exclude `onChange` from deps to avoid feedback
    // loops; the parent setter is stable per-line.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    line.quantity, line.uom, line.rate_inr, line.igst_amount, line.sgst_amount,
    line.cgst_amount, line.apmc_amount, line.packing_amount, line.freight_amount,
    line.processing_amount, line.quantity_units,
  ]);

  // Field update helper — keeps each input controlled with merge semantics.
  const set = (patch: Partial<LineRow>) => onChange({ ...line, ...patch });

  // Cascade clearing: changing item_type clears the downstream cascade
  // keys so the SKU dropdown options refresh from scratch.
  const cascadeSet = (patch: Partial<LineRow>) => {
    const cleared: Partial<LineRow> = { ...patch };
    if ("item_type"      in patch) Object.assign(cleared, { item_category: "", sub_category: "", sales_group: "", sku_name: "" });
    if ("item_category"  in patch) Object.assign(cleared, { sub_category: "", sales_group: "", sku_name: "" });
    if ("sub_category"   in patch) Object.assign(cleared, { sales_group: "", sku_name: "" });
    onChange({ ...line, ...cleared });
  };

  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] p-4 mb-3">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[12px] font-semibold text-[var(--text-secondary)]">
          Line {line.line_number ?? index + 1}
        </div>
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          className="text-[12px] text-[var(--aws-error)] hover:underline disabled:opacity-50"
        >
          Remove
        </button>
      </div>

      {/* ── SKU lookup ──────────────────────────────────── */}
      <Subsection label="SKU Lookup">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 mb-2">
          <Select label="Item Type"  value={line.item_type ?? ""}     options={state.options.item_types ?? []}  onChange={(v) => cascadeSet({ item_type: v })}     disabled={disabled} />
          <Select label="Item Group" value={line.item_category}        options={state.options.item_groups ?? []} onChange={(v) => cascadeSet({ item_category: v })} disabled={disabled} />
          <Select label="Sub Group"  value={line.sub_category}          options={state.options.sub_groups ?? []}  onChange={(v) => cascadeSet({ sub_category: v })}   disabled={disabled} />
          <Select label="Sales Group" value={line.sales_group ?? ""}    options={state.options.sales_groups ?? []} onChange={(v) => cascadeSet({ sales_group: v })}  disabled={disabled} />
        </div>
        <div className="relative">
          <Field label="Particulars *" value={line.sku_name} onChange={(v) => set({ sku_name: v })} disabled={disabled} placeholder="Type to search SKUs…" />
          {particularSuggestions.length > 0 && line.sku_name ? (
            <div className="absolute z-10 left-0 right-0 mt-1 max-h-[180px] overflow-y-auto bg-white border border-[var(--aws-border)] rounded-md shadow-[0_4px_12px_rgba(0,28,36,0.18)]">
              {particularSuggestions.slice(0, 12).map((p, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    set({ sku_name: p });
                    setParticularSuggestions([]);
                    // Pull the canonical metadata for the chosen particular.
                    lookupSku({
                      particulars: p,
                      item_type:  line.item_type,
                      item_group: line.item_category || undefined,
                      sub_group:  line.sub_category  || undefined,
                      sales_group: line.sales_group  || undefined,
                    }).then((r) => {
                      const sel = r.selected_item;
                      if (!sel) return;
                      onChange({
                        ...line,
                        sku_name: sel.particulars ?? p,
                        uom: sel.uom ?? line.uom,
                        item_type: sel.item_type ?? line.item_type,
                        item_category: sel.item_group ?? line.item_category,
                        sub_category: sel.sub_group ?? line.sub_category,
                        sales_group: sel.sale_group ?? line.sales_group,
                      });
                    }).catch(() => { /* ignore */ });
                  }}
                  className="block w-full text-left px-2 py-1.5 text-[12px] hover:bg-[var(--surface-subtle)]"
                >
                  {p}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="mt-2 flex gap-3 text-[11px] text-[var(--text-secondary)]">
          {line.uom ? <span>UoM: <strong>{line.uom}</strong></span> : null}
          {state.loading ? <span className="text-[var(--text-muted)] italic">Looking up…</span> : null}
          {void refresh}
        </div>
      </Subsection>

      {/* ── Quantity & pricing ───────────────────────────
          The pack-count / weight fields stay visible for every role —
          they're operational metrics. The Rate and Amount inputs are
          gated by `seesCost` so deny-list roles (team_leader,
          qc_inspector, floor_manager, viewer) don't see any ₹ chrome.
          The grid collapses gracefully on narrow viewports: 2-up on
          phones, 3-/4-up on tablets+ depending on column count. */}
      <Subsection label={seesCost ? "Quantity & Pricing" : "Quantity"}>
        <div className={[
          "grid gap-2",
          seesCost ? "grid-cols-2 lg:grid-cols-4" : "grid-cols-2",
        ].join(" ")}>
          <Field label="Pack Count *"     value={line.quantity}        onChange={(v) => set({ quantity: v })}        disabled={disabled} type="number" />
          <Field label="Quantity (Kg)"    value={line.quantity_units}  onChange={(v) => set({ quantity_units: v })}  disabled={disabled} type="number" />
          {seesCost ? (
            <>
              <Field label="Rate (₹) *"       value={line.rate_inr}        onChange={(v) => set({ rate_inr: v })}        disabled={disabled} type="number" />
              <Field label="Amount (₹)"       value={line.amount_inr}      onChange={(v) => set({ amount_inr: v })}      disabled={disabled} type="number" readOnly />
            </>
          ) : null}
        </div>
      </Subsection>

      {/* ── Tax & charges ───────────────────────────────
          The IGST / SGST / CGST / APMC / Packing / Freight / Processing
          columns are all currency amounts (the `*_amount` keys are part
          of `COST_BEARING_FIELDS`). The whole subsection collapses for
          deny-list roles because there's nothing left to show. */}
      {seesCost ? (
        <Subsection label="Tax & Charges">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            <Field label="IGST"        value={line.igst_amount}       onChange={(v) => set({ igst_amount: v })}       disabled={disabled} type="number" />
            <Field label="SGST"        value={line.sgst_amount}       onChange={(v) => set({ sgst_amount: v })}       disabled={disabled} type="number" />
            <Field label="CGST"        value={line.cgst_amount}       onChange={(v) => set({ cgst_amount: v })}       disabled={disabled} type="number" />
            <Field label="APMC"        value={line.apmc_amount}       onChange={(v) => set({ apmc_amount: v })}       disabled={disabled} type="number" />
            <Field label="Packing"     value={line.packing_amount}    onChange={(v) => set({ packing_amount: v })}    disabled={disabled} type="number" />
            <Field label="Freight"     value={line.freight_amount}    onChange={(v) => set({ freight_amount: v })}    disabled={disabled} type="number" />
            <Field label="Processing"  value={line.processing_amount} onChange={(v) => set({ processing_amount: v })} disabled={disabled} type="number" />
            <Field label="Total (₹)"   value={line.total_amount_inr}  onChange={(v) => set({ total_amount_inr: v })}  disabled={disabled} type="number" readOnly />
          </div>
        </Subsection>
      ) : null}
    </div>
  );
}

// ── Field primitives (intentionally local — the detail page's form
//    primitives are wired to its theming and would create an awkward
//    cross-tree dependency). ────────────────────────────────────────

function Subsection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="text-[11px] uppercase tracking-wide font-semibold text-[var(--text-secondary)] mb-1.5">{label}</div>
      {children}
    </div>
  );
}

const inputCls =
  "w-full h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] disabled:bg-[var(--surface-disabled)] disabled:text-[var(--text-disabled)] read-only:bg-[var(--surface-subtle)]";

function Field({
  label, value, onChange, disabled, placeholder, type = "text", readOnly,
}: {
  label: string; value: string; onChange: (v: string) => void;
  disabled?: boolean; placeholder?: string; type?: "text" | "number"; readOnly?: boolean;
}) {
  return (
    <label className="block">
      <span className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">{label}</span>
      <input
        type={type}
        step={type === "number" ? "any" : undefined}
        // Hide the spinner arrows and blur on wheel for number fields so a
        // stray mouse-wheel scroll can't silently change the value.
        className={type === "number" ? `${inputCls} no-spinner` : inputCls}
        onWheel={type === "number" ? (e) => e.currentTarget.blur() : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        readOnly={readOnly}
        placeholder={placeholder}
      />
    </label>
  );
}

function Select({
  label, value, options, onChange, disabled,
}: {
  label: string; value: string; options: string[];
  onChange: (v: string) => void; disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">{label}</span>
      <select
        className={inputCls}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      >
        <option value="">— Any —</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}
