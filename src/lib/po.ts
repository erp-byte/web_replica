// PO (Purchase Order) client. Mirrors the Electron renderer's
// frontend_replica/src/shared/js/po-view.js + po-creation.js. All endpoints
// under /api/v1/po except manual create (/api/v1/purchase/create, pending).

import { apiFetch } from "./auth";

// ── Listing / detail types (schemas/po_api.py: PoListItem, PoLineOut) ──
export interface PoListItem {
  transaction_no: string;
  entity: string;
  po_number?: string | null;
  po_date?: string | null;
  voucher_type?: string | null;
  order_reference_no?: string | null;
  narration?: string | null;
  vendor_supplier_name?: string | null;
  supplier_id?: string | null;
  gross_total?: number | null;
  total_amount?: number | null;
  sgst_amount?: number | null;
  cgst_amount?: number | null;
  igst_amount?: number | null;
  round_off?: number | null;
  freight_transport_local?: number | null;
  apmc_tax?: number | null;
  packing_charges?: number | null;
  freight_transport_charges?: number | null;
  loading_unloading_charges?: number | null;
  other_charges_non_gst?: number | null;
  deleted_at?: string | null;
}

export interface PoLineOut {
  transaction_no: string;
  line_number: number;
  sku_name?: string | null;
  uom?: string | null;
  pack_count?: number | null;
  po_weight?: number | null;
  rate?: number | null;
  amount?: number | null;
  particulars?: string | null;
  item_category?: string | null;
  sub_category?: string | null;
  item_type?: string | null;
  sales_group?: string | null;
  gst_rate?: number | null;
  match_score?: number | null;
  match_source?: string | null;
  matched_item?: { sku_code?: string | null } & Record<string, unknown>;
}

export interface PoListResponse {
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
  has_next: boolean;
  has_prev: boolean;
  items: PoListItem[];
}
export interface PoLinesResponse {
  header: PoListItem;
  total_lines: number;
  lines: PoLineOut[];
}
export interface PoDeleteResponse {
  transaction_no: string;
  entity: string;
  po_number?: string | null;
  deleted_at: string;
  deleted_by: string;
  delete_reason: string;
  dependent_records: { dock_arrivals: number; grns: number; po_boxes: number };
}

// ── Preview / commit types (schemas/po_api.py) ──
export interface PreviewHeader {
  po_number?: string | null;
  po_date?: string | null;
  voucher_type?: string | null;
  order_reference_no?: string | null;
  narration?: string | null;
  vendor_supplier_name?: string | null;
  supplier_id?: string | null;
  gross_total?: number | null;
  total_amount?: number | null;
  sgst_amount?: number | null;
  cgst_amount?: number | null;
  igst_amount?: number | null;
  round_off?: number | null;
  [k: string]: unknown; // extra='allow' round-trip
}
export interface PreviewLine {
  line_number: number;
  sku_name?: string | null;
  uom?: string | null;
  pack_count?: number | null;
  po_weight?: number | null;
  rate?: number | null;
  amount?: number | null;
  gst_rate?: number | null;
  match_score?: number | null;
  match_source?: string | null;
  matched_item?: ({ sku_code?: string | null } & Record<string, unknown>) | null;
  [k: string]: unknown;
}
export interface PreviewPo {
  is_duplicate: boolean;
  duplicate_key: string;
  transaction_no: string;
  header: PreviewHeader;
  incoming: Record<string, unknown>;
  existing?: PreviewHeader | null;
  diff?: Record<string, unknown> | null;
  lines: PreviewLine[];
  warnings: string[];
  [k: string]: unknown;
}
export interface PreviewSummary {
  total_pos: number;
  new: number;
  duplicates: number;
  matched_lines: number;
  unmatched_lines: number;
}
export interface PreviewResponse { summary: PreviewSummary; pos: PreviewPo[] }

export type CommitMode = "create_only" | "update_only" | "upsert";
export interface CommitPo {
  duplicate_key?: string | null;
  transaction_no?: string | null;
  header: Record<string, unknown>;
  lines: Record<string, unknown>[];
  incoming?: Record<string, unknown> | null;
}
export interface CommitResponse {
  created: string[];
  updated: string[];
  skipped_duplicates: string[];
  skipped_missing: string[];
  errors: { po_number?: string | null; transaction_no?: string | null; duplicate_key?: string | null; reason: string }[];
}

// ── Listing query ──
export interface PoListQuery {
  page?: number;
  page_size?: number;
  sort?: string; // "<col>:<dir>"
  entity?: string;
  po_number_contains?: string;
  vendor_supplier_name_contains?: string;
  order_reference_no_contains?: string;
  narration_contains?: string;
  supplier_id?: string;
  voucher_type?: string;
  po_date_from?: string;
  po_date_to?: string;
}

function toQuery(q: PoListQuery): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === "" || v == null) continue;
    p.set(k, String(v));
  }
  return p.toString();
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    const d = body?.detail;
    if (typeof d === "string") return d;
    if (d && typeof d === "object" && typeof d.message === "string") return d.message;
  } catch { /* ignore */ }
  return `${fallback} (HTTP ${res.status})`;
}

// ── Endpoints ──
export async function previewPo(file: File, entity: string): Promise<PreviewResponse> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await apiFetch(`/api/v1/po/preview?entity=${encodeURIComponent(entity)}`, { method: "POST", body: fd });
  if (!res.ok) throw new Error(await readError(res, "Preview failed"));
  return res.json();
}

export async function commitPo(body: { entity: string; mode: CommitMode; pos: CommitPo[] }): Promise<CommitResponse> {
  const res = await apiFetch(`/api/v1/po/commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readError(res, "Commit failed"));
  return res.json();
}

export async function listPos(q: PoListQuery, signal?: AbortSignal): Promise<PoListResponse> {
  const res = await apiFetch(`/api/v1/po?${toQuery(q)}`, { signal });
  if (!res.ok) throw new Error(await readError(res, "Failed to load POs"));
  return res.json();
}

export async function getPoLines(transactionNo: string): Promise<PoLinesResponse> {
  const res = await apiFetch(`/api/v1/po/${encodeURIComponent(transactionNo)}/lines`);
  if (!res.ok) throw new Error(await readError(res, "Failed to load articles"));
  return res.json();
}

export async function deletePo(transactionNo: string, reason: string): Promise<PoDeleteResponse> {
  const res = await apiFetch(`/api/v1/po/${encodeURIComponent(transactionNo)}?reason=${encodeURIComponent(reason)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await readError(res, "Delete failed"));
  return res.json();
}

// ── QC Intimation ──────────────────────────────────────────────────────────────
export interface QcIntimationBody { line_numbers: number[]; vehicle_number: string; invoice_no: string; }
export interface QcIntimationRecipient { role: string; phone: string; status: string; error?: string | null; }
export interface QcIntimationResult {
  template: string;
  recipients: QcIntimationRecipient[];
  skipped: { role: string; reason: string }[];
  errors: string[];
}
export async function sendQcIntimation(transactionNo: string, body: QcIntimationBody): Promise<QcIntimationResult> {
  const res = await apiFetch(`/api/v1/po/${encodeURIComponent(transactionNo)}/intimation`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (res.status === 404) throw new Error("QC intimation isn't available on this backend yet.");
  if (!res.ok) throw new Error(await readError(res, "Failed to send intimation"));
  return res.json();
}

// Manual create — backend route pending. Mirrors manual-entry.js payload.
// TODO: type the payload + return once POST /api/v1/purchase/create is implemented on the backend.
export async function createPo(payload: Record<string, unknown>): Promise<unknown> {
  const res = await apiFetch(`/api/v1/purchase/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.status === 404 || res.status === 405) {
    throw new Error("Manual PO creation isn't available yet — the backend create endpoint is not implemented.");
  }
  if (!res.ok) throw new Error(await readError(res, "Failed to create PO"));
  return res.json();
}

// ── SKU lookup — reuse so.ts's typed client (accepts AbortSignal for debounced autocomplete) ──
// SKU lookup is shared with the SO module — reuse so.ts's typed client
// (it already accepts an AbortSignal for debounced autocomplete).
export { lookupSku as skuLookup, type SkuLookupParams, type SkuLookupResponse } from "./so";

// ── Shared formatters (mirror po-view.js) ──
export function fmtDate(d?: string | null): string {
  if (!d) return "—";
  const p = String(d).split("-");
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0].slice(2)}` : String(d);
}
export function fmtCur(n?: number | string | null): string {
  if (n == null || n === "") return "—";
  const v = typeof n === "number" ? n : parseFloat(n);
  if (Number.isNaN(v)) return "—";
  return "₹" + v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function fmtNum(n?: number | string | null): string {
  if (n == null || n === "") return "—";
  const v = typeof n === "number" ? n : parseFloat(n);
  if (Number.isNaN(v)) return "—";
  return v.toLocaleString("en-IN", { maximumFractionDigits: 3 });
}

// ── CSV export (mirror po-view.js EXPORT_COLUMNS, 21 cols; CSV not xlsx) ──
export const PO_EXPORT_COLUMNS: { key: keyof PoListItem; label: string }[] = [
  { key: "transaction_no", label: "Transaction No" },
  { key: "po_number", label: "PO Number" },
  { key: "po_date", label: "PO Date" },
  { key: "voucher_type", label: "Voucher Type" },
  { key: "order_reference_no", label: "Order Ref" },
  { key: "narration", label: "Narration" },
  { key: "vendor_supplier_name", label: "Vendor" },
  { key: "supplier_id", label: "Supplier ID" },
  { key: "entity", label: "Entity" },
  { key: "gross_total", label: "Gross Total" },
  { key: "total_amount", label: "Total Amount" },
  { key: "sgst_amount", label: "SGST" },
  { key: "cgst_amount", label: "CGST" },
  { key: "igst_amount", label: "IGST" },
  { key: "round_off", label: "Round Off" },
  { key: "freight_transport_local", label: "Freight (Local)" },
  { key: "freight_transport_charges", label: "Freight Charges" },
  { key: "apmc_tax", label: "APMC Tax" },
  { key: "packing_charges", label: "Packing" },
  { key: "loading_unloading_charges", label: "Loading/Unloading" },
  { key: "other_charges_non_gst", label: "Other Non-GST" },
];

function csvCell(v: unknown): string {
  if (v == null) return "";
  let s = String(v);
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}
export function buildPoCsv(items: PoListItem[], cols: { key: keyof PoListItem; label: string }[]): string {
  const rows = [cols.map((c) => csvCell(c.label)).join(",")];
  for (const it of items) rows.push(cols.map((c) => csvCell(it[c.key])).join(","));
  return "﻿" + rows.join("\r\n");
}
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// Page through /api/v1/po collecting all matching items for export (cap 5000).
export async function fetchAllPosForExport(q: PoListQuery): Promise<PoListItem[]> {
  const all: PoListItem[] = [];
  let page = 1;
  const HARD = 5000;
  while (all.length < HARD) {
    const data = await listPos({ ...q, page, page_size: 200 });
    all.push(...data.items);
    if (!data.has_next || data.items.length === 0) break;
    page++;
  }
  return all;
}
