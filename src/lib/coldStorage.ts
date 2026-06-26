// Cold Storage API client (doc 08 cold picker). Targets /api/v1/cold-storage/* —
// lot/group stock search + FIFO per-box pick. Auth via apiFetch (shared bearer).

import { apiFetch, readApiErrorMessage } from "./auth";

const BASE = "/api/v1/cold-storage";

function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

async function getJson<T>(path: string, fallback: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) throw new Error(await readApiErrorMessage(res, fallback));
  return (await res.json()) as T;
}

export interface ColdStockRecord {
  id: number;
  inward_dt?: string | null;
  unit?: string | null;
  inward_no?: string | null;
  item_description?: string | null;
  item_mark?: string | null;
  vakkal?: string | null;
  lot_no?: string | null;
  net_qty_on_cartons?: number | null;
  weight_kg?: number | null;
  total_inventory_kgs?: number | null;
  group_name?: string | null;
  storage_location?: string | null;
  exporter?: string | null;
  last_purchase_rate?: number | null;
  value?: number | null;
  box_id?: string | null;
  transaction_no?: string | null;
  company?: string | null; // real source company (cfpl/cdpl) — drives pick + deduction
}

export interface ColdSearchResult {
  results: ColdStockRecord[];
  total: number;
}

export interface PickedBox {
  id: number;
  box_id?: string | null;
  transaction_no?: string | null;
  weight_kg: number;
  item_mark?: string | null;
  inward_dt?: string | null;
  unit?: string | null;
  inward_no?: string | null;
  item_description?: string | null;
  vakkal?: string | null;
  lot_no?: string | null;
  no_of_cartons?: number | null;
  total_inventory_kgs?: number | null;
  group_name?: string | null;
  storage_location?: string | null;
}

export const ColdStorageApi = {
  searchStocks: (p: { lot_no?: string; item_description?: string; group_name?: string; q?: string; limit?: number } = {}) =>
    getJson<ColdSearchResult>(`${BASE}/stocks/search${qs({ ...p, limit: p.limit ?? 50 })}`, "Cold-stock search failed."),

  pickBoxes: (p: { company: string; item_description: string; lot_no: string; inward_no: string; qty: number }) =>
    getJson<{ boxes: PickedBox[] }>(`${BASE}/stocks/pick-boxes${qs(p)}`, "Could not pick boxes."),
};
