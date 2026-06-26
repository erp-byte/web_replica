"use client";

// NPD draft-BOM editor for a requisition. Lives on the dedicated /[id]/develop
// page (kept off the clean request view). Creates / clones a draft BOM against
// the requisition, lets the NPD team author RM recipe lines, and promotes the
// draft to a live BOM (BH-gated server-side).

import { useCallback, useEffect, useState } from "react";
import {
  getNpdDraft, createNpdDraft, replaceNpdLines, promoteNpdDraft,
  type Requisition, type NpdDraft, type NpdLine,
} from "@/lib/sample";
import { sampleCaps } from "@/lib/sample-roles";
import { ArticlePicker } from "../_form";

export function NpdSection({ req, caps, onChange }: {
  req: Requisition; caps: ReturnType<typeof sampleCaps>; onChange: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<NpdDraft | null>(null);
  const [lines, setLines] = useState<NpdLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (req.npd_draft_bom_id == null) { setDraft(null); return; }
    try {
      const d = await getNpdDraft(req.npd_draft_bom_id);
      setDraft(d); setLines(d.lines ?? []);
    } catch (e) { setErr(e instanceof Error ? e.message : "Failed to load draft"); }
  }, [req.npd_draft_bom_id]);
  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

  async function wrap(fn: () => Promise<unknown>) {
    setBusy(true); setErr(null);
    try { await fn(); await load(); await onChange(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Failed"); }
    finally { setBusy(false); }
  }

  const editable = draft?.status === "DRAFT" && caps.canNpd;

  return (
    <Card title="NPD draft BOM">
      {err && <div className="mb-2 text-[12px] text-[var(--aws-error)]">{err}</div>}
      {req.npd_draft_bom_id == null ? (
        caps.canNpd ? (
          <div className="flex flex-wrap gap-2">
            <button disabled={busy} onClick={() => wrap(() => createNpdDraft(req.id, { base_bom_id: req.base_bom_id ?? undefined, fg_sku_name: req.npd_target_name ?? undefined, clone_from_base: !!req.base_bom_id }))}
              className="h-9 px-4 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] disabled:opacity-50 hover:bg-[var(--aws-orange-hover)]">
              {req.base_bom_id ? "Create draft (clone base BOM)" : "Create empty draft"}
            </button>
          </div>
        ) : <Empty>No draft BOM yet.</Empty>
      ) : !draft ? <Empty>Loading draft…</Empty> : (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-[13px]">
            <span className="font-medium">Draft #{draft.id}</span>
            <StatusPillSmall status={draft.status} />
            {draft.promoted_bom_id && <span className="text-[12px] text-[var(--text-success)]">→ BOM #{draft.promoted_bom_id}</span>}
          </div>
          {/* Add materials — from the SKU master, or free-text off-master below. */}
          {editable && (
            <ArticlePicker restrictItemType="rm" onAdd={(s) => setLines((p) =>
              p.some((x) => x.sku_id === s.sku_id) ? p
                : [...p, { sku_id: s.sku_id, sku_name: s.sku_name, qty: "1", uom: "kg", item_type: "rm", ownership: "OWN", delta_type: "ADDED" }])} />
          )}
          {lines.length === 0 ? <Empty>No lines.</Empty> : (
            <table className="w-full text-[13px]">
              <thead><tr className="text-left text-[12px] text-[var(--text-secondary)]">
                <th className="py-1 font-semibold">Material</th>
                <th className="py-1 font-semibold text-right">Qty</th>
                <th className="py-1 font-semibold">UOM</th>
                <th className="py-1 font-semibold">Type</th>
                <th className="py-1 font-semibold">Ownership</th>
                {editable && <th />}
              </tr></thead>
              <tbody>
                {lines.map((ln, i) => (
                  <tr key={ln.id ?? `new-${i}`} className="border-t border-[var(--surface-divider)]">
                    <td className="py-1">{ln.sku_name}{ln.is_off_master ? <span className="text-[var(--text-muted)]"> · off-master</span> : null}</td>
                    <td className="py-1 text-right">{editable ? (
                      <input className="form-input !h-7 !w-20 text-right" type="number" step="0.001" value={String(ln.qty)}
                        onChange={(e) => setLines((p) => p.map((x, idx) => idx === i ? { ...x, qty: e.target.value } : x))} />
                    ) : ln.qty}</td>
                    <td className="py-1">{ln.uom}</td>
                    <td className="py-1">{ln.item_type ?? "—"}</td>
                    <td className="py-1">{editable ? (
                      <select className="form-input !h-7 !w-28" value={ln.ownership ?? "OWN"}
                        onChange={(e) => setLines((p) => p.map((x, idx) => idx === i ? { ...x, ownership: e.target.value as "OWN" | "CUSTOMER", is_off_master: e.target.value === "CUSTOMER" ? true : x.is_off_master } : x))}>
                        <option value="OWN">Own</option>
                        <option value="CUSTOMER">Customer</option>
                      </select>
                    ) : (ln.ownership === "CUSTOMER" ? <span className="text-[var(--aws-error)]">Customer</span> : "Own")}</td>
                    {editable && <td className="py-1 text-right"><button onClick={() => setLines((p) => p.filter((_, idx) => idx !== i))} className="text-[12px] text-[var(--aws-error)] hover:underline">×</button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {editable && (
            <div className="flex flex-wrap gap-2 pt-1">
              <button disabled={busy} onClick={() => wrap(() => replaceNpdLines(draft.id, lines.map((l) => ({
                ...l, qty: Number(l.qty) || 0, ownership: l.ownership ?? "OWN", is_off_master: !!l.is_off_master,
              }))))}
                className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] disabled:opacity-50 hover:bg-[var(--surface-subtle)]">Save lines</button>
              <button disabled={busy || lines.length === 0} onClick={() => wrap(() => promoteNpdDraft(draft.id))}
                className="h-9 px-4 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] disabled:opacity-50 hover:bg-[var(--aws-orange-hover)]">Promote to live BOM</button>
            </div>
          )}
          <p className="text-[11px] text-[var(--text-muted)]">Customer-supplied lines are recorded for traceability — no stock is issued for them.</p>
        </div>
      )}
    </Card>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white border border-[var(--aws-border)] rounded-md p-4">
      <h2 className="text-[13px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide mb-3">{title}</h2>
      {children}
    </section>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-[13px] text-[var(--text-muted)]">{children}</p>;
}
function StatusPillSmall({ status }: { status: string }) {
  return <span className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--surface-divider)] text-[var(--text-secondary)]">{status}</span>;
}
