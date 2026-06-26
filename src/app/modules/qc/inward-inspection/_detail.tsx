"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  type InspectionDetail,
  type AuditEvent,
  type Reading,
  getInspection,
  getInspectionAudit,
} from "@/lib/qc";
import { useIsQcManager } from "@/lib/user";
import { AddReadingsModal } from "./_modals/AddReadingsModal";
import { EditReadingModal } from "./_modals/EditReadingModal";
import { DeleteReadingModal } from "./_modals/DeleteReadingModal";
import { SetVerdictModal } from "./_modals/SetVerdictModal";
import { OverrideVerdictModal } from "./_modals/OverrideVerdictModal";
import { CancelInspectionModal } from "./_modals/CancelInspectionModal";
import { ReopenInspectionModal } from "./_modals/ReopenInspectionModal";
import { UpdateHeaderModal } from "./_modals/UpdateHeaderModal";
import { RaiseNcrModal } from "./_modals/RaiseNcrModal";

// ── Types ─────────────────────────────────────────────────────────────────────

type ActiveModal =
  | { kind: "addReadings" }
  | { kind: "editReading"; reading: Reading }
  | { kind: "deleteReading"; reading: Reading }
  | { kind: "setVerdict" }
  | { kind: "overrideVerdict" }
  | { kind: "cancelInspection" }
  | { kind: "reopenInspection" }
  | { kind: "updateHeader" }
  | { kind: "raiseNcr" };

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function fmtDateShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function humanizeEventType(et: string): string {
  return et
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function humanizeKey(k: string): string {
  return k
    .replace(/_/g, " ")
    .replace(/\bpct\b/i, "%")
    .replace(/\bncr\b/i, "NCR")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtDiffValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

// Renders an audit event's payload_diff as readable labelled fields instead of
// raw JSON. Null/undefined entries are dropped.
function AuditPayload({ diff }: { diff: Record<string, unknown> }): React.JSX.Element | null {
  const entries = Object.entries(diff).filter(([, v]) => v !== null && v !== undefined);
  if (entries.length === 0) return null;
  return (
    <dl className="mt-1.5 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-[11px] bg-[var(--surface-subtle)] border border-[var(--aws-border)] rounded-[2px] px-2.5 py-1.5">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-[var(--text-muted)] font-medium whitespace-nowrap">{humanizeKey(k)}</dt>
          <dd className="text-[var(--text-primary)] font-mono break-words">{fmtDiffValue(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

// ── Status / verdict badges ────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string | null }): React.JSX.Element {
  if (!status) return <span className="text-[var(--text-muted)]">—</span>;
  const map: Record<string, { bg: string; fg: string; border: string; label: string }> = {
    in_progress:          { bg: "#eaf0fb", fg: "#2c5fa8", border: "#b3caf0",   label: "In Progress" },
    readings_submitted:   { bg: "#fdf8e1", fg: "#856404", border: "#f0d97a",   label: "Readings Submitted" },
    verdict_passed:       { bg: "#eaf6ed", fg: "#1a7a3c", border: "#b6dbb1",   label: "Verdict: Passed" },
    verdict_failed:       { bg: "#fdf3f1", fg: "#b1361e", border: "#f0c7be",   label: "Verdict: Failed" },
    cancelled:            { bg: "#f4f4f4", fg: "#6b7280", border: "#d1d5db",   label: "Cancelled" },
  };
  const s = map[status] ?? { bg: "#f4f4f4", fg: "#6b7280", border: "#d1d5db", label: status };
  return (
    <span
      className="inline-block text-[11px] font-semibold px-2 py-0.5 rounded-sm"
      style={{ background: s.bg, color: s.fg, border: `1px solid ${s.border}` }}
    >
      {s.label}
    </span>
  );
}

function VerdictBadge({ verdict }: { verdict: string | null }): React.JSX.Element | null {
  if (!verdict) return null;
  const passed = verdict === "passed";
  return (
    <span
      className="inline-block text-[11px] font-semibold px-2 py-0.5 rounded-sm"
      style={
        passed
          ? { background: "#eaf6ed", color: "#1a7a3c", border: "1px solid #b6dbb1" }
          : { background: "#fdf3f1", color: "#b1361e", border: "1px solid #f0c7be" }
      }
    >
      {passed ? "Passed" : "Failed"}
    </span>
  );
}

function ComplianceBadge({ reading }: { reading: Reading }): React.JSX.Element {
  const { is_within_spec, severity, deviation_pct } = reading;
  if (is_within_spec === null) {
    return (
      <span className="inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded-sm bg-[#f4f4f4] text-[#6b7280] border border-[#d1d5db]">
        N/A
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 flex-wrap">
      <span
        className="inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded-sm"
        style={
          is_within_spec
            ? { background: "#eaf6ed", color: "#1a7a3c", border: "1px solid #b6dbb1" }
            : { background: "#fdf3f1", color: "#b1361e", border: "1px solid #f0c7be" }
        }
      >
        {is_within_spec ? "In Spec" : "OOS"}
      </span>
      {severity ? (
        <span className="inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded-sm bg-[#fdf8e1] text-[#856404] border border-[#f0d97a]">
          {severity}
        </span>
      ) : null}
      {deviation_pct != null ? (
        <span className="text-[10px] text-[var(--text-secondary)] font-mono">
          {deviation_pct > 0 ? "+" : ""}{deviation_pct.toFixed(1)}%
        </span>
      ) : null}
    </span>
  );
}

// ── Info grid row ─────────────────────────────────────────────────────────────

function InfoRow({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex gap-2 py-1.5 border-b border-[var(--aws-border)] last:border-b-0">
      <dt className="w-40 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
        {label}
      </dt>
      <dd className="text-[13px] text-[var(--text-primary)] flex-1 break-words">{children}</dd>
    </div>
  );
}

// ── Card wrapper ──────────────────────────────────────────────────────────────

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
    <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.1)] overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-[var(--aws-border)] bg-[var(--surface-subtle)]">
        <div className="flex items-center gap-2">
          <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">{title}</h3>
          {count != null ? (
            <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 text-[10px] font-bold rounded-full bg-[var(--aws-border-strong)] text-[var(--text-secondary)]">
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

// ── Spec range display ────────────────────────────────────────────────────────

function SpecRange({ reading }: { reading: Reading }): React.JSX.Element {
  const { spec_min, spec_max, spec_target } = reading;
  let range = "—";
  if (spec_min != null && spec_max != null) range = `${spec_min} – ${spec_max}`;
  else if (spec_min != null) range = `≥${spec_min}`;
  else if (spec_max != null) range = `≤${spec_max}`;
  const target = spec_target != null ? ` · tgt ${spec_target}` : "";
  return (
    <span className="font-mono text-[12px]">
      {range}
      {target ? <span className="text-[var(--text-muted)]">{target}</span> : null}
    </span>
  );
}

// ── Spinner ───────────────────────────────────────────────────────────────────

function Spinner({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-[var(--text-secondary)]">
      <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
      {label}
    </div>
  );
}

// ── Action button helpers ─────────────────────────────────────────────────────

function ActionBtn({
  label,
  onClick,
  variant = "default",
  disabled,
}: {
  label: string;
  onClick: () => void;
  variant?: "default" | "primary" | "danger";
  disabled?: boolean;
}): React.JSX.Element {
  const base =
    "h-8 px-3 text-[12px] rounded-[2px] border font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
  const styles: Record<string, string> = {
    default:
      "border-[var(--aws-border-strong)] bg-white text-[var(--text-primary)] hover:border-[var(--aws-navy)]",
    primary:
      "border-[var(--aws-orange)] bg-[var(--aws-orange)] text-white hover:bg-[#b5222a] hover:border-[#b5222a]",
    danger:
      "border-[#b1361e] bg-white text-[#b1361e] hover:bg-[#fdf3f1]",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[base, styles[variant]].join(" ")}
    >
      {label}
    </button>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export function InwardInspectionDetail({
  inspectionId,
  onBack,
  onChanged,
}: {
  inspectionId: number | null;
  onBack: () => void;
  onChanged?: () => void;
}): React.JSX.Element {
  const router = useRouter();
  const isManager = useIsQcManager();
  const [detail, setDetail] = useState<InspectionDetail | null>(null);
  const [audit, setAudit]   = useState<AuditEvent[]>([]);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [activeModal, setActiveModal] = useState<ActiveModal | null>(null);
  // Bumping this nonce re-runs the fetch effect (used by reload()).
  const [fetchNonce, setFetchNonce] = useState(0);

  // Track whether we should call onChanged on next back press.
  const changedRef = useRef(false);

  // ── Fetch effect ──────────────────────────────────────────────────────────
  // All setState calls are inside the async IIFE so the linter does not flag
  // them as synchronous setState-in-effect violations.

  useEffect(() => {
    if (!inspectionId) return;
    const ctrl = new AbortController();
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const [d, a] = await Promise.all([
          getInspection(inspectionId),
          getInspectionAudit(inspectionId),
        ]);
        if (ctrl.signal.aborted) return;
        setDetail(d);
        setAudit(a);
      } catch (e) {
        if (ctrl.signal.aborted) return;
        if (e instanceof Error && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Failed to load inspection");
        setDetail(null);
        setAudit([]);
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    })();
    return () => ctrl.abort();
  }, [inspectionId, fetchNonce]);

  // ── Reload (called after modal onDone) ────────────────────────────────────

  function reload() {
    changedRef.current = true;
    setFetchNonce((n) => n + 1);
  }

  // ── onBack: propagate change signal ──────────────────────────────────────

  function handleBack() {
    if (changedRef.current) onChanged?.();
    onBack();
  }

  // ── Close modal + reload ──────────────────────────────────────────────────

  function closeAndReload() {
    setActiveModal(null);
    reload();
  }

  // ── Loading / error shell ─────────────────────────────────────────────────

  if (!inspectionId) {
    return (
      <div className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-center text-[13px] text-[var(--text-secondary)]">
        No inspection selected.
      </div>
    );
  }

  if (loading && !detail) {
    return (
      <div className="bg-white border border-[var(--aws-border)] rounded-md">
        <Spinner label="Loading inspection…" />
      </div>
    );
  }

  if (error && !detail) {
    return (
      <div className="bg-white border border-[var(--aws-border)] rounded-md p-6">
        <button
          type="button"
          onClick={handleBack}
          className="text-[13px] text-[var(--aws-link)] hover:underline mb-3 flex items-center gap-1"
        >
          ← Back to list
        </button>
        <p className="text-[13px] text-[var(--aws-error)]">{error}</p>
      </div>
    );
  }

  if (!detail) return <></>;

  const status = detail.status ?? "";

  // ── Access gates ──────────────────────────────────────────────────────────
  // Approved = a verdict has been recorded. Before approval, anyone holding the
  // qc.inspection.edit permission (inspector or manager) may add/edit/delete
  // readings; AFTER approval, only a QC manager may. The verdict itself is the
  // manager's sign-off, so only managers may set or change it.
  const isApproved = status === "verdict_passed" || status === "verdict_failed";
  const canEditReadings = isApproved
    ? isManager
    : status === "in_progress" || status === "readings_submitted";

  // ── Helpers for the spec display ──────────────────────────────────────────

  const sku = detail.sku_name ?? detail.sku_name_raw ?? "—";
  const skuId = detail.sku_id != null ? ` (SKU ${detail.sku_id})` : "";

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">

      {/* ── Header bar ── */}
      <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.1)] px-4 py-3">
        {/* Top row: back + id + badges */}
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <button
            type="button"
            onClick={handleBack}
            className="text-[13px] text-[var(--aws-link)] hover:underline flex items-center gap-1 shrink-0"
          >
            ← Back to list
          </button>
          <span className="font-mono text-[13px] font-semibold text-[var(--text-primary)]">
            #{detail.inspection_id}
            {detail.inspection_ref ? ` · ${detail.inspection_ref}` : ""}
          </span>
          <StatusBadge status={status} />
          <VerdictBadge verdict={detail.verdict} />
        </div>

        {/* Meta line */}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-[var(--text-secondary)]">
          {detail.po_number ? (
            <span>PO: <span className="font-mono font-medium text-[var(--text-primary)]">{detail.po_number}</span></span>
          ) : null}
          {detail.transaction_no ? (
            <span>Txn: <span className="font-mono font-medium text-[var(--text-primary)]">{detail.transaction_no}</span></span>
          ) : null}
          <span>SKU: <span className="font-medium text-[var(--text-primary)]">{sku}{skuId}</span></span>
          {detail.supplier_name ? (
            <span>
              Supplier: <span className="font-medium text-[var(--text-primary)]">{detail.supplier_name}</span>
              {detail.supplier_id ? <span className="text-[var(--text-muted)]"> #{detail.supplier_id}</span> : null}
            </span>
          ) : null}
          {detail.lot_number ? (
            <span>Lot: <span className="font-mono font-medium text-[var(--text-primary)]">{detail.lot_number}</span></span>
          ) : null}
        </div>
      </div>

      {/* ── Action bar ── */}
      <div className="flex flex-wrap gap-2 items-center">
        {/* Status-driven actions */}
        {status === "in_progress" ? (
          <>
            <ActionBtn label="Update header" onClick={() => setActiveModal({ kind: "updateHeader" })} />
            <ActionBtn label="Cancel inspection" onClick={() => setActiveModal({ kind: "cancelInspection" })} variant="danger" />
            <ActionBtn label="Add readings" onClick={() => setActiveModal({ kind: "addReadings" })} variant="primary" />
          </>
        ) : status === "readings_submitted" ? (
          <>
            <ActionBtn label="Update header" onClick={() => setActiveModal({ kind: "updateHeader" })} />
            {canEditReadings ? (
              <ActionBtn label="Add readings" onClick={() => setActiveModal({ kind: "addReadings" })} />
            ) : null}
            {/* Verdict is the QC manager's sign-off — managers only. */}
            {isManager ? (
              <ActionBtn label="Set verdict" onClick={() => setActiveModal({ kind: "setVerdict" })} variant="primary" />
            ) : null}
          </>
        ) : isApproved ? (
          <>
            {/* After approval only a manager may modify readings or change the verdict. */}
            {canEditReadings ? (
              <ActionBtn label="Add readings" onClick={() => setActiveModal({ kind: "addReadings" })} />
            ) : null}
            {isManager ? (
              <ActionBtn label="Change verdict" onClick={() => setActiveModal({ kind: "overrideVerdict" })} />
            ) : null}
          </>
        ) : status === "cancelled" ? (
          <ActionBtn label="Reopen" onClick={() => setActiveModal({ kind: "reopenInspection" })} variant="primary" />
        ) : null}

        {/* Raise NCR — shown for a failed verdict. If an NCR already exists,
            show a badge linking to it instead of the button. */}
        {detail.verdict === "failed" ? (
          detail.ncr_no ? (
            <span className="inline-flex items-center gap-1.5 h-8 px-3 text-[12px] rounded-[2px] border border-[#f0c7be] bg-[#fdf3f1] text-[#b1361e] font-semibold">
              NCR: <span className="font-mono">{detail.ncr_no}</span>
            </span>
          ) : (
            <ActionBtn
              label="Raise NCR"
              onClick={() => setActiveModal({ kind: "raiseNcr" })}
              variant="danger"
            />
          )
        ) : null}

        {/* Always-present reload */}
        <button
          type="button"
          onClick={reload}
          disabled={loading}
          className="h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] flex items-center gap-1.5 disabled:opacity-50"
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2}>
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
          Reload
        </button>
      </div>

      {/* ── Card 1: Inspection details ── */}
      <Card title="Inspection details">
        <dl className="divide-y divide-[var(--aws-border)]">
          <InfoRow label="Inspection ID">
            <span className="font-mono">{detail.inspection_id}</span>
          </InfoRow>
          {detail.qc_intimation_id ? (
            <InfoRow label="Intimation #">
              <span className="font-mono">{detail.qc_intimation_id}</span>
            </InfoRow>
          ) : null}
          <InfoRow label="SKU">
            {sku}
            {detail.sku_id ? (
              <span className="ml-1 text-[var(--text-muted)] text-[11px] font-mono">SKU {detail.sku_id}</span>
            ) : null}
          </InfoRow>
          {detail.supplier_name ? (
            <InfoRow label="Supplier">
              {detail.supplier_name}
              {detail.supplier_id ? (
                <span className="ml-1 text-[var(--text-muted)] text-[11px] font-mono">#{detail.supplier_id}</span>
              ) : null}
            </InfoRow>
          ) : null}
          {detail.lot_number ? (
            <InfoRow label="Lot">
              <span className="font-mono">{detail.lot_number}</span>
            </InfoRow>
          ) : null}
          {detail.sample_size != null ? (
            <InfoRow label="Sample size">{detail.sample_size}</InfoRow>
          ) : null}
          {detail.inspection_method ? (
            <InfoRow label="Method">{detail.inspection_method}</InfoRow>
          ) : null}
          {detail.started_at ? (
            <InfoRow label="Started">
              {fmtDate(detail.started_at)}
              {detail.started_by_name ? (
                <span className="text-[var(--text-muted)]"> · by {detail.started_by_name}</span>
              ) : null}
            </InfoRow>
          ) : null}
          {detail.verdict_at ? (
            <InfoRow label="Verdict at">{fmtDate(detail.verdict_at)}</InfoRow>
          ) : null}
          {detail.accepted_qty != null && status === "verdict_passed" ? (
            <InfoRow label="Accepted qty">{detail.accepted_qty}</InfoRow>
          ) : null}
          {detail.rejected_qty != null && status === "verdict_failed" ? (
            <InfoRow label="Rejected qty">{detail.rejected_qty}</InfoRow>
          ) : null}
          {detail.ncr_no ? (
            <InfoRow label="NCR">
              <span className="font-mono">{detail.ncr_no}</span>
            </InfoRow>
          ) : null}
          {detail.cancelled_at ? (
            <InfoRow label="Cancelled">
              {fmtDate(detail.cancelled_at)}
              {detail.cancelled_by_name ? (
                <span className="text-[var(--text-muted)]"> · by {detail.cancelled_by_name}</span>
              ) : null}
              {detail.cancel_reason ? (
                <span className="text-[var(--text-muted)]"> · {detail.cancel_reason}</span>
              ) : null}
            </InfoRow>
          ) : null}
          {detail.reopened_at ? (
            <InfoRow label="Reopened">
              {fmtDate(detail.reopened_at)}
              {detail.reopen_reason ? (
                <span className="text-[var(--text-muted)]"> · {detail.reopen_reason}</span>
              ) : null}
            </InfoRow>
          ) : null}
          {detail.verdict_overridden_by_name ? (
            <InfoRow label="Override">
              by {detail.verdict_overridden_by_name}
              {detail.override_reason ? (
                <span className="text-[var(--text-muted)]"> · {detail.override_reason}</span>
              ) : null}
            </InfoRow>
          ) : null}
          {detail.remarks ? (
            <InfoRow label="Remarks">{detail.remarks}</InfoRow>
          ) : null}
        </dl>
      </Card>

      {/* ── Card 1b: Approval (manager sign-off) — once a verdict exists ── */}
      {detail.verdict ? (
        <Card title="Approval">
          <dl className="divide-y divide-[var(--aws-border)]">
            <InfoRow label="Decision">
              <VerdictBadge verdict={detail.verdict} />
              {detail.verdict_overridden_by_name ? (
                <span className="ml-2 text-[11px] text-[var(--text-muted)]">(changed via override)</span>
              ) : null}
            </InfoRow>
            <InfoRow label="Approved by">
              {detail.approved_by_name
                ? detail.approved_by_name
                : detail.approved_by != null
                ? `User #${detail.approved_by}`
                : <span className="text-[var(--text-muted)]">—</span>}
            </InfoRow>
            <InfoRow label="Approved at">
              {fmtDate(detail.approved_at ?? detail.verdict_at)}
            </InfoRow>
            {detail.accepted_qty != null && detail.verdict === "passed" ? (
              <InfoRow label="Accepted qty">{detail.accepted_qty}</InfoRow>
            ) : null}
            {detail.rejected_qty != null && detail.verdict === "failed" ? (
              <InfoRow label="Rejected qty">{detail.rejected_qty}</InfoRow>
            ) : null}
            {detail.ncr_no ? (
              <InfoRow label="NCR">
                <span className="font-mono">{detail.ncr_no}</span>
              </InfoRow>
            ) : null}
            {detail.verdict_overridden_by_name ? (
              <InfoRow label="Override">
                by {detail.verdict_overridden_by_name}
                {detail.override_reason ? (
                  <span className="text-[var(--text-muted)]"> · {detail.override_reason}</span>
                ) : null}
              </InfoRow>
            ) : null}
          </dl>
        </Card>
      ) : null}

      {/* ── Card 2: Readings ── */}
      <Card
        title="Readings"
        count={detail.readings.length}
        actions={
          canEditReadings ? (
            <ActionBtn
              label="Add reading"
              onClick={() => setActiveModal({ kind: "addReadings" })}
              variant="primary"
            />
          ) : undefined
        }
      >
        {detail.readings.length === 0 ? (
          <p className="text-[13px] text-[var(--text-secondary)] italic">
            No readings recorded yet.
            {canEditReadings ? " Use the Add reading button to begin." : ""}
          </p>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden md:block overflow-x-auto rounded-[2px] border border-[var(--aws-border)]">
              <table className="w-full text-[12px] border-collapse">
                <thead className="bg-[var(--surface-subtle)]">
                  <tr className="border-b border-[var(--aws-border)]">
                    <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)] whitespace-nowrap">Parameter</th>
                    <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)] whitespace-nowrap">Spec</th>
                    <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)] whitespace-nowrap">Observed</th>
                    <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)] whitespace-nowrap">Status</th>
                    <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)] whitespace-nowrap">Method / Instrument</th>
                    <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)] whitespace-nowrap">Notes</th>
                    <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)] whitespace-nowrap">Recorded</th>
                    {canEditReadings ? (
                      <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)] w-16">Actions</th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {detail.readings.map((r) => (
                    <tr key={r.reading_id} className="border-b border-[var(--aws-border)] last:border-b-0 hover:bg-[var(--surface-subtle)]">
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className="font-medium">{r.parameter_name ?? "—"}</span>
                        {r.parameter_unit ? (
                          <span className="ml-1 text-[var(--text-muted)] text-[11px] font-mono">{r.parameter_unit}</span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <SpecRange reading={r} />
                      </td>
                      <td className="px-3 py-2 font-mono whitespace-nowrap">
                        {r.observed_value_num != null
                          ? String(r.observed_value_num)
                          : r.observed_value_text ?? "—"}
                      </td>
                      <td className="px-3 py-2">
                        <ComplianceBadge reading={r} />
                      </td>
                      <td className="px-3 py-2">
                        {r.method ? (
                          <div className="text-[12px] text-[var(--text-primary)]">{r.method}</div>
                        ) : null}
                        {r.instrument ? (
                          <div className="text-[11px] text-[var(--text-muted)]">{r.instrument}</div>
                        ) : null}
                        {!r.method && !r.instrument ? <span className="text-[var(--text-muted)]">—</span> : null}
                      </td>
                      <td className="px-3 py-2 max-w-[160px] truncate text-[var(--text-secondary)]" title={r.notes ?? ""}>
                        {r.notes ?? <span className="text-[var(--text-muted)]">—</span>}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-[var(--text-secondary)]">
                        {fmtDateShort(r.recorded_at)}
                      </td>
                      {canEditReadings ? (
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              title="Edit reading"
                              aria-label="Edit reading"
                              onClick={() => setActiveModal({ kind: "editReading", reading: r })}
                              className="p-1 rounded hover:bg-[var(--surface-divider)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                            >
                              ✎
                            </button>
                            <button
                              type="button"
                              title="Delete reading"
                              aria-label="Delete reading"
                              onClick={() => setActiveModal({ kind: "deleteReading", reading: r })}
                              className="p-1 rounded hover:bg-[#fdf3f1] text-[var(--text-secondary)] hover:text-[#b1361e]"
                            >
                              🗑
                            </button>
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="md:hidden space-y-2">
              {detail.readings.map((r) => (
                <div key={r.reading_id} className="border border-[var(--aws-border)] rounded-[2px] p-3 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-[13px]">
                      {r.parameter_name ?? "—"}
                      {r.parameter_unit ? (
                        <span className="ml-1 text-[var(--text-muted)] text-[11px] font-mono">{r.parameter_unit}</span>
                      ) : null}
                    </span>
                    <ComplianceBadge reading={r} />
                  </div>
                  <div className="text-[12px] text-[var(--text-secondary)] flex flex-wrap gap-x-3 gap-y-0.5">
                    <span>Spec: <SpecRange reading={r} /></span>
                    <span>Observed: <span className="font-mono">{r.observed_value_num != null ? String(r.observed_value_num) : r.observed_value_text ?? "—"}</span></span>
                    {r.method ? <span>Method: {r.method}</span> : null}
                    {r.instrument ? <span>Instrument: {r.instrument}</span> : null}
                  </div>
                  {r.notes ? (
                    <p className="text-[12px] text-[var(--text-secondary)] italic">{r.notes}</p>
                  ) : null}
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-[var(--text-muted)]">{fmtDateShort(r.recorded_at)}</span>
                    {canEditReadings ? (
                      <div className="flex gap-1">
                        <button
                          type="button"
                          onClick={() => setActiveModal({ kind: "editReading", reading: r })}
                          className="text-[12px] text-[var(--aws-link)] hover:underline"
                        >
                          Edit
                        </button>
                        <span className="text-[var(--text-muted)]">·</span>
                        <button
                          type="button"
                          onClick={() => setActiveModal({ kind: "deleteReading", reading: r })}
                          className="text-[12px] text-[#b1361e] hover:underline"
                        >
                          Delete
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>

      {/* ── Card 4: Audit timeline ── */}
      <Card title="Audit timeline" count={audit.length}>
        {audit.length === 0 ? (
          <p className="text-[13px] text-[var(--text-secondary)] italic">No audit events recorded.</p>
        ) : (
          <ol className="relative border-l border-[var(--aws-border)] ml-2 space-y-4">
            {audit.map((ev, i) => (
              <li key={i} className="pl-4">
                {/* Timeline dot */}
                <span className="absolute -left-1.5 top-[3px] w-3 h-3 rounded-full bg-[var(--aws-border-strong)] border-2 border-white" />

                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-[13px] font-semibold text-[var(--text-primary)]">
                    {humanizeEventType(ev.event_type)}
                  </span>
                  {ev.from_state || ev.to_state ? (
                    <span className="text-[11px] text-[var(--text-muted)] font-mono">
                      {ev.from_state ?? "—"} → {ev.to_state ?? "—"}
                    </span>
                  ) : null}
                  <span className="text-[11px] text-[var(--text-muted)]">{fmtDate(ev.occurred_at)}</span>
                  {ev.actor_user_id != null ? (
                    <span className="text-[11px] text-[var(--text-muted)]">· user #{ev.actor_user_id}</span>
                  ) : null}
                </div>

                {ev.payload_diff ? <AuditPayload diff={ev.payload_diff} /> : null}
              </li>
            ))}
          </ol>
        )}
      </Card>

      {/* ── Modals ── */}

      {activeModal?.kind === "addReadings" ? (
        <AddReadingsModal
          inspectionId={inspectionId}
          onClose={() => setActiveModal(null)}
          onDone={closeAndReload}
        />
      ) : null}

      {activeModal?.kind === "editReading" ? (
        <EditReadingModal
          inspectionId={inspectionId}
          reading={activeModal.reading}
          onClose={() => setActiveModal(null)}
          onDone={closeAndReload}
        />
      ) : null}

      {activeModal?.kind === "deleteReading" ? (
        <DeleteReadingModal
          inspectionId={inspectionId}
          reading={activeModal.reading}
          onClose={() => setActiveModal(null)}
          onDone={closeAndReload}
        />
      ) : null}

      {activeModal?.kind === "setVerdict" ? (
        <SetVerdictModal
          inspectionId={inspectionId}
          onClose={() => setActiveModal(null)}
          onDone={closeAndReload}
        />
      ) : null}

      {activeModal?.kind === "overrideVerdict" ? (
        <OverrideVerdictModal
          inspectionId={inspectionId}
          currentVerdict={detail.verdict}
          onClose={() => setActiveModal(null)}
          onDone={closeAndReload}
        />
      ) : null}

      {activeModal?.kind === "cancelInspection" ? (
        <CancelInspectionModal
          inspectionId={inspectionId}
          onClose={() => setActiveModal(null)}
          onDone={closeAndReload}
        />
      ) : null}

      {activeModal?.kind === "reopenInspection" ? (
        <ReopenInspectionModal
          inspectionId={inspectionId}
          onClose={() => setActiveModal(null)}
          onDone={closeAndReload}
        />
      ) : null}

      {activeModal?.kind === "updateHeader" ? (
        <UpdateHeaderModal
          inspection={detail}
          onClose={() => setActiveModal(null)}
          onDone={closeAndReload}
        />
      ) : null}

      {activeModal?.kind === "raiseNcr" ? (
        <RaiseNcrModal
          inspectionId={inspectionId}
          onClose={() => setActiveModal(null)}
          onDone={(ncrId) => {
            setActiveModal(null);
            router.push(`/modules/qc/ncr/${ncrId}`);
          }}
        />
      ) : null}

    </div>
  );
}
