"use client";

// Transfer-In View — read-only GRN receipt detail (doc 03). Header metadata,
// totals summary, and received boxes grouped by article (desktop table + mobile
// cards with issue detail). Backed by the existing GET /api/v1/transfer/transfer-in/{id}.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import { TransferChrome } from "../../_chrome";
import { TransferApi, type TransferInDetail, type TransferInBox } from "@/lib/transfer";

function formatDate(d?: string | null): string {
  if (!d) return "N/A";
  try {
    return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" }).replace(/\//g, "-");
  } catch {
    return "N/A";
  }
}

function conditionTone(c?: string | null): string {
  const v = (c || "").toLowerCase();
  if (v === "good") return "bg-emerald-100 text-emerald-800";
  if (v === "damaged") return "bg-rose-100 text-rose-800";
  return "bg-orange-100 text-orange-800";
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

interface IssueShape { actual_qty?: unknown; actual_total_weight?: unknown; remarks?: unknown; }
function parseIssue(issue: TransferInBox["issue"]): IssueShape | null {
  if (!issue) return null;
  if (typeof issue === "string") {
    try { return JSON.parse(issue) as IssueShape; } catch { return null; }
  }
  return issue as IssueShape;
}

function InfoCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md p-3">
      <div className="text-[11px] uppercase tracking-wide text-[var(--text-secondary)]">{label}</div>
      <div className="text-[13px] font-medium text-[var(--text-primary)] mt-0.5">{children}</div>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="text-center">
      <div className="text-[18px] font-semibold text-[var(--text-primary)]">{value}</div>
      <div className="text-[11px] text-[var(--text-secondary)]">{label}</div>
    </div>
  );
}

export default function TransferInViewPage() {
  const router = useRouter();
  const allowed = useRequireAuth(router.replace);
  const params = useParams<{ transferInId: string }>();
  const transferInId = params?.transferInId;

  const [data, setData] = useState<TransferInDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!transferInId) return;
    setLoading(true);
    try {
      const r = await TransferApi.getTransferIn(Number(transferInId));
      setData(r);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [transferInId]);

  useEffect(() => {
    if (!allowed) return;
    queueMicrotask(() => { load(); });
  }, [allowed, load]);

  const groupedBoxes = useMemo(() => {
    const out: Record<string, TransferInBox[]> = {};
    for (const b of data?.boxes ?? []) {
      const key = b.article || "Unknown";
      (out[key] ||= []).push(b);
    }
    return out;
  }, [data]);

  // No `if (!allowed) return null` gate: useRequireAuth returns true on the server but
  // false on the client's first render, so gating the render on it causes a hydration
  // mismatch. The body reads data null-safely (data?.boxes ?? []); effects are gated on
  // `allowed` and the hook redirects unauthenticated users.

  const boxes = data?.boxes ?? [];
  const totalBoxes = boxes.length;
  const matchedBoxes = boxes.filter((b) => b.is_matched).length;
  const issuedBoxes = boxes.filter((b) => b.issue).length;
  const totalNet = boxes.reduce((s, b) => s + num(b.net_weight), 0);
  const totalGross = boxes.reduce((s, b) => s + num(b.gross_weight), 0);

  return (
    <TransferChrome title="Transfer-In View">
      <button onClick={() => router.push("/modules/transfer")}
        className="text-[12px] text-[var(--text-secondary)] hover:underline mb-3">← Back to Transfer dashboard</button>

      {loading ? (
        <div className="py-16 text-center text-[13px] text-[var(--text-secondary)]">Loading transfer-in details…</div>
      ) : !data ? (
        <div className="py-16 text-center text-[13px] text-[var(--text-secondary)]">Transfer-in not found.</div>
      ) : (
        <div className="space-y-4">
          {/* Header */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h1 className="text-[18px] font-semibold text-[var(--text-primary)]">{data.grn_number}</h1>
              <div className="text-[12px] text-[var(--text-secondary)]">Transfer IN — {data.transfer_out_no}</div>
            </div>
            <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${data.status === "Received" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>
              {data.status}
            </span>
          </div>

          {/* Info cards */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            <InfoCard label="From (Sender)">{data.from_warehouse || "N/A"}</InfoCard>
            <InfoCard label="To (Receiver)">{data.receiving_warehouse || "N/A"}</InfoCard>
            <InfoCard label="Received By">{data.received_by || "N/A"}</InfoCard>
            <InfoCard label="Date">{formatDate(data.grn_date)}</InfoCard>
            <InfoCard label="Condition">
              <span className={`inline-block px-2 py-0.5 rounded text-[11px] ${conditionTone(data.box_condition)}`}>{data.box_condition || "N/A"}</span>
            </InfoCard>
          </div>

          {data.condition_remarks && (
            <div className="bg-white border border-[var(--aws-border)] rounded-md p-3">
              <div className="text-[11px] uppercase tracking-wide text-[var(--text-secondary)]">Condition Remarks</div>
              <div className="text-[13px] text-[var(--text-primary)] mt-0.5">{data.condition_remarks}</div>
            </div>
          )}

          {/* Totals */}
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-4 grid grid-cols-2 sm:grid-cols-5 gap-3">
            <Tile label="Total Boxes" value={totalBoxes} />
            <Tile label="Matched" value={matchedBoxes} />
            <Tile label="Issues" value={issuedBoxes} />
            <Tile label="Net Weight" value={`${totalNet.toFixed(2)} kg`} />
            <Tile label="Gross Weight" value={`${totalGross.toFixed(2)} kg`} />
          </div>

          {/* Received items */}
          <div className="bg-white border border-[var(--aws-border)] rounded-md">
            <div className="px-4 py-3 border-b border-[var(--aws-border)] text-[13px] font-semibold text-[var(--text-primary)]">
              Received Items ({totalBoxes})
            </div>
            {totalBoxes === 0 ? (
              <div className="py-10 text-center text-[13px] text-[var(--text-secondary)]">No items recorded in this transfer-in.</div>
            ) : (
              Object.entries(groupedBoxes).map(([article, artBoxes]) => (
                <div key={article} className="border-b border-[var(--aws-border)]/50 last:border-b-0">
                  <div className="px-4 py-2 bg-[var(--background)] flex items-center justify-between">
                    <span className="text-[12px] font-medium text-[var(--text-primary)]">{article}</span>
                    <span className="text-[11px] text-[var(--text-secondary)]">{artBoxes.length} box(es)</span>
                  </div>

                  {/* Desktop table */}
                  <table className="hidden md:table w-full text-[12px]">
                    <thead><tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]/50">
                      <th className="px-4 py-1.5">#</th><th>Box ID</th><th>Transaction No</th><th>Batch / Lot</th>
                      <th className="text-right">Net Wt</th><th className="text-right">Gross Wt</th><th className="text-center pr-4">Status</th>
                    </tr></thead>
                    <tbody>
                      {artBoxes.map((b, idx) => {
                        const hasIssue = !!b.issue;
                        const tint = hasIssue ? "bg-rose-50/40" : b.is_matched ? "bg-emerald-50/40" : "";
                        return (
                          <tr key={b.id} className={tint}>
                            <td className="px-4 py-1.5 font-mono">{idx + 1}</td>
                            <td className="font-mono">{b.box_id || "-"}</td>
                            <td className="font-mono">{b.transaction_no || "-"}</td>
                            <td className="font-mono">{b.batch_number || b.lot_number || "-"}</td>
                            <td className="text-right">{b.net_weight != null ? `${b.net_weight} kg` : "-"}</td>
                            <td className="text-right">{b.gross_weight != null ? `${b.gross_weight} kg` : "-"}</td>
                            <td className="text-center pr-4">
                              {hasIssue ? <span className="text-rose-700">Issue</span>
                                : b.is_matched ? <span className="text-emerald-700">OK</span> : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>

                  {/* Mobile cards */}
                  <div className="md:hidden p-3 space-y-2">
                    {artBoxes.map((b, idx) => {
                      const issue = parseIssue(b.issue);
                      const hasIssue = !!b.issue;
                      return (
                        <div key={b.id} className={`border rounded p-2 ${hasIssue ? "border-rose-200 bg-rose-50/40" : "border-[var(--aws-border)]"}`}>
                          <div className="flex items-center justify-between mb-1">
                            <span className="font-mono text-[12px]">#{idx + 1} · {b.box_id || "-"}</span>
                            {hasIssue ? <span className="text-[11px] text-rose-700">Issue</span>
                              : b.is_matched ? <span className="text-[11px] text-emerald-700">OK</span> : null}
                          </div>
                          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-[var(--text-secondary)]">
                            <span>Trans: {b.transaction_no || "-"}</span>
                            <span>Lot: {b.lot_number || "-"}</span>
                            <span>Net: {b.net_weight != null ? `${b.net_weight} kg` : "-"}</span>
                            <span>Gross: {b.gross_weight != null ? `${b.gross_weight} kg` : "-"}</span>
                          </div>
                          {hasIssue && issue && (
                            <div className="mt-1.5 text-[11px] text-rose-700 border-t border-rose-200 pt-1">
                              {issue.actual_qty != null && <div>Actual Qty: {String(issue.actual_qty)}</div>}
                              {issue.actual_total_weight != null && <div>Actual Wt: {String(issue.actual_total_weight)}</div>}
                              {issue.remarks != null && <div>Remarks: {String(issue.remarks)}</div>}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </TransferChrome>
  );
}
