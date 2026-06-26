"use client";

// Inner Cold Transfer (doc 11) — relabel a lot (old → new) and/or relocate boxes WITHIN
// cold storage. Not an inter-unit transfer: it mutates the cold-stock tables directly via
// POST /api/v1/transfer/inner-transfer. Create, or edit (append lines) via ?editChallan=.
// Reuses the shared ColdStockSearch picker + _formParts Card/Field. Per the reference, the
// fetched storage-locations list is dead data, so we use the fixed cold-location chips only.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import { TransferChrome } from "../_chrome";
import { Card, Field } from "../_formParts";
import { ColdStockSearch } from "../_ColdStockSearch";
import { TransferApi, type InnerTransferCreateBody } from "@/lib/transfer";
import type { ColdStockRecord } from "@/lib/coldStorage";

const COMPANY = "cfpl";
const COLD_LOCATIONS = ["Savla Bond", "Savla D-39", "Savla D-514", "Rishi", "Supreme"];
const REASONS = ["Stock Requirement", "Material Movement", "Inventory Balancing", "Space Management", "Other"];

function todayDMY(): string {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
}
function genICTNo(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `ICT${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}
function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

interface ICTArticle {
  uid: number;
  stockRecordId: number | null;
  itemCategory: string; itemDescription: string;
  oldLot: string; perBoxWeight: number; availableBoxes: number;
  quantity: string; newLot: string; newLocation: string;
}
const EMPTY: Omit<ICTArticle, "uid"> = {
  stockRecordId: null, itemCategory: "", itemDescription: "", oldLot: "",
  perBoxWeight: 0, availableBoxes: 0, quantity: "0", newLot: "", newLocation: "",
};

interface TransferEntry {
  id: number; stockRecordId: number | null; itemCategory: string; itemDescription: string;
  perBoxWeight: number; quantity: number; oldLot: string; newLot: string; newLocation: string;
  isExisting?: boolean;
}

function LocationChips({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {COLD_LOCATIONS.map((loc) => {
        const sel = value === loc;
        return (
          <button key={loc} type="button" onClick={() => onChange(sel ? "" : loc)}
            className={`px-2.5 py-1 text-[12px] rounded-full border ${sel ? "bg-[var(--aws-navy)] text-white border-[var(--aws-navy)]" : "border-[var(--aws-border)] text-[var(--text-secondary)] hover:border-[var(--aws-navy)]"}`}>
            {loc}
          </button>
        );
      })}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<TransferChrome title="Inner Cold Transfer"><div className="py-16 text-center text-[13px] text-[var(--text-secondary)]">Loading…</div></TransferChrome>}>
      <InnerColdTransferForm />
    </Suspense>
  );
}

function InnerColdTransferForm() {
  const router = useRouter();
  const allowed = useRequireAuth(router.replace);
  const searchParams = useSearchParams();
  const editChallan = searchParams.get("editChallan");
  const isEditMode = !!editChallan;

  // Seeded empty so the initial render is deterministic (genICTNo()/todayDMY() read the
  // wall clock and would mismatch between the SSR render and client hydration). Filled on mount below.
  const [transferNo, setTransferNo] = useState("");
  const [form, setForm] = useState({ transferDate: "", fromWarehouse: "", reason: "", reasonDescription: "" });
  const [articles, setArticles] = useState<ICTArticle[]>([{ uid: 0, ...EMPTY }]);
  const nextUid = useRef(1);
  const [entries, setEntries] = useState<TransferEntry[]>([]);
  const nextEntryId = useRef(1);

  const [submitting, setSubmitting] = useState(false);
  const [editLoading, setEditLoading] = useState(isEditMode);
  const [banner, setBanner] = useState<{ type: "error" | "success"; text: string } | null>(null);

  // ── Edit prefill ──
  useEffect(() => {
    if (!allowed || !editChallan) return;
    let off = false;
    (async () => {
      try {
        const d = await TransferApi.getInnerTransfer(editChallan);
        if (off) return;
        setTransferNo(d.challan_no || genICTNo());
        setForm({
          transferDate: d.transfer_date || todayDMY(),
          fromWarehouse: d.from_warehouse || "",
          reason: d.reason_code || "",
          reasonDescription: d.remark || "",
        });
        setEntries(d.lines.map((ln) => ({
          id: nextEntryId.current++,
          stockRecordId: ln.stock_record_id,
          itemCategory: ln.item_category || "",
          itemDescription: ln.item_description || "",
          perBoxWeight: ln.quantity ? num(ln.net_weight_kg) / ln.quantity : num(ln.net_weight_kg),
          quantity: ln.quantity,
          oldLot: ln.old_lot_number || "",
          newLot: ln.new_lot_number || "",
          newLocation: ln.new_storage_location || "",
          isExisting: true,
        })));
      } catch (e) {
        if (!off) setBanner({ type: "error", text: e instanceof Error ? e.message : "Failed to load transfer." });
      } finally {
        if (!off) setEditLoading(false);
      }
    })();
    return () => { off = true; };
  }, [allowed, editChallan]);

  // ── Seed clock-derived defaults on the client (avoids the SSR hydration mismatch). ──
  // Edit mode fills these from the loaded transfer; deferred via setTimeout so the
  // setState isn't synchronous in the effect body (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (isEditMode) return;
    const id = setTimeout(() => {
      setTransferNo(genICTNo());
      setForm((f) => ({ ...f, transferDate: todayDMY() }));
    }, 0);
    return () => clearTimeout(id);
  }, [isEditMode]);

  // ── Article ops ──
  const patch = useCallback((uid: number, p: Partial<ICTArticle>) =>
    setArticles((as) => as.map((a) => (a.uid === uid ? { ...a, ...p } : a))), []);
  const addArticle = () => { const uid = nextUid.current++; setArticles((as) => [...as, { uid, ...EMPTY }]); };
  const removeArticle = (uid: number) => setArticles((as) => (as.length > 1 ? as.filter((a) => a.uid !== uid) : as));

  const selectStock = (uid: number, r: ColdStockRecord) => {
    setArticles((as) => as.map((a) => (a.uid === uid ? {
      ...a,
      stockRecordId: r.id,
      itemCategory: r.group_name || "",
      itemDescription: r.item_description || "",
      oldLot: r.lot_no ? String(r.lot_no) : "",
      perBoxWeight: num(r.weight_kg),
      availableBoxes: r.net_qty_on_cartons != null ? Math.ceil(r.net_qty_on_cartons) : 0,
      quantity: "0", newLot: "", newLocation: "",
    } : a)));
    // Auto-derive the source location from the picked record if none chosen yet.
    setForm((f) => {
      if (f.fromWarehouse) return f;
      const guess = (r.storage_location || r.unit || "").trim();
      const match = COLD_LOCATIONS.find((l) => l.toLowerCase() === guess.toLowerCase());
      return match ? { ...f, fromWarehouse: match } : f;
    });
    setBanner(null);
  };

  const addToList = (a: ICTArticle) => {
    if (!a.itemDescription || a.stockRecordId == null) { setBanner({ type: "error", text: "Select a stock lot first." }); return; }
    const qty = Math.floor(num(a.quantity));
    if (qty <= 0) { setBanner({ type: "error", text: "Enter the number of boxes (> 0)." }); return; }
    if (a.availableBoxes && qty > a.availableBoxes) { setBanner({ type: "error", text: `Only ${a.availableBoxes} boxes available for this lot.` }); return; }
    if (!a.newLot.trim()) { setBanner({ type: "error", text: "New lot number is required." }); return; }
    const id = nextEntryId.current++;
    setEntries((es) => [...es, {
      id, stockRecordId: a.stockRecordId, itemCategory: a.itemCategory, itemDescription: a.itemDescription,
      perBoxWeight: a.perBoxWeight, quantity: qty, oldLot: a.oldLot, newLot: a.newLot.trim(), newLocation: a.newLocation,
    }]);
    // Reset the source fields for the next pick on this article.
    patch(a.uid, { stockRecordId: null, itemCategory: "", itemDescription: "", oldLot: "", perBoxWeight: 0, availableBoxes: 0, quantity: "0", newLot: "", newLocation: "" });
    setBanner({ type: "success", text: `Staged ${a.itemDescription}: lot ${a.oldLot || "—"} → ${a.newLot.trim()}.` });
  };

  const removeEntry = (id: number) => setEntries((es) => es.filter((e) => e.id !== id));
  const clearNew = () => setEntries((es) => es.filter((e) => e.isExisting));

  const newEntries = useMemo(() => entries.filter((e) => !e.isExisting), [entries]);

  const validate = (): string[] => {
    const e: string[] = [];
    if (!form.fromWarehouse) e.push("Inner Stock Transfer selection is required");
    if (!form.reason) e.push("Reason is required");
    if (!form.reasonDescription.trim()) e.push("Reason description is required");
    if (!isEditMode && entries.length === 0) e.push("Add at least one transfer entry");
    return e;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBanner(null);
    const errs = validate();
    if (errs.length) { setBanner({ type: "error", text: errs.join(" · ") }); return; }
    // Edit appends only the new lines (existing rows are already saved server-side).
    const toSend = isEditMode ? newEntries : entries;
    if (toSend.length === 0) { setBanner({ type: "error", text: "No new lines to submit." }); return; }
    setSubmitting(true);
    const body: InnerTransferCreateBody = {
      company: COMPANY,
      header: {
        challan_no: transferNo, transfer_name: form.transferDate, from_warehouse: form.fromWarehouse,
        remark: form.reasonDescription || form.reason, reason_code: form.reason, transfer_type: "INNER_COLD",
      },
      lines: toSend.map((en) => ({
        stock_record_id: en.stockRecordId, item_category: en.itemCategory, item_description: en.itemDescription,
        net_weight: en.perBoxWeight, quantity: en.quantity, old_lot_number: en.oldLot,
        new_lot_number: en.newLot, new_storage_location: en.newLocation || null,
      })),
    };
    try {
      const res = await TransferApi.createInnerTransfer(body);
      if (res.errors && res.errors.length > 0) {
        // Backend is atomic (all-or-nothing) — errors mean nothing was applied.
        setBanner({ type: "error", text: `Not submitted: ${res.errors.join(" · ")}` });
        setSubmitting(false);
        return;
      }
      setBanner({ type: "success", text: `${isEditMode ? "Updated" : "Submitted"} — ${res.updated_records} line(s) relabeled.` });
      setTimeout(() => router.push("/modules/transfer"), 1200);
      // Leave submitting=true on success — page navigates away.
    } catch (err) {
      setBanner({ type: "error", text: err instanceof Error ? err.message : "Failed to submit inner cold transfer." });
      setSubmitting(false);
    }
  };

  // No `if (!allowed) return null` gate: useRequireAuth returns true on the server but
  // false on the client's first render, so gating the render on it causes a hydration
  // mismatch. Effects are gated on `allowed`; the hook redirects unauthenticated users.

  return (
    <TransferChrome title={isEditMode ? "Edit Inner Cold Transfer" : "Inner Cold Transfer"}>
      <button onClick={() => router.push("/modules/transfer")}
        className="text-[12px] text-[var(--text-secondary)] hover:underline mb-3">← Back to Transfer dashboard</button>

      <div className="flex flex-wrap items-end justify-between gap-2 mb-4">
        <h1 className="text-[20px] font-semibold text-[var(--text-primary)]">{isEditMode ? "Edit Inner Cold Transfer" : "Inner Cold Transfer"}</h1>
        <span className="text-[12px] text-[var(--text-secondary)]">Transfer No <span className="font-mono text-[var(--text-primary)]">{transferNo}</span></span>
      </div>

      {editLoading && <div className="mb-4 rounded-md p-3 text-[13px] bg-[var(--background)] border border-[var(--aws-border)] text-[var(--text-secondary)]">Loading transfer…</div>}
      {banner && (
        <div className={`mb-4 rounded-md p-3 text-[13px] border ${banner.type === "error" ? "bg-rose-50 border-rose-200 text-rose-700" : "bg-emerald-50 border-emerald-200 text-emerald-700"}`}>{banner.text}</div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4 max-w-5xl">
        {/* Header */}
        <Card title="Transfer details">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Transfer Date" required><input value={form.transferDate} onChange={(e) => setForm({ ...form, transferDate: e.target.value })}
              placeholder="DD-MM-YYYY" className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" /></Field>
            <Field label="Reason" required>
              <select value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}
                className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-white">
                <option value="">Select…</option>{REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </Field>
            <div className="sm:col-span-2">
              <Field label="Inner Stock Transfer (cold unit)" required><LocationChips value={form.fromWarehouse} onChange={(v) => setForm({ ...form, fromWarehouse: v })} /></Field>
            </div>
            <div className="sm:col-span-2">
              <Field label="Reason Description" required><textarea value={form.reasonDescription} onChange={(e) => setForm({ ...form, reasonDescription: e.target.value })}
                rows={2} className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md resize-y" /></Field>
            </div>
          </div>
        </Card>

        {/* Article entry */}
        <div className="flex items-center justify-between">
          <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">Articles ({articles.length})</h2>
          <button type="button" onClick={addArticle}
            className="px-2.5 py-1 text-[12px] border border-[var(--aws-navy)] text-[var(--aws-navy)] rounded-md hover:bg-[var(--aws-navy)] hover:text-white">+ Add Article</button>
        </div>
        {articles.map((a) => (
          <Card key={a.uid} title="Relabel / relocate a lot" action={articles.length > 1 ? <button type="button" onClick={() => removeArticle(a.uid)} className="text-[12px] text-rose-600 hover:underline">Remove</button> : undefined}>
            <ColdStockSearch onSelect={(r) => selectStock(a.uid, r)} />
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-3">
              <Field label="Item Category"><input value={a.itemCategory} readOnly className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-[var(--background)]" /></Field>
              <Field label="Item Description"><input value={a.itemDescription} readOnly className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-[var(--background)]" /></Field>
              <Field label="Old Lot Number"><input value={a.oldLot} readOnly className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-[var(--background)] font-mono" /></Field>
              <Field label="Weight / box (kg)"><input value={a.perBoxWeight || 0} readOnly className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-[var(--background)]" /></Field>
              <Field label={`No. of Boxes${a.availableBoxes ? ` (max ${a.availableBoxes})` : ""}`} required>
                <input type="number" step="1" min="0" value={a.quantity} onWheel={(e) => e.currentTarget.blur()}
                  onChange={(e) => { const n = parseInt(e.target.value, 10) || 0; patch(a.uid, { quantity: String(a.availableBoxes ? Math.min(n, a.availableBoxes) : n) }); }}
                  className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" />
              </Field>
              <Field label="Total Weight (kg)"><input value={(num(a.quantity) * a.perBoxWeight).toFixed(3)} readOnly className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-[var(--background)]" /></Field>
              <Field label="New Lot Number" required><input value={a.newLot} onChange={(e) => patch(a.uid, { newLot: e.target.value })}
                placeholder="Enter new lot" className="w-full px-2.5 py-1.5 text-[13px] border border-orange-300 rounded-md font-mono" /></Field>
              <div className="sm:col-span-2 lg:col-span-2">
                <Field label="New Storage Location (optional)"><LocationChips value={a.newLocation} onChange={(v) => patch(a.uid, { newLocation: v })} /></Field>
                {a.newLocation && <div className="text-[11px] text-[var(--text-secondary)] mt-1">Will move to: {a.newLocation}</div>}
              </div>
            </div>
            <div className="mt-3 flex justify-end">
              <button type="button" onClick={() => addToList(a)}
                className="px-3 py-1.5 text-[12px] rounded-md border border-[var(--aws-navy)] text-[var(--aws-navy)] hover:bg-[var(--aws-navy)] hover:text-white">Add to Transfer List</button>
            </div>
          </Card>
        ))}

        {/* Transfer list */}
        <Card title={`Transfer List (${entries.length})`} action={newEntries.length > 0 ? <button type="button" onClick={clearNew} className="text-[12px] text-rose-600 hover:underline">Clear New</button> : undefined}>
          {entries.length === 0 ? (
            <p className="text-[12px] text-[var(--text-secondary)] py-2">No entries yet — pick a lot, set the new lot, and add it to the list.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead><tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]">
                  <th className="py-1.5 pr-2">Item</th><th className="py-1.5 pr-2">Old Lot</th><th className="py-1.5 pr-2">New Lot</th>
                  <th className="py-1.5 pr-2 text-right">Boxes</th><th className="py-1.5 pr-2 text-right">Total Wt</th><th className="py-1.5 pr-2">New Location</th><th /></tr></thead>
                <tbody>{entries.map((en) => (
                  <tr key={en.id} className="border-b border-[var(--aws-border)]/40">
                    <td className="py-1.5 pr-2 max-w-[200px] truncate" title={en.itemDescription}>{en.itemDescription}{en.isExisting && <span className="ml-1 text-[10px] px-1 rounded bg-gray-100 text-gray-600">saved</span>}</td>
                    <td className="py-1.5 pr-2 font-mono">{en.oldLot || "—"}</td>
                    <td className="py-1.5 pr-2 font-mono text-orange-600">{en.newLot}</td>
                    <td className="py-1.5 pr-2 text-right">{en.quantity}</td>
                    <td className="py-1.5 pr-2 text-right">{(en.quantity * en.perBoxWeight).toFixed(3)}</td>
                    <td className="py-1.5 pr-2">{en.newLocation || "—"}</td>
                    <td className="py-1.5 text-right">{!en.isExisting && <button type="button" onClick={() => removeEntry(en.id)} className="text-rose-600 hover:underline">✕</button>}</td>
                  </tr>))}</tbody>
              </table>
            </div>
          )}
        </Card>

        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-[12px] text-[var(--text-secondary)]">{isEditMode ? "Edit appends new lines to this challan." : "Relabels the selected cold-stock lots."}</span>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => router.push("/modules/transfer")} className="px-3 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md hover:border-[var(--aws-navy)]">Cancel</button>
              <button type="submit" disabled={submitting || (!isEditMode && entries.length === 0)} className="px-4 py-1.5 text-[13px] rounded-md bg-[var(--aws-navy)] text-white hover:opacity-90 disabled:opacity-50">
                {submitting ? "Submitting…" : isEditMode ? `Update${newEntries.length ? ` (+${newEntries.length} new)` : ""}` : "Submit Transfer"}
              </button>
            </div>
          </div>
        </Card>
      </form>
    </TransferChrome>
  );
}
