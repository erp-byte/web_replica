// Builds ChallanHoverCard data from a transfer/transfer-in detail. Mirrors the
// production groupBoxesByItem / groupLinesByItem aggregation (group by item+lot,
// sum qty/weight, resolve cold source unit with a fallback to the header unit).

import type { HoverData, HoverLine } from "./_ChallanHoverCard";
import type { TransferDetail, TransferInDetail } from "@/lib/transfer";

function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

function groupBoxesByItem(boxes: TransferDetail["boxes"], fallbackUnit?: string | null): HoverLine[] {
  const map = new Map<string, HoverLine & { _w: number }>();
  for (const b of boxes) {
    const lot = b.lot_number || "";
    const key = `${b.article}||${lot}`;
    const sourceUnit = b.lot_origin_unit || b.source_unit || b.source_storage || fallbackUnit || null;
    const cur = map.get(key);
    if (cur) {
      cur.qty = (cur.qty as number) + 1;
      cur._w += num(b.net_weight);
      cur.weightKg = +cur._w.toFixed(2);
    } else {
      map.set(key, { name: b.article, qty: 1, _w: num(b.net_weight), weightKg: +num(b.net_weight).toFixed(2), lot: lot || null, sourceUnit });
    }
  }
  return [...map.values()].map(({ _w, ...rest }) => { void _w; return rest; });
}

function groupLinesByItem(lines: TransferDetail["lines"], fallbackUnit?: string | null): HoverLine[] {
  const map = new Map<string, HoverLine & { _w: number; _q: number }>();
  for (const l of lines) {
    const lot = l.lot_number || "";
    const key = `${l.item_description}||${lot}`;
    const cur = map.get(key);
    if (cur) {
      cur._q += num(l.quantity); cur._w += num(l.net_weight);
      cur.qty = cur._q; cur.weightKg = +cur._w.toFixed(2);
    } else {
      map.set(key, {
        name: l.item_description, _q: num(l.quantity), _w: num(l.net_weight),
        qty: num(l.quantity), weightKg: +num(l.net_weight).toFixed(2),
        lot: lot || null, sourceUnit: fallbackUnit || null,
      });
    }
  }
  return [...map.values()].map(({ _w, _q, ...rest }) => { void _w; void _q; return rest; });
}

export function transferHoverData(d: TransferDetail): HoverData {
  const fallback = d.from_cold_unit;
  const lines = d.boxes.length ? groupBoxesByItem(d.boxes, fallback) : groupLinesByItem(d.lines, fallback);
  const meta = [];
  if (d.vehicle_no) meta.push({ label: "Vehicle", value: d.vehicle_no });
  if (d.driver_name) meta.push({ label: "Driver", value: d.driver_name });
  if (d.has_variance) meta.push({ label: "Variance", value: "yes", tone: "warn" as const });
  return { lines, meta };
}

export function transferInHoverData(d: TransferInDetail): HoverData {
  const map = new Map<string, HoverLine & { _w: number }>();
  for (const b of d.boxes) {
    const lot = b.lot_number || "";
    const key = `${b.article || ""}||${lot}`;
    const cur = map.get(key);
    if (cur) {
      cur.qty = (cur.qty as number) + 1;
      cur._w += num(b.net_weight);
      cur.weightKg = +cur._w.toFixed(2);
    } else {
      map.set(key, { name: b.article || "(unmatched)", qty: 1, _w: num(b.net_weight), weightKg: +num(b.net_weight).toFixed(2), lot: lot || null });
    }
  }
  const lines = [...map.values()].map(({ _w, ...rest }) => { void _w; return rest; });
  const meta = [];
  if (d.received_by) meta.push({ label: "Received by", value: d.received_by });
  if (d.box_condition) meta.push({ label: "Condition", value: d.box_condition });
  meta.push({ label: "Status", value: d.status });
  return { lines, meta };
}
