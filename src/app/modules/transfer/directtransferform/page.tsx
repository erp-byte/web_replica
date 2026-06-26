"use client";

// Direct Transfer OUT (doc 08) — create a dispatch with no prior request, or EDIT an
// existing one via ?editId=. Reuses the shared form parts (_formParts) + QR scanner; adds
// a per-article Cold-Storage stock picker (cold-source dispatch) and the edit prefill.
// Create → POST /transfers; Edit → PUT /transfers/{id} (stamps edited_at). On submit the
// source stock (cold or warehouse) is deducted and boxes parked In-Transit.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import { TransferChrome } from "../_chrome";
import { QRScanner } from "../_QRScanner";
import { ColdStockSearch } from "../_ColdStockSearch";
import {
  Card, Field, SearchableSelect, QuickSearch,
  EMPTY_ARTICLE, patchArticle, todayDMY, genTransferNo,
  UOM_OPTIONS, FROM_WAREHOUSES, TO_WAREHOUSES, REASONS, VEHICLES, DRIVERS, COLD_STORAGE_WAREHOUSES,
  type Article, type ScannedBox,
} from "../_formParts";
import {
  TransferApi,
  type CategorialSearchItem, type LookupBox,
  type TransferBoxCreateInput, type TransferLineCreateInput,
} from "@/lib/transfer";
import { ColdStorageApi, type ColdStockRecord } from "@/lib/coldStorage";

const COMPANY = "cfpl"; // hint only — lookups search both cfpl + cdpl

export default function Page() {
  return (
    <Suspense fallback={<TransferChrome title="Transfer OUT"><div className="py-16 text-center text-[13px] text-[var(--text-secondary)]">Loading…</div></TransferChrome>}>
      <DirectTransferForm />
    </Suspense>
  );
}

function DirectTransferForm() {
  const router = useRouter();
  const allowed = useRequireAuth(router.replace);
  const searchParams = useSearchParams();
  const editId = searchParams.get("editId");
  const isEditMode = !!editId;

  // Seeded empty (not genTransferNo()/todayDMY()) so the initial render is deterministic:
  // reading the wall clock here would differ between the SSR render and client hydration
  // (timezone / minute drift) and throw a hydration mismatch. Filled on mount below.
  const [transferNo, setTransferNo] = useState("");
  const [form, setForm] = useState({
    requestNo: "", requestDate: "", fromWarehouse: "", toWarehouse: "", reason: "", reasonDescription: "",
  });
  const [transport, setTransport] = useState({ vehicle: "", vehicleOther: "", driver: "", driverOther: "", approval: "" });
  const [articles, setArticles] = useState<Article[]>([{ uid: 0, ...EMPTY_ARTICLE }]);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set([0]));
  const nextUid = useRef(1);
  const boxCounter = useRef(1);
  const scannedKeysRef = useRef<Set<string>>(new Set());
  // Preserve a request-originated transfer's FK link across an edit (create stays null).
  const existingRequestId = useRef<number | null>(null);

  const [scannedBoxes, setScannedBoxes] = useState<ScannedBox[]>([]);
  const [materialTypes, setMaterialTypes] = useState<string[]>([]);
  const [manualBox, setManualBox] = useState({ boxNumber: "", transactionNo: "" });
  const [showScanner, setShowScanner] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [editLoading, setEditLoading] = useState(isEditMode);
  const [banner, setBanner] = useState<{ type: "error" | "success"; text: string } | null>(null);
  const [coldPopup, setColdPopup] = useState<string | null>(null);

  const isColdFrom = COLD_STORAGE_WAREHOUSES.has(form.fromWarehouse);

  // ── Material types on mount ──
  useEffect(() => {
    if (!allowed) return;
    let off = false;
    TransferApi.categorialDropdown({}).then((d) => { if (!off) setMaterialTypes(d.options.material_types); }).catch(() => {});
    return () => { off = true; };
  }, [allowed]);

  // ── Seed clock-derived defaults on the client (avoids the SSR hydration mismatch). ──
  // Edit mode fills these from the loaded transfer, so only seed for a fresh create.
  // Deferred via setTimeout so the setState isn't synchronous in the effect body
  // (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (isEditMode) return;
    const id = setTimeout(() => {
      setTransferNo(genTransferNo());
      setForm((f) => ({ ...f, requestDate: todayDMY() }));
    }, 0);
    return () => clearTimeout(id);
  }, [isEditMode]);

  // ── Edit prefill ──
  useEffect(() => {
    if (!allowed || !editId) return;
    let off = false;
    (async () => {
      try {
        const t = await TransferApi.getTransfer(Number(editId));
        if (off) return;
        const norm = (v?: string | null) => (!v || v === "N/A" ? "" : v);
        const presetOrOther = (val: string, list: string[]) =>
          list.includes(val) ? { sel: val, other: "" } : (val ? { sel: "Other", other: val } : { sel: "", other: "" });
        setTransferNo(t.challan_no || genTransferNo());
        existingRequestId.current = t.request_id ?? null;
        setForm({
          requestNo: t.request_no || "", requestDate: t.stock_trf_date || todayDMY(),
          fromWarehouse: norm(t.from_warehouse), toWarehouse: norm(t.to_warehouse),
          reason: t.reason_code || "", reasonDescription: t.remark || "",
        });
        const v = presetOrOther(t.vehicle_no || "", VEHICLES);
        const d = presetOrOther(t.driver_name || "", DRIVERS);
        setTransport({ vehicle: v.sel, vehicleOther: v.other, driver: d.sel, driverOther: d.other, approval: t.approved_by || "" });
        const l0 = t.lines[0];
        if (l0) {
          setArticles([{
            uid: 0, materialType: norm(l0.material_type), itemCategory: norm(l0.item_category),
            subCategory: norm(l0.sub_category), itemDescription: norm(l0.item_description),
            unitPackSize: l0.unit_pack_size || "", uom: norm(l0.uom), packSize: l0.pack_size || "1",
            quantity: l0.quantity || "1", netWeight: l0.net_weight || "0", lotNumber: l0.lot_number || "",
            entryMode: "regular",
          }]);
        }
        // Prefer real box rows; else rebuild from lines as DIRECT (line-only) entries.
        if (t.boxes.length) {
          setScannedBoxes(t.boxes.map((b, i) => {
            const tno = b.transaction_no || "";
            if (b.box_id && tno && tno !== "DIRECT") scannedKeysRef.current.add(`${b.box_id}|${tno}`);
            return {
              id: i + 1, boxNumber: b.box_number ?? i + 1, boxId: b.box_id || "", transactionNo: tno,
              article: b.article || "", lotNumber: b.lot_number || "", batchNumber: b.batch_number || "",
              netWeight: String(b.net_weight ?? "0"), grossWeight: String(b.gross_weight ?? "0"),
            };
          }));
          boxCounter.current = t.boxes.length + 1;
        } else {
          setScannedBoxes(t.lines.map((l, i) => ({
            id: i + 1, boxNumber: i + 1, boxId: "", transactionNo: "DIRECT", article: l.item_description,
            lotNumber: l.lot_number || "", batchNumber: "", netWeight: String(l.net_weight ?? "0"),
            grossWeight: String(l.total_weight ?? l.net_weight ?? "0"),
          })));
          boxCounter.current = t.lines.length + 1;
        }
      } catch (e) {
        if (!off) setBanner({ type: "error", text: e instanceof Error ? e.message : "Failed to load transfer." });
      } finally {
        if (!off) setEditLoading(false);
      }
    })();
    return () => { off = true; };
  }, [allowed, editId]);

  // Changing From away from a cold warehouse resets any cold articles to regular
  // (done in the handler, not an effect, to avoid cascading setState-in-effect).
  const changeFromWarehouse = (value: string) => {
    setForm((f) => ({ ...f, fromWarehouse: value }));
    if (!COLD_STORAGE_WAREHOUSES.has(value)) {
      setArticles((as) => as.map((a) => (a.entryMode === "cold-storage"
        ? { ...a, entryMode: "regular", csCompany: "", csInwardNo: "", csMaxBoxes: 0 } : a)));
    }
  };

  // ── Article ops ──
  const patchArt = useCallback((uid: number, patch: Partial<Article>) =>
    setArticles((as) => as.map((a) => (a.uid === uid ? patchArticle(a, patch) : a))), []);
  const addArticle = () => {
    const uid = nextUid.current++;
    setArticles((as) => [...as, { uid, ...EMPTY_ARTICLE }]);
    setExpanded((s) => new Set(s).add(uid));
  };
  const removeArticle = (uid: number) => setArticles((as) => (as.length > 1 ? as.filter((a) => a.uid !== uid) : as));
  const toggle = (uid: number) => setExpanded((s) => { const n = new Set(s); if (n.has(uid)) n.delete(uid); else n.add(uid); return n; });
  const setMode = (uid: number, mode: "regular" | "cold-storage") =>
    setArticles((as) => as.map((a) => (a.uid === uid
      ? (mode === "regular" ? { ...a, entryMode: "regular", csCompany: "", csInwardNo: "", csMaxBoxes: 0 } : { ...a, entryMode: "cold-storage" })
      : a)));

  // ── Box ingestion (shared with transferform) ──
  const appendBox = useCallback((b: LookupBox, fallbackTno: string): boolean => {
    const boxId = (b.box_id || "").trim();
    const tno = (b.transaction_no || fallbackTno || "").trim();
    const key = boxId && tno ? `${boxId}|${tno}` : "";
    if (key && scannedKeysRef.current.has(key)) { setBanner({ type: "error", text: `Box ${boxId} / ${tno} already scanned.` }); return false; }
    if (key) scannedKeysRef.current.add(key);
    const article = b.item_description || b.article_description || "";
    const id = boxCounter.current++;
    setScannedBoxes((boxes) => [...boxes, {
      id, boxNumber: typeof b.box_number === "number" ? b.box_number : id, boxId, transactionNo: tno, article,
      lotNumber: b.lot_number || "", batchNumber: b.batch_number || "",
      netWeight: b.net_weight != null ? String(b.net_weight) : "0",
      grossWeight: b.gross_weight != null ? String(b.gross_weight) : "0",
    }]);
    setBanner(null);
    return true;
  }, []);

  const handleManualBoxFetch = async () => {
    const num = parseInt(manualBox.boxNumber, 10);
    const tno = manualBox.transactionNo.trim();
    if (!num || !tno) { setBanner({ type: "error", text: "Box number and transaction no are required." }); return; }
    try {
      const res = await TransferApi.boxLookupByNumber(COMPANY, num, tno);
      appendBox(res.box, tno);
      setManualBox({ boxNumber: "", transactionNo: "" });
    } catch (e) {
      setBanner({ type: "error", text: e instanceof Error ? e.message : "Box not found." });
    }
  };

  // Returns whether the code was added, so the scanner shows green (added) / rose
  // (unrecognised or duplicate) feedback. The scanner stays open so the operator can
  // scan box after box and read each result in the green bar; they dismiss it with ✕.
  const handleQRScan = useCallback(async (text: string): Promise<boolean> => {
    try {
      let parsed: { tx?: string; bi?: string } | null = null;
      try { parsed = JSON.parse(text); } catch { /* not JSON */ }
      if (parsed && parsed.tx && parsed.bi) {
        const tx = String(parsed.tx), bi = String(parsed.bi);
        const res = tx.startsWith("BE-")
          ? await TransferApi.bulkEntryBoxLookup(COMPANY, bi, tx)
          : await TransferApi.boxLookupById(COMPANY, bi, tx);
        return appendBox(res.box, tx);
      }
      setBanner({ type: "error", text: "Unrecognised QR format (expected a BE-/TR- box code)." });
      return false;
    } catch (e) {
      setBanner({ type: "error", text: e instanceof Error ? e.message : "QR lookup failed." });
      return false;
    }
  }, [appendBox]);

  // Cold-stock select → fill the article's cold fields (read-only item/weight + cs identifiers).
  const handleSelectCold = (uid: number, r: ColdStockRecord) => {
    setArticles((as) => as.map((a) => (a.uid === uid ? {
      ...a, entryMode: "cold-storage" as const,
      itemCategory: r.group_name || a.itemCategory, itemDescription: r.item_description || "",
      lotNumber: r.lot_no || "", netWeight: r.weight_kg != null ? String(r.weight_kg) : "0",
      quantity: "0", csCompany: r.company || "", csInwardNo: r.inward_no || "",
      csMaxBoxes: r.net_qty_on_cartons != null ? Math.ceil(r.net_qty_on_cartons) : 0,
    } : a)));
  };

  const addArticleToList = async (a: Article) => {
    if (!a.itemDescription) { setBanner({ type: "error", text: "Pick an item before adding to the list." }); return; }
    const isCold = a.entryMode === "cold-storage";
    const qty = Math.max(1, Math.floor(parseFloat(a.quantity) || 0));

    if (isCold) {
      // csInwardNo may legitimately be "" (cold rows with a NULL inward_no — pick_boxes
      // matches via COALESCE); csCompany + lotNumber are the real "selected" markers.
      if (!a.lotNumber || !a.csCompany) { setBanner({ type: "error", text: "Select a cold lot before adding." }); return; }
      if (a.csMaxBoxes && qty > a.csMaxBoxes) { setBanner({ type: "error", text: `Only ${a.csMaxBoxes} boxes available for this lot.` }); return; }
      let picked;
      try {
        picked = await ColdStorageApi.pickBoxes({ company: a.csCompany, item_description: a.itemDescription, lot_no: a.lotNumber, inward_no: a.csInwardNo || "", qty });
      } catch (e) {
        setBanner({ type: "error", text: e instanceof Error ? e.message : "Could not pick boxes." }); return;
      }
      const boxes = picked.boxes || [];
      if (boxes.length < qty) { setBanner({ type: "error", text: `Only ${boxes.length} unique boxes available (need ${qty}).` }); return; }
      const ids = new Set(boxes.map((b) => b.box_id));
      if (ids.size < boxes.length) { setBanner({ type: "error", text: "Cold pick returned duplicate box ids — aborting to avoid inventory loss." }); return; }
      const add: ScannedBox[] = [];
      for (const b of boxes) {
        const key = b.box_id && b.transaction_no ? `${b.box_id}|${b.transaction_no}` : "";
        if (key && scannedKeysRef.current.has(key)) continue;
        if (key) scannedKeysRef.current.add(key);
        const id = boxCounter.current++;
        add.push({
          id, boxNumber: id, boxId: b.box_id || "", transactionNo: b.transaction_no || "",
          article: a.itemDescription, lotNumber: a.lotNumber, batchNumber: "",
          netWeight: String(b.weight_kg ?? "0"), grossWeight: String(b.weight_kg ?? "0"),
        });
      }
      if (add.length === 0) {
        // pick_boxes is non-deducting + FIFO, so re-adding the same lot returns the same
        // leading box_ids — all already deduped. Tell the operator instead of a green "0".
        setBanner({ type: "error", text: "Those boxes are already in the list — remove some first, or this lot has no further unique boxes." });
        return;
      }
      setScannedBoxes((boxes2) => [...boxes2, ...add]);
      setBanner({ type: "success", text: `Added ${add.length} cold box(es) for ${a.itemDescription}.` });
      return;
    }

    // Regular (warehouse / manual) → DIRECT line-only boxes.
    if (a.materialType.toUpperCase() === "FG" && (parseFloat(a.unitPackSize) || 0) <= 0) {
      setBanner({ type: "error", text: "FG articles need a unit pack size before adding." }); return;
    }
    const totalNet = parseFloat(a.netWeight) || 0;
    const perBox = qty ? totalNet / qty : totalNet;
    const add: ScannedBox[] = [];
    for (let i = 0; i < qty; i++) {
      const id = boxCounter.current++;
      add.push({ id, boxNumber: id, boxId: "", transactionNo: "DIRECT", article: a.itemDescription, lotNumber: a.lotNumber, batchNumber: "", netWeight: perBox.toFixed(3), grossWeight: perBox.toFixed(3) });
    }
    setScannedBoxes((boxes) => [...boxes, ...add]);
    setBanner({ type: "success", text: `Added ${qty} ${a.itemDescription} entr${qty === 1 ? "y" : "ies"} to the list.` });
  };

  const updateScannedBox = (id: number, patch: Partial<ScannedBox>) =>
    setScannedBoxes((boxes) => boxes.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  const removeBox = (id: number) => setScannedBoxes((boxes) => {
    const b = boxes.find((x) => x.id === id);
    if (b && b.boxId && b.transactionNo && b.transactionNo !== "DIRECT") scannedKeysRef.current.delete(`${b.boxId}|${b.transactionNo}`);
    return boxes.filter((x) => x.id !== id);
  });
  const clearAllBoxes = () => { scannedKeysRef.current.clear(); setScannedBoxes([]); boxCounter.current = 1; };

  // ── Derived ──
  const totals = useMemo(() => {
    const net = scannedBoxes.reduce((s, b) => s + (parseFloat(b.netWeight) || 0), 0);
    const gross = scannedBoxes.reduce((s, b) => s + (parseFloat(b.grossWeight) || 0), 0);
    return { count: scannedBoxes.length, net, gross };
  }, [scannedBoxes]);

  const resolvedVehicle = transport.vehicle === "Other" ? transport.vehicleOther.trim() : transport.vehicle;
  const resolvedDriver = transport.driver === "Other" ? transport.driverOther.trim() : transport.driver;
  const isColdInvolved = COLD_STORAGE_WAREHOUSES.has(form.fromWarehouse) || COLD_STORAGE_WAREHOUSES.has(form.toWarehouse);

  const validate = (): string[] => {
    const e: string[] = [];
    if (!form.fromWarehouse) e.push("From warehouse is required");
    if (!form.toWarehouse) e.push("To warehouse is required");
    if (form.fromWarehouse && form.toWarehouse && form.fromWarehouse === form.toWarehouse) e.push("From and To warehouse must differ");
    if (!form.reason) e.push("Reason is required");
    if (!form.reasonDescription.trim()) e.push("Reason description is required");
    if (!resolvedVehicle) e.push("Vehicle number is required");
    if (!resolvedDriver) e.push("Driver name is required");
    if (!transport.approval.trim()) e.push("Approval authority is required");
    if (scannedBoxes.length === 0) e.push("Add at least one box (scan, fetch, cold-pick, or add an article to the list)");
    scannedBoxes.forEach((b) => {
      if ((parseFloat(b.netWeight) || 0) > (parseFloat(b.grossWeight) || 0) + 1e-6) e.push(`Box ${b.boxNumber}: net weight exceeds gross`);
    });
    return e;
  };

  const buildPayload = () => {
    // One line per box (doc 08), so the lines mirror what shipped.
    const lines: TransferLineCreateInput[] = scannedBoxes.map((b) => ({
      material_type: "RM", item_category: "", sub_category: "", item_description: b.article,
      quantity: "1", uom: "", pack_size: "0", unit_pack_size: null,
      net_weight: (parseFloat(b.netWeight) || 0).toFixed(3), total_weight: (parseFloat(b.grossWeight) || 0).toFixed(3),
      batch_number: b.batchNumber || null, lot_number: b.lotNumber || null, vakkal: null,
    }));
    const boxes: TransferBoxCreateInput[] = scannedBoxes.map((b) => ({
      box_number: b.boxNumber, box_id: b.boxId || null, article: b.article,
      lot_number: b.lotNumber || null, batch_number: b.batchNumber || null, transaction_no: b.transactionNo || null,
      net_weight: (parseFloat(b.netWeight) || 0).toFixed(3), gross_weight: (parseFloat(b.grossWeight) || 0).toFixed(3),
    }));
    return {
      header: {
        challan_no: transferNo, stock_trf_date: form.requestDate, from_warehouse: form.fromWarehouse,
        to_warehouse: form.toWarehouse, vehicle_no: resolvedVehicle, driver_name: resolvedDriver || null,
        approved_by: transport.approval.trim() || null, remark: form.reasonDescription || form.reason, reason_code: form.reason,
      },
      lines, boxes, request_id: existingRequestId.current,
    };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBanner(null);
    const errs = validate();
    if (errs.length) { setBanner({ type: "error", text: errs.join(" · ") }); window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }); return; }
    setSubmitting(true);
    try {
      const payload = buildPayload();
      const res = isEditMode ? await TransferApi.updateTransfer(Number(editId), payload) : await TransferApi.createTransfer(payload);
      if (isColdInvolved) {
        setColdPopup([
          `Transfer ${res.challan_no} (${res.status})`, `From ${form.fromWarehouse} → ${form.toWarehouse}`,
          `Vehicle ${resolvedVehicle}`, "", ...scannedBoxes.map((b) => `${b.article} — lot ${b.lotNumber || "—"}`),
        ].join("\n"));
      } else {
        setBanner({ type: "success", text: `Transfer ${res.challan_no} ${isEditMode ? "updated" : "created"} (${res.status}).` });
        setTimeout(() => router.push("/modules/transfer"), 1200);
      }
      // Leave submitting=true on success (page navigates away / cold popup blocks) so a
      // second click can't duplicate the dispatch.
    } catch (err) {
      setBanner({ type: "error", text: err instanceof Error ? err.message : "Failed to submit transfer." });
      setSubmitting(false);
    }
  };

  // Render the shell regardless of `allowed`: useRequireAuth returns true on the server
  // but false on the client's first render, so gating the render on it makes the SSR HTML
  // differ from the first client render → hydration mismatch. Effects stay gated on
  // `allowed` and the hook redirects unauthenticated users.

  return (
    <TransferChrome title={isEditMode ? "Edit Transfer OUT" : "Transfer OUT"}>
      <button onClick={() => router.push("/modules/transfer")}
        className="text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] mb-3">← Transfer</button>

      <div className="flex flex-wrap items-end justify-between gap-2 mb-4">
        <h1 className="text-[20px] font-semibold text-[var(--text-primary)]">{isEditMode ? "Edit Transfer OUT" : "Direct Transfer OUT"}</h1>
        <span className="text-[12px] text-[var(--text-secondary)]">Transfer No <span className="font-mono text-[var(--text-primary)]">{transferNo}</span></span>
      </div>

      {editLoading && <div className="mb-4 rounded-md p-3 text-[13px] bg-[var(--background)] border border-[var(--aws-border)] text-[var(--text-secondary)]">Loading transfer…</div>}
      {banner && (
        <div className={`mb-4 rounded-md p-3 text-[13px] border ${banner.type === "error" ? "bg-rose-50 border-rose-200 text-rose-700" : "bg-emerald-50 border-emerald-200 text-emerald-700"}`}>{banner.text}</div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4 max-w-4xl">
        <Card title="Transfer details">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Request No"><input value={form.requestNo} readOnly placeholder="(direct transfer)"
              className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-[var(--background)] font-mono" /></Field>
            <Field label="Transfer Date" required><input value={form.requestDate} onChange={(e) => setForm({ ...form, requestDate: e.target.value })}
              placeholder="DD-MM-YYYY" className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" /></Field>
            <Field label="From (Requesting)" required>
              <select value={form.fromWarehouse} onChange={(e) => changeFromWarehouse(e.target.value)}
                className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-white">
                <option value="">Select…</option>{FROM_WAREHOUSES.map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            </Field>
            <Field label="To (Supplying)" required>
              <select value={form.toWarehouse} onChange={(e) => setForm({ ...form, toWarehouse: e.target.value })}
                className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-white">
                <option value="">Select…</option>{TO_WAREHOUSES.filter((w) => w !== form.fromWarehouse).map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            </Field>
            <Field label="Reason" required>
              <select value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}
                className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-white">
                <option value="">Select…</option>{REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </Field>
            <div />
            <div className="sm:col-span-2">
              <Field label="Reason Description" required>
                <textarea value={form.reasonDescription} onChange={(e) => setForm({ ...form, reasonDescription: e.target.value })}
                  rows={2} className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md resize-y" />
              </Field>
            </div>
          </div>
        </Card>

        <Card title="Scan / add boxes">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <span className="block text-[11px] uppercase tracking-wide text-[var(--text-secondary)] mb-1">Camera</span>
              <button type="button" onClick={() => setShowScanner(true)} title="Start camera scan" aria-label="Start camera scan"
                className="grid h-9 w-9 place-items-center rounded-md border border-[var(--aws-navy)] text-[18px] leading-none text-[var(--aws-navy)] hover:bg-[var(--aws-navy)] hover:text-white">📷</button>
            </div>
            <span className="text-[12px] text-[var(--text-secondary)]">or enter manually:</span>
            <div className="flex items-end gap-2">
              <Field label="Box Number"><input value={manualBox.boxNumber} type="number" onWheel={(e) => e.currentTarget.blur()}
                onChange={(e) => setManualBox({ ...manualBox, boxNumber: e.target.value })}
                className="w-28 px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" /></Field>
              <Field label="Transaction No"><input value={manualBox.transactionNo}
                onChange={(e) => setManualBox({ ...manualBox, transactionNo: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleManualBoxFetch(); } }}
                className="w-44 px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" /></Field>
              <button type="button" onClick={handleManualBoxFetch}
                className="px-3 py-1.5 text-[13px] rounded-md bg-[var(--aws-navy)] text-white hover:opacity-90">Fetch Box</button>
            </div>
          </div>
        </Card>

        <Card title="Transfer information">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Vehicle Number" required>
              <select value={transport.vehicle} onChange={(e) => setTransport({ ...transport, vehicle: e.target.value })}
                className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-white">
                <option value="">Select…</option>{VEHICLES.map((v) => <option key={v} value={v}>{v}</option>)}<option value="Other">Other</option>
              </select>
              {transport.vehicle === "Other" && <input value={transport.vehicleOther} onChange={(e) => setTransport({ ...transport, vehicleOther: e.target.value })}
                placeholder="Enter vehicle no" className="mt-1.5 w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" />}
            </Field>
            <Field label="Driver Name" required>
              <select value={transport.driver} onChange={(e) => setTransport({ ...transport, driver: e.target.value })}
                className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-white">
                <option value="">Select…</option>{DRIVERS.map((d) => <option key={d} value={d}>{d}</option>)}<option value="Other">Other</option>
              </select>
              {transport.driver === "Other" && <input value={transport.driverOther} onChange={(e) => setTransport({ ...transport, driverOther: e.target.value })}
                placeholder="Enter driver name" className="mt-1.5 w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" />}
            </Field>
            <Field label="Approval Authority" required>
              <input value={transport.approval} onChange={(e) => setTransport({ ...transport, approval: e.target.value })}
                className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" />
            </Field>
          </div>
        </Card>

        <div className="flex items-center justify-between">
          <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">Articles ({articles.length})</h2>
          <button type="button" onClick={addArticle}
            className="px-2.5 py-1 text-[12px] border border-[var(--aws-navy)] text-[var(--aws-navy)] rounded-md hover:bg-[var(--aws-navy)] hover:text-white">+ Add Article</button>
        </div>
        {articles.map((a, idx) => (
          <DirectArticleSection key={a.uid} index={idx} data={a} open={expanded.has(a.uid)} materialTypes={materialTypes}
            canRemove={articles.length > 1} isColdFrom={isColdFrom}
            onToggle={() => toggle(a.uid)} onRemove={() => removeArticle(a.uid)} onPatch={(p) => patchArt(a.uid, p)}
            onSetMode={(m) => setMode(a.uid, m)} onSelectCold={(r) => handleSelectCold(a.uid, r)} onAddToList={() => addArticleToList(a)} />
        ))}

        <Card title={`Scanned boxes (${totals.count})`} action={scannedBoxes.length ? <button type="button" onClick={clearAllBoxes} className="text-[12px] text-rose-600 hover:underline">Clear All</button> : undefined}>
          {scannedBoxes.length === 0 ? (
            <p className="text-[12px] text-[var(--text-secondary)] py-2">No boxes yet — scan, fetch, cold-pick, or use “Add to list”.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead><tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]">
                  <th className="py-1.5 pr-2">#</th><th className="py-1.5 pr-2">Box ID</th><th className="py-1.5 pr-2">Txn</th>
                  <th className="py-1.5 pr-2">Article</th><th className="py-1.5 pr-2">Lot</th>
                  <th className="py-1.5 pr-2 text-right">Net</th><th className="py-1.5 pr-2 text-right">Gross</th><th /></tr></thead>
                <tbody>{scannedBoxes.map((b) => (
                  <tr key={b.id} className="border-b border-[var(--aws-border)]/40 hover:bg-[var(--background)]">
                    <td className="py-1 pr-2">{b.boxNumber}</td>
                    <td className="py-1 pr-2 font-mono">{b.boxId || (b.transactionNo === "DIRECT" ? "—" : "")}</td>
                    <td className="py-1 pr-2 font-mono">{b.transactionNo}</td>
                    <td className="py-1 pr-2 max-w-[180px] truncate" title={b.article}>{b.article}</td>
                    <td className="py-1 pr-2">{b.lotNumber || "—"}</td>
                    <td className="py-1 pr-2 text-right"><input value={b.netWeight} type="number" step="any" onWheel={(e) => e.currentTarget.blur()}
                      onChange={(e) => updateScannedBox(b.id, { netWeight: e.target.value })}
                      className="w-20 px-1.5 py-1 text-[12px] text-right border border-[var(--aws-border)] rounded" /></td>
                    <td className="py-1 pr-2 text-right"><input value={b.grossWeight} type="number" step="any" onWheel={(e) => e.currentTarget.blur()}
                      onChange={(e) => updateScannedBox(b.id, { grossWeight: e.target.value })}
                      className="w-20 px-1.5 py-1 text-[12px] text-right border border-[var(--aws-border)] rounded" /></td>
                    <td className="py-1 text-right"><button type="button" onClick={() => removeBox(b.id)} className="text-rose-600 hover:underline">✕</button></td>
                  </tr>))}</tbody>
                <tfoot><tr className="font-medium text-[var(--text-primary)]">
                  <td className="py-1.5" colSpan={5}>Totals</td>
                  <td className="py-1.5 pr-2 text-right">{totals.net.toFixed(3)}</td>
                  <td className="py-1.5 pr-2 text-right">{totals.gross.toFixed(3)}</td><td /></tr></tfoot>
              </table>
            </div>
          )}
        </Card>

        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-[12px] text-[var(--text-secondary)]">Saved as <span className="font-medium text-sky-600">Dispatch</span> (or Partial if scanned boxes &lt; ordered qty).</span>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => router.back()} className="px-3 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md hover:border-[var(--aws-navy)]">Cancel</button>
              <button type="submit" disabled={submitting || scannedBoxes.length === 0} className="px-4 py-1.5 text-[13px] rounded-md bg-[var(--aws-navy)] text-white hover:opacity-90 disabled:opacity-50">
                {submitting ? "Submitting…" : isEditMode ? "Update Transfer" : "Submit Transfer"}
              </button>
            </div>
          </div>
        </Card>
      </form>

      {showScanner && <QRScanner onScan={handleQRScan} onClose={() => setShowScanner(false)} />}

      {coldPopup && (
        <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg w-full max-w-md p-4">
            <h3 className="text-[14px] font-semibold text-[var(--text-primary)] mb-2">Cold transfer summary</h3>
            <pre className="text-[12px] bg-[var(--background)] border border-[var(--aws-border)] rounded-md p-3 whitespace-pre-wrap max-h-72 overflow-y-auto">{coldPopup}</pre>
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={() => navigator.clipboard?.writeText(coldPopup)}
                className="px-3 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md hover:border-[var(--aws-navy)]">Copy</button>
              <button type="button" onClick={() => { setColdPopup(null); router.push("/modules/transfer"); }}
                className="px-4 py-1.5 text-[13px] rounded-md bg-[var(--aws-navy)] text-white hover:opacity-90">OK</button>
            </div>
          </div>
        </div>
      )}
    </TransferChrome>
  );
}

// ── Article section: regular grid OR cold-storage picker (per-article toggle) ──
function DirectArticleSection({ index, data, open, materialTypes, canRemove, isColdFrom, onToggle, onRemove, onPatch, onSetMode, onSelectCold, onAddToList }: {
  index: number; data: Article; open: boolean; materialTypes: string[]; canRemove: boolean; isColdFrom: boolean;
  onToggle: () => void; onRemove: () => void; onPatch: (p: Partial<Article>) => void;
  onSetMode: (m: "regular" | "cold-storage") => void; onSelectCold: (r: ColdStockRecord) => void; onAddToList: () => void;
}) {
  const isCold = data.entryMode === "cold-storage";
  const [opt, setOpt] = useState<{ categories: string[]; subs: string[]; descriptions: string[]; uoms: (number | null)[] }>(
    { categories: [], subs: [], descriptions: [], uoms: [] });

  useEffect(() => {
    if (isCold || !data.materialType) return; let off = false;
    TransferApi.categorialDropdown({ material_type: data.materialType })
      .then((d) => { if (!off) setOpt((o) => ({ ...o, categories: d.options.item_categories })); }).catch(() => {});
    return () => { off = true; };
  }, [isCold, data.materialType]);
  useEffect(() => {
    if (isCold || !data.materialType || !data.itemCategory) return; let off = false;
    TransferApi.categorialDropdown({ material_type: data.materialType, item_category: data.itemCategory })
      .then((d) => { if (!off) setOpt((o) => ({ ...o, subs: d.options.sub_categories })); }).catch(() => {});
    return () => { off = true; };
  }, [isCold, data.materialType, data.itemCategory]);
  useEffect(() => {
    if (isCold || !data.materialType || !data.itemCategory || !data.subCategory) return; let off = false;
    TransferApi.categorialDropdown({ material_type: data.materialType, item_category: data.itemCategory, sub_category: data.subCategory })
      .then((d) => { if (!off) setOpt((o) => ({ ...o, descriptions: d.options.item_descriptions, uoms: d.options.uom_values })); }).catch(() => {});
    return () => { off = true; };
  }, [isCold, data.materialType, data.itemCategory, data.subCategory]);

  const selectDescription = (desc: string) => {
    const i = opt.descriptions.indexOf(desc); const uom = i >= 0 ? opt.uoms[i] : null;
    onPatch(uom != null ? { itemDescription: desc, unitPackSize: String(uom) } : { itemDescription: desc });
  };
  const applySearchItem = (it: CategorialSearchItem) => onPatch({
    materialType: it.material_type || "", itemCategory: it.group || "", subCategory: it.sub_group || "",
    itemDescription: it.item_description || "", unitPackSize: it.uom != null ? String(it.uom) : data.unitPackSize,
  });
  const addQty = Math.max(1, Math.floor(parseFloat(data.quantity) || 0));

  return (
    <section className="bg-white border border-[var(--aws-border)] rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 cursor-pointer hover:bg-[var(--background)]" onClick={onToggle}>
        <span className="inline-block w-4 text-[var(--text-secondary)]">{open ? "▾" : "▸"}</span>
        <span className="text-[12px] font-semibold text-[var(--text-primary)] shrink-0">Article {index + 1}{isCold ? " · cold" : ""}</span>
        <span className="text-[12px] text-[var(--text-secondary)] truncate flex-1">
          {data.itemDescription ? <>· {data.itemDescription} · {data.quantity || "0"} {data.uom} · {data.netWeight} kg</> : <span className="italic">New article — not yet filled</span>}
        </span>
        {canRemove && <button type="button" onClick={(e) => { e.stopPropagation(); onRemove(); }} className="text-[12px] text-rose-600 hover:underline shrink-0">Remove</button>}
      </div>
      {open && (
        <div className="px-4 pb-4 pt-1 border-t border-[var(--aws-border)]">
          {isColdFrom && (
            <div className="mt-3">
              <button type="button" onClick={() => onSetMode(isCold ? "regular" : "cold-storage")}
                className="px-2.5 py-1 text-[12px] border border-[var(--aws-border)] rounded-md hover:border-[var(--aws-navy)]">
                {isCold ? "Switch to Manual Entry" : "Switch to Cold Storage"}
              </button>
            </div>
          )}

          {isCold ? (
            <div className="mt-3 space-y-3">
              <ColdStockSearch onSelect={onSelectCold} />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Item Description"><input value={data.itemDescription} readOnly className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-[var(--background)]" /></Field>
                <Field label="Lot Number" required><input value={data.lotNumber} readOnly className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-[var(--background)] font-mono" /></Field>
                <Field label={`No. of Boxes${data.csMaxBoxes ? ` (max ${data.csMaxBoxes})` : ""}`} required>
                  <input type="number" step="1" min="0" value={data.quantity} onWheel={(e) => e.currentTarget.blur()}
                    onChange={(e) => { const n = parseInt(e.target.value, 10) || 0; onPatch({ quantity: String(data.csMaxBoxes ? Math.min(n, data.csMaxBoxes) : n) }); }}
                    className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" /></Field>
                <Field label="UOM" required>
                  <select value={data.uom} onChange={(e) => onPatch({ uom: e.target.value })} className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-white">
                    <option value="">—</option>{UOM_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
                  </select></Field>
                <Field label="Weight per box (Kg)"><input value={data.netWeight} readOnly className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-[var(--background)]" /></Field>
              </div>
            </div>
          ) : (
            <>
              <div className="mt-3"><QuickSearch onPick={applySearchItem} /></div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                <Field label="Material Type" required><SearchableSelect value={data.materialType} options={materialTypes} onChange={(v) => onPatch({ materialType: v })} placeholder="Select…" /></Field>
                <Field label="Category" required><SearchableSelect value={data.itemCategory} options={opt.categories} disabled={!data.materialType} onChange={(v) => onPatch({ itemCategory: v })} placeholder={data.materialType ? "Select…" : "Pick material first"} /></Field>
                <Field label="Sub Category" required><SearchableSelect value={data.subCategory} options={opt.subs} disabled={!data.itemCategory} onChange={(v) => onPatch({ subCategory: v })} placeholder={data.itemCategory ? "Select…" : "Pick category first"} /></Field>
                <Field label="Item Description" required><SearchableSelect value={data.itemDescription} options={opt.descriptions} disabled={!data.subCategory} onChange={selectDescription} placeholder={data.subCategory ? "Select…" : "Pick sub category first"} /></Field>
                <Field label="Unit Pack Size / Count"><input type="number" step="any" min="0" value={data.unitPackSize} onWheel={(e) => e.currentTarget.blur()} onChange={(e) => onPatch({ unitPackSize: e.target.value })} className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" /></Field>
                <Field label="UOM"><select value={data.uom} onChange={(e) => onPatch({ uom: e.target.value })} className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-white"><option value="">—</option>{UOM_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}</select></Field>
                <Field label="Case Pack / Box Wt."><input type="number" step="any" min="0" value={data.packSize} onWheel={(e) => e.currentTarget.blur()} onChange={(e) => onPatch({ packSize: e.target.value })} className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" /></Field>
                <Field label="Quantity (Box/Bags)"><input type="number" step="any" min="0" value={data.quantity} onWheel={(e) => e.currentTarget.blur()} onChange={(e) => onPatch({ quantity: e.target.value })} className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" /></Field>
                <Field label="Net Weight (Kg)"><input type="number" step="any" min="0" value={data.netWeight} onWheel={(e) => e.currentTarget.blur()} onChange={(e) => onPatch({ netWeight: e.target.value })} className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" /></Field>
                <Field label="Lot Number (optional)"><input value={data.lotNumber} onChange={(e) => onPatch({ lotNumber: e.target.value })} className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" /></Field>
              </div>
            </>
          )}

          <div className="mt-3 flex justify-end">
            <button type="button" onClick={onAddToList} className="px-3 py-1.5 text-[12px] rounded-md border border-[var(--aws-navy)] text-[var(--aws-navy)] hover:bg-[var(--aws-navy)] hover:text-white">
              Add to list ({addQty} {addQty === 1 ? "box" : "boxes"})
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
