"use client";

// Printable Delivery Challan + tear-off Gate Pass (doc 10). Pure document component:
// consolidates the transfer lines, paginates 10 items/DC page, and auto-fires
// window.print() once on mount. Inline styles (not Tailwind) so print fidelity +
// color-adjust are explicit. Rendered by dc/[transferId]/page.tsx.

import { useEffect, useMemo } from "react";

interface DCItem {
  item_description?: string | null;
  item_category?: string | null;
  pack_size?: string | null;
  quantity?: string | null;
  uom?: string | null;
  net_weight?: string | null;
  material_type?: string | null;
  unit_pack_size?: string | null;
}
type ConsolidatedItem = DCItem & { box_count: number };

export interface DeliveryChallanProps {
  dcNumber: string;
  requestDate: string;
  fromWarehouse: string;
  toWarehouse: string;
  vehicleNumber: string;
  driverName: string;
  approvalAuthority: string;
  reasonDescription: string;
  items: DCItem[];
  totalQtyRequired: number;
  boxesProvided: number;
  isPartial: boolean;
}

const WAREHOUSE_ADDRESSES: Record<string, { name: string; address: string }> = {
  W202: { name: "Warehouse W202", address: "W-202, MIDC TTC Industrial area, Khairane, Navi Mumbai, Maharashtra 400710" },
  A185: { name: "Warehouse A185", address: "A-185, MIDC TTC Industrial area, Khairane, Navi Mumbai, Maharashtra 400709" },
  A101: { name: "Warehouse A101", address: "A-101, MIDC TTC Industrial area, Khairane, Navi Mumbai, Maharashtra 400709" },
  A68: { name: "Warehouse A68", address: "A-68, MIDC TTC Industrial area, Khairane, Navi Mumbai, Maharashtra 400709" },
  F53: { name: "Warehouse F53", address: "F53, APMC Masala Market, Sector 19, Vashi, Navi Mumbai, Maharashtra 400703" },
  "Savla D-39": { name: "Savla D-39 Cold Storage", address: "Savla D-39, MIDC TTC Industrial area, Khairane, Navi Mumbai, Maharashtra 400709" },
  "Savla D-514": { name: "Savla D-514 Cold Storage", address: "Savla D-514, MIDC TTC Industrial area, Khairane, Navi Mumbai, Maharashtra 400709" },
  Rishi: { name: "Rishi Cold Storage", address: "Rishi, MIDC TTC Industrial area, Khairane, Navi Mumbai, Maharashtra 400709" },
  Supreme: { name: "Supreme Cold Storage", address: "MIDC, Turbhe, Navi Mumbai" },
  "Cold Storage": { name: "Cold Storage", address: "MIDC TTC Industrial area, Khairane, Navi Mumbai" },
};

const MAROON = "#8B4049";
const ITEMS_PER_PAGE = 10;

function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}
function isCountable(it: DCItem): boolean {
  return (it.material_type || "").toUpperCase() === "PM" || (it.item_category || "").toUpperCase() === "PACKAGING";
}
function itemCount(it: DCItem): number {
  return isCountable(it) ? num(it.unit_pack_size) * num(it.quantity) : 0;
}
function warehouseBlock(code: string): { name: string; address: string } {
  return WAREHOUSE_ADDRESSES[code] || { name: code, address: "" };
}

export function DeliveryChallan(props: DeliveryChallanProps) {
  const { dcNumber, requestDate, fromWarehouse, toWarehouse, vehicleNumber, driverName,
    approvalAuthority, reasonDescription, items, totalQtyRequired, boxesProvided, isPartial } = props;

  // Auto-print once after the layout/logo settle.
  useEffect(() => {
    const t = setTimeout(() => window.print(), 500);
    return () => clearTimeout(t);
  }, []);

  const consolidated = useMemo<ConsolidatedItem[]>(() => {
    const map = new Map<string, ConsolidatedItem>();
    for (const it of items) {
      const key = `${(it.item_description || "").trim().toUpperCase()}__${(it.item_category || "").trim().toUpperCase()}__${it.pack_size || "0"}`;
      const ex = map.get(key);
      if (ex) {
        ex.quantity = String(num(ex.quantity) + num(it.quantity));
        ex.net_weight = (num(ex.net_weight) + num(it.net_weight)).toFixed(3);
        ex.box_count += 1;
      } else {
        map.set(key, { ...it, box_count: 1 });
      }
    }
    return Array.from(map.values());
  }, [items]);

  const showCount = consolidated.some(isCountable) || /a-?68/i.test(fromWarehouse);
  const totalNet = consolidated.reduce((s, it) => s + num(it.net_weight), 0);
  const totalCount = consolidated.reduce((s, it) => s + itemCount(it), 0);
  const totalBoxes = items.length;
  const cols = showCount ? 9 : 8;

  const from = warehouseBlock(fromWarehouse);
  const to = warehouseBlock(toWarehouse);

  const pages: ConsolidatedItem[][] = [];
  for (let i = 0; i < consolidated.length; i += ITEMS_PER_PAGE) pages.push(consolidated.slice(i, i + ITEMS_PER_PAGE));
  if (pages.length === 0) pages.push([]);

  const td: React.CSSProperties = { border: "1px solid #000", padding: "3px 5px", fontSize: "11px" };
  const th: React.CSSProperties = { ...td, background: "#e0e0e0", fontWeight: 700, textAlign: "center" };

  const renderHeader = (pageNum: number) => (
    <thead>
      <tr><td colSpan={cols} style={{ borderBottom: "2px solid #000", padding: "6px 0", textAlign: "center" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/candor_logo.jpg" alt="Candor Foods" style={{ height: "56px", margin: "0 auto", display: "block" }} />
        <div style={{ fontSize: "20px", fontWeight: 700, color: MAROON }}>CANDOR FOODS</div>
        <div style={{ fontSize: "14px", letterSpacing: "2px" }}>DELIVERY CHALLAN</div>
        {pageNum > 1 && <div style={{ fontSize: "11px" }}>Page {pageNum}</div>}
      </td></tr>
      <tr>
        <td colSpan={Math.ceil(cols / 2)} style={{ ...td, fontWeight: 600 }}>Transfer No: {dcNumber}</td>
        <td colSpan={Math.floor(cols / 2)} style={{ ...td, fontWeight: 600 }}>Date: {requestDate}</td>
      </tr>
      <tr>
        <td colSpan={Math.ceil(cols / 2)} style={td}>
          <div style={{ fontSize: "10px", color: "#666" }}>FROM: Candor Foods</div>
          <div style={{ fontWeight: 700 }}>{from.name}</div>
          <div style={{ fontSize: "10px", color: "#666" }}>{from.address}</div>
        </td>
        <td colSpan={Math.floor(cols / 2)} style={td}>
          <div style={{ fontSize: "10px", color: "#666" }}>TO: Candor Foods</div>
          <div style={{ fontWeight: 700 }}>{to.name}</div>
          <div style={{ fontSize: "10px", color: "#666" }}>{to.address}</div>
        </td>
      </tr>
      <tr>
        <td colSpan={Math.ceil(cols / 2)} style={td}>Vehicle No: {vehicleNumber}</td>
        <td colSpan={Math.floor(cols / 2)} style={td}>Driver Name: {driverName}</td>
      </tr>
      {showCount && (
        <tr><td colSpan={cols} style={{ ...td, background: "#fdf8f4", color: MAROON, fontWeight: 700, textAlign: "center" }}>
          Total Count (PM): {totalCount.toLocaleString("en-IN")}
        </td></tr>
      )}
      <tr>
        <th style={th}>S.No</th>
        <th style={{ ...th, textAlign: "left" }}>Item Description</th>
        <th style={th}>Category</th>
        <th style={th}>No. of Boxes</th>
        <th style={th}>Qty</th>
        <th style={th}>UOM</th>
        <th style={th}>Pack Size (kg)</th>
        <th style={th}>Net Wt (kg)</th>
        {showCount && <th style={th}>Count</th>}
      </tr>
    </thead>
  );

  return (
    <div className="dc-print-content" style={{ width: "100%", background: "#fff", padding: "0.5cm 1.25cm" }}>
      {/* A. Delivery Challan pages */}
      {pages.map((pageItems, pageIdx) => {
        const isLast = pageIdx === pages.length - 1;
        return (
          <div key={pageIdx} className="dc-page" style={{ pageBreakAfter: isLast ? "auto" : "always" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "auto" }}>
              {renderHeader(pageIdx + 1)}
              <tbody>
                {pageItems.map((it, i) => {
                  const globalIndex = pageIdx * ITEMS_PER_PAGE + i;
                  const cnt = itemCount(it);
                  return (
                    <tr key={globalIndex}>
                      <td style={{ ...td, textAlign: "center" }}>{globalIndex + 1}</td>
                      <td style={{ ...td, wordBreak: "break-word" }}>{it.item_description}</td>
                      <td style={{ ...td, textAlign: "center" }}>{it.item_category}</td>
                      <td style={{ ...td, textAlign: "center", fontWeight: 700 }}>{it.box_count.toLocaleString("en-IN")}</td>
                      <td style={{ ...td, textAlign: "center", fontWeight: 700 }}>{num(it.quantity).toLocaleString("en-IN")}</td>
                      <td style={{ ...td, textAlign: "center" }}>{it.uom}</td>
                      <td style={{ ...td, textAlign: "center" }}>{it.pack_size && it.pack_size !== "0" ? num(it.pack_size).toLocaleString("en-IN", { minimumFractionDigits: 3, maximumFractionDigits: 3 }) : ""}</td>
                      <td style={{ ...td, textAlign: "right" }}>{num(it.net_weight).toLocaleString("en-IN", { minimumFractionDigits: 3, maximumFractionDigits: 3 })}</td>
                      {showCount && <td style={{ ...td, textAlign: "right" }}>{cnt > 0 ? cnt.toLocaleString("en-IN") : "—"}</td>}
                    </tr>
                  );
                })}

                {isLast && (
                  <>
                    <tr style={{ background: "#f0ebe3", fontWeight: 700 }}>
                      <td colSpan={3} style={td}>TOTAL ({consolidated.length} item(s)):</td>
                      <td style={{ ...td, textAlign: "center" }}>{totalBoxes.toLocaleString("en-IN")}</td>
                      <td style={{ ...td, textAlign: "center" }}>{totalQtyRequired.toLocaleString("en-IN")}</td>
                      <td style={td}></td>
                      <td style={td}></td>
                      <td style={{ ...td, textAlign: "right" }}>{totalNet.toLocaleString("en-IN", { minimumFractionDigits: 3, maximumFractionDigits: 3 })}</td>
                      {showCount && <td style={{ ...td, textAlign: "right" }}>{totalCount > 0 ? totalCount.toLocaleString("en-IN") : "—"}</td>}
                    </tr>
                    <tr><td colSpan={cols} style={td}>Reason: {reasonDescription}</td></tr>
                    <tr><td colSpan={cols} style={{ ...td, padding: "14px 5px" }}>Auth Sign : _________________________</td></tr>
                    <tr><td colSpan={cols} style={{ ...td, fontStyle: "italic", textAlign: "center", color: "#666" }}>
                      This is a computer-generated delivery challan. No signature required.
                    </td></tr>
                  </>
                )}
              </tbody>
            </table>
          </div>
        );
      })}

      {/* B. CUT HERE */}
      <div style={{ position: "relative", borderTop: "2px dashed #999", margin: "16px 0", pageBreakBefore: "avoid" }}>
        <span style={{ position: "absolute", left: "50%", top: "-10px", transform: "translateX(-50%)", background: "#fff", padding: "0 8px", fontSize: "11px", color: "#999" }}>✂ CUT HERE</span>
      </div>

      {/* C. Gate Pass */}
      <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed", pageBreakInside: "avoid" }}>
        <tbody>
          <tr><td colSpan={showCount ? 6 : 5} style={{ border: "1px solid #000", background: "#f0f0f0", padding: "6px", textAlign: "center" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/candor_logo.jpg" alt="Candor Foods" style={{ height: "44px", verticalAlign: "middle", marginRight: "8px" }} />
            <span style={{ fontSize: "18px", fontWeight: 700, color: MAROON, verticalAlign: "middle" }}>CANDOR FOODS - GATE PASS</span>
          </td></tr>
          <tr>
            <td colSpan={showCount ? 2 : 2} style={td}>Transfer No: {dcNumber}</td>
            <td colSpan={2} style={td}>Date: {requestDate}</td>
            <td colSpan={showCount ? 2 : 1} style={td}>Vehicle: {vehicleNumber} / {driverName}</td>
          </tr>
          <tr>
            <td colSpan={showCount ? 3 : 2} style={td}>From: {from.name}</td>
            <td colSpan={3} style={td}>To: {to.name}</td>
          </tr>
          <tr><td colSpan={showCount ? 6 : 5} style={{ ...td, background: "#fdf8f4", color: MAROON, fontWeight: 700, textAlign: "center" }}>ITEMS SUMMARY</td></tr>
          <tr>
            <th style={th}>S.No</th>
            <th style={{ ...th, textAlign: "left" }}>Item Description</th>
            <th style={th}>Boxes</th>
            <th style={th}>Qty</th>
            <th style={th}>Net Wt (Kg)</th>
            {showCount && <th style={th}>Count</th>}
          </tr>
          {consolidated.map((it, i) => {
            const cnt = itemCount(it);
            return (
              <tr key={i}>
                <td style={{ ...td, textAlign: "center" }}>{i + 1}</td>
                <td style={{ ...td, wordBreak: "break-word" }}>{it.item_description}</td>
                <td style={{ ...td, textAlign: "center" }}>{it.box_count.toLocaleString("en-IN")}</td>
                <td style={{ ...td, textAlign: "center" }}>{num(it.quantity).toLocaleString("en-IN")}</td>
                <td style={{ ...td, textAlign: "right" }}>{num(it.net_weight).toFixed(2)}</td>
                {showCount && <td style={{ ...td, textAlign: "right" }}>{cnt > 0 ? cnt.toLocaleString("en-IN") : "—"}</td>}
              </tr>
            );
          })}
          <tr style={{ background: "#f0ebe3", fontWeight: 700 }}>
            <td colSpan={2} style={td}>Total Items: {consolidated.length}</td>
            <td style={{ ...td, textAlign: "center" }}>{totalBoxes}</td>
            <td style={{ ...td, textAlign: "center" }}>{totalQtyRequired.toLocaleString("en-IN")}</td>
            <td style={{ ...td, textAlign: "right" }}>
              {totalNet.toFixed(2)}{" "}
              <span style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 3, fontSize: "10px", color: "#fff", background: isPartial ? "#c0392b" : "#27ae60" }}>
                {isPartial ? "PARTIAL" : "COMPLETE"}
              </span>
            </td>
            {showCount && <td style={{ ...td, textAlign: "right" }}>{totalCount > 0 ? totalCount.toLocaleString("en-IN") : "—"}</td>}
          </tr>
          <tr>
            <td colSpan={showCount ? 3 : 2} style={{ ...td, padding: "16px 5px" }}>Security Sign: ______________</td>
            <td colSpan={3} style={{ ...td, padding: "16px 5px" }}>Driver Sign: ______________</td>
          </tr>
          <tr><td colSpan={showCount ? 6 : 5} style={{ ...td, fontSize: "10px", color: "#666", textAlign: "center" }}>
            Present this gate pass at security gate • Authorized by: {approvalAuthority} • Boxes provided: {boxesProvided}
          </td></tr>
        </tbody>
      </table>

      {/* D. Print stylesheet — plain global <style> (this codebase doesn't use styled-jsx) */}
      <style dangerouslySetInnerHTML={{ __html: `
        @page { size: A4; margin: 0; }
        @media print {
          body * { visibility: hidden; }
          .dc-print-content, .dc-print-content * { visibility: visible; }
          .dc-print-content { position: absolute; top: 0; left: 0; width: 100%; }
          body, * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
        }
        @media screen { body { background: #f5f5f5; } }
      ` }} />
    </div>
  );
}
