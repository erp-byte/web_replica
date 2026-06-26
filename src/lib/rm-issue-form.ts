// RM Issue / Collection Form (Document 015) client — NPD plan §10. The NPD
// author raises an indent (snapshots recipe RM lines); the Store approves and
// issues, recording issued_qty + lot_no per line, which fires the 265 Goods
// Issue (own-only) on the backend. All under /api/v1/sample/rm-issue-forms/*.

import { apiFetch, readApiErrorMessage } from "./auth";

export type RmFormStatus = "DRAFT" | "SUBMITTED" | "APPROVED" | "ISSUED" | "CLOSED" | "CANCELLED";

export interface RmLine {
  id?: number;
  sku_id?: number | null;
  sku_name: string;
  location?: string | null;
  lot_no?: string | null;
  reqd_qty: number | string;
  issued_qty?: number | string | null;
  uom: string;
  ownership?: "OWN" | "CUSTOMER";
  is_off_master?: boolean;
  notes?: string | null;
  line_order?: number;
}

export interface RmForm {
  id: number;
  form_number: string;
  trial_name?: string | null;
  product_name?: string | null;
  customer_name?: string | null;
  purpose_tag?: string | null;
  source_type?: string | null;
  source_id?: number | null;
  status: RmFormStatus;
  requested_by?: number | null;
  issued_by?: number | null;
  issue_mat_doc_id?: string | null;
  cancellation_reason?: string | null;
  created_at?: string | null;
  line_count?: number;
  lines?: RmLine[];
}

export interface RmFormCreate {
  trial_name?: string;
  product_name?: string;
  customer_name?: string;
  purpose_tag?: string;
  source_type?: string;
  source_id?: number;
  requisition_id?: number;
  notes?: string;
  submit?: boolean;
  lines: RmLine[];
}

export interface RmIssueResult { line_id: number; issued_qty: number; lot_no?: string | null }

async function jsonOrThrow<T>(resP: Response | Promise<Response>, fallback: string): Promise<T> {
  const res = await resP;
  if (!res.ok) throw new Error(await readApiErrorMessage(res, fallback));
  return (await res.json()) as T;
}
function post(path: string, body?: unknown): Promise<Response> {
  return apiFetch(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
}

const BASE = "/api/v1/sample/rm-issue-forms";

export async function listRmForms(status?: string): Promise<RmForm[]> {
  const q = new URLSearchParams();
  if (status) q.set("status", status);
  q.set("limit", "200");
  return jsonOrThrow(await apiFetch(`${BASE}?${q}`), "Failed to load RM issue forms");
}
export async function getRmForm(id: number): Promise<RmForm> {
  return jsonOrThrow(await apiFetch(`${BASE}/${id}`), "Failed to load form");
}
export async function raiseRmForm(body: RmFormCreate): Promise<RmForm> {
  return jsonOrThrow(await post(BASE, body), "Failed to raise indent");
}
export const submitRmForm = (id: number) => jsonOrThrow<RmForm>(post(`${BASE}/${id}/submit`), "Submit failed");
export const approveRmForm = (id: number) => jsonOrThrow<RmForm>(post(`${BASE}/${id}/approve`), "Approve failed");
export const issueRmForm = (id: number, issued: RmIssueResult[]) =>
  jsonOrThrow<RmForm>(post(`${BASE}/${id}/issue`, { issued }), "Issue failed");
export const cancelRmForm = (id: number, reason: string) =>
  jsonOrThrow<RmForm>(post(`${BASE}/${id}/cancel`, { reason }), "Cancel failed");

/** Fetches the rendered Document 015 PDF as a Blob. */
export async function printRmFormBlob(id: number): Promise<Blob> {
  const res = await apiFetch(`${BASE}/${id}/pdf`);
  if (!res.ok) throw new Error(await readApiErrorMessage(res, "Print failed"));
  return res.blob();
}
