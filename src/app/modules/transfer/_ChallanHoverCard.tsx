"use client";

// Hover card for transfer identifier cells (challan / GRN / request / inner-cold).
// Mirrors components/transfer/ChallanHoverCard.tsx: dotted-underline blue
// trigger, hover-only, portal to <body> (escapes table overflow), fetch-on-open
// (cached, no retry on failure), 180ms close, cancel-close on cursor-onto-card.

import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface HoverLine {
  name: string;
  qty?: number | string | null;
  weightKg?: number | string | null;
  count?: number | string | null;
  lot?: string | null;
  lotFrom?: string | null;
  lotTo?: string | null;
  sourceUnit?: string | null;
}
export interface MetaChip {
  label: string;
  value: string;
  tone?: "default" | "warn" | "success";
}
export interface HoverData {
  lines: HoverLine[];
  meta?: MetaChip[];
}

const TONE_CLASS: Record<string, string> = {
  default: "bg-slate-100 text-slate-700",
  warn: "bg-amber-100 text-amber-800",
  success: "bg-emerald-100 text-emerald-800",
};

export function ChallanHoverCard({
  label, from, to, reason, lines, meta, fetchLines,
}: {
  label: string;
  from?: string | null;
  to?: string | null;
  reason?: string | null;
  lines?: HoverLine[];
  meta?: MetaChip[];
  fetchLines?: () => Promise<HoverData>;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean }>({ left: 0, top: 0, above: false });
  const [data, setData] = useState<HoverData | null>(lines ? { lines, meta } : null);
  const [loading, setLoading] = useState(false);
  const fetchedRef = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);

  const doOpen = useCallback(() => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
    const el = triggerRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      const spaceBelow = window.innerHeight - r.bottom;
      const above = spaceBelow < 260 && r.top > spaceBelow;
      const left = Math.min(Math.max(8, r.left), window.innerWidth - 320);
      setPos({ left, top: above ? r.top - 6 : r.bottom + 6, above });
    }
    setOpen(true);
    if (fetchLines && !fetchedRef.current) {
      fetchedRef.current = true;
      setLoading(true);
      fetchLines()
        .then((d) => setData(d))
        .catch(() => setData({ lines: [] })) // cache empty → no retry
        .finally(() => setLoading(false));
    }
  }, [fetchLines]);

  const scheduleClose = useCallback(() => {
    closeTimer.current = setTimeout(() => setOpen(false), 180);
  }, []);
  const cancelClose = useCallback(() => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  }, []);

  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={doOpen}
        onMouseLeave={scheduleClose}
        className="text-sky-700 underline decoration-dotted underline-offset-2 cursor-default"
      >
        {label}
      </span>
      {open && typeof document !== "undefined" && createPortal(
        <div
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          style={{
            position: "fixed", left: pos.left,
            top: pos.above ? undefined : pos.top,
            bottom: pos.above ? window.innerHeight - pos.top : undefined,
            width: 304, maxHeight: 360,
          }}
          className="z-50 overflow-auto bg-white border border-[var(--aws-border)] rounded-md shadow-lg p-3 text-[12px]"
        >
          <div className="flex items-center gap-1 font-medium text-[var(--text-primary)] mb-1">
            <span>{from || "—"}</span><span className="text-[var(--text-secondary)]">→</span><span>{to || "—"}</span>
          </div>
          {reason && <div className="text-[11px] text-[var(--text-secondary)] mb-1">Reason: {reason}</div>}
          {data?.meta && data.meta.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2">
              {data.meta.map((m, i) => (
                <span key={i} className={`px-1.5 py-0.5 rounded text-[10px] ${TONE_CLASS[m.tone || "default"]}`}>
                  {m.label}: {m.value}
                </span>
              ))}
            </div>
          )}
          {loading ? (
            <div className="text-[var(--text-secondary)] py-2">Loading…</div>
          ) : data && data.lines.length > 0 ? (
            <ul className="space-y-1.5">
              {data.lines.map((ln, i) => (
                <li key={i} className="border-t border-[var(--aws-border)]/40 pt-1.5 first:border-t-0 first:pt-0">
                  <div className="font-medium text-[var(--text-primary)]">{ln.name}</div>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-[var(--text-secondary)]">
                    {ln.qty != null && <span>{ln.qty} boxes</span>}
                    {ln.weightKg != null && <span>Wt: {ln.weightKg} kg</span>}
                    {ln.count != null && <span className="text-rose-600">Count: {ln.count}</span>}
                    {ln.lot && <span className="text-indigo-600 font-mono">Lot: {ln.lot}</span>}
                    {(ln.lotFrom || ln.lotTo) && <span>{ln.lotFrom || "?"} → {ln.lotTo || "?"}</span>}
                    {ln.sourceUnit && <span className="text-violet-600">From: {ln.sourceUnit}</span>}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-[var(--text-secondary)] py-2">No line details.</div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
