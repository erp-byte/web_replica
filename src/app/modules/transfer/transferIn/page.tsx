"use client";

// Transfer In (Receive / GRN) — UI replicated from the reference page
// deploy/frontend/app/[company]/transfer/transferIn/page.tsx (the "Article Entries"
// view: Find Transfer → route → Box & Article Acknowledgement → Start Camera Scan →
// Article Entries table). Adapted to the rebuild's Tailwind theme (the reference's
// shadcn/ui + lucide + sonner + qrcode stack is not present here).
//
// "Entries" unify the two source shapes: when the transfer carries scanned boxes,
// each box is one entry; otherwise each line is expanded into `qty` entries (one per
// box) with a synthetic LINE-<lineId>-<n> box_id so per-entry acknowledge still works.
//
// ───────────────────────── FUNCTION BLOCKS ─────────────────────────
// WIRED:  doSearch · ensurePending · onAck/onAckAll/onUnack · openIssue/submitIssue · onConfirm(finalize)
// STUBBED (UI present, build later — route through notWired(), tagged FUNCTION BLOCK (TODO)):
//   • handleScan / camera QR          ref:1078–1211, 2091–2148   (QR scanner component)
//   • handleGenerateQRs               ref:1369–1394              (TR-/box-id generation)
//   • handlePrintQR / Bulk / Range    ref:1214–1525              (4"×2" thermal labels, qrcode)
//   • handleCloseWithShortage         ref:1913–1931              (NEEDS backend)
//   • handleReopen / handleEditReceipt ref:511–530, 2996–3134    (NEEDS backend)
//   • STBR reconciliation             ref:2839–2871              (NEEDS backend)
// ────────────────────────────────────────────────────────────────────

import { Fragment, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useRequireAuth, useMe } from "@/lib/user";
import { TransferChrome } from "../_chrome";
import { TransferApi, type TransferDetail, type AcknowledgeBoxInput } from "@/lib/transfer";
import { getDisplayWarehouseName } from "@/lib/transferBuildSummary";
import { QRScanner } from "../_QRScanner";

function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}
function str(v: unknown): string { return v == null ? "" : String(v); }

const ACK_EMAILS = new Set(["yash@candorfoods.in", "b.hrithik@candorfoods.in", "sunil.jasoria@candorfoods.in"]);
const COLD_SITES = new Set(["cold storage", "rishi", "savla d-39", "savla d-514", "supreme", "eskimo"]);
const REOPEN_EMAILS = new Set(["b.hrithik@candorfoods.in"]);

type IssueData = { net_weight: string; gross_weight: string; qty: string; remarks: string };
const EMPTY_ISSUE: IssueData = { net_weight: "", gross_weight: "", qty: "", remarks: "" };

// One receivable unit. From a scanned box, or one expanded unit of a line.
type Entry = {
  sr: number; key: string; box_id: string; out_box_id: number | null; synthetic: boolean;
  article: string; transaction_no: string; case_pack: string;
  net_weight: number; gross_weight: number; lot_number: string; batch_number: string;
};

function buildEntries(t: TransferDetail | null): Entry[] {
  if (!t) return [];
  const realBoxes = (t.boxes ?? []).filter((b) => !!b.box_id);
  const out: Entry[] = [];
  let sr = 0;
  if (realBoxes.length) {
    for (const b of realBoxes) {
      sr += 1;
      out.push({
        sr, key: String(b.id), box_id: b.box_id!, out_box_id: b.id, synthetic: false,
        article: b.article || "—", transaction_no: b.transaction_no || "", case_pack: "",
        net_weight: num(b.net_weight), gross_weight: num(b.gross_weight),
        lot_number: b.lot_number || "", batch_number: b.batch_number || "",
      });
    }
    return out;
  }
  // line flow: expand each line into `qty` entries (one per box).
  for (const l of t.lines ?? []) {
    const q = Math.max(1, Math.round(num(l.quantity)));
    const perNet = num(l.net_weight) / q;
    const perGross = num(l.total_weight) / q;
    for (let n = 1; n <= q; n++) {
      sr += 1;
      out.push({
        sr, key: `L${l.id}-${n}`, box_id: `LINE-${l.id}-${n}`, out_box_id: null, synthetic: true,
        article: l.item_description || "—", transaction_no: "", case_pack: str(l.pack_size),
        net_weight: perNet, gross_weight: perGross,
        lot_number: l.lot_number || "", batch_number: l.batch_number || "",
      });
    }
  }
  return out;
}

function toAck(e: Entry, matched: boolean, issue?: IssueData): AcknowledgeBoxInput {
  const net = issue && issue.net_weight !== "" ? num(issue.net_weight) : e.net_weight;
  const gross = issue && issue.gross_weight !== "" ? num(issue.gross_weight) : e.gross_weight;
  return {
    box_id: e.box_id, transfer_out_box_id: e.out_box_id, article: e.article,
    batch_number: e.batch_number, lot_number: e.lot_number, transaction_no: e.transaction_no,
    net_weight: net, gross_weight: gross, is_matched: matched, scan_source: "manual",
    issue: matched || !issue ? null : {
      remarks: issue.remarks || "",
      ...(issue.net_weight ? { net_weight: issue.net_weight } : {}),
      ...(issue.gross_weight ? { gross_weight: issue.gross_weight } : {}),
      ...(issue.qty ? { qty: issue.qty } : {}),
    },
  };
}

function Chip({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <span className={`text-[11px] px-1.5 py-0.5 rounded font-medium ${tone}`}>{children}</span>;
}

function ReceiveInner() {
  const router = useRouter();
  const allowed = useRequireAuth(router.replace);
  const me = useMe();
  const searchParams = useSearchParams();
  const resumeNo = searchParams.get("resume");

  const email = (me?.email || "").toLowerCase();
  const canAcknowledge = me?.is_admin === true || ACK_EMAILS.has(email);
  const canReopen = me?.is_admin === true || REOPEN_EMAILS.has(email);
  const receivedBy = me?.full_name || me?.email || "web";

  const [transferNumber, setTransferNumber] = useState("");
  const [transferData, setTransferData] = useState<TransferDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [boxCondition, setBoxCondition] = useState("Good");
  const [conditionRemarks, setConditionRemarks] = useState("");

  const [pendingHeaderId, setPendingHeaderId] = useState<number | null>(null);
  const [acked, setAcked] = useState<Set<string>>(new Set());
  const [issues, setIssues] = useState<Map<string, IssueData>>(new Map());
  const [issueOpen, setIssueOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<IssueData>(EMPTY_ISSUE);
  const [busy, setBusy] = useState(false);
  const [doneGrn, setDoneGrn] = useState<string | null>(null);
  const [receivedHeaderId, setReceivedHeaderId] = useState<number | null>(null);
  const [showShortage, setShowShortage] = useState(false);
  const [shortageReason, setShortageReason] = useState("");
  const [showEdit, setShowEdit] = useState(false);
  const [editForm, setEditForm] = useState({ grn_number: "", box_condition: "Good", condition_remarks: "" });
  const [showScanner, setShowScanner] = useState(false);

  const notWired = (what: string) => setNotice(`${what} — function block, to be built later.`);
  const resetReceiveState = () => {
    setPendingHeaderId(null); setAcked(new Set()); setIssues(new Map());
    setIssueOpen(null); setDoneGrn(null); setReceivedHeaderId(null); setShowShortage(false);
  };

  // ── FUNCTION BLOCK: doSearch (WIRED) ──
  const doSearch = useCallback(async (no: string) => {
    const q = no.trim();
    if (!q) return;
    setLoading(true); setError(null); setNotice(null); setTransferData(null); resetReceiveState();
    try {
      const t = await TransferApi.getTransferByNumber(q);
      if (!t) { setError(`No transfer found for "${q}".`); return; }
      setTransferData(t);
      try {
        const pend = await TransferApi.getPendingByTransferOut(t.id);
        if (pend.exists && pend.header) {
          if ((pend.header.status || "").toLowerCase() === "received") {
            // Already received → offer Re-open (don't adopt its boxes as in-progress).
            setReceivedHeaderId(pend.header.id);
          } else {
            // Pending → resume: adopt the acknowledged / issued boxes.
            setPendingHeaderId(pend.header.id);
            const a = new Set<string>(); const iss = new Map<string, IssueData>();
            for (const b of pend.header.boxes) {
              if (!b.box_id) continue;
              a.add(b.box_id);
              if (b.is_matched === false) {
                const i = parseIssueObj(b.issue) || {};
                iss.set(b.box_id, { net_weight: str(i.net_weight), gross_weight: str(i.gross_weight), qty: str(i.qty), remarks: str(i.remarks) });
              }
            }
            setAcked(a); setIssues(iss);
          }
        }
      } catch { /* resume best-effort */ }
    } catch (e) { setError(e instanceof Error ? e.message : "Search failed."); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (!allowed || !resumeNo) return;
    queueMicrotask(() => { setTransferNumber(resumeNo); doSearch(resumeNo); });
  }, [allowed, resumeNo, doSearch]);

  const entries = useMemo(() => buildEntries(transferData), [transferData]);
  const byArticle = useMemo(() => {
    const m = new Map<string, Entry[]>();
    for (const e of entries) { const a = m.get(e.article); if (a) a.push(e); else m.set(e.article, [e]); }
    return Array.from(m.entries());
  }, [entries]);
  const totals = useMemo(() => ({
    boxes: (transferData?.boxes ?? []).length,
    entries: entries.length,
    net: entries.reduce((s, e) => s + e.net_weight, 0),
    gross: entries.reduce((s, e) => s + e.gross_weight, 0),
  }), [transferData, entries]);

  const resolved = acked.size;
  const issueCount = issues.size;
  const pendingCount = Math.max(entries.length - resolved, 0);
  const allResolved = entries.length > 0 && resolved === entries.length;
  const isCold = !!transferData?.from_cold_unit ||
    (transferData ? COLD_SITES.has((transferData.from_warehouse || "").trim().toLowerCase()) : false);
  const boxCount = (transferData?.boxes ?? []).filter((b) => !!b.box_id).length;

  // ── FUNCTION BLOCK: ensurePending (WIRED) ──
  const ensurePending = useCallback(async (): Promise<number> => {
    if (pendingHeaderId) return pendingHeaderId;
    if (!transferData) throw new Error("No transfer loaded.");
    const hdr = await TransferApi.createPendingTransferIn({
      transfer_out_id: transferData.id, grn_number: `GRN-${transferData.challan_no}`,
      receiving_warehouse: transferData.to_warehouse, received_by: receivedBy,
      box_condition: boxCondition, condition_remarks: conditionRemarks,
    });
    setPendingHeaderId(hdr.id);
    if (hdr.boxes?.length) setAcked(new Set(hdr.boxes.map((b) => b.box_id).filter(Boolean) as string[]));
    return hdr.id;
  }, [pendingHeaderId, transferData, receivedBy, boxCondition, conditionRemarks]);

  // ── FUNCTION BLOCK: onAck / onAckAll / onUnack (WIRED) ──
  const onAck = async (e: Entry) => {
    setBusy(true); setError(null);
    try {
      const hid = await ensurePending();
      await TransferApi.acknowledgeBox(hid, toAck(e, true));
      setAcked((p) => new Set(p).add(e.box_id));
      setIssues((p) => { const n = new Map(p); n.delete(e.box_id); return n; });
    } catch (err) { setError(err instanceof Error ? err.message : "Acknowledge failed."); }
    finally { setBusy(false); }
  };
  const onAckAll = async () => {
    setBusy(true); setError(null);
    try {
      const hid = await ensurePending();
      const todo = entries.filter((e) => !acked.has(e.box_id));
      if (todo.length) {
        const res = await TransferApi.acknowledgeBatch(hid, todo.map((e) => toAck(e, true)));
        if (res.conflicts?.length) setError(`${res.conflicts.length} entr(ies) had conflicts.`);
      }
      setAcked(new Set(entries.map((e) => e.box_id)));
    } catch (err) { setError(err instanceof Error ? err.message : "Acknowledge-all failed."); }
    finally { setBusy(false); }
  };
  const onUnack = async (e: Entry) => {
    setBusy(true); setError(null);
    try {
      if (pendingHeaderId) await TransferApi.unacknowledgeBox(pendingHeaderId, e.box_id);
      setAcked((p) => { const n = new Set(p); n.delete(e.box_id); return n; });
      setIssues((p) => { const n = new Map(p); n.delete(e.box_id); return n; });
    } catch (err) { setError(err instanceof Error ? err.message : "Un-acknowledge failed."); }
    finally { setBusy(false); }
  };

  // ── FUNCTION BLOCK: openIssue / submitIssue (WIRED) ──
  const openIssue = (e: Entry) => {
    setDraft(issues.get(e.box_id) || { ...EMPTY_ISSUE, net_weight: String(e.net_weight), gross_weight: String(e.gross_weight) });
    setIssueOpen(e.box_id);
  };
  const submitIssue = async (e: Entry) => {
    setBusy(true); setError(null);
    try {
      const hid = await ensurePending();
      await TransferApi.acknowledgeBox(hid, toAck(e, false, draft));
      setAcked((p) => new Set(p).add(e.box_id));
      setIssues((p) => new Map(p).set(e.box_id, draft));
      setIssueOpen(null);
    } catch (err) { setError(err instanceof Error ? err.message : "Flagging issue failed."); }
    finally { setBusy(false); }
  };

  // ── FUNCTION BLOCK: onConfirm (WIRED) ──
  const onConfirm = async () => {
    setBusy(true); setError(null);
    try {
      const hid = await ensurePending();
      const result = await TransferApi.finalizeTransferIn(hid, { box_condition: boxCondition, condition_remarks: conditionRemarks });
      setDoneGrn(result.grn_number);
      setTimeout(() => router.push("/modules/transfer"), 1800);
    } catch (err) { setError(err instanceof Error ? err.message : "Confirm receipt failed."); }
    finally { setBusy(false); }
  };

  // ── FUNCTION BLOCK: handleReopen (WIRED) ── reverse a Received GRN → Pending
  const handleReopen = async () => {
    if (!receivedHeaderId) return;
    setBusy(true); setError(null);
    try {
      await TransferApi.reopenTransferIn(receivedHeaderId);
      setNotice("Receipt re-opened — stock moved back to in-transit. Re-acknowledge to correct.");
      await doSearch(transferData?.challan_no || transferNumber);
    } catch (e) { setError(e instanceof Error ? e.message : "Re-open failed."); }
    finally { setBusy(false); }
  };

  // ── FUNCTION BLOCK: handleCloseWithShortage (WIRED) ── receive acked boxes, write off the rest
  const handleCloseWithShortage = async () => {
    setBusy(true); setError(null);
    try {
      const hid = await ensurePending();
      const result = await TransferApi.closeTransferInWithShortage(hid, shortageReason || undefined);
      setShowShortage(false);
      setDoneGrn(result.grn_number);
      setTimeout(() => router.push("/modules/transfer"), 1800);
    } catch (e) { setError(e instanceof Error ? e.message : "Close with shortage failed."); }
    finally { setBusy(false); }
  };

  // ── FUNCTION BLOCK: handleEditReceipt (WIRED, header fields) ──
  // Loads the GRN's current header to prefill, then PUTs the edit. Per-box edits
  // are supported by the backend; this dialog exposes the header fields.
  const handleEditOpen = async () => {
    if (!receivedHeaderId) return;
    setBusy(true); setError(null);
    try {
      const g = await TransferApi.getTransferIn(receivedHeaderId);
      setEditForm({ grn_number: g.grn_number || "", box_condition: g.box_condition || "Good", condition_remarks: g.condition_remarks || "" });
      setShowEdit(true);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load the receipt to edit."); }
    finally { setBusy(false); }
  };
  const handleEditSubmit = async () => {
    if (!receivedHeaderId) return;
    setBusy(true); setError(null);
    try {
      await TransferApi.editTransferIn(receivedHeaderId, {
        grn_number: editForm.grn_number || undefined,
        box_condition: editForm.box_condition || undefined,
        condition_remarks: editForm.condition_remarks || undefined,
      });
      setShowEdit(false);
      setNotice("Receipt updated.");
      await doSearch(transferData?.challan_no || transferNumber);
    } catch (e) { setError(e instanceof Error ? e.message : "Edit failed."); }
    finally { setBusy(false); }
  };

  // ── FUNCTION BLOCK: handleScan (camera QR) ── in-memory match → acknowledge.
  // Parses a box_id out of the QR (JSON {bi|box_id} or plain text), matches an expected
  // scanned box, and acknowledges it. Returns true → green bar, false → red bar.
  // (Matching/parsing rules are the part to refine per your "further" note.)
  const onScanDetected = async (text: string): Promise<boolean> => {
    let id = text.trim();
    try { const o = JSON.parse(text); id = String(o.bi ?? o.box_id ?? o.boxId ?? id); } catch { /* plain text */ }
    const entry = entries.find((e) => !e.synthetic && e.box_id === id);
    if (!entry) return false;
    if (!acked.has(entry.box_id)) await onAck(entry);
    return true;
  };

  // No `if (!allowed) return null` gate: useRequireAuth returns true on the server but
  // false on the client's first render, so gating the render on it causes a hydration
  // mismatch. Effects are gated on `allowed`; the hook redirects unauthenticated users.

  const fromName = transferData ? (transferData.from_cold_unit || getDisplayWarehouseName(transferData.from_warehouse) || transferData.from_warehouse) : "";
  const toName = transferData ? (getDisplayWarehouseName(transferData.to_warehouse) || transferData.to_warehouse) : "";
  const isReceived = (transferData?.status || "").toLowerCase() === "received";
  const stateOf = (e: Entry) => issues.has(e.box_id) ? "issue" : acked.has(e.box_id) ? "ok" : "pending";

  return (
    <TransferChrome title="Transfer In (Receive)">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-2 mb-4">
        <div>
          <h1 className="text-[18px] font-semibold text-[var(--text-primary)]">Transfer IN</h1>
          <div className="text-[12px] text-[var(--text-secondary)]">Receive incoming stock transfers</div>
        </div>
        <div className="flex items-center gap-2">
          {canReopen && isReceived && (
            <button onClick={handleReopen} disabled={busy || !receivedHeaderId} className="border border-amber-300 text-amber-700 text-[12px] px-3 py-1.5 rounded hover:bg-amber-50 disabled:opacity-40">Re-open receipt</button>
          )}
          {canReopen && isReceived && (
            <button onClick={handleEditOpen} disabled={busy || !receivedHeaderId} className="border border-[var(--aws-border)] text-[12px] px-3 py-1.5 rounded hover:border-[var(--aws-navy)] disabled:opacity-40">Edit receipt</button>
          )}
          <button onClick={() => router.push("/modules/transfer")} className="text-[12px] text-[var(--text-secondary)] hover:underline">← Back</button>
        </div>
      </div>

      {notice && (
        <div className="mb-3 text-[12px] text-sky-800 bg-sky-50 border border-sky-200 rounded px-3 py-2 flex items-center justify-between">
          <span>{notice}</span><button onClick={() => setNotice(null)} className="text-sky-700">✕</button>
        </div>
      )}

      {error && (
        <div className="mb-3 text-[12px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-3 py-2">{error}</div>
      )}

      {doneGrn ? (
        <div className="py-12 text-center">
          <div className="text-[15px] font-semibold text-emerald-700 mb-1">Receipt confirmed — {doneGrn}</div>
          <div className="text-[12px] text-[var(--text-secondary)]">Stock posted to destination. Returning to the dashboard…</div>
        </div>
      ) : loading && !transferData ? (
        <div className="space-y-3">{[0, 1, 2].map((i) => <div key={i} className="h-24 bg-white border border-[var(--aws-border)] rounded-md animate-pulse" />)}</div>
      ) : !transferData ? (
        <div className="bg-white border border-[var(--aws-border)] rounded-md py-12 text-center">
          <div className="text-[13px] font-medium text-[var(--text-primary)]">No Transfer Loaded</div>
          <div className="text-[12px] text-[var(--text-secondary)] mt-1">Search a dispatched transfer by its challan number to begin receiving.</div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Route */}
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-4 flex flex-wrap items-center gap-3">
            <Chip tone="bg-blue-50 text-blue-800 border border-blue-200">{fromName}</Chip>
            <span className="text-[var(--text-secondary)]">→</span>
            <Chip tone="bg-teal-50 text-teal-800 border border-teal-200">{toName}</Chip>
            <span className="ml-auto text-[11px] px-2 py-0.5 rounded border border-[var(--aws-border)] font-mono">{transferData.challan_no}</span>
            {isCold && <Chip tone="bg-sky-100 text-sky-800">Cold storage</Chip>}
            {pendingHeaderId && <Chip tone="bg-amber-100 text-amber-800">Receiving (GRN #{pendingHeaderId})</Chip>}
          </div>

          {/* Box & Article Acknowledgement */}
          <div className="bg-white border border-[var(--aws-border)] rounded-md">
            <div className="px-4 py-3 border-b border-[var(--aws-border)] flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-[13px] font-semibold text-[var(--text-primary)]">📦 Box &amp; Article Acknowledgement</div>
                <div className="text-[11px] text-[var(--text-secondary)]">{transferData.challan_no} — {boxCount} boxes, {byArticle.length} article(s)</div>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <Chip tone="bg-emerald-50 text-emerald-700 border border-emerald-200">{resolved} resolved</Chip>
                {issueCount > 0 && <Chip tone="bg-rose-50 text-rose-700 border border-rose-200">{issueCount} issue(s)</Chip>}
                {pendingCount > 0 && <Chip tone="bg-amber-50 text-amber-700 border border-amber-200">{pendingCount} pending</Chip>}
              </div>
            </div>
            {!canAcknowledge && (
              <div className="px-4 py-2 text-[11px] text-amber-800 bg-amber-50">You are not authorized to receive transfers — viewing only.</div>
            )}
            {canAcknowledge && (
              <div className="p-3">
                <button onClick={onAckAll} disabled={busy || allResolved}
                  className="w-full py-2 text-[13px] rounded border border-emerald-300 text-emerald-700 hover:bg-emerald-50 disabled:opacity-40">
                  ✓ Acknowledge All ({entries.length})
                </button>
              </div>
            )}
          </div>

          {/* Camera QR scan — opens the device camera with a proportional ROI overlay. */}
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-center">
            <button onClick={() => setShowScanner(true)} disabled={!canAcknowledge}
              className="px-5 py-2 text-[13px] rounded bg-blue-600 text-white hover:opacity-90 disabled:opacity-40">📷 Start Camera Scan</button>
            <div className="text-[11px] text-[var(--text-secondary)] mt-2">Scan QR codes to auto-acknowledge boxes</div>
          </div>

          {/* Article Entries */}
          <div className="bg-white border border-[var(--aws-border)] rounded-md">
            <div className="px-4 py-3 border-b border-[var(--aws-border)] flex flex-wrap items-center justify-between gap-2">
              <span className="text-[13px] font-semibold text-violet-700">📄 Article Entries ({entries.length})</span>
              <div className="flex items-center gap-2">
                <Chip tone="bg-amber-50 text-amber-700 border border-amber-200">{resolved}/{entries.length}</Chip>
                {canAcknowledge && (
                  <button onClick={onAckAll} disabled={busy || allResolved}
                    className="px-2 py-0.5 text-[12px] rounded border border-[var(--aws-border)] hover:border-[var(--aws-navy)] disabled:opacity-40">✓ All</button>
                )}
                {/* FUNCTION BLOCK (TODO): handleGenerateQRs */}
                <button onClick={() => notWired("Generate QR ID's")}
                  className="px-2 py-0.5 text-[12px] rounded border border-violet-300 text-violet-700 hover:bg-violet-50">🖨 Generate QR ID&apos;s</button>
              </div>
            </div>

            {byArticle.map(([article, items]) => {
              const aResolved = items.filter((e) => acked.has(e.box_id)).length;
              return (
                <div key={article} className="border-b border-[var(--aws-border)]/50 last:border-b-0">
                  <div className="px-4 py-2 bg-violet-50/40 flex items-center justify-between gap-2">
                    <span className="text-[12px] font-semibold text-violet-800 truncate max-w-[320px]">{article}</span>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] text-[var(--text-secondary)]">{items.length} boxes</span>
                      <Chip tone="bg-amber-50 text-amber-700 border border-amber-200">{aResolved}/{items.length}</Chip>
                    </div>
                  </div>

                  {/* Desktop table — reference columns */}
                  <div className="hidden md:block overflow-x-auto max-h-[460px]">
                    <table className="w-full text-[12px]">
                      <thead className="sticky top-0 bg-white">
                        <tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]/50">
                          <th className="px-4 py-1.5">SR NO</th><th>ITEM NAME</th><th>TRANSACTION NO</th><th>BOX ID</th>
                          <th className="text-right">CASE PACK</th><th>QTY</th>
                          <th className="text-right">NET WT</th><th className="text-right">TOTAL WT</th><th>LOT</th><th className="text-right pr-4">ACTION</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((e) => {
                          const st = stateOf(e);
                          const iss = issues.get(e.box_id);
                          return (
                            <Fragment key={e.key}>
                              <tr className={`border-b border-[var(--aws-border)]/40 ${st === "ok" ? "bg-emerald-50/40" : st === "issue" ? "bg-rose-50/30" : "hover:bg-gray-50/50"}`}>
                                <td className="px-4 py-1.5 text-center text-[var(--text-secondary)]">{e.sr}</td>
                                <td className="max-w-[220px] truncate">{e.article}</td>
                                <td className="font-mono text-[11px] text-[var(--text-secondary)]">{e.synthetic ? "—" : (e.transaction_no || "—")}</td>
                                <td className="font-mono text-[11px]">{e.synthetic ? "—" : e.box_id}</td>
                                <td className="text-right">{e.case_pack || "—"}</td>
                                <td className="text-blue-700">1 <span className="text-[var(--text-secondary)]">BOX</span></td>
                                <td className={`text-right ${iss?.net_weight ? "text-rose-700 font-medium" : ""}`}>{(iss?.net_weight ? num(iss.net_weight) : e.net_weight).toFixed(3)}</td>
                                <td className={`text-right ${iss?.gross_weight ? "text-rose-700 font-medium" : ""}`}>{(iss?.gross_weight ? num(iss.gross_weight) : e.gross_weight).toFixed(3)}</td>
                                <td className="font-mono text-[11px] text-[var(--text-secondary)]">{e.lot_number || "—"}</td>
                                <td className="text-right pr-4 whitespace-nowrap">
                                  {/* FUNCTION BLOCK (TODO): handlePrintQR */}
                                  <button onClick={() => notWired("Print QR")} className="text-[11px] text-[var(--text-secondary)] underline decoration-dotted mr-2">🖨 Print QR</button>
                                  {!canAcknowledge ? (st !== "pending" ? <span className="text-[var(--text-secondary)]">Done</span> : "—")
                                    : st === "pending" ? (
                                      <>
                                        <button onClick={() => onAck(e)} disabled={busy} className="px-2 py-0.5 text-[11px] rounded border border-[var(--aws-border)] hover:border-[var(--aws-navy)]">Acknowledge</button>
                                        <button onClick={() => openIssue(e)} disabled={busy} className="ml-1 px-2 py-0.5 text-[11px] rounded border border-rose-300 text-rose-700 hover:bg-rose-50">⚠ Issue</button>
                                      </>
                                    ) : (
                                      <>
                                        {st === "issue" && <button onClick={() => openIssue(e)} disabled={busy} className="px-2 py-0.5 text-[11px] rounded border border-rose-300 text-rose-700 hover:bg-rose-50">Edit issue</button>}
                                        <button onClick={() => onUnack(e)} disabled={busy} className="ml-1 text-[11px] text-[var(--text-secondary)] underline decoration-dotted">Undo</button>
                                      </>
                                    )}
                                </td>
                              </tr>
                              {issueOpen === e.box_id && (
                                <tr className="bg-rose-50/60"><td colSpan={10} className="px-4 py-3">
                                  <IssueForm draft={draft} setDraft={setDraft} busy={busy} onCancel={() => setIssueOpen(null)} onSubmit={() => submitIssue(e)} />
                                </td></tr>
                              )}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Mobile cards */}
                  <div className="md:hidden p-3 space-y-2">
                    {items.map((e) => {
                      const st = stateOf(e);
                      const iss = issues.get(e.box_id);
                      return (
                        <div key={e.key} className={`border rounded p-2 ${st === "ok" ? "border-emerald-200 bg-emerald-50/40" : st === "issue" ? "border-rose-200 bg-rose-50/30" : "border-[var(--aws-border)]"}`}>
                          <div className="flex items-center justify-between">
                            <span className="text-[12px] font-medium truncate max-w-[200px]">#{e.sr} {e.article}</span>
                            {st === "ok" ? <Chip tone="bg-emerald-100 text-emerald-800">OK</Chip> : st === "issue" ? <Chip tone="bg-rose-100 text-rose-800">Issue</Chip> : <Chip tone="bg-amber-100 text-amber-800">Pending</Chip>}
                          </div>
                          <div className="text-[11px] text-[var(--text-secondary)] mt-0.5">
                            Case {e.case_pack || "—"} · Net {(iss?.net_weight ? num(iss.net_weight) : e.net_weight).toFixed(3)} · Total {(iss?.gross_weight ? num(iss.gross_weight) : e.gross_weight).toFixed(3)} · Lot {e.lot_number || "—"}
                          </div>
                          {canAcknowledge && (
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              {st === "pending" ? (
                                <>
                                  <button onClick={() => onAck(e)} disabled={busy} className="px-2 py-0.5 text-[11px] rounded border border-[var(--aws-border)]">Acknowledge</button>
                                  <button onClick={() => openIssue(e)} disabled={busy} className="px-2 py-0.5 text-[11px] rounded border border-rose-300 text-rose-700">⚠ Issue</button>
                                </>
                              ) : (
                                <>
                                  {st === "issue" && <button onClick={() => openIssue(e)} disabled={busy} className="px-2 py-0.5 text-[11px] rounded border border-rose-300 text-rose-700">Edit issue</button>}
                                  <button onClick={() => onUnack(e)} disabled={busy} className="px-2 py-0.5 text-[11px] text-[var(--text-secondary)] underline decoration-dotted">Undo</button>
                                </>
                              )}
                              <button onClick={() => notWired("Print QR")} className="px-2 py-0.5 text-[11px] text-[var(--text-secondary)] underline decoration-dotted">🖨 Print QR</button>
                            </div>
                          )}
                          {issueOpen === e.box_id && (
                            <div className="mt-2"><IssueForm draft={draft} setDraft={setDraft} busy={busy} onCancel={() => setIssueOpen(null)} onSubmit={() => submitIssue(e)} /></div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Totals */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-md p-3 text-center border bg-blue-50 border-blue-100 text-blue-700"><div className="text-[18px] font-semibold">{totals.entries}</div><div className="text-[11px] text-[var(--text-secondary)]">Total Entries</div></div>
            <div className="rounded-md p-3 text-center border bg-indigo-50 border-indigo-100 text-indigo-700"><div className="text-[18px] font-semibold">{totals.boxes}</div><div className="text-[11px] text-[var(--text-secondary)]">Scanned Boxes</div></div>
            <div className="rounded-md p-3 text-center border bg-emerald-50 border-emerald-100 text-emerald-700"><div className="text-[18px] font-semibold">{totals.net.toFixed(2)}</div><div className="text-[11px] text-[var(--text-secondary)]">Net Wt (kg)</div></div>
            <div className="rounded-md p-3 text-center border bg-amber-50 border-amber-100 text-amber-700"><div className="text-[18px] font-semibold">{totals.gross.toFixed(2)}</div><div className="text-[11px] text-[var(--text-secondary)]">Gross Wt (kg)</div></div>
          </div>

          {/* Condition Assessment */}
          <div className="bg-white border border-[var(--aws-border)] rounded-md">
            <div className="px-4 py-3 border-b border-[var(--aws-border)] text-[13px] font-semibold text-[var(--text-primary)]">Condition Assessment</div>
            <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <select value={boxCondition} onChange={(e) => setBoxCondition(e.target.value)} className="border border-[var(--aws-border)] rounded px-2 py-1.5 text-[12px]">
                <option>Good</option><option>Damaged</option><option>Partial</option>
              </select>
              <input value={conditionRemarks} onChange={(e) => setConditionRemarks(e.target.value)} placeholder="Condition remarks (optional)…" className="border border-[var(--aws-border)] rounded px-2 py-1.5 text-[12px]" />
            </div>
          </div>

          {/* Confirm */}
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-4 space-y-2">
            <button onClick={onConfirm} disabled={busy || !canAcknowledge || !allResolved}
              className="w-full py-2 text-[13px] rounded bg-emerald-600 text-white disabled:bg-[var(--aws-navy)] disabled:opacity-40">
              {busy ? "Working…" : allResolved ? "Confirm Receipt — All Items Acknowledged" : `Acknowledge all items to continue (${resolved}/${entries.length})`}
            </button>
            {canAcknowledge && pendingHeaderId && resolved > 0 && pendingCount > 0 && (
              <button onClick={() => setShowShortage(true)} disabled={busy}
                className="w-full py-2 text-[13px] rounded border border-amber-300 text-amber-700 hover:bg-amber-50 disabled:opacity-40">
                Close with shortage — write off {pendingCount} un-received
              </button>
            )}
          </div>
        </div>
      )}

      {/* Close-with-shortage dialog */}
      {showShortage && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-md max-w-md w-full p-4">
            <div className="text-[14px] font-semibold text-amber-800 mb-1">Close with shortage</div>
            <p className="text-[12px] text-[var(--text-secondary)] mb-3">
              Receive {resolved} acknowledged item(s) and write off {pendingCount} un-received. The GRN is marked Received.
            </p>
            <input value={shortageReason} onChange={(e) => setShortageReason(e.target.value)}
              placeholder="Shortage reason (optional)…"
              className="w-full border border-[var(--aws-border)] rounded px-2 py-1.5 text-[12px] mb-3" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowShortage(false)} disabled={busy} className="px-3 py-1.5 text-[12px] rounded border border-[var(--aws-border)]">Cancel</button>
              <button onClick={handleCloseWithShortage} disabled={busy} className="px-3 py-1.5 text-[12px] rounded bg-amber-600 text-white disabled:opacity-40">Close &amp; write off {pendingCount}</button>
            </div>
          </div>
        </div>
      )}

      {/* Edit-receipt dialog (header fields; per-box edit is backend-supported) */}
      {showEdit && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-md max-w-md w-full p-4 space-y-3">
            <div className="text-[14px] font-semibold text-[var(--text-primary)]">Edit receipt</div>
            <div>
              <div className="text-[11px] text-[var(--text-secondary)] mb-0.5">GRN Number</div>
              <input value={editForm.grn_number} onChange={(e) => setEditForm({ ...editForm, grn_number: e.target.value })}
                className="w-full border border-[var(--aws-border)] rounded px-2 py-1.5 text-[12px]" />
            </div>
            <div>
              <div className="text-[11px] text-[var(--text-secondary)] mb-0.5">Box Condition</div>
              <select value={editForm.box_condition} onChange={(e) => setEditForm({ ...editForm, box_condition: e.target.value })}
                className="w-full border border-[var(--aws-border)] rounded px-2 py-1.5 text-[12px]">
                <option>Good</option><option>Damaged</option><option>Partial</option>
              </select>
            </div>
            <div>
              <div className="text-[11px] text-[var(--text-secondary)] mb-0.5">Condition Remarks</div>
              <input value={editForm.condition_remarks} onChange={(e) => setEditForm({ ...editForm, condition_remarks: e.target.value })}
                placeholder="Remarks…" className="w-full border border-[var(--aws-border)] rounded px-2 py-1.5 text-[12px]" />
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowEdit(false)} disabled={busy} className="px-3 py-1.5 text-[12px] rounded border border-[var(--aws-border)]">Cancel</button>
              <button onClick={handleEditSubmit} disabled={busy} className="px-3 py-1.5 text-[12px] rounded bg-[var(--aws-navy)] text-white disabled:opacity-40">Save changes</button>
            </div>
          </div>
        </div>
      )}

      {/* Camera scanner (mounted only while open, so closing fully releases the camera) */}
      {showScanner && (
        <QRScanner
          title="Scan box to receive"
          hint="Align the box QR inside the green box to acknowledge it."
          onScan={onScanDetected}
          onClose={() => setShowScanner(false)}
        />
      )}
    </TransferChrome>
  );
}

// jsonb issue may arrive as object or string.
function parseIssueObj(issue: unknown): Record<string, unknown> | null {
  if (!issue) return null;
  if (typeof issue === "string") { try { return JSON.parse(issue); } catch { return null; } }
  return issue as Record<string, unknown>;
}

function IssueForm({ draft, setDraft, busy, onCancel, onSubmit }: {
  draft: IssueData; setDraft: (d: IssueData) => void; busy: boolean; onCancel: () => void; onSubmit: () => void;
}) {
  const field = (label: string, key: keyof IssueData, ph: string) => (
    <div>
      <div className="text-[10px] text-rose-700 mb-0.5">{label}</div>
      <input value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} placeholder={ph}
        className="w-full border border-rose-200 rounded px-2 py-1 text-[12px] bg-white" />
    </div>
  );
  return (
    <div className="space-y-2">
      <div className="text-[11px] font-medium text-rose-700">Report Issue (received quantities differ)</div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {field("Actual Net Wt", "net_weight", "kg")}
        {field("Actual Gross Wt", "gross_weight", "kg")}
        {field("Actual Qty", "qty", "units")}
        {field("Remarks", "remarks", "short / damaged / extra…")}
      </div>
      <div className="flex gap-2">
        <button onClick={onCancel} disabled={busy} className="px-3 py-1 text-[12px] rounded border border-[var(--aws-border)]">Cancel</button>
        <button onClick={onSubmit} disabled={busy} className="px-3 py-1 text-[12px] rounded bg-rose-600 text-white disabled:opacity-40">Submit Issue</button>
      </div>
    </div>
  );
}

export default function TransferInReceivePage() {
  return (
    <Suspense fallback={null}>
      <ReceiveInner />
    </Suspense>
  );
}
