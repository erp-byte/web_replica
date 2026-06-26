// Transfer Summary dashboard API client (doc 04). Targets the replica backend
// at /api/v1/transfer/dashboard/* (same-origin proxy — see next.config.ts).
// All records load once; KPIs/filters/aggregation happen client-side.
//
// Mirrors the production `transferDashboardApi`: a stale-while-revalidate
// localStorage cache for records + filter-options so the page paints instantly,
// then revalidates in the background. (No [company] segment in the replica's
// routing, so caches use a single fixed namespace instead of being per-company.)

import { apiFetch, readApiErrorMessage } from "./auth";

const BASE = "/api/v1/transfer/dashboard";

export interface IssueDetail {
  article: string;
  remarks: string;
  actual_qty: string;
  actual_total_weight: string;
}

export interface TransferRecord {
  transfer_id: number;
  challan_no: string;
  transfer_date: string;       // ISO YYYY-MM-DD (or "")
  transfer_month: string;      // YYYY-MM
  from_warehouse: string;
  to_warehouse: string;
  vehicle_no: string;
  driver_name: string;
  status: string;
  created_by: string;
  remark: string;
  item_description: string;
  item_category: string;
  sub_category: string;
  material_type: string;
  lot_number: string;
  qty: number;
  uom: string;
  pack_size: number;
  net_weight: number;
  total_weight: number;
  box_count: number;
  received_status: string;
  issue_count: number;
  issue_items: string;
  issue_weight: number;
  issue_details: IssueDetail[];
  has_issue: boolean;
}

export interface AllDataResponse {
  records: TransferRecord[];
  total: number;
  as_of_date: string;
}

async function getJson<T>(path: string, fallback: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) throw new Error(await readApiErrorMessage(res, fallback));
  return (await res.json()) as T;
}

function qs(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export const TransferDashboardApi = {
  // Date window (ISO YYYY-MM-DD) bounds stock_trf_date so the client can load a
  // small recent window by default and widen on demand. Both omitted = all-time.
  getAllData: (fromDate?: string, toDate?: string) =>
    getJson<AllDataResponse>(`${BASE}/all-data${qs({ from_date: fromDate, to_date: toDate })}`, "Failed to load transfer dashboard."),
};

// ── Stale-while-revalidate cache (localStorage, versioned, per-window) ───────
const CACHE_PREFIX = "transfer-dashboard:cache:v2:";

interface CacheShape {
  records: TransferRecord[];
  cachedAt: number;
}

export function readTransferCache(windowKey: string): CacheShape | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + windowKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheShape;
    if (!Array.isArray(parsed.records)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeTransferCache(windowKey: string, records: TransferRecord[], cachedAt: number): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(CACHE_PREFIX + windowKey, JSON.stringify({ records, cachedAt }));
  } catch {
    /* quota / serialization — non-fatal, just skip caching */
  }
}
