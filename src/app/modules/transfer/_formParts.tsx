"use client";

// Shared building blocks for the Transfer-OUT forms (doc 07 transferform + doc 08
// directtransferform): static option lists, the Article/ScannedBox shapes + cascade/
// net-weight helpers, and the small presentational components (Card, Field,
// SearchableSelect, QuickSearch). Kept in one place so both forms stay in lockstep.

import { useEffect, useMemo, useRef, useState } from "react";
import { TransferApi, type CategorialSearchItem } from "@/lib/transfer";

export const UOM_OPTIONS = ["KG", "PCS", "BOX", "BAG", "CARTON"];
export const FROM_WAREHOUSES = ["W202", "A185", "A101", "A68", "F53", "Cold Storage"];
export const TO_WAREHOUSES = ["W202", "A185", "A101", "A68", "F53", "Rishi", "Savla D-39", "Savla D-514", "Supreme"];
export const REASONS = ["Stock Requirement", "Material Movement", "Production Need", "Customer Order", "Inventory Balancing", "Other"];
export const VEHICLES = ["MH43BP6885", "MH43BX1881", "MH46BM5987 (Contract Vehicle)"];
export const DRIVERS = ["Tukaram (+919930056340)", "Sachin (8692885298)", "Gopal (+919975887148)"];
export const COLD_STORAGE_WAREHOUSES = new Set(["Cold Storage", "Rishi", "Savla D-39", "Savla D-514", "Supreme"]);

export function todayDMY(): string {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
}
export function genTransferNo(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `TRANS${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}

export interface Article {
  uid: number;
  materialType: string; itemCategory: string; subCategory: string; itemDescription: string;
  unitPackSize: string; uom: string; packSize: string; quantity: string; netWeight: string; lotNumber: string;
  // Cold-source identifiers (directtransferform cold mode); absent/empty for warehouse rows.
  csCompany?: string; csInwardNo?: string; csMaxBoxes?: number;
  entryMode?: "regular" | "cold-storage";
}
export const EMPTY_ARTICLE: Omit<Article, "uid"> = {
  materialType: "", itemCategory: "", subCategory: "", itemDescription: "",
  unitPackSize: "", uom: "", packSize: "1", quantity: "1", netWeight: "0", lotNumber: "",
  csCompany: "", csInwardNo: "", csMaxBoxes: 0, entryMode: "regular",
};

export interface ScannedBox {
  id: number; boxNumber: number; boxId: string; transactionNo: string; article: string;
  lotNumber: string; batchNumber: string; netWeight: string; grossWeight: string;
}

export function calcNetWeight(a: Pick<Article, "materialType" | "quantity" | "packSize" | "unitPackSize">): string {
  const q = parseFloat(a.quantity) || 0;
  const ps = parseFloat(a.packSize) || 0;
  const ups = parseFloat(a.unitPackSize) || 0;
  if (a.materialType.toUpperCase() === "FG") return (ups * ps * q).toFixed(3);
  return (ps * q).toFixed(3);
}

// Apply a field patch with cascade resets + net-weight recompute. A reset only clears a
// downstream field when the SAME patch isn't already setting it (so a bulk set from quick
// search is preserved). Cold articles keep their per-box net_weight (no recompute).
export function patchArticle(prev: Article, patch: Partial<Article>): Article {
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
  const isCold = next.entryMode === "cold-storage";
  if (!isCold && ("quantity" in patch || "packSize" in patch || "unitPackSize" in patch || "materialType" in patch || "itemDescription" in patch)) {
    next.netWeight = calcNetWeight(next);
  }
  return next;
}

// ── presentational components ──
export function Card({ title, action, children }: { title?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="bg-white border border-[var(--aws-border)] rounded-lg p-4">
      {(title || action) && (
        <div className="flex items-center justify-between mb-3">
          {title ? <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">{title}</h2> : <span />}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] uppercase tracking-wide text-[var(--text-secondary)] mb-1">{label}{required && <span className="text-rose-500"> *</span>}</span>
      {children}
    </label>
  );
}

export function SearchableSelect({ value, options, onChange, placeholder, disabled }: {
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
  const filtered = useMemo(() => { const t = q.trim().toLowerCase(); return t ? options.filter((o) => o.toLowerCase().includes(t)) : options; }, [q, options]);
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
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="w-full px-2 py-1 text-[12px] border border-[var(--aws-border)] rounded" />
          </div>
          {filtered.length === 0 ? <div className="px-3 py-3 text-[12px] text-[var(--text-secondary)] text-center">No matches</div>
            : filtered.map((o) => <button key={o} type="button" onClick={() => { onChange(o); setOpen(false); }} className={`block w-full text-left px-3 py-1.5 text-[12px] hover:bg-[var(--background)] ${o === value ? "bg-[var(--background)] font-medium" : ""}`}>{o}</button>)}
        </div>
      )}
    </div>
  );
}

export function QuickSearch({ onPick }: { onPick: (it: CategorialSearchItem) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<CategorialSearchItem[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  useEffect(() => {
    const t = q.trim(); if (t.length < 2) return; let off = false;
    const h = setTimeout(async () => {
      try { const r = await TransferApi.categorialSearch(t, 50); if (!off) { setResults(r.items); setOpen(true); } } catch { /* ignore */ }
    }, 300);
    return () => { off = true; clearTimeout(h); };
  }, [q]);
  const onType = (v: string) => { setQ(v); if (v.trim().length < 2) { setResults([]); setOpen(false); } };
  return (
    <div className="relative" ref={ref}>
      <input value={q} onChange={(e) => onType(e.target.value)} onFocus={() => results.length && setOpen(true)}
        placeholder="Quick search item (type 2+ chars)…" className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" />
      {open && results.length > 0 && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-[var(--aws-border)] rounded-md shadow-lg max-h-[60vh] overflow-y-auto">
          {results.map((it) => (
            <button key={`${it.id}-${it.material_type}`} type="button" onClick={() => { onPick(it); setQ(""); setOpen(false); }}
              className="block w-full text-left px-3 py-2 text-[12px] hover:bg-[var(--background)] border-b border-[var(--aws-border)]/40">
              <div className="text-[var(--text-primary)]">{it.item_description}</div>
              <div className="text-[11px] text-[var(--text-secondary)]">{[it.material_type, it.group, it.sub_group].filter(Boolean).join(" · ")}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
