"use client";

// NCR detail page with full lifecycle editing. Uses the [id] dynamic route
// (router param read via useParams<{ id }>(), the same idiom as
// job-card/[id]). The whole NCR is fetched once; every card edits a local
// draft and PATCHes via updateNcr, then re-seeds from the returned NcrDetail.
//
// Cards: header/lot fields, disposition, failed-parameters table, supplier
// CAPA, sign-off — plus a status-transition bar and delete. Edits are gated
// behind a per-card "Edit" toggle (mirrors the inward-inspection editable-
// header idiom) so a stray keystroke never PATCHes the server.

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  type NcrDetail,
  type NcrUpdateBody,
  type FailedParameter,
  type SupplierAction,
  type NcrStatus,
  type NcrDisposition,
  type NcrFinancialAction,
  type NcrSupplierActionType,
  type NcrDeviationType,
  type NcrSeverity,
  type NcrCapaActionType,
  getNcr,
  updateNcr,
  deleteNcr,
} from "@/lib/qc";
import { useRequireAuth } from "@/lib/user";
import { BackLink } from "@/components/BackLink";
import { QcChrome } from "../../_chrome";

// ── Option tables ────────────────────────────────────────────────────────────

const DISPOSITIONS: { value: NcrDisposition; label: string }[] = [
  { value: "rejected", label: "Rejected" },
  { value: "returned", label: "Returned" },
  { value: "accepted_dispensation", label: "Accepted (dispensation)" },
];
const FINANCIAL_ACTIONS: { value: NcrFinancialAction; label: string }[] = [
  { value: "correction", label: "Correction" },
  { value: "credit", label: "Credit" },
  { value: "debit", label: "Debit" },
];
const SUPPLIER_ACTION_TYPES: { value: NcrSupplierActionType; label: string }[] = [
  { value: "info_only", label: "Info only" },
  { value: "investigation_required", label: "Investigation required" },
];
const DEVIATION_TYPES: { value: NcrDeviationType; label: string }[] = [
  { value: "above_max", label: "Above max" },
  { value: "below_min", label: "Below min" },
  { value: "presence", label: "Presence" },
  { value: "absence", label: "Absence" },
];
const SEVERITIES: { value: NcrSeverity; label: string }[] = [
  { value: "critical", label: "Critical" },
  { value: "major", label: "Major" },
  { value: "minor", label: "Minor" },
];
const CAPA_ACTION_TYPES: { value: NcrCapaActionType; label: string }[] = [
  { value: "root_cause", label: "Root cause" },
  { value: "correction", label: "Correction" },
  { value: "preventive", label: "Preventive" },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-IN", {
      day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch { return iso; }
}

function humanize(s: string | null | undefined): string {
  if (!s) return "—";
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// `null` for blank → trims and converts to a Number or null.
function numOrNull(v: string): number | null {
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isNaN(n) ? null : n;
}
function strOrNull(v: string): string | null {
  const t = v.trim();
  return t === "" ? null : t;
}
function asText(v: number | null | undefined): string {
  return v == null ? "" : String(v);
}

// A `YYYY-MM-DD` value for <input type=date> from an ISO/date string.
function dateInputValue(iso: string | null | undefined): string {
  if (!iso) return "";
  // Already date-only?
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// ── Pills ────────────────────────────────────────────────────────────────────

function StatusPill({ status }: { status: string | null }): React.JSX.Element {
  if (!status) return <span className="text-(--text-muted)">—</span>;
  const map: Record<string, { bg: string; fg: string; border: string; label: string }> = {
    open:               { bg: "#eaf0fb", fg: "#2c5fa8", border: "#b3caf0", label: "Open" },
    in_supplier_action: { bg: "#fdf8e1", fg: "#856404", border: "#f0d97a", label: "In Supplier Action" },
    closed:             { bg: "#eaf6ed", fg: "#1a7a3c", border: "#b6dbb1", label: "Closed" },
  };
  const s = map[status] ?? { bg: "#f4f4f4", fg: "#6b7280", border: "#d1d5db", label: humanize(status) };
  return (
    <span
      className="inline-block text-[11px] font-semibold px-2 py-0.5 rounded-sm"
      style={{ background: s.bg, color: s.fg, border: `1px solid ${s.border}` }}
    >
      {s.label}
    </span>
  );
}

function SeverityPill({ severity }: { severity: string | null }): React.JSX.Element | null {
  if (!severity) return null;
  const map: Record<string, { bg: string; fg: string; border: string }> = {
    critical: { bg: "#fdf3f1", fg: "#b1361e", border: "#f0c7be" },
    major:    { bg: "#fdf8e1", fg: "#856404", border: "#f0d97a" },
    minor:    { bg: "#eaf0fb", fg: "#2c5fa8", border: "#b3caf0" },
  };
  const s = map[severity] ?? { bg: "#f4f4f4", fg: "#6b7280", border: "#d1d5db" };
  return (
    <span
      className="inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded-sm uppercase tracking-wide"
      style={{ background: s.bg, color: s.fg, border: `1px solid ${s.border}` }}
    >
      {severity}
    </span>
  );
}

function FoodSafetyBadge(): React.JSX.Element {
  return (
    <span className="inline-block text-[10px] font-bold px-1.5 py-0.5 rounded-sm bg-[#fdf3f1] text-[#b1361e] border border-[#f0c7be] uppercase tracking-wide">
      Food Safety
    </span>
  );
}

// ── Small layout primitives ──────────────────────────────────────────────────

function Card({
  title,
  count,
  actions,
  children,
}: {
  title: string;
  count?: number;
  actions?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="bg-white border border-(--aws-border) rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.1)] overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-(--aws-border) bg-(--surface-subtle)">
        <div className="flex items-center gap-2">
          <h3 className="text-[13px] font-semibold text-(--text-primary)">{title}</h3>
          {count != null ? (
            <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 text-[10px] font-bold rounded-full bg-(--aws-border-strong) text-(--text-secondary)">
              {count}
            </span>
          ) : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex gap-2 py-1.5 border-b border-(--aws-border) last:border-b-0">
      <dt className="w-44 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-(--text-muted)">
        {label}
      </dt>
      <dd className="text-[13px] text-(--text-primary) flex-1 break-words">{children}</dd>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <label className="block text-[11px] font-semibold text-(--text-primary) mb-1">{label}</label>
      {children}
    </div>
  );
}

const INPUT_CLS =
  "w-full h-8 px-2 text-[13px] rounded-[2px] border border-(--aws-border-strong) bg-white outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]";

function EditBtn({ editing, onClick }: { editing: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-7 px-3 text-[12px] rounded-[2px] border border-(--aws-border-strong) bg-white hover:border-(--aws-navy) text-(--text-primary)"
    >
      {editing ? "Cancel" : "Edit"}
    </button>
  );
}

function SaveBtn({ busy, onClick, disabled }: { busy: boolean; onClick: () => void; disabled?: boolean }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      className="h-7 px-4 text-[12px] rounded-[2px] border border-(--aws-orange) bg-(--aws-orange) text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
    >
      {busy ? <span className="inline-block w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" /> : null}
      Save
    </button>
  );
}

function Spinner({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-(--text-secondary)">
      <span className="inline-block w-4 h-4 border-2 border-(--aws-border-strong) border-t-(--aws-orange) rounded-full animate-spin" />
      {label}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function NcrDetailPage(): React.JSX.Element {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);
  const params = useParams<{ id: string }>();
  const ncrId = Number(params?.id);

  const [mounted, setMounted] = useState(false);
  useEffect(() => { queueMicrotask(() => setMounted(true)); }, []);

  const [detail, setDetail] = useState<NcrDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchNonce, setFetchNonce] = useState(0);

  // Page-level banner (status transitions, delete errors).
  const [banner, setBanner] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!Number.isFinite(ncrId)) return;
    const ctrl = new AbortController();
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const d = await getNcr(ncrId, ctrl.signal);
        if (ctrl.signal.aborted) return;
        setDetail(d);
      } catch (e) {
        if (ctrl.signal.aborted) return;
        if (e instanceof Error && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Failed to load NCR");
        setDetail(null);
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    })();
    return () => ctrl.abort();
  }, [ncrId, fetchNonce]);

  function applyUpdated(d: NcrDetail) {
    setDetail(d);
    setFetchNonce((n) => n + 1); // keep derived child drafts in step on next mount
  }

  // ── Loading / error shells ─────────────────────────────────────────────────
  if (!mounted) {
    return (
      <QcChrome title="NCR">
        <div className="bg-white border border-(--aws-border) rounded-md p-10 text-center text-(--text-secondary)">
          <Spinner label="Loading…" />
        </div>
      </QcChrome>
    );
  }
  if (!authed) return <></>;

  if (loading && !detail) {
    return (
      <QcChrome title="NCR">
        <div className="mb-3"><BackLink parentHref="/modules/qc/ncr" label="NCR list" /></div>
        <div className="bg-white border border-(--aws-border) rounded-md"><Spinner label="Loading NCR…" /></div>
      </QcChrome>
    );
  }
  if (error && !detail) {
    return (
      <QcChrome title="NCR">
        <div className="mb-3"><BackLink parentHref="/modules/qc/ncr" label="NCR list" /></div>
        <div className="bg-white border border-(--aws-border) rounded-md p-6">
          <p className="text-[13px] text-(--aws-error)">{error}</p>
        </div>
      </QcChrome>
    );
  }
  if (!detail) {
    return (
      <QcChrome title="NCR">
        <div className="mb-3"><BackLink parentHref="/modules/qc/ncr" label="NCR list" /></div>
        <div className="bg-white border border-(--aws-border) rounded-md p-6 text-[13px] text-(--text-secondary)">NCR not found.</div>
      </QcChrome>
    );
  }

  return (
    <QcChrome title="NCR">
      <div className="mb-3"><BackLink parentHref="/modules/qc/ncr" label="NCR list" /></div>

      {banner ? (
        <div
          className={[
            "mb-3 px-3 py-2 text-[13px] rounded-[2px] border flex items-center justify-between",
            banner.kind === "ok"
              ? "bg-[#eaf6ed] border-[#b6dbb1] text-(--text-success)"
              : "bg-[#fdf3f1] border-[#f0c7be] text-[#b1361e]",
          ].join(" ")}
        >
          <span>{banner.text}</span>
          <button type="button" onClick={() => setBanner(null)} aria-label="Dismiss" className="ml-4 text-(--text-muted) hover:text-(--text-primary)">✕</button>
        </div>
      ) : null}

      <div className="space-y-4">
        <HeaderCard detail={detail} />
        <StatusBar
          detail={detail}
          onUpdated={applyUpdated}
          onBanner={setBanner}
          onDeleted={() => router.push("/modules/qc/ncr")}
        />
        <LotHeaderCard key={`lot-${fetchNonce}`} detail={detail} onUpdated={applyUpdated} onBanner={setBanner} />
        <DispositionCard key={`disp-${fetchNonce}`} detail={detail} onUpdated={applyUpdated} onBanner={setBanner} />
        <FailedParamsCard key={`fp-${fetchNonce}`} detail={detail} onUpdated={applyUpdated} onBanner={setBanner} />
        <SupplierCapaCard key={`capa-${fetchNonce}`} detail={detail} onUpdated={applyUpdated} onBanner={setBanner} />
        <SignOffCard key={`sign-${fetchNonce}`} detail={detail} onUpdated={applyUpdated} onBanner={setBanner} />
        <RollupCard detail={detail} />
      </div>
    </QcChrome>
  );
}

// ── Shared props ─────────────────────────────────────────────────────────────

interface CardProps {
  detail: NcrDetail;
  onUpdated: (d: NcrDetail) => void;
  onBanner: (b: { kind: "ok" | "err"; text: string } | null) => void;
}

// ── Header card ──────────────────────────────────────────────────────────────

function HeaderCard({ detail }: { detail: NcrDetail }): React.JSX.Element {
  return (
    <div className="bg-white border border-(--aws-border) rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.1)] px-4 py-3">
      <div className="flex flex-wrap items-center gap-3 mb-2">
        <span className="font-mono text-[14px] font-semibold text-(--text-primary)">
          {detail.ncr_no ?? `#${detail.ncr_id}`}
        </span>
        <StatusPill status={detail.status} />
        <SeverityPill severity={detail.severity_rollup} />
        {detail.food_safety_flag ? <FoodSafetyBadge /> : null}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-(--text-secondary)">
        {detail.transaction_no ? (
          <span>Txn: <span className="font-mono font-medium text-(--text-primary)">{detail.transaction_no}</span></span>
        ) : null}
        {detail.supplier_name || detail.supplier_id != null ? (
          <span>
            Supplier: <span className="font-medium text-(--text-primary)">{detail.supplier_name ?? `#${detail.supplier_id}`}</span>
          </span>
        ) : null}
        {detail.product_description ? (
          <span>Product: <span className="font-medium text-(--text-primary)">{detail.product_description}</span></span>
        ) : null}
        <span>Created: <span className="font-medium text-(--text-primary)">{fmtDate(detail.created_at)}</span></span>
      </div>
    </div>
  );
}

// ── Status-transition bar + delete ───────────────────────────────────────────

function StatusBar({
  detail,
  onUpdated,
  onBanner,
  onDeleted,
}: CardProps & { onDeleted: () => void }): React.JSX.Element {
  const [busy, setBusy] = useState<NcrStatus | "delete" | null>(null);

  async function transition(status: NcrStatus) {
    setBusy(status);
    onBanner(null);
    try {
      const d = await updateNcr(detail.ncr_id, { status });
      onUpdated(d);
      onBanner({ kind: "ok", text: `Status changed to ${humanize(status)}.` });
    } catch (e) {
      onBanner({ kind: "err", text: e instanceof Error ? e.message : "Status change failed" });
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete() {
    if (!window.confirm("Delete this NCR permanently? This cannot be undone.")) return;
    setBusy("delete");
    onBanner(null);
    try {
      await deleteNcr(detail.ncr_id);
      onDeleted();
    } catch (e) {
      onBanner({ kind: "err", text: e instanceof Error ? e.message : "Delete failed" });
      setBusy(null);
    }
  }

  const status = detail.status ?? "";

  return (
    <div className="flex flex-wrap gap-2 items-center">
      {status === "open" ? (
        <TransitionBtn label="→ In Supplier Action" busy={busy === "in_supplier_action"} onClick={() => void transition("in_supplier_action")} variant="primary" />
      ) : null}
      {status === "in_supplier_action" ? (
        <>
          <TransitionBtn label="← Re-open" busy={busy === "open"} onClick={() => void transition("open")} />
          <TransitionBtn label="→ Close" busy={busy === "closed"} onClick={() => void transition("closed")} variant="primary" />
        </>
      ) : null}
      {status === "closed" ? (
        <TransitionBtn label="← Re-open" busy={busy === "open"} onClick={() => void transition("open")} />
      ) : null}

      <div className="flex-1" />

      <button
        type="button"
        onClick={() => void handleDelete()}
        disabled={busy != null}
        className="h-8 px-3 text-[12px] rounded-[2px] border border-[#b1361e] bg-white text-[#b1361e] hover:bg-[#fdf3f1] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
      >
        {busy === "delete" ? <span className="inline-block w-3 h-3 border-2 border-[#b1361e]/40 border-t-[#b1361e] rounded-full animate-spin" /> : null}
        Delete NCR
      </button>
    </div>
  );
}

function TransitionBtn({
  label,
  busy,
  onClick,
  variant = "default",
}: {
  label: string;
  busy: boolean;
  onClick: () => void;
  variant?: "default" | "primary";
}): React.JSX.Element {
  const cls =
    variant === "primary"
      ? "border-(--aws-orange) bg-(--aws-orange) text-white hover:opacity-90"
      : "border-(--aws-border-strong) bg-white text-(--text-primary) hover:border-(--aws-navy)";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={["h-8 px-3 text-[12px] rounded-[2px] border font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2", cls].join(" ")}
    >
      {busy ? <span className="inline-block w-3 h-3 border-2 border-(--aws-border-strong) border-t-(--aws-orange) rounded-full animate-spin" /> : null}
      {label}
    </button>
  );
}

// ── Lot / header fields card ─────────────────────────────────────────────────

function LotHeaderCard({ detail, onUpdated, onBanner }: CardProps): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const [supplierName, setSupplierName] = useState(detail.supplier_name ?? "");
  const [otherParty, setOtherParty] = useState(detail.other_party ?? "");
  const [invoiceRef, setInvoiceRef] = useState(detail.invoice_challan_ref ?? "");
  const [batchNo, setBatchNo] = useState(detail.batch_no ?? "");
  const [transactionNo, setTransactionNo] = useState(detail.transaction_no ?? "");
  const [lineNumber, setLineNumber] = useState(asText(detail.line_number));
  const [productDescription, setProductDescription] = useState(detail.product_description ?? "");
  const [rcNo, setRcNo] = useState(detail.rc_no ?? "");
  const [quantity, setQuantity] = useState(asText(detail.quantity));
  const [reason, setReason] = useState(detail.reason_nonconformity ?? "");
  const [foodSafety, setFoodSafety] = useState(detail.food_safety_flag);
  const [documentedDate, setDocumentedDate] = useState(dateInputValue(detail.documented_date));

  async function save() {
    setBusy(true);
    onBanner(null);
    const body: NcrUpdateBody = {
      supplier_name: strOrNull(supplierName),
      other_party: strOrNull(otherParty),
      invoice_challan_ref: strOrNull(invoiceRef),
      batch_no: strOrNull(batchNo),
      transaction_no: strOrNull(transactionNo),
      line_number: numOrNull(lineNumber),
      product_description: strOrNull(productDescription),
      rc_no: strOrNull(rcNo),
      quantity: numOrNull(quantity),
      reason_nonconformity: strOrNull(reason),
      food_safety_flag: foodSafety,
      documented_date: documentedDate || null,
    };
    try {
      const d = await updateNcr(detail.ncr_id, body);
      onUpdated(d);
      setEditing(false);
      onBanner({ kind: "ok", text: "Lot / header fields saved." });
    } catch (e) {
      onBanner({ kind: "err", text: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Lot / header"
      actions={
        editing ? (
          <>
            <EditBtn editing onClick={() => setEditing(false)} />
            <SaveBtn busy={busy} onClick={() => void save()} />
          </>
        ) : (
          <EditBtn editing={false} onClick={() => setEditing(true)} />
        )
      }
    >
      {editing ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Supplier name"><input type="text" value={supplierName} onChange={(e) => setSupplierName(e.target.value)} className={INPUT_CLS} /></Field>
          <Field label="Other party"><input type="text" value={otherParty} onChange={(e) => setOtherParty(e.target.value)} className={INPUT_CLS} /></Field>
          <Field label="Invoice / challan ref"><input type="text" value={invoiceRef} onChange={(e) => setInvoiceRef(e.target.value)} className={INPUT_CLS} /></Field>
          <Field label="Batch no"><input type="text" value={batchNo} onChange={(e) => setBatchNo(e.target.value)} className={INPUT_CLS} /></Field>
          <Field label="Transaction no"><input type="text" value={transactionNo} onChange={(e) => setTransactionNo(e.target.value)} className={INPUT_CLS} /></Field>
          <Field label="Line number"><input type="number" value={lineNumber} onChange={(e) => setLineNumber(e.target.value)} className={INPUT_CLS} /></Field>
          <Field label="RC no"><input type="text" value={rcNo} onChange={(e) => setRcNo(e.target.value)} className={INPUT_CLS} /></Field>
          <Field label="Quantity"><input type="number" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} className={INPUT_CLS} /></Field>
          <Field label="Documented date"><input type="date" value={documentedDate} onChange={(e) => setDocumentedDate(e.target.value)} className={INPUT_CLS} /></Field>
          <div className="sm:col-span-2">
            <Field label="Product description"><input type="text" value={productDescription} onChange={(e) => setProductDescription(e.target.value)} className={INPUT_CLS} /></Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Reason for non-conformity">
              <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} className="w-full px-2 py-1.5 text-[13px] rounded-[2px] border border-(--aws-border-strong) outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] resize-y" />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-[13px] text-(--text-primary) cursor-pointer sm:col-span-2">
            <input type="checkbox" checked={foodSafety} onChange={(e) => setFoodSafety(e.target.checked)} className="w-4 h-4 accent-[#b1361e]" />
            Food-safety related
          </label>
        </div>
      ) : (
        <dl className="divide-y divide-(--aws-border)">
          <InfoRow label="Supplier name">{detail.supplier_name ?? "—"}</InfoRow>
          <InfoRow label="Other party">{detail.other_party ?? "—"}</InfoRow>
          <InfoRow label="Invoice / challan ref">{detail.invoice_challan_ref ?? "—"}</InfoRow>
          <InfoRow label="Batch no">{detail.batch_no ?? "—"}</InfoRow>
          <InfoRow label="Transaction no"><span className="font-mono">{detail.transaction_no ?? "—"}</span></InfoRow>
          <InfoRow label="Line number">{detail.line_number ?? "—"}</InfoRow>
          <InfoRow label="Product description">{detail.product_description ?? "—"}</InfoRow>
          <InfoRow label="RC no">{detail.rc_no ?? "—"}</InfoRow>
          <InfoRow label="Quantity">{detail.quantity ?? "—"}</InfoRow>
          <InfoRow label="Reason">{detail.reason_nonconformity ?? "—"}</InfoRow>
          <InfoRow label="Food safety">{detail.food_safety_flag ? <FoodSafetyBadge /> : "No"}</InfoRow>
          <InfoRow label="Documented date">{fmtDate(detail.documented_date)}</InfoRow>
        </dl>
      )}
    </Card>
  );
}

// ── Disposition card ─────────────────────────────────────────────────────────

function DispositionCard({ detail, onUpdated, onBanner }: CardProps): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const [disposition, setDisposition] = useState(detail.disposition ?? "");
  const [financialAction, setFinancialAction] = useState(detail.financial_action ?? "");
  const [supplierActionType, setSupplierActionType] = useState(detail.supplier_action_type ?? "");
  const [targetDate, setTargetDate] = useState(dateInputValue(detail.target_completion_date));

  async function save() {
    setBusy(true);
    onBanner(null);
    const body: NcrUpdateBody = {
      disposition: disposition !== "" ? (disposition as NcrDisposition) : null,
      financial_action: financialAction !== "" ? (financialAction as NcrFinancialAction) : null,
      supplier_action_type: supplierActionType !== "" ? (supplierActionType as NcrSupplierActionType) : null,
      target_completion_date: targetDate || null,
    };
    try {
      const d = await updateNcr(detail.ncr_id, body);
      onUpdated(d);
      setEditing(false);
      onBanner({ kind: "ok", text: "Disposition saved." });
    } catch (e) {
      onBanner({ kind: "err", text: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Disposition"
      actions={
        editing ? (
          <>
            <EditBtn editing onClick={() => setEditing(false)} />
            <SaveBtn busy={busy} onClick={() => void save()} />
          </>
        ) : (
          <EditBtn editing={false} onClick={() => setEditing(true)} />
        )
      }
    >
      {editing ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Disposition">
            <select value={disposition} onChange={(e) => setDisposition(e.target.value)} className={INPUT_CLS}>
              <option value="">— none —</option>
              {DISPOSITIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
          </Field>
          <Field label="Financial action">
            <select value={financialAction} onChange={(e) => setFinancialAction(e.target.value)} className={INPUT_CLS}>
              <option value="">— none —</option>
              {FINANCIAL_ACTIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
          </Field>
          <Field label="Supplier action type">
            <select value={supplierActionType} onChange={(e) => setSupplierActionType(e.target.value)} className={INPUT_CLS}>
              <option value="">— none —</option>
              {SUPPLIER_ACTION_TYPES.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
          </Field>
          <Field label="Target completion date">
            <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} className={INPUT_CLS} />
          </Field>
        </div>
      ) : (
        <dl className="divide-y divide-(--aws-border)">
          <InfoRow label="Disposition">{humanize(detail.disposition)}</InfoRow>
          <InfoRow label="Financial action">{humanize(detail.financial_action)}</InfoRow>
          <InfoRow label="Supplier action type">{humanize(detail.supplier_action_type)}</InfoRow>
          <InfoRow label="Target completion">{fmtDate(detail.target_completion_date)}</InfoRow>
        </dl>
      )}
    </Card>
  );
}

// ── Failed-parameters card ───────────────────────────────────────────────────

function emptyFailedParam(): FailedParameter {
  return {
    param_code: "",
    spec_value: null,
    actual_value: null,
    deviation_type: null,
    severity: null,
    quantity_impacted_kg: null,
    disposition: "",
  };
}

function FailedParamsCard({ detail, onUpdated, onBanner }: CardProps): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<FailedParameter[]>(detail.failed_parameters);

  function patchRow(i: number, patch: Partial<FailedParameter>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRow() { setRows((prev) => [...prev, emptyFailedParam()]); }
  function removeRow(i: number) { setRows((prev) => prev.filter((_, idx) => idx !== i)); }

  function startEdit() {
    setRows(detail.failed_parameters);
    setEditing(true);
  }

  async function save() {
    setBusy(true);
    onBanner(null);
    const cleaned: FailedParameter[] = rows.map((r) => ({
      param_code: strOrNull(r.param_code ?? ""),
      spec_value: r.spec_value ?? null,
      actual_value: r.actual_value ?? null,
      deviation_type: r.deviation_type ?? null,
      severity: r.severity ?? null,
      quantity_impacted_kg: r.quantity_impacted_kg ?? null,
      disposition: strOrNull(r.disposition ?? ""),
    }));
    try {
      const d = await updateNcr(detail.ncr_id, { failed_parameters: cleaned });
      onUpdated(d);
      setEditing(false);
      onBanner({ kind: "ok", text: "Failed parameters saved." });
    } catch (e) {
      onBanner({ kind: "err", text: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Failed parameters"
      count={editing ? rows.length : detail.failed_parameters.length}
      actions={
        editing ? (
          <>
            <button type="button" onClick={addRow} className="h-7 px-3 text-[12px] rounded-[2px] border border-(--aws-border-strong) bg-white hover:border-(--aws-navy) text-(--text-primary)">+ Row</button>
            <EditBtn editing onClick={() => setEditing(false)} />
            <SaveBtn busy={busy} onClick={() => void save()} />
          </>
        ) : (
          <EditBtn editing={false} onClick={startEdit} />
        )
      }
    >
      {!editing ? (
        detail.failed_parameters.length === 0 ? (
          <p className="text-[13px] text-(--text-secondary) italic">No failed parameters recorded.</p>
        ) : (
          <div className="overflow-x-auto rounded-[2px] border border-(--aws-border)">
            <table className="w-full text-[12px] border-collapse">
              <thead className="bg-(--surface-subtle)">
                <tr className="border-b border-(--aws-border)">
                  <FpTh>Param</FpTh><FpTh>Spec</FpTh><FpTh>Actual</FpTh><FpTh>Deviation</FpTh><FpTh>Severity</FpTh><FpTh>Qty impacted (kg)</FpTh><FpTh>Disposition</FpTh>
                </tr>
              </thead>
              <tbody>
                {detail.failed_parameters.map((r, i) => (
                  <tr key={i} className="border-b border-(--aws-border) last:border-b-0">
                    <td className="px-3 py-2 font-mono">{r.param_code ?? "—"}</td>
                    <td className="px-3 py-2 font-mono">{r.spec_value ?? "—"}</td>
                    <td className="px-3 py-2 font-mono">{r.actual_value ?? "—"}</td>
                    <td className="px-3 py-2">{humanize(r.deviation_type)}</td>
                    <td className="px-3 py-2">{r.severity ? <SeverityPill severity={r.severity} /> : "—"}</td>
                    <td className="px-3 py-2 font-mono">{r.quantity_impacted_kg ?? "—"}</td>
                    <td className="px-3 py-2">{r.disposition ? humanize(r.disposition) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : rows.length === 0 ? (
        <p className="text-[13px] text-(--text-secondary) italic">No rows. Use “+ Row” to add a failed parameter.</p>
      ) : (
        <div className="space-y-3">
          {rows.map((r, i) => (
            <div key={i} className="border border-(--aws-border) rounded-[2px] p-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
              <Field label="Param code"><input type="text" value={r.param_code ?? ""} onChange={(e) => patchRow(i, { param_code: e.target.value })} className={INPUT_CLS} /></Field>
              <Field label="Spec value"><input type="number" step="any" value={asText(r.spec_value)} onChange={(e) => patchRow(i, { spec_value: numOrNull(e.target.value) })} className={INPUT_CLS} /></Field>
              <Field label="Actual value"><input type="number" step="any" value={asText(r.actual_value)} onChange={(e) => patchRow(i, { actual_value: numOrNull(e.target.value) })} className={INPUT_CLS} /></Field>
              <Field label="Qty impacted (kg)"><input type="number" step="any" value={asText(r.quantity_impacted_kg)} onChange={(e) => patchRow(i, { quantity_impacted_kg: numOrNull(e.target.value) })} className={INPUT_CLS} /></Field>
              <Field label="Deviation type">
                <select value={r.deviation_type ?? ""} onChange={(e) => patchRow(i, { deviation_type: e.target.value ? (e.target.value as NcrDeviationType) : null })} className={INPUT_CLS}>
                  <option value="">—</option>
                  {DEVIATION_TYPES.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                </select>
              </Field>
              <Field label="Severity">
                <select value={r.severity ?? ""} onChange={(e) => patchRow(i, { severity: e.target.value ? (e.target.value as NcrSeverity) : null })} className={INPUT_CLS}>
                  <option value="">—</option>
                  {SEVERITIES.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                </select>
              </Field>
              <Field label="Disposition"><input type="text" value={r.disposition ?? ""} onChange={(e) => patchRow(i, { disposition: e.target.value })} className={INPUT_CLS} /></Field>
              <div className="flex items-end">
                <button type="button" onClick={() => removeRow(i)} className="h-8 px-3 text-[12px] rounded-[2px] border border-[#b1361e] bg-white text-[#b1361e] hover:bg-[#fdf3f1]">Remove</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function FpTh({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-(--text-secondary) whitespace-nowrap">{children}</th>;
}

// ── Supplier CAPA card ───────────────────────────────────────────────────────

function emptySupplierAction(): SupplierAction {
  return {
    action_type: null,
    description: "",
    responsible_party: "",
    target_date: null,
    actual_closure_date: null,
    evidence_file_url: "",
    is_effective: null,
  };
}

function SupplierCapaCard({ detail, onUpdated, onBanner }: CardProps): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<SupplierAction[]>(detail.supplier_actions);

  function patchRow(i: number, patch: Partial<SupplierAction>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRow() { setRows((prev) => [...prev, emptySupplierAction()]); }
  function removeRow(i: number) { setRows((prev) => prev.filter((_, idx) => idx !== i)); }
  function startEdit() { setRows(detail.supplier_actions); setEditing(true); }

  async function save() {
    setBusy(true);
    onBanner(null);
    const cleaned: SupplierAction[] = rows.map((r) => ({
      // Preserve fields the form doesn't render (verified_by, verification_date)
      // so editing a CAPA row never strips them on round-trip.
      ...r,
      action_type: r.action_type ?? null,
      description: strOrNull(r.description ?? ""),
      responsible_party: strOrNull(r.responsible_party ?? ""),
      target_date: r.target_date || null,
      actual_closure_date: r.actual_closure_date || null,
      evidence_file_url: strOrNull(r.evidence_file_url ?? ""),
      is_effective: r.is_effective ?? null,
    }));
    try {
      const d = await updateNcr(detail.ncr_id, { supplier_actions: cleaned });
      onUpdated(d);
      setEditing(false);
      onBanner({ kind: "ok", text: "Supplier CAPA saved." });
    } catch (e) {
      onBanner({ kind: "err", text: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Supplier CAPA"
      count={editing ? rows.length : detail.supplier_actions.length}
      actions={
        editing ? (
          <>
            <button type="button" onClick={addRow} className="h-7 px-3 text-[12px] rounded-[2px] border border-(--aws-border-strong) bg-white hover:border-(--aws-navy) text-(--text-primary)">+ Action</button>
            <EditBtn editing onClick={() => setEditing(false)} />
            <SaveBtn busy={busy} onClick={() => void save()} />
          </>
        ) : (
          <EditBtn editing={false} onClick={startEdit} />
        )
      }
    >
      {!editing ? (
        detail.supplier_actions.length === 0 ? (
          <p className="text-[13px] text-(--text-secondary) italic">No supplier corrective actions recorded.</p>
        ) : (
          <div className="space-y-3">
            {detail.supplier_actions.map((r, i) => (
              <div key={i} className="border border-(--aws-border) rounded-[2px] p-3">
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <span className="text-[13px] font-semibold text-(--text-primary)">{humanize(r.action_type)}</span>
                  {r.is_effective != null ? (
                    <span
                      className="inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded-sm"
                      style={r.is_effective
                        ? { background: "#eaf6ed", color: "#1a7a3c", border: "1px solid #b6dbb1" }
                        : { background: "#fdf3f1", color: "#b1361e", border: "1px solid #f0c7be" }}
                    >
                      {r.is_effective ? "Effective" : "Not effective"}
                    </span>
                  ) : null}
                </div>
                {r.description ? <p className="text-[13px] text-(--text-primary)">{r.description}</p> : null}
                <div className="mt-1 text-[11px] text-(--text-muted) flex flex-wrap gap-x-3 gap-y-0.5">
                  {r.responsible_party ? <span>Owner: {r.responsible_party}</span> : null}
                  {r.target_date ? <span>Target: {fmtDate(r.target_date)}</span> : null}
                  {r.actual_closure_date ? <span>Closed: {fmtDate(r.actual_closure_date)}</span> : null}
                  {r.evidence_file_url ? (
                    <a href={r.evidence_file_url} target="_blank" rel="noopener noreferrer" className="text-(--aws-link) hover:underline">Evidence</a>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )
      ) : rows.length === 0 ? (
        <p className="text-[13px] text-(--text-secondary) italic">No actions. Use “+ Action” to add a CAPA entry.</p>
      ) : (
        <div className="space-y-3">
          {rows.map((r, i) => (
            <div key={i} className="border border-(--aws-border) rounded-[2px] p-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
              <Field label="Action type">
                <select value={r.action_type ?? ""} onChange={(e) => patchRow(i, { action_type: e.target.value ? (e.target.value as NcrCapaActionType) : null })} className={INPUT_CLS}>
                  <option value="">—</option>
                  {CAPA_ACTION_TYPES.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                </select>
              </Field>
              <Field label="Responsible party"><input type="text" value={r.responsible_party ?? ""} onChange={(e) => patchRow(i, { responsible_party: e.target.value })} className={INPUT_CLS} /></Field>
              <Field label="Target date"><input type="date" value={dateInputValue(r.target_date)} onChange={(e) => patchRow(i, { target_date: e.target.value || null })} className={INPUT_CLS} /></Field>
              <Field label="Actual closure date"><input type="date" value={dateInputValue(r.actual_closure_date)} onChange={(e) => patchRow(i, { actual_closure_date: e.target.value || null })} className={INPUT_CLS} /></Field>
              <div className="sm:col-span-2">
                <Field label="Description"><textarea rows={2} value={r.description ?? ""} onChange={(e) => patchRow(i, { description: e.target.value })} className="w-full px-2 py-1.5 text-[13px] rounded-[2px] border border-(--aws-border-strong) outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] resize-y" /></Field>
              </div>
              <div className="sm:col-span-2">
                <Field label="Evidence file URL"><input type="text" value={r.evidence_file_url ?? ""} onChange={(e) => patchRow(i, { evidence_file_url: e.target.value })} className={INPUT_CLS} /></Field>
              </div>
              <label className="flex items-center gap-2 text-[13px] text-(--text-primary) cursor-pointer">
                <input type="checkbox" checked={r.is_effective === true} onChange={(e) => patchRow(i, { is_effective: e.target.checked })} className="w-4 h-4 accent-[#1a7a3c]" />
                Effective
              </label>
              <div className="flex items-end justify-end">
                <button type="button" onClick={() => removeRow(i)} className="h-8 px-3 text-[12px] rounded-[2px] border border-[#b1361e] bg-white text-[#b1361e] hover:bg-[#fdf3f1]">Remove</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ── Sign-off card ────────────────────────────────────────────────────────────

function SignOffCard({ detail, onUpdated, onBanner }: CardProps): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const [authorizedPerson, setAuthorizedPerson] = useState(asText(detail.authorized_person));
  const [authorizedDate, setAuthorizedDate] = useState(dateInputValue(detail.authorized_date));
  const [receivedBy, setReceivedBy] = useState(asText(detail.received_by));
  const [receivedDate, setReceivedDate] = useState(dateInputValue(detail.received_date));
  const [approvedBy, setApprovedBy] = useState(asText(detail.approved_by));

  async function save() {
    setBusy(true);
    onBanner(null);
    const body: NcrUpdateBody = {
      authorized_person: numOrNull(authorizedPerson),
      authorized_date: authorizedDate || null,
      received_by: numOrNull(receivedBy),
      received_date: receivedDate || null,
      approved_by: numOrNull(approvedBy),
    };
    try {
      const d = await updateNcr(detail.ncr_id, body);
      onUpdated(d);
      setEditing(false);
      onBanner({ kind: "ok", text: "Sign-off saved." });
    } catch (e) {
      onBanner({ kind: "err", text: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Sign-off"
      actions={
        editing ? (
          <>
            <EditBtn editing onClick={() => setEditing(false)} />
            <SaveBtn busy={busy} onClick={() => void save()} />
          </>
        ) : (
          <EditBtn editing={false} onClick={() => setEditing(true)} />
        )
      }
    >
      {editing ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Authorized person (user ID)"><input type="number" value={authorizedPerson} onChange={(e) => setAuthorizedPerson(e.target.value)} className={INPUT_CLS} /></Field>
          <Field label="Authorized date"><input type="date" value={authorizedDate} onChange={(e) => setAuthorizedDate(e.target.value)} className={INPUT_CLS} /></Field>
          <Field label="Received by (user ID)"><input type="number" value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} className={INPUT_CLS} /></Field>
          <Field label="Received date"><input type="date" value={receivedDate} onChange={(e) => setReceivedDate(e.target.value)} className={INPUT_CLS} /></Field>
          <Field label="Approved by (user ID)"><input type="number" value={approvedBy} onChange={(e) => setApprovedBy(e.target.value)} className={INPUT_CLS} /></Field>
        </div>
      ) : (
        <dl className="divide-y divide-(--aws-border)">
          <InfoRow label="Authorized person">{detail.authorized_person ?? "—"}</InfoRow>
          <InfoRow label="Authorized date">{fmtDate(detail.authorized_date)}</InfoRow>
          <InfoRow label="Received by">{detail.received_by ?? "—"}</InfoRow>
          <InfoRow label="Received date">{fmtDate(detail.received_date)}</InfoRow>
          <InfoRow label="Approved by">{detail.approved_by ?? "—"}</InfoRow>
        </dl>
      )}
    </Card>
  );
}

// ── Roll-up / read-only metrics card ─────────────────────────────────────────

function RollupCard({ detail }: { detail: NcrDetail }): React.JSX.Element | null {
  const hasAny =
    detail.ncr_category != null ||
    detail.closure_tat_days != null ||
    detail.financial_impact_inr != null;
  if (!hasAny) return null;
  return (
    <Card title="Roll-up">
      <dl className="divide-y divide-(--aws-border)">
        {detail.ncr_category != null ? <InfoRow label="Category">{humanize(detail.ncr_category)}</InfoRow> : null}
        {detail.closure_tat_days != null ? <InfoRow label="Closure TAT (days)">{detail.closure_tat_days}</InfoRow> : null}
        {detail.financial_impact_inr != null ? (
          <InfoRow label="Financial impact (INR)">
            {detail.financial_impact_inr.toLocaleString("en-IN")}
          </InfoRow>
        ) : null}
      </dl>
    </Card>
  );
}
