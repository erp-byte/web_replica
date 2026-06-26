"use client";

// New Transfer Request (doc 05) — create a Pending interunit transfer request:
// a header (date, from/to warehouse, reason) plus one or more article lines,
// POSTed to /api/v1/transfer/requests. Each article is a collapsible, editable
// section (its own cascading dropdowns + quick search), so added articles stay
// editable. Cascading dropdowns + quick search are backed by all_sku. Feedback
// via an inline banner (no toast lib in web_replica).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import { TransferChrome } from "../_chrome";
import {
  TransferApi,
  type WarehouseSite,
  type CategorialSearchItem,
  type ArticleCreateInput,
} from "@/lib/transfer";

const UOM_OPTIONS = ["BOX", "CARTON", "KG", "PCS"];   // DB chk_uom-valid set
const WAREHOUSE_FALLBACK = ["W202", "A185", "A68", "A101", "F53"];

function todayDMY(): string {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
}
function genRequestNo(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `REQ${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

interface Article {
  materialType: string; itemCategory: string; subCategory: string; itemDescription: string;
  unitPackSize: string; uom: string; packSize: string; quantity: string; netWeight: string; lotNumber: string;
}
const EMPTY_ARTICLE: Article = {
  materialType: "", itemCategory: "", subCategory: "", itemDescription: "",
  unitPackSize: "", uom: "", packSize: "", quantity: "", netWeight: "0", lotNumber: "",
};
const NEW_ARTICLE: Article = { ...EMPTY_ARTICLE, quantity: "1", packSize: "1", netWeight: "0" };

interface Row { uid: number; data: Article }

function calcNetWeight(a: Article): string {
  const q = parseFloat(a.quantity) || 0;
  const ps = parseFloat(a.packSize) || 0;
  const ups = parseFloat(a.unitPackSize) || 0;
  if (a.materialType.toUpperCase() === "FG") return (ups * ps * q).toFixed(3);
  return (ps * q).toFixed(2);
}

// apply a field patch with cascade resets + net-weight recompute. A reset only
// clears a downstream field when the SAME patch isn't already setting it — so a
// bulk set (e.g. quick-search filling all four levels at once) is preserved.
function patchArticle(prev: Article, patch: Partial<Article>): Article {
  const next: Article = { ...prev, ...patch };
  if ("materialType" in patch) {
    if (!("itemCategory" in patch)) next.itemCategory = "";
    if (!("subCategory" in patch)) next.subCategory = "";
    if (!("itemDescription" in patch)) next.itemDescription = "";
  }
  if ("itemCategory" in patch) {
    if (!("subCategory" in patch)) next.subCategory = "";
    if (!("itemDescription" in patch)) next.itemDescription = "";
  }
  if ("subCategory" in patch && !("itemDescription" in patch)) next.itemDescription = "";
  if ("quantity" in patch || "packSize" in patch || "unitPackSize" in patch || "materialType" in patch || "itemDescription" in patch) {
    next.netWeight = calcNetWeight(next);
  }
  return next;
}

function toApiArticle(a: Article): ArticleCreateInput {
  return {
    material_type: a.materialType, item_category: a.itemCategory, sub_category: a.subCategory,
    item_description: a.itemDescription, quantity: a.quantity || "0", uom: a.uom || "",
    pack_size: a.packSize || "0", unit_pack_size: a.unitPackSize || null,
    net_weight: a.netWeight || "0", lot_number: a.lotNumber || null,
  };
}

function validate(
  form: { request_date: string; from_warehouse: string; to_warehouse: string; reason_description: string },
  articles: Article[],
): string[] {
  const e: string[] = [];
  if (!form.request_date.trim()) e.push("Request date is required");
  if (!form.from_warehouse) e.push("From warehouse is required");
  if (!form.to_warehouse) e.push("To warehouse is required");
  if (form.from_warehouse && form.to_warehouse && form.from_warehouse === form.to_warehouse) e.push("From and To warehouse must be different");
  if (!form.reason_description.trim()) e.push("Reason is required");
  if (articles.length === 0) e.push("Add at least one complete article");
  articles.forEach((a, i) => {
    const n = i + 1;
    if (!a.materialType) e.push(`Article ${n}: material type required`);
    if (!a.itemCategory) e.push(`Article ${n}: category required`);
    if (!a.subCategory) e.push(`Article ${n}: sub category required`);
    if (!a.itemDescription) e.push(`Article ${n}: item description required`);
    if (a.materialType.toUpperCase() === "FG" && (parseFloat(a.unitPackSize) || 0) <= 0) e.push(`Article ${n}: unit pack size required for FG`);
  });
  return e;
}

export default function NewTransferRequestPage() {
  const router = useRouter();
  const allowed = useRequireAuth(router.replace);

  // Seeded empty so the initial render is deterministic (genRequestNo()/todayDMY() read
  // the wall clock and would mismatch between the SSR render and client hydration). Filled on mount below.
  const [requestNo, setRequestNo] = useState("");
  const [form, setForm] = useState({ request_date: "", from_warehouse: "", to_warehouse: "", reason_description: "" });
  const [rows, setRows] = useState<Row[]>(() => [{ uid: 0, data: { ...EMPTY_ARTICLE } }]);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set([0]));
  const nextUid = useRef(1);

  const [warehouses, setWarehouses] = useState<string[]>([]);
  const [materialTypes, setMaterialTypes] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [banner, setBanner] = useState<{ type: "error" | "success"; text: string } | null>(null);

  // load warehouses + material types on mount
  useEffect(() => {
    if (!allowed) return;
    let off = false;
    (async () => {
      try {
        const sites = await TransferApi.getWarehouseSites();
        if (!off) setWarehouses(sites.length ? sites.map((s: WarehouseSite) => s.site_code) : WAREHOUSE_FALLBACK);
      } catch { if (!off) setWarehouses(WAREHOUSE_FALLBACK); }
      try {
        const d = await TransferApi.categorialDropdown({});
        if (!off) setMaterialTypes(d.options.material_types);
      } catch { /* leave empty */ }
    })();
    return () => { off = true; };
  }, [allowed]);

  // ── Seed clock-derived defaults on the client (avoids the SSR hydration mismatch). ──
  // Deferred via setTimeout so the setState isn't synchronous in the effect body
  // (react-hooks/set-state-in-effect).
  useEffect(() => {
    const id = setTimeout(() => {
      setRequestNo(genRequestNo());
      setForm((f) => ({ ...f, request_date: todayDMY() }));
    }, 0);
    return () => clearTimeout(id);
  }, []);

  // ── row ops ──
  const patchRow = useCallback((uid: number, patch: Partial<Article>) => {
    setRows((rs) => rs.map((r) => (r.uid === uid ? { uid, data: patchArticle(r.data, patch) } : r)));
  }, []);
  const addRow = () => {
    const uid = nextUid.current++;
    setRows((rs) => [...rs, { uid, data: { ...NEW_ARTICLE } }]);
    setExpanded((s) => new Set(s).add(uid));
  };
  const removeRow = (uid: number) => {
    setRows((rs) => {
      const left = rs.filter((r) => r.uid !== uid);
      return left.length ? left : [{ uid: nextUid.current++, data: { ...EMPTY_ARTICLE } }];
    });
    setExpanded((s) => { const n = new Set(s); n.delete(uid); return n; });
  };
  const toggle = (uid: number) => setExpanded((s) => { const n = new Set(s); if (n.has(uid)) n.delete(uid); else n.add(uid); return n; });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setBanner(null);
    const filled = rows.map((r) => r.data).filter((a) => a.materialType || a.itemDescription);
    const errs = validate(form, filled);
    if (errs.length) { setBanner({ type: "error", text: errs.join(" · ") }); setSubmitting(false); return; }
    try {
      const res = await TransferApi.createRequest({
        form_data: { ...form },
        article_data: filled.map(toApiArticle),
        computed_fields: { request_no: requestNo },
      });
      setBanner({ type: "success", text: `Request ${res.request_no || requestNo} created.` });
      setTimeout(() => router.push("/modules/transfer"), 700);
    } catch (err) {
      setBanner({ type: "error", text: err instanceof Error ? err.message : "Failed to create request." });
      setSubmitting(false);
    }
  };

  // No `if (!allowed) return null` gate: useRequireAuth returns true on the server but
  // false on the client's first render, so gating the render on it causes a hydration
  // mismatch. Effects are gated on `allowed`; the hook redirects unauthenticated users.

  return (
    <TransferChrome title="New Transfer Request">
      <button onClick={() => router.push("/modules/transfer")}
        className="text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] mb-3">← Transfer</button>

      <div className="flex flex-wrap items-end justify-between gap-2 mb-4">
        <h1 className="text-[20px] font-semibold text-[var(--text-primary)]">New Transfer Request</h1>
        <span className="text-[12px] text-[var(--text-secondary)]">Request No <span className="font-mono text-[var(--text-primary)]">{requestNo}</span></span>
      </div>

      {banner && (
        <div className={`mb-4 rounded-md p-3 text-[13px] border ${banner.type === "error" ? "bg-rose-50 border-rose-200 text-rose-700" : "bg-emerald-50 border-emerald-200 text-emerald-700"}`}>
          {banner.text}
        </div>
      )}

      <form id="transfer-request-form" onSubmit={handleSubmit} className="space-y-4 max-w-3xl">
        {/* Header card */}
        <section className="bg-white border border-[var(--aws-border)] rounded-lg p-4">
          <h2 className="text-[13px] font-semibold text-[var(--text-primary)] mb-3">Request details</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Request Date" required>
              <input value={form.request_date} onChange={(e) => setForm({ ...form, request_date: e.target.value })}
                placeholder="DD-MM-YYYY" className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" />
            </Field>
            <div />
            <Field label="From (Requesting)" required>
              <select value={form.from_warehouse} onChange={(e) => setForm({ ...form, from_warehouse: e.target.value })}
                className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-white">
                <option value="">Select warehouse…</option>
                {warehouses.map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            </Field>
            <Field label="To (Supplying)" required>
              <select value={form.to_warehouse} onChange={(e) => setForm({ ...form, to_warehouse: e.target.value })}
                className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-white">
                <option value="">Select warehouse…</option>
                {warehouses.filter((w) => w !== form.from_warehouse).map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            </Field>
            <div className="sm:col-span-2">
              <Field label="Reason" required>
                <textarea value={form.reason_description} onChange={(e) => setForm({ ...form, reason_description: e.target.value })}
                  rows={2} placeholder="Short reason for this transfer…"
                  className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md resize-y" />
              </Field>
            </div>
          </div>
        </section>

        {/* Articles — collapsible editable sections */}
        <div className="flex items-center justify-between">
          <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">Articles ({rows.length})</h2>
          <button type="button" onClick={addRow}
            className="px-2.5 py-1 text-[12px] border border-[var(--aws-navy)] text-[var(--aws-navy)] rounded-md hover:bg-[var(--aws-navy)] hover:text-white">+ Add another</button>
        </div>

        {rows.map((r, idx) => (
          <ArticleSection
            key={r.uid}
            index={idx}
            data={r.data}
            open={expanded.has(r.uid)}
            materialTypes={materialTypes}
            canRemove={rows.length > 1}
            onToggle={() => toggle(r.uid)}
            onRemove={() => removeRow(r.uid)}
            onPatch={(patch) => patchRow(r.uid, patch)}
          />
        ))}

        {/* Footer */}
        <section className="bg-white border border-[var(--aws-border)] rounded-lg p-4 flex flex-wrap items-center justify-between gap-3">
          <span className="text-[12px] text-[var(--text-secondary)]">The request will be created with status <span className="font-medium text-amber-600">Pending</span>.</span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => router.back()}
              className="px-3 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md hover:border-[var(--aws-navy)]">Cancel</button>
            <button type="submit" disabled={submitting}
              className="px-4 py-1.5 text-[13px] rounded-md bg-[var(--aws-navy)] text-white hover:opacity-90 disabled:opacity-50">
              {submitting ? "Submitting…" : "Submit Request"}
            </button>
          </div>
        </section>
      </form>
    </TransferChrome>
  );
}

// ── Collapsible article section ───────────────────────────────────────────────
function ArticleSection({ index, data, open, materialTypes, canRemove, onToggle, onRemove, onPatch }: {
  index: number; data: Article; open: boolean; materialTypes: string[]; canRemove: boolean;
  onToggle: () => void; onRemove: () => void; onPatch: (patch: Partial<Article>) => void;
}) {
  // Per-article cascading options (each section is independent).
  const [opt, setOpt] = useState<{ categories: string[]; subs: string[]; descriptions: string[]; uoms: (number | null)[] }>(
    { categories: [], subs: [], descriptions: [], uoms: [] });

  useEffect(() => {
    if (!data.materialType) return;
    let off = false;
    (async () => {
      const d = await TransferApi.categorialDropdown({ material_type: data.materialType });
      if (!off) setOpt((o) => ({ ...o, categories: d.options.item_categories }));
    })().catch(() => {});
    return () => { off = true; };
  }, [data.materialType]);

  useEffect(() => {
    if (!data.materialType || !data.itemCategory) return;
    let off = false;
    (async () => {
      const d = await TransferApi.categorialDropdown({ material_type: data.materialType, item_category: data.itemCategory });
      if (!off) setOpt((o) => ({ ...o, subs: d.options.sub_categories }));
    })().catch(() => {});
    return () => { off = true; };
  }, [data.materialType, data.itemCategory]);

  useEffect(() => {
    if (!data.materialType || !data.itemCategory || !data.subCategory) return;
    let off = false;
    (async () => {
      const d = await TransferApi.categorialDropdown({ material_type: data.materialType, item_category: data.itemCategory, sub_category: data.subCategory });
      if (!off) setOpt((o) => ({ ...o, descriptions: d.options.item_descriptions, uoms: d.options.uom_values }));
    })().catch(() => {});
    return () => { off = true; };
  }, [data.materialType, data.itemCategory, data.subCategory]);

  const selectDescription = (desc: string) => {
    const i = opt.descriptions.indexOf(desc);
    const uom = i >= 0 ? opt.uoms[i] : null;
    onPatch(uom != null ? { itemDescription: desc, unitPackSize: String(uom) } : { itemDescription: desc });
  };
  const applySearchItem = (it: CategorialSearchItem) => {
    onPatch({
      materialType: it.material_type || "", itemCategory: it.group || "",
      subCategory: it.sub_group || "", itemDescription: it.item_description || "",
      unitPackSize: it.uom != null ? String(it.uom) : data.unitPackSize,
    });
  };

  const summary = data.itemDescription || "New article — not yet filled";

  return (
    <section className="bg-white border border-[var(--aws-border)] rounded-lg overflow-hidden">
      {/* Header (click to expand/collapse) */}
      <div className="flex items-center gap-2 px-4 py-2.5 cursor-pointer hover:bg-[var(--background)]" onClick={onToggle}>
        <span className="inline-block w-4 text-[var(--text-secondary)]">{open ? "▾" : "▸"}</span>
        <span className="text-[12px] font-semibold text-[var(--text-primary)] shrink-0">Article {index + 1}</span>
        <span className="text-[12px] text-[var(--text-secondary)] truncate flex-1">
          {data.itemDescription ? (
            <>· {summary} <span className="text-[var(--text-secondary)]">· {data.materialType || "—"} · {data.quantity || "0"} {data.uom} · {data.netWeight} kg</span></>
          ) : (
            <span className="italic">{summary}</span>
          )}
        </span>
        {canRemove && (
          <button type="button" onClick={(e) => { e.stopPropagation(); onRemove(); }}
            className="text-[12px] text-rose-600 hover:underline shrink-0">Remove</button>
        )}
      </div>

      {/* Editable body */}
      {open && (
        <div className="px-4 pb-4 pt-1 border-t border-[var(--aws-border)]">
          <div className="mt-3"><QuickSearch onPick={applySearchItem} /></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
            <Field label="Material Type" required>
              <SearchableSelect value={data.materialType} options={materialTypes}
                onChange={(v) => onPatch({ materialType: v })} placeholder="Select…" />
            </Field>
            <Field label="Category" required>
              <SearchableSelect value={data.itemCategory} options={opt.categories} disabled={!data.materialType}
                onChange={(v) => onPatch({ itemCategory: v })} placeholder={data.materialType ? "Select…" : "Pick material first"} />
            </Field>
            <Field label="Sub Category" required>
              <SearchableSelect value={data.subCategory} options={opt.subs} disabled={!data.itemCategory}
                onChange={(v) => onPatch({ subCategory: v })} placeholder={data.itemCategory ? "Select…" : "Pick category first"} />
            </Field>
            <Field label="Item Description" required>
              <SearchableSelect value={data.itemDescription} options={opt.descriptions} disabled={!data.subCategory}
                onChange={selectDescription} placeholder={data.subCategory ? "Select…" : "Pick sub category first"} />
            </Field>
            <Field label="Unit Pack Size / Count">
              <input type="number" step="any" min="0" value={data.unitPackSize} onWheel={(e) => e.currentTarget.blur()}
                onChange={(e) => onPatch({ unitPackSize: e.target.value })}
                className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" />
            </Field>
            <Field label="UOM">
              <select value={data.uom} onChange={(e) => onPatch({ uom: e.target.value })}
                className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-white">
                <option value="">—</option>
                {UOM_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </Field>
            <Field label="Case Pack / Box Wt.">
              <input type="number" step="any" min="0" value={data.packSize} placeholder="0.00" onWheel={(e) => e.currentTarget.blur()}
                onChange={(e) => onPatch({ packSize: e.target.value })}
                className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" />
            </Field>
            <Field label="Quantity (Box/Bags)">
              <input type="number" step="any" min="0" value={data.quantity} placeholder="0" onWheel={(e) => e.currentTarget.blur()}
                onChange={(e) => onPatch({ quantity: e.target.value })}
                className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" />
            </Field>
            <Field label="Net Weight (Kg)">
              <input type="number" step="any" min="0" value={data.netWeight} onWheel={(e) => e.currentTarget.blur()}
                onChange={(e) => onPatch({ netWeight: e.target.value })}
                className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" />
            </Field>
            <Field label="Lot Number (optional)">
              <input value={data.lotNumber} onChange={(e) => onPatch({ lotNumber: e.target.value })}
                className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" />
            </Field>
          </div>
        </div>
      )}
    </section>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────
function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] uppercase tracking-wide text-[var(--text-secondary)] mb-1">{label}{required && <span className="text-rose-500"> *</span>}</span>
      {children}
    </label>
  );
}

function SearchableSelect({ value, options, onChange, placeholder, disabled }: {
  value: string; options: string[]; onChange: (v: string) => void; placeholder?: string; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? options.filter((o) => o.toLowerCase().includes(t)) : options;
  }, [q, options]);

  return (
    <div className="relative" ref={ref}>
      <button type="button" disabled={disabled} onClick={() => { setOpen((v) => !v); setQ(""); }}
        className={`w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-white text-left flex items-center justify-between gap-2 ${disabled ? "opacity-50 cursor-not-allowed" : "hover:border-[var(--aws-navy)]"}`}>
        <span className={value ? "text-[var(--text-primary)] truncate" : "text-[var(--text-secondary)]"}>{value || placeholder || "Select…"}</span>
        <span className="text-[var(--text-secondary)] shrink-0">▾</span>
      </button>
      {open && !disabled && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-[var(--aws-border)] rounded-md shadow-lg max-h-64 overflow-y-auto">
          <div className="p-1.5 sticky top-0 bg-white border-b border-[var(--aws-border)]">
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…"
              className="w-full px-2 py-1 text-[12px] border border-[var(--aws-border)] rounded" />
          </div>
          {filtered.length === 0 ? (
            <div className="px-3 py-3 text-[12px] text-[var(--text-secondary)] text-center">No matches</div>
          ) : filtered.map((o) => (
            <button key={o} type="button" onClick={() => { onChange(o); setOpen(false); }}
              className={`block w-full text-left px-3 py-1.5 text-[12px] hover:bg-[var(--background)] ${o === value ? "bg-[var(--background)] font-medium" : ""}`}>{o}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function QuickSearch({ onPick }: { onPick: (it: CategorialSearchItem) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<CategorialSearchItem[]>([]);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) return;   // clearing handled in the input onChange
    let off = false;
    const h = setTimeout(async () => {
      try {
        const r = await TransferApi.categorialSearch(t, 50);
        if (!off) { setResults(r.items); setTotal(r.meta.total_items ?? r.items.length); setOpen(true); }
      } catch { /* ignore */ }
    }, 300);
    return () => { off = true; clearTimeout(h); };
  }, [q]);

  const onType = (v: string) => {
    setQ(v);
    if (v.trim().length < 2) { setResults([]); setTotal(0); setOpen(false); }
  };

  return (
    <div className="relative" ref={ref}>
      <input value={q} onChange={(e) => onType(e.target.value)} onFocus={() => results.length && setOpen(true)}
        placeholder="Quick search item (type 2+ chars)…"
        className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" />
      {open && results.length > 0 && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-[var(--aws-border)] rounded-md shadow-lg max-h-[60vh] overflow-y-auto">
          {results.map((it) => (
            <button key={`${it.id}-${it.material_type}`} type="button" onClick={() => { onPick(it); setQ(""); setOpen(false); }}
              className="block w-full text-left px-3 py-2 text-[12px] hover:bg-[var(--background)] border-b border-[var(--aws-border)]/40">
              <div className="text-[var(--text-primary)]">{it.item_description}</div>
              <div className="text-[11px] text-[var(--text-secondary)]">{[it.material_type, it.group, it.sub_group].filter(Boolean).join(" · ")}</div>
            </button>
          ))}
          <div className="px-3 py-1.5 text-[11px] text-[var(--text-secondary)] sticky bottom-0 bg-white border-t border-[var(--aws-border)]">Showing {results.length} of {total}</div>
        </div>
      )}
      {open && q.trim().length >= 2 && results.length === 0 && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-[var(--aws-border)] rounded-md shadow-lg px-3 py-3 text-[12px] text-[var(--text-secondary)] text-center">No items found</div>
      )}
    </div>
  );
}
