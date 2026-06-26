// Transfer Summary aggregation (doc 04, simplified UI). Pure functions:
// normalization, dimension accessors, a single-level group→transfers rollup,
// and KPI totals. Box counts are per-transfer (deduped), not summed per line.

import type { TransferRecord } from "./transferDashboard";

// ── Normalization (ports shared/canonicalize.py) ─────────────────────────────
const WAREHOUSE_ALIASES: Record<string, string> = {
  "savla d-39": "Savla D-39", "savla d39": "Savla D-39", "d-39": "Savla D-39", "d39": "Savla D-39",
  "savla bond": "Savla D-39", "old savla": "Savla D-39", "savla d-39 cold": "Savla D-39", "savla d39 cold": "Savla D-39",
  "savla d-514": "Savla D-514", "savla d514": "Savla D-514", "d-514": "Savla D-514", "d514": "Savla D-514",
  "new savla": "Savla D-514", "savla d-514 cold": "Savla D-514",
  "rishi": "Rishi", "rishi cold": "Rishi", "rishi cold storage": "Rishi",
  "supreme": "Supreme", "supreme cold": "Supreme", "supreme cold storage": "Supreme",
  "w202": "W202", "warehouse w202": "W202", "a101": "A101", "warehouse a101": "A101",
  "a185": "A185", "warehouse a185": "A185", "a68": "A68", "warehouse a68": "A68",
  "f53": "F53", "warehouse f53": "F53", "dev int": "Dev Int", "dev_int": "Dev Int",
};

export function normalizeWarehouseName(raw?: string | null): string {
  const s = (raw || "").trim();
  if (!s) return "";
  const key = s.toLowerCase().replace(/_/g, " ");
  return WAREHOUSE_ALIASES[key] ?? s;
}

export const getDisplayWarehouseName = normalizeWarehouseName;

// Title-case a free-text label so "DATES" / "dates" / "Dates" collapse to one
// bucket. Short all-caps tokens stay upper (acronyms).
export function canonicalizeCategory(raw?: string | null): string {
  const s = (raw || "").trim();
  if (!s) return "";
  return s.split(/\s+/).map((w) =>
    (w.length <= 3 && /^[A-Za-z]+$/.test(w) && w === w.toUpperCase())
      ? w.toUpperCase()
      : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
  ).join(" ");
}

// ── Dimensions ───────────────────────────────────────────────────────────────
export type GroupDim =
  | "route" | "from_warehouse" | "to_warehouse" | "status" | "item_category"
  | "material_type" | "transfer_month" | "received_status";

export const DIM_LABELS: Record<GroupDim, string> = {
  route: "From → To",
  from_warehouse: "From",
  to_warehouse: "To",
  status: "Status",
  item_category: "Category",
  material_type: "Material",
  transfer_month: "Month",
  received_status: "Received",
};

const DIM_FN: Record<GroupDim, (r: TransferRecord) => string> = {
  route: (r) => `${normalizeWarehouseName(r.from_warehouse) || "Unknown"} → ${normalizeWarehouseName(r.to_warehouse) || "Unknown"}`,
  from_warehouse: (r) => normalizeWarehouseName(r.from_warehouse) || "Unknown",
  to_warehouse: (r) => normalizeWarehouseName(r.to_warehouse) || "Unknown",
  status: (r) => r.status || "Unknown",
  item_category: (r) => canonicalizeCategory(r.item_category) || "Uncategorized",
  material_type: (r) => r.material_type || "General",
  transfer_month: (r) => r.transfer_month || "N/A",
  received_status: (r) => r.received_status || "Not Received",
};

export type SortBy = "weight" | "count" | "name";

const PENDING = new Set(["dispatch", "pending"]);

// ── Rollups ──────────────────────────────────────────────────────────────────
export interface TransferLeaf {
  transfer_id: number;
  challan_no: string;
  status: string;
  received_status: string;
  transfer_date: string;
  from_warehouse: string;
  to_warehouse: string;
  has_issue: boolean;
  issue_count: number;
  line_count: number;
  net_weight: number;
  total_weight: number;
  box_count: number;
}

export interface SummaryGroup {
  key: string;
  label: string;
  tx_count: number;
  net_weight: number;
  total_weight: number;
  box_count: number;
  pending_count: number;
  transfers: TransferLeaf[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function rollupTransfer(recs: TransferRecord[]): TransferLeaf {
  const first = recs[0];
  let net = 0, gross = 0;
  for (const r of recs) { net += r.net_weight || 0; gross += r.total_weight || 0; }
  return {
    transfer_id: first.transfer_id,
    challan_no: first.challan_no,
    status: first.status,
    received_status: first.received_status,
    transfer_date: first.transfer_date,
    from_warehouse: first.from_warehouse,
    to_warehouse: first.to_warehouse,
    has_issue: first.has_issue,
    issue_count: first.issue_count || 0,
    line_count: recs.length,
    net_weight: round2(net),
    total_weight: round2(gross),
    box_count: first.box_count || 0,   // per-transfer value (NOT summed per line)
  };
}

export function buildGroups(records: TransferRecord[], dim: GroupDim, sortBy: SortBy): SummaryGroup[] {
  const fn = DIM_FN[dim];
  const buckets = new Map<string, TransferRecord[]>();
  for (const r of records) {
    const k = fn(r);
    const arr = buckets.get(k);
    if (arr) arr.push(r); else buckets.set(k, [r]);
  }

  const groups: SummaryGroup[] = [];
  for (const [label, recs] of buckets) {
    // group records by transfer for the leaf rows + correct box/pending counts
    const byTx = new Map<number, TransferRecord[]>();
    for (const r of recs) {
      const a = byTx.get(r.transfer_id);
      if (a) a.push(r); else byTx.set(r.transfer_id, [r]);
    }
    const transfers = [...byTx.values()].map(rollupTransfer);
    sortTransfers(transfers, sortBy);
    let net = 0, gross = 0, boxes = 0, pending = 0;
    for (const t of transfers) {
      net += t.net_weight; gross += t.total_weight; boxes += t.box_count;
      if (PENDING.has((t.status || "").toLowerCase())) pending += 1;
    }
    groups.push({
      key: label, label, tx_count: transfers.length,
      net_weight: round2(net), total_weight: round2(gross), box_count: boxes,
      pending_count: pending, transfers,
    });
  }
  return sortGroups(groups, sortBy);
}

function sortGroups(groups: SummaryGroup[], sortBy: SortBy): SummaryGroup[] {
  groups.sort((a, b) => {
    if (sortBy === "count") return b.tx_count - a.tx_count || b.net_weight - a.net_weight;
    if (sortBy === "name") return a.label.localeCompare(b.label);
    return (b.net_weight || b.total_weight) - (a.net_weight || a.total_weight);
  });
  return groups;
}

function sortTransfers(transfers: TransferLeaf[], sortBy: SortBy): void {
  transfers.sort((a, b) => {
    if (sortBy === "count") return b.line_count - a.line_count;
    if (sortBy === "name") return (a.challan_no || "").localeCompare(b.challan_no || "");
    return (b.net_weight || b.total_weight) - (a.net_weight || a.total_weight);
  });
}

// ── KPIs ─────────────────────────────────────────────────────────────────────
export interface Kpis {
  total_transfers: number;
  total_net_weight: number;
  total_gross_weight: number;
  total_weight: number;
  total_boxes: number;
  pending_count: number;
  not_received: number;
  issue_transfers: number;
  issue_items: number;
}

export function computeKpis(records: TransferRecord[]): Kpis {
  const txBox = new Map<number, number>();   // dedup box_count per transfer
  const pending = new Set<number>();
  const notReceived = new Set<number>();
  const issueTransfers = new Set<number>();
  const txIssueCount = new Map<number, number>();
  let net = 0, gross = 0;
  for (const r of records) {
    net += r.net_weight || 0;
    gross += r.total_weight || 0;
    if (!txBox.has(r.transfer_id)) txBox.set(r.transfer_id, r.box_count || 0);
    const st = (r.status || "").toLowerCase();
    if (st === "dispatch" || st === "pending") pending.add(r.transfer_id);
    if (r.received_status !== "Received") notReceived.add(r.transfer_id);
    if (r.has_issue) { issueTransfers.add(r.transfer_id); txIssueCount.set(r.transfer_id, r.issue_count || 0); }
  }
  let boxes = 0; for (const b of txBox.values()) boxes += b;
  let issueItems = 0; for (const n of txIssueCount.values()) issueItems += n;
  const totalNet = round2(net);
  const totalGross = round2(gross);
  return {
    total_transfers: txBox.size,
    total_net_weight: totalNet,
    total_gross_weight: totalGross,
    total_weight: totalNet || totalGross,
    total_boxes: boxes,
    pending_count: pending.size,
    not_received: notReceived.size,
    issue_transfers: issueTransfers.size,
    issue_items: issueItems,
  };
}
