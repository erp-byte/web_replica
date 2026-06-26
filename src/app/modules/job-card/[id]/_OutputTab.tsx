"use client";

// Output tab — sits beside "Output & Accounting" on the job card detail page.
// Modelled on the SFG Boxes tab. Three stacked sections:
//
//   1. Accounting summary  — compact, READ-ONLY roll-up from the JC detail
//      payload (detail.accounting + detail.section_5_output). Real data now.
//   2. Batchwise output    — produced Qty per batch in Kg / Units / Cartons,
//      with a totals row. Kg + Units are real; Cartons read an optional batch
//      field (see below). Real data now.
//   3. Cartons             — one row per FG carton with a per-carton "Trace"
//      expander (carton → batch → JC → RM lot) and sticker printing, exactly
//      like the SFG box rows. Backed by FG-carton endpoints that MIRROR the
//      SFG box ones (see the backend-contract note in the structure doc). The
//      panel degrades gracefully (404 / empty → quiet hint) until those land —
//      same defensive idiom as SfgGenealogyPanel / BoxTrace.
//
// Field mapping (production batches view / job_card_batch_v2):
//   Kg      ← produced_qty_kg (→ fg_actual_kg fallback)   — real
//   Units   ← fg_actual_units                              — real
//   Cartons ← produced_qty_cartons ?? cartons              — optional, "—" until backend emits it

import { useEffect, useMemo, useState } from "react";
import { apiFetch, readApiErrorMessage } from "@/lib/auth";
import { friendlyApiError } from "@/lib/apiErrors";

// Minimal shape of the JC detail fields this tab reads. Kept local so the tab
// has no import cycle with page.tsx (where the full JobCardDetail lives).
type OutputDetail = {
  job_card_id: number;
  section_5_output?: {
    fg_actual_kg?: number | string | null;
    fg_actual_units?: number | null;
    process_loss_kg?: number | string | null;
    rm_consumed_kg?: number | string | null;
    yield_pct?: number | string | null;
  } | null;
  accounting?: {
    process_loss_pct?: number | string | null;
    total_loss_pct?: number | string | null;
    balance_diff_kg?: number | string | null;
    balance_diff_pct?: number | string | null;
    is_balanced?: boolean | null;
    [k: string]: unknown;
  } | null;
};

type BatchOutputRow = {
  batch_id: number;
  batch_number: number;
  batch_date: string | null;
  status: string;
  produced_qty_kg: number | string | null;
  fg_actual_kg: number | string | null;
  fg_actual_units: number | string | null;
  produced_qty_cartons?: number | string | null;
  cartons?: number | string | null;
};

// One FG carton (sfg_box item_type='fg'). carton_id is the 8-digit QR payload.
type CartonRowT = {
  carton_id: number;
  batch_id?: number | null;
  batch_code?: string | null;
  net_weight_kg?: number | string | null;
  units?: number | string | null;
  fg_sku_name?: string | null;
  sfg_code?: string | null;
  status?: string | null;
};

// One node of a carton's upstream trace (carton → batch → JC → RM lot).
type TraceNode = {
  level: number;
  carton_id?: number | null;
  box_id?: number | null;
  sfg_code?: string | null;
  lot_number?: string | null;
  batch_id?: number | null;
  source_inventory_batch_id?: string | null;  // inventory_batch.batch_id is TEXT
  producer_job_card_id?: number | null;
  label?: string | null;
};

// ── formatting ─────────────────────────────────────────────────────────────
function toNum(v: number | string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
function fmtKg(v: number | string | null | undefined): string {
  const n = toNum(v);
  return n == null ? "—" : n.toLocaleString("en-IN", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}
function fmtInt(v: number | string | null | undefined): string {
  const n = toNum(v);
  return n == null ? "—" : Math.round(n).toLocaleString("en-IN");
}
function fmtPct(v: number | string | null | undefined): string {
  const n = toNum(v);
  return n == null ? "—" : `${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`;
}
function cartonsOf(r: BatchOutputRow): number | string | null | undefined {
  return r.produced_qty_cartons ?? r.cartons;
}

// Open a server PDF (sticker labels) in a new tab — same blob → window.open
// flow the SFG box "print labels" uses. Returns an error message or null.
async function openPdf(path: string): Promise<string | null> {
  try {
    const res = await apiFetch(path);
    if (!res.ok) return await readApiErrorMessage(res, "Could not open stickers PDF");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return null;
  } catch (e) {
    return friendlyApiError(e);
  }
}

export function OutputTab({ detail, onReload }: { detail: OutputDetail; onReload: () => void }) {
  void onReload; // reserved for future actions that mutate JC-level state
  const jcId = detail.job_card_id;
  // Bumped after cartons are created so the batchwise table's Cartons count
  // (sourced from the same backend) refreshes alongside the carton list.
  const [version, setVersion] = useState(0);
  return (
    <div className="space-y-4">
      <AccountingSummary detail={detail} />
      <BatchwiseOutput jcId={jcId} version={version} />
      <CartonsPanel jcId={jcId} version={version} onChanged={() => setVersion((v) => v + 1)} />
    </div>
  );
}

// Shared input styling for the create-cartons form.
const fieldCls =
  "h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] " +
  "outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]";

// ── 1. Accounting summary (read-only) ───────────────────────────────────────
function AccountingSummary({ detail }: { detail: OutputDetail }) {
  const out = detail.section_5_output ?? null;
  const acc = detail.accounting ?? null;
  const isBalanced = acc?.is_balanced;
  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--aws-border)] flex items-center justify-between gap-2">
        <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">Accounting</h3>
        {isBalanced == null ? (
          <span className="text-[11px] text-[var(--text-muted)]">Not yet recorded</span>
        ) : isBalanced ? (
          <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--text-success)]">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" /></svg>
            Balanced
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--aws-error)]">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" /></svg>
            Not balanced
          </span>
        )}
      </div>
      <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-4 gap-y-3 p-4 text-[12px]">
        <KV label="FG produced" value={`${fmtKg(out?.fg_actual_kg)} kg`} />
        <KV label="Units" value={fmtInt(out?.fg_actual_units)} />
        <KV label="RM consumed" value={`${fmtKg(out?.rm_consumed_kg)} kg`} />
        <KV label="Yield" value={fmtPct(out?.yield_pct)} />
        <KV label="Process loss" value={`${fmtKg(out?.process_loss_kg)} kg`} />
        <KV label="Process loss %" value={fmtPct(acc?.process_loss_pct)} />
        <KV label="Total loss %" value={fmtPct(acc?.total_loss_pct)} />
        <KV label="Balance diff" value={`${fmtKg(acc?.balance_diff_kg)} kg · ${fmtPct(acc?.balance_diff_pct)}`} />
      </dl>
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted)]">{label}</dt>
      <dd className="font-mono text-[13px] text-[var(--text-primary)] truncate" title={value}>{value}</dd>
    </div>
  );
}

// ── 2. Batchwise output table ────────────────────────────────────────────────
function BatchwiseOutput({ jcId, version }: { jcId: number; version: number }) {
  const [rows, setRows] = useState<BatchOutputRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch(`/api/v1/production/job-cards-v2/${jcId}/batches`, { signal: ctrl.signal });
        if (ctrl.signal.aborted) return;
        if (res.status === 401) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { batches?: BatchOutputRow[] };
        if (ctrl.signal.aborted) return;
        setRows(Array.isArray(data.batches) ? data.batches : []);
      } catch (e) {
        if (ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        setError(friendlyApiError(e));
        setRows([]);
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    })();
    return () => ctrl.abort();
  }, [jcId, reloadKey, version]);

  const totals = useMemo(() => {
    let kg = 0, units = 0, cartons = 0;
    let hasKg = false, hasUnits = false, hasCartons = false;
    for (const r of rows) {
      const k = toNum(r.produced_qty_kg ?? r.fg_actual_kg);
      const u = toNum(r.fg_actual_units);
      const c = toNum(cartonsOf(r));
      if (k != null) { kg += k; hasKg = true; }
      if (u != null) { units += u; hasUnits = true; }
      if (c != null) { cartons += c; hasCartons = true; }
    }
    return { kg: hasKg ? kg : null, units: hasUnits ? units : null, cartons: hasCartons ? cartons : null };
  }, [rows]);

  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--aws-border)] flex items-center justify-between gap-2">
        <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">Batchwise Output</h3>
        {!loading && !error ? (
          <span className="text-[11px] text-[var(--text-muted)]">{rows.length} batch{rows.length === 1 ? "" : "es"}</span>
        ) : null}
      </div>

      {loading && rows.length === 0 ? (
        <div className="p-8 text-center text-[13px] text-[var(--text-secondary)]">
          <span className="inline-flex items-center gap-2">
            <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
            Loading output…
          </span>
        </div>
      ) : error ? (
        <div className="p-6 text-center">
          <p className="text-[13px] text-[var(--aws-error)] mb-2">{error}</p>
          <button type="button" onClick={() => setReloadKey((k) => k + 1)} className="h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]">Retry</button>
        </div>
      ) : rows.length === 0 ? (
        <div className="p-8 text-center text-[13px] text-[var(--text-secondary)]">No batches yet. Output appears once a batch is opened and closed.</div>
      ) : (
        <>
          {/* md+ : table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-[12px] border-collapse">
              <thead className="bg-[var(--surface-subtle)]">
                <tr className="border-b border-[var(--aws-border)]">
                  <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">Batch</th>
                  <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)] hidden lg:table-cell">Date</th>
                  <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">Status</th>
                  <th className="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">Produced Qty (Kg)</th>
                  <th className="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">Qty (Units)</th>
                  <th className="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">Qty (Cartons)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.batch_id} className="border-b border-[var(--aws-border)] hover:bg-[var(--surface-subtle)]">
                    <td className="px-3 py-2 font-mono text-[var(--text-primary)]">#{r.batch_number}</td>
                    <td className="px-3 py-2 text-[var(--text-secondary)] hidden lg:table-cell">{r.batch_date || "—"}</td>
                    <td className="px-3 py-2 text-[var(--text-secondary)] capitalize">{(r.status || "—").replace(/_/g, " ")}</td>
                    <td className="px-3 py-2 text-right font-mono text-[var(--text-primary)]">{fmtKg(r.produced_qty_kg ?? r.fg_actual_kg)}</td>
                    <td className="px-3 py-2 text-right font-mono text-[var(--text-primary)]">{fmtInt(r.fg_actual_units)}</td>
                    <td className="px-3 py-2 text-right font-mono text-[var(--text-primary)]">{fmtInt(cartonsOf(r))}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-[var(--surface-subtle)] border-t-2 border-[var(--aws-border-strong)] font-semibold">
                  <td className="px-3 py-2 text-[var(--text-primary)]" colSpan={3}>Total</td>
                  <td className="px-3 py-2 text-right font-mono text-[var(--text-primary)]">{fmtKg(totals.kg)}</td>
                  <td className="px-3 py-2 text-right font-mono text-[var(--text-primary)]">{fmtInt(totals.units)}</td>
                  <td className="px-3 py-2 text-right font-mono text-[var(--text-primary)]">{fmtInt(totals.cartons)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          {/* < md : stacked cards */}
          <div className="md:hidden divide-y divide-[var(--aws-border)]">
            {rows.map((r) => (
              <div key={r.batch_id} className="px-4 py-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-mono text-[13px] font-semibold text-[var(--text-primary)]">Batch #{r.batch_number}</span>
                  <span className="text-[11px] text-[var(--text-secondary)] capitalize">{(r.status || "—").replace(/_/g, " ")}</span>
                </div>
                <dl className="grid grid-cols-3 gap-2 text-center">
                  <OutputCell label="Kg" value={fmtKg(r.produced_qty_kg ?? r.fg_actual_kg)} />
                  <OutputCell label="Units" value={fmtInt(r.fg_actual_units)} />
                  <OutputCell label="Cartons" value={fmtInt(cartonsOf(r))} />
                </dl>
              </div>
            ))}
            <div className="px-4 py-3 bg-[var(--surface-subtle)]">
              <div className="text-[11px] uppercase tracking-wide font-semibold text-[var(--text-muted)] mb-2">Total</div>
              <dl className="grid grid-cols-3 gap-2 text-center">
                <OutputCell label="Kg" value={fmtKg(totals.kg)} strong />
                <OutputCell label="Units" value={fmtInt(totals.units)} strong />
                <OutputCell label="Cartons" value={fmtInt(totals.cartons)} strong />
              </dl>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function OutputCell({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted)]">{label}</dt>
      <dd className={["font-mono truncate", strong ? "text-[14px] font-semibold text-[var(--text-primary)]" : "text-[13px] text-[var(--text-primary)]"].join(" ")}>{value}</dd>
    </div>
  );
}

// ── 3. Cartons (SFG-box-style list + trace + sticker printing + create) ──────
function CartonsPanel({ jcId, version, onChanged }: { jcId: number; version: number; onChanged: () => void }) {
  const [cartons, setCartons] = useState<CartonRowT[]>([]);
  const [batches, setBatches] = useState<BatchOutputRow[]>([]);
  const [loading, setLoading] = useState(true);
  // 404 / parse failure → quiet "not available" state (same defensive pattern
  // as SfgGenealogyPanel) so the panel never throws if the route is absent.
  const [unavailable, setUnavailable] = useState(false);
  const [printErr, setPrintErr] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    void (async () => {
      setLoading(true);
      try {
        const [cRes, bRes] = await Promise.all([
          apiFetch(`/api/v1/production/job-cards-v2/${jcId}/fg-cartons`, { signal: ctrl.signal }),
          apiFetch(`/api/v1/production/job-cards-v2/${jcId}/batches`, { signal: ctrl.signal }),
        ]);
        if (ctrl.signal.aborted) return;
        if (!cRes.ok) {
          setUnavailable(true);
          setCartons([]);
        } else {
          const data = (await cRes.json()) as { cartons?: CartonRowT[] } | null;
          setCartons(Array.isArray(data?.cartons) ? data!.cartons : []);
          setUnavailable(false);
        }
        if (bRes.ok) {
          const bd = (await bRes.json()) as { batches?: BatchOutputRow[] };
          setBatches(Array.isArray(bd.batches) ? bd.batches : []);
        }
      } catch (e) {
        if (ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        setUnavailable(true);
        setCartons([]);
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    })();
    return () => ctrl.abort();
  }, [jcId, version, reloadKey]);

  async function printAll() {
    setPrintErr(null);
    const err = await openPdf(`/api/v1/production/job-cards-v2/${jcId}/fg-cartons/labels.pdf`);
    if (err) setPrintErr(err);
  }

  const totalKg = useMemo(
    () => cartons.reduce((s, c) => s + (toNum(c.net_weight_kg) ?? 0), 0),
    [cartons],
  );

  function afterCreate() {
    setShowCreate(false);
    setReloadKey((k) => k + 1); // refresh the carton list
    onChanged();                // refresh the batchwise Cartons count
  }

  const btnPrimary =
    "h-7 px-3 rounded-[2px] text-[12px] font-semibold border border-[var(--aws-orange-active)] " +
    "bg-[var(--aws-orange)] hover:bg-[var(--aws-orange-hover)] text-white";
  const btnSecondary =
    "h-7 px-3 rounded-[2px] text-[12px] font-semibold border border-[var(--aws-border-strong)] " +
    "bg-white hover:border-[var(--aws-navy)] text-[var(--text-primary)]";

  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--aws-border)] flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">Cartons</h3>
        <div className="flex flex-wrap items-center gap-3">
          {cartons.length > 0 ? (
            <span className="text-[11px] text-[var(--text-muted)]">{cartons.length} carton{cartons.length === 1 ? "" : "s"} · Σ {fmtKg(totalKg)} kg</span>
          ) : null}
          {cartons.length > 0 ? (
            <button type="button" onClick={() => void printAll()} className={btnPrimary}>Print all stickers</button>
          ) : null}
          <button type="button" onClick={() => setShowCreate((v) => !v)} className={btnSecondary}>
            {showCreate ? "Cancel" : "Create cartons"}
          </button>
        </div>
      </div>

      {showCreate ? <CreateCartonsForm jcId={jcId} batches={batches} onDone={afterCreate} /> : null}

      <div className="p-4">
        {printErr ? <div className="text-[12px] text-[var(--aws-error)] mb-2">{printErr}</div> : null}
        {loading ? (
          <p className="text-[12px] text-[var(--text-muted)] italic">Loading cartons…</p>
        ) : unavailable || cartons.length === 0 ? (
          <p className="text-[12px] text-[var(--text-muted)]">
            No cartons yet. Use <strong>Create cartons</strong> to pack this stage&apos;s FG into weighed cartons — each gets an 8-digit QR sticker and is traceable upstream.
          </p>
        ) : (
          <div className="space-y-1">
            <div className="hidden sm:grid grid-cols-12 gap-2 text-[11px] text-[var(--text-muted)] font-semibold px-1">
              <div className="col-span-3">Carton ID</div>
              <div className="col-span-2">Net kg</div>
              <div className="col-span-1">Units</div>
              <div className="col-span-2">Batch</div>
              <div className="col-span-1">Status</div>
              <div className="col-span-3 text-right">Actions</div>
            </div>
            {cartons.map((c) => (
              <CartonRow key={c.carton_id} carton={c} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Inline form to pack cartons (net weight + units each) against an optional
// batch, then POST /fg-cartons and open the sticker PDF.
function CreateCartonsForm({ jcId, batches, onDone }: { jcId: number; batches: BatchOutputRow[]; onDone: () => void }) {
  const [batchId, setBatchId] = useState<string>("");
  const [rows, setRows] = useState<{ net: string; gross: string; units: string }[]>([{ net: "", gross: "", units: "" }]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const sumKg = useMemo(() => rows.reduce((s, r) => s + (toNum(r.net) ?? 0), 0), [rows]);

  async function submit() {
    setErr(null);
    const cartons = rows
      .map((r) => ({
        net_weight: toNum(r.net),
        gross_weight: r.gross.trim() === "" ? null : toNum(r.gross),
        units: r.units.trim() === "" ? null : Math.round(toNum(r.units) ?? 0),
      }))
      .filter((c): c is { net_weight: number; gross_weight: number | null; units: number | null } =>
        c.net_weight != null && c.net_weight > 0);
    if (cartons.length === 0) {
      setErr("Enter at least one carton net weight (> 0).");
      return;
    }
    // Gross (when given) must be >= net — same rule the backend enforces; fail
    // fast here so the operator doesn't round-trip for it.
    const badGross = cartons.find((c) => c.gross_weight != null && c.gross_weight < c.net_weight);
    if (badGross) {
      setErr("Gross weight cannot be less than net weight.");
      return;
    }
    const selected = batches.find((b) => String(b.batch_id) === batchId);
    setBusy(true);
    try {
      const res = await apiFetch(`/api/v1/production/job-cards-v2/${jcId}/fg-cartons`, {
        method: "POST",
        body: JSON.stringify({
          cartons,
          batch_id: selected ? selected.batch_id : null,
          batch_code: selected ? `#${selected.batch_number}` : null,
        }),
      });
      if (!res.ok) {
        setErr(await readApiErrorMessage(res, "Could not create cartons"));
        return;
      }
      // Open the stickers for what we just packed (same blob → new-tab flow).
      await openPdf(`/api/v1/production/job-cards-v2/${jcId}/fg-cartons/labels.pdf`);
      onDone();
    } catch (e) {
      setErr(friendlyApiError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="px-4 py-3 border-b border-[var(--aws-border)] bg-[var(--surface-subtle)]">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        <label className="block">
          <span className="block text-[10px] uppercase tracking-wide font-semibold text-[var(--text-secondary)] mb-0.5">Batch (optional)</span>
          <select value={batchId} onChange={(e) => setBatchId(e.target.value)} className={`${fieldCls} w-full`}>
            <option value="">— none —</option>
            {batches.map((b) => (
              <option key={b.batch_id} value={String(b.batch_id)}>
                #{b.batch_number}{b.batch_date ? ` · ${b.batch_date}` : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-[var(--text-muted)] w-16 shrink-0">Carton {i + 1}</span>
            <input
              type="number" step="any" inputMode="decimal" placeholder="net kg"
              className={`${fieldCls} w-28`} value={r.net}
              onChange={(e) => setRows((p) => p.map((x, j) => (j === i ? { ...x, net: e.target.value } : x)))}
            />
            <input
              type="number" step="any" inputMode="decimal" placeholder="gross kg"
              className={`${fieldCls} w-28`} value={r.gross}
              onChange={(e) => setRows((p) => p.map((x, j) => (j === i ? { ...x, gross: e.target.value } : x)))}
            />
            <input
              type="number" step="1" inputMode="numeric" placeholder="units"
              className={`${fieldCls} w-24`} value={r.units}
              onChange={(e) => setRows((p) => p.map((x, j) => (j === i ? { ...x, units: e.target.value } : x)))}
            />
            {rows.length > 1 ? (
              <button type="button" className="text-[12px] text-[var(--aws-error)] hover:underline"
                onClick={() => setRows((p) => p.filter((_, j) => j !== i))}>remove</button>
            ) : null}
          </div>
        ))}
        <div className="flex items-center gap-3 pt-1">
          <button type="button" className="text-[12px] text-[var(--aws-link)] hover:underline"
            onClick={() => setRows((p) => [...p, { net: "", gross: "", units: "" }])}>+ add carton</button>
          <span className="text-[12px] text-[var(--text-muted)]">Σ {fmtKg(sumKg)} kg</span>
        </div>
        {err ? <div className="text-[12px] text-[var(--aws-error)]">{err}</div> : null}
        <button
          type="button" disabled={busy} onClick={() => void submit()}
          className="h-8 px-3 rounded-[2px] text-[12px] font-semibold border border-[var(--aws-orange-active)] bg-[var(--aws-orange)] hover:bg-[var(--aws-orange-hover)] text-white disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? "Creating…" : "Create cartons & print stickers"}
        </button>
      </div>
    </div>
  );
}

function CartonRow({ carton }: { carton: CartonRowT }) {
  const [open, setOpen] = useState(false);
  const [printErr, setPrintErr] = useState<string | null>(null);

  async function printOne() {
    setPrintErr(null);
    const err = await openPdf(`/api/v1/production/fg-cartons/${carton.carton_id}/label.pdf`);
    if (err) setPrintErr(err);
  }

  return (
    <div className="border border-[var(--aws-border)] rounded-md p-2 bg-white">
      <div className="grid grid-cols-2 sm:grid-cols-12 gap-2 items-center text-[12px]">
        <div className="sm:col-span-3 font-mono text-[var(--aws-link)] font-semibold" title={carton.fg_sku_name ?? carton.sfg_code ?? ""}>{carton.carton_id}</div>
        <div className="sm:col-span-2">{fmtKg(carton.net_weight_kg)}</div>
        <div className="sm:col-span-1">{fmtInt(carton.units)}</div>
        <div className="sm:col-span-2 font-mono text-[var(--text-secondary)]">{carton.batch_code || "—"}</div>
        <div className="sm:col-span-1 text-[var(--text-secondary)] capitalize">{(carton.status || "—").toLowerCase()}</div>
        <div className="sm:col-span-3 flex items-center justify-end gap-3">
          <button type="button" className="text-[12px] text-[var(--aws-link)] hover:underline" onClick={() => void printOne()}>Sticker</button>
          <button type="button" className="text-[12px] text-[var(--aws-link)] hover:underline" onClick={() => setOpen((v) => !v)}>{open ? "Hide trace" : "Trace"}</button>
        </div>
      </div>
      {printErr ? <div className="text-[12px] text-[var(--aws-error)] mt-1">{printErr}</div> : null}
      {open ? <CartonTrace cartonId={carton.carton_id} /> : null}
    </div>
  );
}

function CartonTrace({ cartonId }: { cartonId: number }) {
  const [chain, setChain] = useState<TraceNode[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    void (async () => {
      setLoading(true);
      try {
        const res = await apiFetch(`/api/v1/production/fg-cartons/${cartonId}/genealogy`, { signal: ctrl.signal });
        if (ctrl.signal.aborted) return;
        if (!res.ok) { setUnavailable(true); setChain(null); return; }
        const json = (await res.json()) as { chain?: TraceNode[] } | null;
        if (ctrl.signal.aborted) return;
        setChain(Array.isArray(json?.chain) ? json!.chain : []);
        setUnavailable(false);
      } catch (e) {
        if (ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        setUnavailable(true);
        setChain(null);
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    })();
    return () => ctrl.abort();
  }, [cartonId]);

  if (loading) return <div className="mt-2 pl-2 text-[12px] text-[var(--text-muted)] italic">Tracing…</div>;
  if (unavailable || !chain || chain.length === 0) {
    return <div className="mt-2 pl-2 text-[12px] text-[var(--text-muted)] italic">No upstream lineage yet.</div>;
  }
  return (
    <ol className="mt-2 border-t border-[var(--surface-divider)] pt-2 space-y-1">
      {chain.map((node, i) => (
        <li
          key={`${node.level}-${node.carton_id ?? node.box_id ?? "x"}-${i}`}
          className="text-[12px] flex items-center gap-2 flex-wrap"
          style={{ paddingLeft: `${Math.max(0, node.level) * 14}px` }}
        >
          <span className="text-[var(--text-muted)]">{node.level === 0 ? "•" : "↳"}</span>
          {(node.carton_id ?? node.box_id) != null ? (
            <span className="font-mono text-[var(--aws-link)] font-semibold">{node.carton_id ?? node.box_id}</span>
          ) : null}
          {node.label ? <span className="text-[var(--text-secondary)]">{node.label}</span> : null}
          {node.sfg_code ? <span className="font-mono font-semibold text-[var(--aws-navy)]">{node.sfg_code}</span> : null}
          {node.lot_number ? (
            <span className="font-mono text-[11px] font-semibold text-[var(--aws-navy)] bg-[var(--surface-divider)] rounded-sm px-1.5 py-0.5">{node.lot_number}</span>
          ) : null}
          {node.batch_id != null ? <span className="font-mono text-[11px] text-[var(--text-muted)]">batch {node.batch_id}</span> : null}
          {node.source_inventory_batch_id != null ? <span className="font-mono text-[11px] text-[var(--text-muted)]">inv-batch {node.source_inventory_batch_id}</span> : null}
          {node.producer_job_card_id != null ? <span className="text-[var(--text-muted)]">· JC {node.producer_job_card_id}</span> : null}
        </li>
      ))}
    </ol>
  );
}
