"use client";

// NPD dev-JC gate pass — an A4 Delivery Challan + Gate Pass, reproduced from the IMS
// interunit-transfer direct-out delivery challan (components/transfer/DeliveryChallan.tsx).
// A dedicated print route: the whole page IS the document, and it auto-opens the browser
// print dialog (Save as PDF) once the data loads — same mechanism as the IMS DC.
// Read-only; no inventory side effects. Reached from the "Download outpass" button.

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useRequireAuth, useMe } from "@/lib/user";
import { sampleCaps } from "@/lib/sample-roles";
import { getDevJobCard, type DevJobCard } from "@/lib/npd-dev";

const BURGUNDY = "#8B4049";

// Candor warehouse addresses (single source: IMS lib/constants/warehouses.ts) so the
// gate pass shows the FROM address, not just the code.
const WAREHOUSE_ADDR: Record<string, string> = {
  W202: "W-202, MIDC TTC Industrial Area, Khairane, Navi Mumbai, Maharashtra 400710",
  A185: "A-185, MIDC TTC Industrial Area, Khairane, Navi Mumbai, Maharashtra 400709",
  A101: "A-101, MIDC TTC Industrial Area, Khairane, Navi Mumbai, Maharashtra 400709",
  A68: "A-68, MIDC TTC Industrial Area, Khairane, Navi Mumbai, Maharashtra 400709",
  F53: "F53, APMC Masala Market, Sector 19, Vashi, Navi Mumbai, Maharashtra 400703",
  "D-39": "Savla D-39, MIDC TTC Industrial Area, Khairane, Navi Mumbai, Maharashtra 400709",
  "D-514": "Savla D-514, MIDC TTC Industrial Area, Khairane, Navi Mumbai, Maharashtra 400709",
  Rishi: "Rishi Cold Storage, MIDC TTC Industrial Area, Khairane, Navi Mumbai, Maharashtra 400709",
  Supreme: "Supreme Cold Storage, MIDC, Turbhe, Navi Mumbai, Maharashtra",
};

function n(v: number | string | null | undefined, dp = 3): string {
  const x = v == null || v === "" ? NaN : Number(v);
  return Number.isFinite(x)
    ? x.toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp })
    : "—";
}
function qtyStr(v: number | string | null | undefined): string {
  const x = v == null || v === "" ? NaN : Number(v);
  return Number.isFinite(x) ? x.toLocaleString("en-IN") : "—";
}

export default function DevJcGatePassPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const authed = useRequireAuth(router.replace);
  const me = useMe();
  const canOutpass = sampleCaps(me).canOutpass;

  const [jc, setJc] = useState<DevJobCard | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Hydration gate (SSR true vs first client false) — mirror the other pages.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { queueMicrotask(() => setMounted(true)); }, []);

  // npd_team + admin only — BH/IM are module members but must not reach the
  // outpass. The module layout lets them in; this is the finer gate.
  useEffect(() => {
    if (authed && me !== null && !canOutpass) {
      router.replace(`/modules/npd-development/job-cards/${id}`);
    }
  }, [authed, me, canOutpass, router, id]);

  useEffect(() => {
    if (!authed || !Number.isFinite(id)) return;
    queueMicrotask(() => {
      void getDevJobCard(id).then(setJc).catch((e) =>
        setError(e instanceof Error ? e.message : "Failed to load job card"));
    });
  }, [authed, id]);

  // Auto-open the print dialog once the document has rendered (matches IMS: 500ms).
  useEffect(() => {
    if (!jc) return;
    const t = setTimeout(() => { try { window.print(); } catch { /* ignore */ } }, 500);
    return () => clearTimeout(t);
  }, [jc]);

  if (mounted && !authed) return null;
  if (mounted && me !== null && !canOutpass) return null;

  if (error) {
    return <div style={{ padding: 24, fontFamily: "Arial, sans-serif", color: "#b1361e" }}>{error}</div>;
  }
  if (!jc) {
    return <div style={{ padding: 24, fontFamily: "Arial, sans-serif", color: "#666" }}>Loading outpass…</div>;
  }

  const itemDesc = jc.fg_sku_name || jc.title || "—";
  const uom = jc.output_uom || jc.uom || "kg";
  const date = (jc.closed_at ?? jc.dispatched_at ?? "").slice(0, 10) || "—";
  const toName = jc.customer_name || jc.company_name || "—";
  const toAddr = jc.customer_ship_to_address || "";
  const fromAddr = (jc.warehouse && WAREHOUSE_ADDR[jc.warehouse]) || jc.warehouse || "—";
  const recipient = jc.dispatch_recipient || "—";
  const reason = jc.output_notes || `NPD sample dispatch — ${id}`;
  // Promote-gate digital signatures (name + decided date) — BH = REQUESTOR_BH, Inventory
  // manager = INV_MGR. Absent for a sourceless / pre-gate card → blank signature line.
  const bh = jc.gate_signatures?.REQUESTOR_BH;
  const im = jc.gate_signatures?.INV_MGR;
  // Billing type carried (read-only) from the source requisition. Show the flags
  // that are set — Returnable / Non-returnable / Paid — but never the amount.
  const sampleType = [
    jc.returnable ? "Returnable" : null,
    jc.non_returnable ? "Non-returnable" : null,
    jc.paid ? "Paid" : null,
  ].filter(Boolean).join(" · ") || "—";

  const td: React.CSSProperties = { padding: "8px", border: "1px solid #000" };
  const cell = (extra: React.CSSProperties = {}): React.CSSProperties =>
    ({ padding: "5px 8px", border: "1px solid #000", fontSize: "10.5px", whiteSpace: "nowrap", ...extra });
  // A signature cell: a digital signature (approver name + "approved" date) when present,
  // else a blank ruled line with white space for a physical signature (e.g. Security).
  const sigCell = (label: string, p?: { name?: string | null; decided_at?: string | null }, span = 2) => (
    <td colSpan={span} style={{ padding: "8px", border: "1px solid #000", verticalAlign: "top", fontSize: "11px", height: "72px" }}>
      <div style={{ fontWeight: "bold", marginBottom: "4px" }}>{label}</div>
      {p?.name ? (
        <>
          <div style={{ fontStyle: "italic", color: BURGUNDY, fontSize: "14px" }}>{p.name}</div>
          <div style={{ color: "#16a34a", fontSize: "10px", marginTop: "2px" }}>
            ✓ Digitally approved{p.decided_at ? ` · ${String(p.decided_at).slice(0, 10)}` : ""}
          </div>
        </>
      ) : (
        <div style={{ borderTop: "1px solid #000", marginTop: "42px" }} />
      )}
    </td>
  );
  const COLS = 5; // S.No | Item Description | Qty | UOM | Net Wt (kg)

  const printCss = `
    @media print { @page { size: A4; margin: 0; } body { margin: 0; padding: 0; print-color-adjust: exact; -webkit-print-color-adjust: exact; } * { print-color-adjust: exact !important; -webkit-print-color-adjust: exact !important; } .no-print { display: none !important; } }
    @media screen { body { background: #f5f5f5; } }
  `;

  return (
    <div className="w-full bg-white dc-print-content" style={{ padding: "0.5cm 1.25cm", fontFamily: "Arial, sans-serif" }}>
      <style dangerouslySetInnerHTML={{ __html: printCss }} />

      {/* On-screen print bar (hidden when printing) */}
      <div className="no-print" style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button onClick={() => window.print()}
          style={{ height: 34, padding: "0 16px", background: BURGUNDY, color: "#fff", border: 0, borderRadius: 4, fontSize: 13, cursor: "pointer" }}>
          Print / Save as PDF
        </button>
        <button onClick={() => router.back()}
          style={{ height: 34, padding: "0 16px", background: "#fff", color: "#333", border: "1px solid #ccc", borderRadius: 4, fontSize: 13, cursor: "pointer" }}>
          Back
        </button>
      </div>

      {/* ── DELIVERY CHALLAN ── */}
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", tableLayout: "auto", marginBottom: "20px" }}>
        <colgroup><col /><col style={{ width: "auto" }} /><col /><col /><col /></colgroup>
        <thead>
          <tr>
            <td colSpan={COLS} style={{ textAlign: "center", padding: "15px", borderBottom: "2px solid #000" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "20px" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/candor_logo.jpg" alt="Candor Foods" style={{ height: "60px", width: "auto" }} />
                <div>
                  <div style={{ fontSize: "20px", fontWeight: "bold", color: BURGUNDY }}>CANDOR FOODS</div>
                  <div style={{ fontSize: "24px", marginTop: "6px", color: BURGUNDY, fontWeight: "bold", letterSpacing: "1px" }}>SAMPLE OUTPASS</div>
                </div>
              </div>
            </td>
          </tr>
          <tr>
            <td colSpan={3} style={td}><strong>Outpass No:</strong> {id}</td>
            <td colSpan={2} style={td}><strong>Date:</strong> {date}</td>
          </tr>
          <tr>
            <td colSpan={3} style={{ ...td, verticalAlign: "top" }}>
              <strong>FROM: Candor Foods</strong>
              {jc.warehouse && <div style={{ marginTop: "5px", fontSize: "11px", fontWeight: "bold" }}>Warehouse {jc.warehouse}</div>}
              <div style={{ color: "#666", marginTop: "3px", fontSize: "11px" }}>{fromAddr}</div>
            </td>
            <td colSpan={2} style={{ ...td, verticalAlign: "top" }}>
              <strong>TO:</strong>
              <div style={{ marginTop: "5px", fontSize: "11px", fontWeight: "bold" }}>{toName}</div>
              {toAddr && <div style={{ color: "#666", marginTop: "3px", fontSize: "11px" }}>{toAddr}</div>}
            </td>
          </tr>
          <tr>
            <td colSpan={3} style={td}><strong>Vehicle No:</strong> —</td>
            <td colSpan={2} style={td}><strong>Recipient / Driver:</strong> {recipient}</td>
          </tr>
          <tr>
            <td colSpan={COLS} style={td}><strong>Sample type:</strong> {sampleType}</td>
          </tr>
          <tr style={{ backgroundColor: "#e0e0e0" }}>
            <td style={cell({ fontWeight: "bold", textAlign: "center" })}>S.No</td>
            <td style={cell({ fontWeight: "bold", whiteSpace: "normal" })}>Item Description</td>
            <td style={cell({ fontWeight: "bold", textAlign: "center" })}>Qty</td>
            <td style={cell({ fontWeight: "bold", textAlign: "center" })}>UOM</td>
            <td style={cell({ fontWeight: "bold", textAlign: "right" })}>Net Wt (kg)</td>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={cell({ textAlign: "center" })}>1</td>
            <td style={cell({ whiteSpace: "normal", wordBreak: "break-word" })}>{itemDesc}</td>
            <td style={cell({ textAlign: "center", fontWeight: "bold" })}>{qtyStr(jc.output_qty)}</td>
            <td style={cell({ textAlign: "center" })}>{uom}</td>
            <td style={cell({ textAlign: "right" })}>{n(jc.output_qty)}</td>
          </tr>
          <tr style={{ backgroundColor: "#f0ebe3" }}>
            <td colSpan={2} style={cell({ fontWeight: "bold", textAlign: "right" })}>TOTAL (1 item):</td>
            <td style={cell({ textAlign: "center", fontWeight: "bold" })}>{qtyStr(jc.output_qty)}</td>
            <td style={cell()}>&nbsp;</td>
            <td style={cell({ textAlign: "right", fontWeight: "bold" })}>{n(jc.output_qty)}</td>
          </tr>
          <tr style={{ backgroundColor: "#fdf8f4" }}>
            <td colSpan={3} style={cell({ fontWeight: "bold", textAlign: "right", whiteSpace: "normal" })}>TOTAL FG (kg):</td>
            <td colSpan={2} style={cell({ textAlign: "right", fontWeight: "bold", color: BURGUNDY, fontSize: "12px" })}>{n(jc.output_qty)}</td>
          </tr>
          <tr><td colSpan={COLS} style={{ padding: "10px", border: "1px solid #000" }}><strong>Reason:</strong> {reason}</td></tr>
          <tr>
            {sigCell("Business Head (digital)", bh, 2)}
            {sigCell("Inventory Manager (digital)", im, 2)}
            {sigCell("Security Sign", undefined, 1)}
          </tr>
          <tr>
            <td colSpan={COLS} style={{ padding: "15px 10px", borderTop: "2px solid #000", textAlign: "center", fontSize: "10px", fontStyle: "italic", backgroundColor: "#f8f9fa" }}>
              This is a computer-generated sample outpass. Business head &amp; inventory manager signatures are captured digitally; the security signature is taken at the gate.
            </td>
          </tr>
        </tbody>
      </table>

      {/* ── CUT LINE ── */}
      <div style={{ margin: "20px 0", borderTop: "2px dashed #999", position: "relative" }}>
        <span style={{ position: "absolute", top: "-12px", left: "50%", transform: "translateX(-50%)", backgroundColor: "white", padding: "0 15px", fontSize: "12px", color: "#666", fontWeight: "bold" }}>✂ CUT HERE</span>
      </div>

      {/* ── OUTPASS (gate stub) ── */}
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px", pageBreakInside: "avoid", tableLayout: "fixed" }}>
        <colgroup><col style={{ width: "8%" }} /><col style={{ width: "40%" }} /><col style={{ width: "12%" }} /><col style={{ width: "16%" }} /><col style={{ width: "24%" }} /></colgroup>
        <thead>
          <tr>
            <td colSpan={5} style={{ textAlign: "center", padding: "10px", borderBottom: "2px solid #000", backgroundColor: "#f0f0f0" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "15px" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/candor_logo.jpg" alt="Candor Foods" style={{ height: "50px", width: "auto" }} />
                <div style={{ fontSize: "18px", fontWeight: "bold", color: BURGUNDY }}>CANDOR FOODS - OUTPASS</div>
              </div>
            </td>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td colSpan={2} style={td}><strong>Outpass No:</strong> {id}</td>
            <td colSpan={3} style={td}><strong>Date:</strong> {date}</td>
          </tr>
          <tr>
            <td colSpan={2} style={td}><strong>From:</strong> Candor Foods, {fromAddr}</td>
            <td colSpan={3} style={td}><strong>To:</strong> {toName}{toAddr ? `, ${toAddr}` : ""}</td>
          </tr>
          <tr>
            <td colSpan={5} style={td}><strong>Sample type:</strong> {sampleType}</td>
          </tr>
          <tr style={{ backgroundColor: "#f8f9fa" }}>
            <td colSpan={5} style={{ padding: "6px", border: "1px solid #000", fontWeight: "bold", textAlign: "center" }}>ITEMS SUMMARY</td>
          </tr>
          <tr style={{ backgroundColor: "#f8f9fa" }}>
            <td style={{ ...td, fontWeight: "bold", textAlign: "center" }}>S.No</td>
            <td style={{ ...td, fontWeight: "bold" }}>Item Description</td>
            <td style={{ ...td, fontWeight: "bold", textAlign: "center" }}>Qty</td>
            <td style={{ ...td, fontWeight: "bold", textAlign: "center" }}>UOM</td>
            <td style={{ ...td, fontWeight: "bold", textAlign: "right" }}>Net Wt (Kg)</td>
          </tr>
          <tr>
            <td style={{ ...td, textAlign: "center" }}>1</td>
            <td style={td}>{itemDesc}</td>
            <td style={{ ...td, textAlign: "center", fontWeight: "bold" }}>{qtyStr(jc.output_qty)}</td>
            <td style={{ ...td, textAlign: "center" }}>{uom}</td>
            <td style={{ ...td, textAlign: "right", fontWeight: "bold" }}>{n(jc.output_qty, 2)}</td>
          </tr>
          <tr style={{ backgroundColor: "#fdf8f4" }}>
            <td colSpan={4} style={{ ...td, fontWeight: "bold", textAlign: "right" }}>Total FG (kg):</td>
            <td style={{ ...td, textAlign: "right", fontWeight: "bold", color: BURGUNDY }}>{n(jc.output_qty, 2)}</td>
          </tr>
          {/* Digital approvals captured on the promote gate */}
          <tr style={{ backgroundColor: "#f8f9fa" }}>
            <td colSpan={5} style={{ padding: "6px 8px", border: "1px solid #000", fontSize: "10px" }}>
              <strong>Digitally approved</strong> — Business Head: <span style={{ color: BURGUNDY }}>{bh?.name || "—"}</span> · Inventory Manager: <span style={{ color: BURGUNDY }}>{im?.name || "—"}</span>
            </td>
          </tr>
          <tr>
            <td colSpan={2} style={{ padding: "25px 8px 8px 8px", border: "1px solid #000", textAlign: "center" }}>
              <div style={{ borderTop: "1px solid #000", paddingTop: "5px", marginTop: "30px" }}><strong>Security Sign</strong></div>
            </td>
            <td colSpan={3} style={{ padding: "25px 8px 8px 8px", border: "1px solid #000", textAlign: "center" }}>
              <div style={{ borderTop: "1px solid #000", paddingTop: "5px", marginTop: "30px" }}><strong>Driver / Recipient Sign</strong></div>
            </td>
          </tr>
          <tr>
            <td colSpan={5} style={{ padding: "6px", border: "1px solid #000", textAlign: "center", fontSize: "10px", fontStyle: "italic", backgroundColor: "#f8f9fa" }}>
              Present this outpass at the security gate.
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
