"use client";

// Shared client form pieces for the Sample module, used by both the generic
// requisition form (new/) and the dedicated NPD form (npd/new/). The article
// picker drives the PO-style cascade (material_type → item_category →
// sub_category → particulars) off /api/v1/so/sku-lookup; picking a particular
// resolves its sku_id and hands the article up via onAdd.

import { useEffect, useMemo, useRef, useState } from "react";
import { lookupSku, type SkuLookupResponse } from "@/lib/sample";
import { searchBoms, browseBoms, type BomOption, type BomBrowseResult } from "@/lib/npd-dev";

// Canonical units of measure for recipe/header quantities. Real recipe data
// (bom_line) only ever uses kg / pcs; the rest are common food-manufacturing
// units offered for completeness. Keep "kg" first so it stays the default.
export const UOM_OPTIONS = ["kg", "gm", "ltr", "ml", "pcs", "nos", "box", "pack"] as const;

// Constrained UOM dropdown — replaces free-text UOM inputs so values stay in a
// known vocabulary (and so a promoted BOM never carries a typo'd unit).
export function UomSelect({ value, onChange, className }: {
  value: string; onChange: (v: string) => void; className?: string;
}) {
  return (
    <select className={`form-input ${className ?? ""}`} value={value} onChange={(e) => onChange(e.target.value)}>
      {/* tolerate a pre-existing value outside the canonical list (e.g. cloned data) */}
      {value && !UOM_OPTIONS.includes(value as (typeof UOM_OPTIONS)[number]) && (
        <option value={value}>{value}</option>
      )}
      {UOM_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
    </select>
  );
}

// Numbered section card shared by the multi-section single-page forms.
export function FormSection({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white border border-[var(--aws-border)] rounded-md p-5 mt-4 first:mt-0">
      <h2 className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide mb-3">
        <span className="w-5 h-5 rounded-full bg-[var(--aws-orange)] text-white text-[11px] font-bold flex items-center justify-center">{n}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

export function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-[var(--text-secondary)]">{label}</dt>
      <dd className="font-medium text-[var(--text-primary)]">{value}</dd>
    </div>
  );
}

// ── Returnable / Non-returnable / Paid checklist + Amount ───────────────────
// Returnable and Non-returnable are mutually exclusive (only one). Amount is
// LOCKED to 0 unless Paid is ticked; when Paid it is mandatory, > 0, and limited
// to 2 decimal places (validated here AND by the backend, which rejects >2dp).
// Shared by the NPD/TRIAL create forms and the requisition edit card.
export interface BillingValue {
  returnable: boolean;
  non_returnable: boolean;
  paid: boolean;
  amount: string;          // raw input string ("" when not paid)
}

export const EMPTY_BILLING: BillingValue = {
  returnable: false, non_returnable: false, paid: false, amount: "",
};

// Build the initial value from a saved requisition (for the edit card).
export function billingFrom(req: { returnable?: boolean | null; non_returnable?: boolean | null; paid?: boolean | null; amount?: number | null }): BillingValue {
  return {
    returnable: !!req.returnable,
    non_returnable: !!req.non_returnable,
    paid: !!req.paid,
    amount: req.paid && req.amount != null ? String(req.amount) : "",
  };
}

// 3+ decimal places — used to reject (the backend's Amount2 rejects >2dp too). Parse
// with Number() rather than a strict shape regex so we accept the same values the
// backend does (e.g. ".5", "100.", "0.50") while still enforcing "at most 2 decimals".
const TOO_MANY_DP = /\.\d{3,}$/;

// Returns a validation message, or null when valid.
export function billingError(v: BillingValue): string | null {
  if (v.returnable && v.non_returnable) return "Pick only one of Returnable / Non-returnable.";
  if (v.paid) {
    const s = v.amount.trim();
    const n = Number(s);
    if (s === "" || !Number.isFinite(n) || n <= 0) return "Amount is required and must be greater than 0 when Paid.";
    if (TOO_MANY_DP.test(s)) return "Amount can have at most 2 decimals.";
  }
  return null;
}

// Serialised billing fields for the create/update payload. amount is 0 unless paid.
export function billingPayload(v: BillingValue): { returnable: boolean; non_returnable: boolean; paid: boolean; amount: number } {
  const n = Number(v.amount);
  return {
    returnable: v.returnable,
    non_returnable: v.non_returnable,
    paid: v.paid,
    amount: v.paid && Number.isFinite(n) && n > 0 ? Number(n.toFixed(2)) : 0,
  };
}

export function BillingFields({ value, onChange }: {
  value: BillingValue;
  onChange: (v: BillingValue) => void;
}) {
  const err = billingError(value);
  const set = (patch: Partial<BillingValue>) => onChange({ ...value, ...patch });
  return (
    <div className="rounded-md border border-[var(--aws-border)] p-3">
      <span className="block text-[12px] font-medium text-[var(--text-secondary)] mb-3">Return &amp; payment <span className="font-normal text-[var(--text-muted)]">(optional)</span></span>
      <div className="flex flex-wrap gap-x-6 gap-y-2 mb-3">
        <label className="flex items-center gap-2 text-[13px] text-[var(--text-secondary)] cursor-pointer">
          <input type="checkbox" checked={value.returnable}
            onChange={(e) => set({ returnable: e.target.checked, non_returnable: e.target.checked ? false : value.non_returnable })} />
          Returnable
        </label>
        <label className="flex items-center gap-2 text-[13px] text-[var(--text-secondary)] cursor-pointer">
          <input type="checkbox" checked={value.non_returnable}
            onChange={(e) => set({ non_returnable: e.target.checked, returnable: e.target.checked ? false : value.returnable })} />
          Non-returnable
        </label>
        <label className="flex items-center gap-2 text-[13px] text-[var(--text-secondary)] cursor-pointer">
          <input type="checkbox" checked={value.paid}
            onChange={(e) => set({ paid: e.target.checked, amount: e.target.checked ? value.amount : "" })} />
          Paid
        </label>
      </div>
      <div className="sm:max-w-[50%]">
        <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">
          Amount {value.paid && <span className="text-[var(--aws-error)]">*</span>}
        </label>
        <input
          type="number" min="0" step="0.01" inputMode="decimal"
          className={`form-input ${value.paid ? "" : "bg-[var(--surface-subtle)] cursor-not-allowed"}`}
          value={value.paid ? value.amount : ""}
          placeholder={value.paid ? "e.g. 1500.00" : "0.00 — tick Paid to enter"}
          disabled={!value.paid} readOnly={!value.paid} tabIndex={value.paid ? 0 : -1}
          onChange={(e) => set({ amount: e.target.value })}
          onWheel={(e) => e.currentTarget.blur()} />
        <p className="mt-1 text-[11px] text-[var(--text-muted)]">
          {value.paid ? "Required when Paid · up to 2 decimals." : "Locked to 0 unless Paid is ticked."}
        </p>
      </div>
      {err && <p className="mt-2 text-[12px] text-[var(--aws-error)]">{err}</p>}
    </div>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="M5 10l3.5 3.5L15 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// A dropdown menu (not a native <select>) so the open panel can list every
// relevant value and visibly highlight the chosen one. Filterable like the
// PO's searchable dropdowns; the trigger turns orange once a value is picked.
// Click-away is handled by a transparent fixed backdrop that sits beneath the
// panel (z-10 < z-20) — no document listener, so there's no mousedown/click
// ordering race that could swallow the opening click.
function CascadeDropdown({ label, value, options, onChange, disabled, placeholder }: {
  label: string; value: string; options: string[];
  onChange: (v: string) => void; disabled?: boolean; placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  function choose(v: string) { setQuery(""); setOpen(false); onChange(v); }

  const q = query.trim().toLowerCase();
  // De-duplicate — the SKU master can return the same name twice (e.g. two
  // "Cashew Paste" rows), which would collide on the React list key and show a
  // duplicate row. Collapse to distinct values, preserving first-seen order.
  const uniqueOptions = Array.from(new Set(options));
  const filtered = q ? uniqueOptions.filter((o) => o.toLowerCase().includes(q)) : uniqueOptions;
  const shown = filtered.slice(0, 200); // cap the DOM for the (potentially huge) particulars list

  return (
    <div className="relative">
      <span className="block text-[11px] font-semibold text-[var(--text-secondary)] mb-1">{label}</span>
      <button
        type="button" disabled={disabled} onClick={() => setOpen((o) => !o)}
        className={`form-input flex w-full items-center justify-between gap-2 text-left ${value ? "!border-[var(--aws-orange)] text-[var(--text-primary)] font-medium" : "text-[var(--text-muted)]"}`}
      >
        <span className="truncate">{value || placeholder}</span>
        <svg viewBox="0 0 20 20" className={`w-3.5 h-3.5 shrink-0 opacity-60 transition-transform ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M5 7l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <>
          <button
            type="button" aria-hidden tabIndex={-1}
            className="fixed inset-0 z-10 cursor-default" onClick={() => setOpen(false)}
          />
          <div className="absolute z-20 mt-1 w-full bg-white border border-[var(--aws-border-strong)] rounded-[2px] shadow-md">
            <div className="p-1.5 border-b border-[var(--surface-divider)]">
              <input
                autoFocus className="form-input h-7 text-[12px]" placeholder={`Search ${label.toLowerCase()}…`}
                value={query} onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <ul className="max-h-56 overflow-auto py-1">
              {value && (
                <li>
                  <button type="button" onClick={() => choose("")}
                    className="block w-full text-left px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)]">
                    Clear selection
                  </button>
                </li>
              )}
              {shown.map((o) => {
                const sel = o === value;
                return (
                  <li key={o}>
                    <button
                      type="button" onClick={() => choose(o)}
                      className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-[13px] ${sel ? "bg-[var(--surface-subtle)] text-[var(--aws-orange)] font-semibold" : "hover:bg-[var(--surface-subtle)]"}`}
                    >
                      <span className="truncate">{o}</span>
                      {sel && <CheckIcon />}
                    </button>
                  </li>
                );
              })}
              {shown.length === 0 && <li className="px-3 py-2 text-[12px] text-[var(--text-muted)]">{options.length === 0 ? "No options yet." : "No matches."}</li>}
              {filtered.length > shown.length && (
                <li className="px-3 py-1 text-[11px] text-[var(--text-muted)]">+{filtered.length - shown.length} more — keep typing to narrow.</li>
              )}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

// Article picker — two ways to find an article, mirroring the Base-BOM picker:
//   • Search — one global typeahead over the SKU master by name (debounced).
//   • Browse — the four dependent dropdowns (material_type → item_category →
//     sub_category → particulars) for stepwise drill-down.
// Either way, picking a particular resolves its sku_id via /api/v1/so/sku-lookup
// and adds an article line through onAdd. restrictItemType (e.g. "rm") locks
// both tabs to that material type.
export function ArticlePicker({ onAdd, restrictItemType }: {
  onAdd: (s: { sku_id: number; sku_name: string; item_type?: string }) => void;
  // Constrain both Search and Browse to one type ("rm") or several (["rm","pm"]).
  // Omit to allow any material type. Used to keep a trial recipe to RM (+ PM).
  restrictItemType?: string | string[];
}) {
  // Normalise the prop to a stable key + list (so an inline array literal from the
  // parent doesn't churn the effect deps every render).
  const allowedKey = restrictItemType == null
    ? ""
    : (Array.isArray(restrictItemType) ? restrictItemType : [restrictItemType]).join(",");
  const allowed = useMemo(() => (allowedKey ? allowedKey.split(",") : null), [allowedKey]);
  const singleType = allowed && allowed.length === 1 ? allowed[0] : null;

  const [tab, setTab] = useState<"search" | "browse">("search");
  const [busy, setBusy] = useState(false);

  // Browse-tab cascade state. When exactly one type is allowed it's locked; with
  // several the operator picks among them, so start unset.
  const [itemType, setItemType] = useState(singleType ?? "");
  const [itemGroup, setItemGroup] = useState("");
  const [subGroup, setSubGroup] = useState("");
  const [particulars, setParticulars] = useState("");
  const [opts, setOpts] = useState<NonNullable<SkuLookupResponse["options"]>>({});
  const [loading, setLoading] = useState(false);
  const ctrl = useRef<AbortController | null>(null);

  // Search-tab state
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);

  // Browse cascade options refresh whenever an upstream key changes. Deferred to
  // a microtask (react-hooks/set-state-in-effect); cleanup aborts the in-flight
  // request so a fast operator never sees stale options land.
  useEffect(() => {
    if (tab !== "browse") return;
    const c = new AbortController();
    ctrl.current = c;
    queueMicrotask(() => {
      if (c.signal.aborted) return;
      setLoading(true);
      lookupSku(
        { item_type: itemType || undefined, item_group: itemGroup || undefined, sub_group: subGroup || undefined },
        c.signal,
      ).then(
        (r) => { if (!c.signal.aborted) { setOpts(r.options ?? {}); setLoading(false); } },
        () => { if (!c.signal.aborted) setLoading(false); },
      );
    });
    return () => c.abort();
  }, [tab, itemType, itemGroup, subGroup]);

  // Debounced global search (Search tab) over the SKU master by name, scoped to
  // restrictItemType when set. Mirrors the Base-BOM picker's typeahead.
  useEffect(() => {
    if (tab !== "search") return;
    const q = query.trim();
    let cancelled = false;
    const t = setTimeout(() => {
      queueMicrotask(() => {
        if (cancelled) return;
        if (!q) { setResults([]); setSearching(false); return; }
        setSearching(true);
        // sku-lookup's item_type filter is single-valued, so query once per
        // allowed type (or once unscoped) and union the names.
        const types = allowedKey ? allowedKey.split(",") : [undefined];
        Promise.all(types.map((ty) => lookupSku({ item_type: ty || undefined, search: q }))).then(
          (lists) => {
            if (cancelled) return;
            const names = lists.flatMap((r) => r.options?.particulars ?? []);
            setResults(Array.from(new Set(names)).slice(0, 50));
            setSearching(false);
          },
          () => { if (!cancelled) setSearching(false); },
        );
      });
    }, q ? 200 : 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [tab, query, allowedKey]);

  // The particulars option only carries a name; resolve it to a sku_id (and the
  // canonical name) through a second lookup before handing the article up.
  async function choose(name: string) {
    setParticulars(name);
    if (!name) return;
    setBusy(true);
    try {
      const r = await lookupSku({
        particulars: name,
        // Only pin item_type when a single type is allowed; with several the
        // name alone resolves (the backend falls back to a name-only match).
        item_type: itemType || singleType || undefined,
        item_group: itemGroup || undefined,
        sub_group: subGroup || undefined,
      });
      const sel = r.selected_item;
      if (sel && sel.sku_id != null) onAdd({ sku_id: Number(sel.sku_id), sku_name: sel.particulars ?? name, item_type: sel.item_type });
    } catch {
      /* lookup failed — leave the dropdowns as-is so the operator can retry */
    } finally {
      setBusy(false);
      setParticulars(""); // reset so the next particular adds from the same filters
    }
  }

  const typeWord = singleType
    ? singleType.toUpperCase()
    : allowed ? allowed.map((t) => t.toUpperCase()).join(" / ") : "";
  const typeLabel = typeWord ? `${typeWord} ` : "";

  return (
    <div className="border border-[var(--aws-border)] rounded-md bg-[var(--surface-subtle)] p-3">
      {/* Tabs + locked-type chip */}
      <div className="flex items-center justify-between gap-2 mb-2.5">
        <div className="inline-flex rounded-[2px] border border-[var(--aws-border-strong)] overflow-hidden">
          {(["search", "browse"] as const).map((t, i) => (
            <button key={t} type="button" onClick={() => setTab(t)} disabled={busy}
              className={`px-3 h-7 text-[12px] ${i > 0 ? "border-l border-[var(--aws-border-strong)]" : ""} ${tab === t ? "bg-[var(--aws-orange)] text-white font-medium" : "bg-white text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)]"}`}>
              {t === "search" ? "Search" : "Browse"}
            </button>
          ))}
        </div>
        {allowed && (
          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-[var(--aws-orange)] text-[var(--aws-orange)] font-medium">{typeWord} only</span>
        )}
      </div>

      {tab === "search" ? (
        <div>
          <input autoFocus className="form-input" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${typeLabel}articles by name…`} />
          {(query.trim() || searching) && (
            <ul className="mt-1 max-h-56 overflow-auto border border-[var(--aws-border)] rounded-[2px] bg-white">
              {searching && <li className="px-3 py-2 text-[12px] text-[var(--text-muted)]">Searching…</li>}
              {!searching && results.map((name) => (
                <li key={name}>
                  <button type="button" disabled={busy} onClick={() => choose(name)}
                    className="block w-full text-left px-3 py-1.5 text-[13px] hover:bg-[var(--surface-subtle)] disabled:opacity-50">{name}</button>
                </li>
              ))}
              {!searching && query.trim() && results.length === 0 && (
                <li className="px-3 py-2 text-[12px] text-[var(--text-muted)]">No matching articles.</li>
              )}
            </ul>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          {singleType ? (
            <div>
              <span className="block text-[11px] font-semibold text-[var(--text-secondary)] mb-1">Material type</span>
              <div className="form-input flex items-center justify-between gap-2 !border-[var(--aws-orange)] bg-[var(--surface-subtle)] text-[var(--text-primary)] font-medium cursor-not-allowed">
                <span className="truncate">{singleType.toUpperCase()}</span>
                <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">locked</span>
              </div>
            </div>
          ) : (
            <CascadeDropdown label="Material type" value={itemType}
              options={allowed ? (opts.item_types ?? []).filter((t) => allowed.includes(t)) : (opts.item_types ?? [])}
              disabled={busy}
              placeholder="Select material type…"
              onChange={(v) => { setItemType(v); setItemGroup(""); setSubGroup(""); setParticulars(""); }} />
          )}
          <CascadeDropdown label="Item category" value={itemGroup} options={opts.item_groups ?? []} disabled={busy}
            placeholder="Select item category…"
            onChange={(v) => { setItemGroup(v); setSubGroup(""); setParticulars(""); }} />
          <CascadeDropdown label="Sub category" value={subGroup} options={opts.sub_groups ?? []} disabled={busy}
            placeholder="Select sub category…"
            onChange={(v) => { setSubGroup(v); setParticulars(""); }} />
          <CascadeDropdown label="Particulars" value={particulars} options={opts.particulars ?? []} disabled={busy}
            placeholder={loading ? "Loading…" : "Select article…"} onChange={choose} />
        </div>
      )}

      <p className="mt-2 text-[11px] text-[var(--text-muted)]">
        {tab === "search"
          ? `Type a name to find ${typeLabel}articles, then pick one to add it.`
          : allowed
            ? `Only ${typeWord} articles — narrow with the dropdowns, then pick a particular.`
            : "Narrow with the dropdowns, then pick a particular to add it as an article line."}
      </p>
    </div>
  );
}

// Base-BOM typeahead. There are ~1300 active BOMs, so this searches the master
// by FG name / customer / id (debounced) rather than rendering a giant <select>.
// Picking a BOM hands the full row up; clearing passes null. Click-away mirrors
// CascadeDropdown's transparent-backdrop approach (no document listener).
export function BomPicker({ value, valueLabel, onChange, placeholder }: {
  value: number | null;
  valueLabel?: string | null;
  onChange: (bom: BomOption | null) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"search" | "browse">("search");
  // Search tab
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<BomOption[]>([]);
  const [loading, setLoading] = useState(false);
  // Browse tab — cascade over the article master joined to BOMs
  const [bType, setBType] = useState("");
  const [bGroup, setBGroup] = useState("");
  const [bSub, setBSub] = useState("");
  const [bPart, setBPart] = useState("");
  const [bOpts, setBOpts] = useState<BomBrowseResult["options"]>({ item_types: [], item_groups: [], sub_groups: [], particulars: [] });
  const [bBoms, setBBoms] = useState<BomOption[]>([]);
  const [bLoading, setBLoading] = useState(false);

  // Debounced text search (Search tab). Deferred to a microtask so no state is
  // set synchronously in the effect (react-hooks/set-state-in-effect); a
  // cancelled flag drops stale responses.
  useEffect(() => {
    if (!open || tab !== "search") return;
    let cancelled = false;
    const t = setTimeout(() => {
      queueMicrotask(() => {
        if (cancelled) return;
        setLoading(true);
        searchBoms(query).then(
          (r) => { if (!cancelled) { setRows(r); setLoading(false); } },
          () => { if (!cancelled) setLoading(false); },
        );
      });
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [open, tab, query]);

  // Cascade options + leaf BOMs (Browse tab) refresh as the drill-down narrows.
  useEffect(() => {
    if (!open || tab !== "browse") return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setBLoading(true);
      browseBoms({ item_type: bType || undefined, item_group: bGroup || undefined, sub_group: bSub || undefined, particulars: bPart || undefined }).then(
        (r) => { if (!cancelled) { setBOpts(r.options); setBBoms(r.boms); setBLoading(false); } },
        () => { if (!cancelled) setBLoading(false); },
      );
    });
    return () => { cancelled = true; };
  }, [open, tab, bType, bGroup, bSub, bPart]);

  function choose(b: BomOption | null) {
    setQuery(""); setOpen(false); onChange(b);
  }

  const triggerText = value != null
    ? (valueLabel ? `${valueLabel} · #${value}` : `BOM #${value}`)
    : (placeholder ?? "Search a base BOM…");

  // Shared renderer for one BOM result row (used by both tabs).
  function bomRow(b: BomOption) {
    const sel = b.bom_id === value;
    return (
      <li key={b.bom_id}>
        <button type="button" onClick={() => choose(b)}
          className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-[13px] ${sel ? "bg-[var(--surface-subtle)] text-[var(--aws-orange)] font-semibold" : "hover:bg-[var(--surface-subtle)]"}`}>
          <span className="truncate">
            {b.fg_sku_name || "(unnamed)"}
            {b.customer_name ? <span className="text-[var(--text-muted)]"> · {b.customer_name}</span> : null}
            {b.version != null ? <span className="text-[var(--text-muted)]"> · v{b.version}</span> : null}
            {b.is_active === false ? <span className="text-[var(--aws-error)]"> · inactive</span> : null}
          </span>
          <span className="shrink-0 text-[11px] text-[var(--text-muted)]">#{b.bom_id}</span>
        </button>
      </li>
    );
  }

  return (
    <div className="relative">
      <button
        type="button" onClick={() => setOpen((o) => !o)}
        className={`form-input flex w-full items-center justify-between gap-2 text-left ${value != null ? "!border-[var(--aws-orange)] text-[var(--text-primary)] font-medium" : "text-[var(--text-muted)]"}`}
      >
        <span className="truncate">{triggerText}</span>
        <svg viewBox="0 0 20 20" className={`w-3.5 h-3.5 shrink-0 opacity-60 transition-transform ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M5 7l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <>
          <button type="button" aria-hidden tabIndex={-1}
            className="fixed inset-0 z-10 cursor-default" onClick={() => setOpen(false)} />
          <div className="absolute z-20 mt-1 w-full bg-white border border-[var(--aws-border-strong)] rounded-[2px] shadow-md">
            {/* Tabs: global search vs stepwise browse */}
            <div className="flex border-b border-[var(--surface-divider)]">
              {(["search", "browse"] as const).map((t) => (
                <button key={t} type="button" onClick={() => setTab(t)}
                  className={`flex-1 px-3 py-1.5 text-[12px] font-medium ${tab === t ? "text-[var(--aws-orange)] border-b-2 border-[var(--aws-orange)]" : "text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)]"}`}>
                  {t === "search" ? "Search" : "Browse"}
                </button>
              ))}
            </div>

            {value != null && (
              <button type="button" onClick={() => choose(null)}
                className="block w-full text-left px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)] border-b border-[var(--surface-divider)]">
                Clear selection
              </button>
            )}

            {tab === "search" ? (
              <>
                <div className="p-1.5 border-b border-[var(--surface-divider)]">
                  <input autoFocus className="form-input h-7 text-[12px]" placeholder="Search by name or id…"
                    value={query} onChange={(e) => setQuery(e.target.value)} />
                </div>
                <ul className="max-h-56 overflow-auto py-1">
                  {loading && <li className="px-3 py-2 text-[12px] text-[var(--text-muted)]">Searching…</li>}
                  {!loading && rows.map(bomRow)}
                  {!loading && rows.length === 0 && (
                    <li className="px-3 py-2 text-[12px] text-[var(--text-muted)]">
                      {query.trim() ? "No matching BOMs." : "Type to search the BOM master."}
                    </li>
                  )}
                </ul>
              </>
            ) : (
              <div>
                <div className="grid grid-cols-2 gap-1.5 p-2 border-b border-[var(--surface-divider)]">
                  <select className="form-input h-7 text-[12px]" value={bType}
                    onChange={(e) => { setBType(e.target.value); setBGroup(""); setBSub(""); setBPart(""); }}>
                    <option value="">Item type…</option>
                    {bOpts.item_types.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                  <select className="form-input h-7 text-[12px]" value={bGroup}
                    onChange={(e) => { setBGroup(e.target.value); setBSub(""); setBPart(""); }}>
                    <option value="">Group…</option>
                    {bOpts.item_groups.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                  <select className="form-input h-7 text-[12px]" value={bSub}
                    onChange={(e) => { setBSub(e.target.value); setBPart(""); }}>
                    <option value="">Sub-group…</option>
                    {bOpts.sub_groups.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                  <select className="form-input h-7 text-[12px]" value={bPart}
                    onChange={(e) => setBPart(e.target.value)}>
                    <option value="">Item description…</option>
                    {bOpts.particulars.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                <ul className="max-h-44 overflow-auto py-1">
                  {bLoading && <li className="px-3 py-2 text-[12px] text-[var(--text-muted)]">Loading…</li>}
                  {!bLoading && bPart !== "" && bBoms.map(bomRow)}
                  {!bLoading && bPart === "" && (
                    <li className="px-3 py-2 text-[12px] text-[var(--text-muted)]">Narrow down to an item description to list its BOM(s).</li>
                  )}
                  {!bLoading && bPart !== "" && bBoms.length === 0 && (
                    <li className="px-3 py-2 text-[12px] text-[var(--text-muted)]">No BOM linked to this item.</li>
                  )}
                </ul>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
