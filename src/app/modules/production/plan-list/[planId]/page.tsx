"use client";

// Plan approval workspace. The list page surfaces a quick inline expansion;
// this page is the thorough review experience — full plan header, every
// line with its step chain visualised, audit trail, plus the canonical
// Approve / Cancel actions. Mirrors the role-played by the frontend_replica's
// plan-detail.html but condensed: no Gantt, no per-step edit (those are
// step-level endpoints that haven't been ported yet).

import { useEffect, useRef, useState } from "react";
import { BrandMark } from "@/components/BrandMark";
import { useParams, useRouter } from "next/navigation";
import { userStore } from "@/lib/auth";
import { useRequireAuth, useUserInitial, useIsAdmin } from "@/lib/user";
import { friendlyApiError } from "@/lib/apiErrors";
import { BackLink } from "@/components/BackLink";
import {
  type PlanDetail,
  type PlanLineRow,
  type PlanStepRow,
  type UpdatePlanBody,
  type UpdatePlanLineBody,
  type UpdatePlanStepBody,
  getPlan,
  approvePlan,
  cancelPlan,
  submitPlanFieldChangeAmendment,
  updatePlan,
  deletePlan,
  updatePlanLine,
  updatePlanStep,
  addPlanStep,
  reorderPlanSteps,
  deletePlanStep,
  fmtPlanKg,
  fmtPlanDate,
  fmtDateRange,
} from "@/lib/plans";
import { PROCESS_OPTIONS, canonProcess, stageFromProcess, classifyProcess, STAGE_FINAL_FG } from "@/lib/processCatalog";
import { normaliseWarehouseCode } from "@/lib/warehouseScope";

// Warehouse → allowed floor list. Same source-of-truth as the Planning
// page's FLOORS_BY_FACTORY mapping.  Keys are pre-normalised ("W202",
// "A185") so the lookup tolerates the hyphenated / lowercased /
// padded admin-typed variants we see in the wild.
const WAREHOUSE_TO_FLOORS: Record<string, readonly string[]> = {
  W202: [
    "Lower Basement", "Upper Basement",
    "First Floor", "First Floor Mezz",
    "Second Floor", "Second Floor Mezz",
    "Terrace",
  ],
  A185: [
    "Roasting Area", "Mezzanine", "Sorting Area", "Printing Area",
    "Dmart Production Area", "Dmart Packing Area",
    "Cheese Floor", "FG store", "FFS Packing Area",
  ],
};

function floorsForWarehouse(wh: string | null | undefined): readonly string[] {
  if (!wh) return [];
  return WAREHOUSE_TO_FLOORS[normaliseWarehouseCode(wh)] ?? [];
}

export default function PlanDetailPage() {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);
  const initial = useUserInitial();
  const params = useParams<{ planId: string }>();
  const planId = Number(params?.planId);

  const [detail, setDetail] = useState<PlanDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const [confirm, setConfirm] = useState<"approve" | "cancel" | "delete" | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!authed) return;
    if (!Number.isFinite(planId)) {
      // Deferred past the sync effect body so the
      // react-hooks/set-state-in-effect rule stays happy — matches the
      // queueMicrotask pattern used by the job-card detail page.
      queueMicrotask(() => {
        setError("Invalid plan id.");
        setLoading(false);
      });
      return;
    }
    const c = new AbortController();
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const d = await getPlan(planId, c.signal);
        if (!c.signal.aborted) setDetail(d);
      } catch (e) {
        if (!c.signal.aborted) setError(friendlyApiError(e));
      } finally {
        if (!c.signal.aborted) setLoading(false);
      }
    })();
    return () => c.abort();
  }, [authed, planId, reload]);

  const status = (detail?.status ?? "").toLowerCase();
  const isDraft = status === "draft";
  const isApproved = status === "approved";
  const hasMobileBar = isDraft || isApproved;
  // Admins bypass the R8 plan_field_change amendment flow on approved
  // plans — they can direct-edit line fields AND step structure without a
  // reason prompt or the "step edits aren't supported" block. This still
  // routes through the same per-step PUT/POST/DELETE endpoints (no server
  // gate on step writes by plan status), so the wire shape is unchanged
  // for the audit log.
  const isAdmin = useIsAdmin();

  async function onApprove() {
    if (!detail) return;
    const me = userStore.load();
    const approvedBy = me?.full_name?.trim() || me?.phone || "user";
    setBusy(true);
    setToast(null);
    try {
      const r = await approvePlan(detail.plan_id, { approved_by: approvedBy });
      const jcCount = (r.job_cards?.lines || [])
        .reduce((n, ln) => n + (ln.job_card_ids?.length || 0), 0);
      const alreadyExisted = r.job_cards?.error === "job_cards_already_exist";
      setToast(
        jcCount > 0
          ? `Plan approved · ${jcCount} job card${jcCount === 1 ? "" : "s"} generated`
          : alreadyExisted
            ? `Plan approved · job cards already exist (${r.job_cards?.count ?? "?"})`
            : "Plan approved",
      );
      setConfirm(null);
      setReload((k) => k + 1);
    } catch (e) {
      setToast(`Approve failed: ${friendlyApiError(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function onCancel() {
    if (!detail) return;
    setBusy(true);
    setToast(null);
    try {
      await cancelPlan(detail.plan_id, { reason: reason.trim() });
      setToast("Plan cancelled · reserved fulfillment qty released.");
      setConfirm(null);
      setReason("");
      setReload((k) => k + 1);
    } catch (e) {
      setToast(`Cancel failed: ${friendlyApiError(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!detail) return;
    if (!reason.trim()) {
      setToast("Reason is required to delete an approved plan.");
      return;
    }
    const me = userStore.load();
    const deletedBy = me?.full_name?.trim() || me?.phone || "user";
    setBusy(true);
    setToast(null);
    try {
      const r = await deletePlan(detail.plan_id, {
        reason: reason.trim(),
        deleted_by: deletedBy,
      });
      const adminCount = r.admin_email_count ?? 0;
      setToast(
        adminCount > 0
          ? `Plan deleted · ${adminCount} admin${adminCount === 1 ? "" : "s"} notified.`
          : "Plan deleted · no admin emails on file to notify.",
      );
      setConfirm(null);
      setReason("");
      // Navigate back to the list — the plan is no longer actionable from
      // this page in any meaningful way once deleted.
      router.replace("/modules/production/plan-list");
    } catch (e) {
      setToast(`Delete failed: ${friendlyApiError(e)}`);
    } finally {
      setBusy(false);
    }
  }

  // Partial-update handler used by the Edit modal. Only the fields the
  // operator changed end up in the body — `updatePlan()` drops undefined
  // / empty values before serialising. The server then filters its own
  // `None`-keys, so unchanged columns stay exactly as they were.
  //
  // Routing per plan status:
  //   • draft     → direct PUT /plans-v2/{id}            (no approval gate)
  //   • approved  → POST /amendments  (plan_field_change) — admin must
  //                 approve before the fields are actually applied;
  //                 cascade rules + step-change limits handled server-side.
  async function onUpdate(patch: UpdatePlanBody) {
    if (!detail) return;
    setBusy(true);
    setToast(null);
    try {
      if (isApproved) {
        // Maker-checker path: collect reason, submit an amendment.
        // window.prompt is a deliberate MVP affordance; a textarea in
        // the EditModal is the follow-up polish (the server enforces
        // the min-20-char rule regardless).
        const reason = (window.prompt(
          "This plan is approved. Submit edit for admin approval?\n\n"
          + "Provide a reason (≥ 20 characters):",
          "",
        ) ?? "").trim();
        if (!reason) {
          setToast("Edit cancelled — no reason provided.");
          return;
        }
        if (reason.length < 20) {
          setToast("Reason must be at least 20 characters.");
          return;
        }
        await submitPlanFieldChangeAmendment(
          { plan_id: detail.plan_id, plan_fields: patch },
          reason,
        );
        setToast("Edit submitted for admin approval.");
      } else {
        await updatePlan(detail.plan_id, patch);
        setToast("Plan updated.");
      }
      setEditing(false);
      setReload((k) => k + 1);
    } catch (e) {
      setToast(`Update failed: ${friendlyApiError(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <PageHeader initial={initial} router={router} />

      <main
        className={[
          "flex-1 max-w-[1400px] w-full mx-auto px-4 sm:px-6 py-6",
          // Pad the bottom on mobile when the sticky action bar is visible.
          hasMobileBar ? "pb-24 md:pb-6" : "",
        ].join(" ")}
      >
        <div className="mb-3">
          <BackLink parentHref="/modules/production/plan-list" label="plan list" />
        </div>

        {loading && !detail ? (
          <Centered>Loading plan…</Centered>
        ) : error ? (
          <Centered tone="error">{error}</Centered>
        ) : detail ? (
          <>
            <PlanHeader
              detail={detail}
              onOpenApprove={() => setConfirm("approve")}
              onOpenCancel={() => setConfirm("cancel")}
              onOpenDelete={() => setConfirm("delete")}
              onOpenEdit={() => setEditing(true)}
            />

            {toast ? (
              <div className="mb-3 px-3 py-2 rounded-sm border border-[var(--aws-border)] bg-[#f1faff] text-[12px] text-[var(--text-primary)] flex items-center justify-between gap-2">
                <span>{toast}</span>
                <button onClick={() => setToast(null)} className="text-[var(--aws-link)] hover:underline">Dismiss</button>
              </div>
            ) : null}

            <LinesSection
              lines={detail.lines ?? []}
              warehouse={detail.warehouse}
              editable={isDraft || isApproved}
              planId={detail.plan_id}
              // Admin bypass: treat the plan as if it weren't approved so
              // line + step edits flow through the direct-write path
              // instead of the amendment + step-block gates.
              requireApproval={isApproved && !isAdmin}
              onSaved={() => setReload((k) => k + 1)}
              onMessage={setToast}
            />
          </>
        ) : null}
      </main>

      {/* Mobile sticky CTA — surfaces approve/cancel for drafts and
          edit/delete for approved plans. The plan label runs left, action
          buttons right, with edit always tucked next to the destructive
          action so it doesn't crowd the primary CTA. */}
      {detail && hasMobileBar ? (
        <div className="md:hidden fixed bottom-0 left-0 right-0 z-20 bg-white border-t border-[var(--aws-border)] shadow-[0_-2px_8px_rgba(0,28,36,0.12)] px-3 py-2 flex items-center gap-1.5 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
          <div className="flex-1 min-w-0">
            <div className="text-[12px] font-semibold text-[var(--text-primary)] truncate">
              {detail.plan_name || `Plan #${detail.plan_id}`}
            </div>
            <div className="text-[10px] text-[var(--text-muted)] truncate">
              {detail.lines?.length ?? 0} lines · {fmtPlanKg(detail.total_planned_kg)} kg
            </div>
          </div>
          {/* Edit is available for both draft + approved. */}
          <button
            onClick={() => setEditing(true)}
            disabled={busy}
            aria-label="Edit plan"
            className="h-9 w-9 rounded-[2px] border border-[var(--aws-border)] bg-white text-[var(--text-secondary)] hover:border-[var(--aws-navy)] disabled:opacity-50 inline-flex items-center justify-center"
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </button>
          {isDraft ? (
            <>
              {isAdmin ? (
                <button
                  onClick={() => setConfirm("cancel")}
                  disabled={busy}
                  className="h-9 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border)] bg-white text-[var(--aws-error)] hover:border-[var(--aws-error)] disabled:opacity-50"
                >
                  Cancel
                </button>
              ) : null}
              <button
                onClick={() => setConfirm("approve")}
                disabled={busy}
                className="h-9 px-4 text-[12px] rounded-[2px] font-semibold border bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white disabled:opacity-50"
              >
                Approve
              </button>
            </>
          ) : null}
          {isApproved && isAdmin ? (
            <button
              onClick={() => setConfirm("delete")}
              disabled={busy}
              className="h-9 px-3 text-[12px] rounded-[2px] border border-[var(--aws-error)] bg-white text-[var(--aws-error)] hover:bg-[#fdf3f1] disabled:opacity-50"
            >
              Delete
            </button>
          ) : null}
        </div>
      ) : null}

      {confirm && detail ? (
        <ConfirmModal
          kind={confirm}
          detail={detail}
          reason={reason}
          setReason={setReason}
          busy={busy}
          onConfirm={
            confirm === "approve" ? onApprove
            : confirm === "cancel" ? onCancel
            : onDelete
          }
          onDismiss={() => { setConfirm(null); setReason(""); }}
        />
      ) : null}

      {editing && detail ? (
        <EditModal
          detail={detail}
          busy={busy}
          onSubmit={onUpdate}
          onDismiss={() => setEditing(false)}
        />
      ) : null}

      <Footer />
    </div>
  );
}

// ── Plan header card ─────────────────────────────────────────────────────
//
// Structured into three clearly separated zones:
//   1. Title strip — name + status + revision + plan id
//   2. Metric panel — Lines / Volume / Units / Period, evenly spaced
//   3. Audit + actions — created/approved KV pairs on the left, action
//      buttons on the right (desktop) or in the sticky bottom bar (mobile).
//
// Lives inside one bordered card with internal dividers so the eye can
// orient without scanning for boundaries.

function PlanHeader({
  detail, onOpenApprove, onOpenCancel, onOpenDelete, onOpenEdit,
}: {
  detail: PlanDetail;
  onOpenApprove: () => void;
  onOpenCancel: () => void;
  onOpenDelete: () => void;
  onOpenEdit: () => void;
}) {
  const status = (detail.status ?? "").toLowerCase();
  const isDraft = status === "draft";
  const isApproved = status === "approved";
  // R10 — Cancel Plan + Delete Plan are admin-only on the server (router
  // gates wrap both POST /plans-v2/{id}/cancel and /delete). Mirror that
  // here so non-admin operators don't see the buttons at all; the
  // alternative (showing them + letting them 403) is bad UX. Approve
  // remains visible to non-admins since multiple roles may approve plans.
  const isAdmin = useIsAdmin();
  // Header fields (plan_date, date_from, date_to, plan_type) are editable
  // while the plan hasn't been executed / cancelled — drafts AND approved
  // plans both qualify. Once a plan is approved, downstream JCs are tied
  // to the plan window so edits should be deliberate, but the server still
  // accepts them.
  const isEditable = isDraft || isApproved;
  const lineCount = detail.lines?.length ?? 0;

  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md overflow-hidden mb-4">
      {/* ── Title strip ─────────────────────────────────────────────── */}
      <div className="px-4 py-3 flex flex-wrap items-center justify-between gap-2 border-b border-[var(--aws-border)]">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <h1 className="text-[18px] leading-[22px] font-semibold text-[var(--text-primary)] truncate">
            {detail.plan_name || `Plan #${detail.plan_id}`}
          </h1>
          <StatusBadge status={detail.status} />
          {detail.revision_number != null && detail.revision_number > 1 ? (
            <span className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-secondary)] bg-[var(--surface-subtle)] border border-[var(--aws-border)] rounded-sm px-1.5 py-0">
              rev {detail.revision_number}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
          <span className="font-mono">#{detail.plan_id}</span>
          {detail.entity ? <span className="uppercase font-semibold text-[var(--text-secondary)]">{detail.entity}</span> : null}
          {detail.warehouse ? <span className="font-mono">{detail.warehouse}</span> : null}
        </div>
      </div>

      {/* ── Metric strip ────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-[var(--aws-border)]">
        <Metric label="Lines"  value={String(lineCount)} />
        <Metric label="Volume" value={fmtPlanKg(detail.total_planned_kg)} suffix="kg" />
        <Metric
          label="Units"
          value={detail.total_planned_units != null ? String(detail.total_planned_units) : "—"}
          suffix={detail.total_planned_units != null ? "pcs" : undefined}
        />
        <Metric label="Period" value={fmtDateRange(detail.date_from, detail.date_to)} />
      </div>

      {/* ── Audit + actions ────────────────────────────────────────── */}
      <div className="border-t border-[var(--aws-border)] px-4 py-3 flex flex-wrap items-end justify-between gap-3">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-[11px]">
          <AuditKV label="Created" by={detail.created_by} at={detail.created_at} />
          <AuditKV label="Approved" by={detail.approved_by} at={detail.approved_at} />
          {detail.plan_date ? (
            <div className="min-w-0">
              <dt className="uppercase tracking-wide font-semibold text-[var(--text-muted)] text-[9px] leading-[12px]">Plan date</dt>
              <dd className="text-[12px] text-[var(--text-primary)] truncate">{fmtPlanDate(detail.plan_date)}</dd>
            </div>
          ) : null}
          <div className="min-w-0">
            <dt className="uppercase tracking-wide font-semibold text-[var(--text-muted)] text-[9px] leading-[12px]">Type</dt>
            <dd className="text-[12px] text-[var(--text-primary)] capitalize truncate">{detail.plan_type || "—"}</dd>
          </div>
        </dl>
        <div className="hidden md:flex items-center gap-2">
          {isEditable ? (
            <button
              onClick={onOpenEdit}
              className="h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] inline-flex items-center gap-1.5"
              title="Edit plan header fields"
            >
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
              Edit
            </button>
          ) : null}
          {isDraft ? (
            <>
              {isAdmin ? (
                <button
                  onClick={onOpenCancel}
                  className="h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[var(--aws-error)] hover:border-[var(--aws-error)]"
                >
                  Cancel plan
                </button>
              ) : null}
              <button
                onClick={onOpenApprove}
                className="h-8 px-4 text-[12px] rounded-[2px] font-semibold border bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white"
              >
                Approve plan →
              </button>
            </>
          ) : null}
          {isApproved && isAdmin ? (
            <button
              onClick={onOpenDelete}
              title="Delete an approved plan — admins are notified by email"
              className="h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-error)] bg-white text-[var(--aws-error)] hover:bg-[#fdf3f1] inline-flex items-center gap-1.5"
            >
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <line x1="10" y1="11" x2="10" y2="17" />
                <line x1="14" y1="11" x2="14" y2="17" />
              </svg>
              Delete plan
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value, suffix }: { label: string; value: string; suffix?: string }) {
  return (
    <div className="px-4 py-3">
      <div className="uppercase tracking-wide font-semibold text-[var(--text-muted)] text-[9px] leading-[12px] mb-0.5">
        {label}
      </div>
      <div className="flex items-baseline gap-1 truncate">
        <span className="text-[16px] leading-[20px] font-semibold text-[var(--text-primary)] truncate">{value}</span>
        {suffix ? <span className="text-[11px] text-[var(--text-muted)]">{suffix}</span> : null}
      </div>
    </div>
  );
}

function AuditKV({
  label, by, at,
}: {
  label: string;
  by?: string | null;
  at?: string | null;
}) {
  return (
    <div className="min-w-0">
      <dt className="uppercase tracking-wide font-semibold text-[var(--text-muted)] text-[9px] leading-[12px]">
        {label}
      </dt>
      <dd className="text-[12px] text-[var(--text-primary)] truncate">
        {by ? (
          <>
            {by}
            {at ? <span className="text-[var(--text-muted)]"> · {fmtPlanDate(at)}</span> : null}
          </>
        ) : (
          "—"
        )}
      </dd>
    </div>
  );
}

// ── Lines section ───────────────────────────────────────────────────────
//
// Each line card is read-only by default and flips into an editable form
// when the operator hits Edit. Only one line can be in edit mode at a
// time (`editingLineId` state at the section level) so the operator can't
// have multiple pending drafts open and confuse themselves.

function LinesSection({
  lines, warehouse, editable, planId, requireApproval, onSaved, onMessage,
}: {
  lines: PlanLineRow[];
  warehouse?: string | null;
  /** Plan-level gate. False on cancelled / executed plans → hide every
   *  per-line Edit affordance. True on draft / approved plans. */
  editable: boolean;
  planId: number;
  /** When true (status='approved') line edits route through the R8
   *  amendment flow (POST /amendments plan_field_change) instead of
   *  direct PUT. Step changes are blocked entirely in this mode. */
  requireApproval: boolean;
  onSaved: () => void;
  onMessage: (msg: string | null) => void;
}) {
  const [editingLineId, setEditingLineId] = useState<number | null>(null);
  if (lines.length === 0) {
    return (
      <div className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-center text-[12px] text-[var(--text-secondary)]">
        This plan has no lines.
      </div>
    );
  }
  return (
    <section>
      <div className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)] mb-1.5">
        Lines · {lines.length}
      </div>
      <ol className="space-y-2">
        {lines.map((l, i) => (
          <LineCard
            key={l.plan_line_id ?? i}
            line={l}
            idx={i + 1}
            warehouse={warehouse}
            editable={editable}
            planId={planId}
            requireApproval={requireApproval}
            isEditing={editable && editingLineId != null && editingLineId === l.plan_line_id}
            onStartEdit={() => editable && setEditingLineId(l.plan_line_id ?? null)}
            onCancelEdit={() => setEditingLineId(null)}
            onSaved={() => { setEditingLineId(null); onSaved(); }}
            onMessage={onMessage}
          />
        ))}
      </ol>
    </section>
  );
}

// Per-step draft used during editing. Carries the original step_id when one
// exists; merges drop the trailing steps via `isDeleted` so they're DELETE'd
// at save time.
interface StepDraft {
  step_id?: number;
  process_name: string | null;
  stage: string | null;
  floor: string | null;
  std_time_min: number | null;
  loss_pct: number | null;
  isDeleted?: boolean;
}

function LineCard({
  line, idx, warehouse, editable, planId, requireApproval,
  isEditing, onStartEdit, onCancelEdit, onSaved, onMessage,
}: {
  line: PlanLineRow;
  idx: number;
  warehouse?: string | null;
  editable: boolean;
  planId: number;
  requireApproval: boolean;
  isEditing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaved: () => void;
  onMessage: (msg: string | null) => void;
}) {
  if (isEditing) {
    return (
      <LineCardEdit
        line={line}
        idx={idx}
        warehouse={warehouse}
        planId={planId}
        requireApproval={requireApproval}
        onCancel={onCancelEdit}
        onSaved={onSaved}
        onMessage={onMessage}
      />
    );
  }

  const steps = line.steps ?? [];
  const flooredCount = steps.filter((s) => !!s.floor).length;
  const linkedSos = line.linked_so_fulfillment_ids ?? [];

  return (
    <li className="bg-white border border-[var(--aws-border)] rounded-md overflow-hidden">
      {/* ── Zone 1: title strip ──────────────────────────────────── */}
      <div className="px-3 py-2.5 flex items-start gap-3 border-b border-[var(--aws-border)]">
        <span className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full bg-[var(--aws-navy)] text-white text-[10px] font-bold mt-0.5">
          {idx}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-[var(--text-primary)] truncate" title={line.fg_sku_name ?? ""}>
            {line.fg_sku_name || "—"}
          </div>
          <div className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted)] truncate">
            {line.customer_name || "—"}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[14px] font-semibold text-[var(--text-primary)] leading-tight">
            {fmtPlanKg(line.planned_qty_kg)}
            <span className="text-[10px] text-[var(--text-muted)] font-normal ml-0.5">kg</span>
          </div>
          {line.planned_qty_units != null ? (
            <div className="text-[11px] text-[var(--text-muted)] leading-tight">
              {line.planned_qty_units} <span className="text-[10px]">pcs</span>
            </div>
          ) : null}
        </div>
        {editable ? (
          <button
            type="button"
            onClick={onStartEdit}
            aria-label="Edit line"
            title="Edit qty, area, deadline, steps"
            className="shrink-0 inline-flex items-center gap-1 h-7 px-2 text-[11px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]"
          >
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            Edit
          </button>
        ) : null}
      </div>

      {/* ── Zone 2: meta strip ────────────────────────────────────── */}
      <dl className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-[var(--aws-border)] border-b border-[var(--aws-border)] text-[12px]">
        <MetaKV label="Deadline" value={line.deadline_date ? fmtPlanDate(line.deadline_date) : "—"} />
        <MetaKV label="Area" value={line.area || "—"} />
        <MetaKV
          label="Linked fulfillments"
          value={
            linkedSos.length === 0
              ? "—"
              : (
                <span className="font-mono">
                  {linkedSos.slice(0, 5).map((id, i) => (
                    <span key={id}>
                      {i > 0 ? " " : ""}#{id}
                    </span>
                  ))}
                  {linkedSos.length > 5 ? (
                    <span className="text-[var(--text-muted)] font-sans"> +{linkedSos.length - 5}</span>
                  ) : null}
                </span>
              )
          }
        />
      </dl>

      {/* ── Zone 3: read-only steps, grouped WIP → Packing ───────────
          Same WIP/Packing stage layout the operator sees in Create/Edit
          Job Card, so an opened plan reads identically to a job card. */}
      {steps.length > 0 ? (
        <div>
          <div className="px-3 pt-2 pb-1 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)]">
              Process steps · {steps.length}
            </span>
            {flooredCount > 0 ? (
              <span className="text-[10px] text-[var(--text-muted)]">
                {flooredCount}/{steps.length} floored
              </span>
            ) : (
              <span className="text-[10px] text-[var(--aws-error)]">No floors set</span>
            )}
          </div>
          <StageGroupedSteps steps={steps} />
        </div>
      ) : null}
    </li>
  );
}

// A plan step is "packing" when its stored stage reads as packing, or — for
// older rows without a stage token — when the process classifies as the
// terminal FG/packaging bucket. Mirrors job_card_v2.py is_packing_stage.
function isPackingStep(s: PlanStepRow): boolean {
  const stage = (s.stage || "").toLowerCase();
  if (stage.includes("pack")) return true;
  return classifyProcess(s.process_name).stageBucket === STAGE_FINAL_FG;
}

// Read-only steps split into WIP processes + Packing, each as its own labelled
// StepsTable so an opened plan matches the Create/Edit Job Card WIP/Packing view.
function StageGroupedSteps({ steps }: { steps: PlanStepRow[] }) {
  const ordered = [...steps].sort((a, b) => (a.step_order ?? 0) - (b.step_order ?? 0));
  const wip = ordered.filter((s) => !isPackingStep(s));
  const pack = ordered.filter((s) => isPackingStep(s));
  return (
    <div className="space-y-2 pb-1">
      {wip.length > 0 ? (
        <div>
          <div className="px-3 py-0.5 flex items-center gap-1.5">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--aws-orange-active)]" />
            <span className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)]">WIP processes · {wip.length}</span>
          </div>
          <StepsTable steps={wip} />
        </div>
      ) : null}
      {pack.length > 0 ? (
        <div>
          <div className="px-3 py-0.5 flex items-center gap-1.5">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#9a393e]" />
            <span className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)]">Packing · {pack.length}</span>
          </div>
          <StepsTable steps={pack} />
        </div>
      ) : null}
    </div>
  );
}

// ── Editable line card ──────────────────────────────────────────────────
//
// All line + step edits live in local state so the operator can experiment
// freely (reorder, merge, change values) without firing any API call until
// they hit Save. The save handler diffs against the original line+steps
// and dispatches:
//   • PUT  /plans-v2/lines/{plan_line_id}          (line fields)
//   • PUT  /plans-v2/steps/{step_id}               (per changed step)
//   • DELETE /plans-v2/steps/{step_id}             (steps marked deleted by a merge)
//   • PUT  /plans-v2/lines/{plan_line_id}/steps/reorder (if order changed)
//
// Order matters: deletes go first (so the reorder body only references
// still-existing step_ids), then per-step PUTs, then reorder, then the
// line PUT last.

function LineCardEdit({
  line, idx, warehouse, planId, requireApproval, onCancel, onSaved, onMessage,
}: {
  line: PlanLineRow;
  idx: number;
  warehouse?: string | null;
  planId: number;
  /** When true, line edits go through the R8 plan_field_change amendment
   *  flow. Step changes are not supported on approved plans because the
   *  amendment scope only covers line fields — operator gets a clear
   *  error toast if they try. */
  requireApproval: boolean;
  onCancel: () => void;
  onSaved: () => void;
  onMessage: (msg: string | null) => void;
}) {
  // ── Line draft fields ──
  const [qtyKg, setQtyKg] = useState<string>(
    line.planned_qty_kg != null ? String(line.planned_qty_kg) : "",
  );
  const [qtyUnits, setQtyUnits] = useState<string>(
    line.planned_qty_units != null ? String(line.planned_qty_units) : "",
  );
  const [area, setArea] = useState<string>(line.area ?? "");
  const [deadline, setDeadline] = useState<string>(
    line.deadline_date ? line.deadline_date.slice(0, 10) : "",
  );

  // ── Step drafts (deep-copied from the loaded line) ──
  const [stepDrafts, setStepDrafts] = useState<StepDraft[]>(() =>
    (line.steps ?? []).map((s) => ({
      step_id: s.step_id,
      process_name: s.process_name ?? null,
      stage: s.stage ?? null,
      floor: s.floor ?? null,
      std_time_min: s.std_time_min != null ? Number(s.std_time_min) : null,
      loss_pct: s.loss_pct != null ? Number(s.loss_pct) : null,
    })),
  );

  // ── Merge selection ──
  const [selectedSteps, setSelectedSteps] = useState<Set<number>>(new Set());

  // ── HTML5 drag state for reorder ──
  const dragFromRef = useRef<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  const [busy, setBusy] = useState(false);

  const floors = floorsForWarehouse(warehouse);
  const activeSteps = stepDrafts.filter((s) => !s.isDeleted);
  const mergeable = activeSteps.length >= 2;

  function patchStep(idx: number, patch: Partial<StepDraft>) {
    setStepDrafts((cur) => cur.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  }
  // Append a blank draft step. step_id stays undefined; onSave below
  // identifies these as "new" and POSTs them via addPlanStep. Inserted
  // at the end so the operator's expected order matches the saved
  // result — a reorder is a separate edit if they want it elsewhere.
  function addStep() {
    setStepDrafts((cur) => [
      ...cur,
      {
        step_id: undefined,
        process_name: null,
        stage: null,
        floor: null,
        std_time_min: null,
        loss_pct: null,
      },
    ]);
  }
  function moveStep(fromIdx: number, toIdx: number) {
    setStepDrafts((cur) => {
      // Map active-index → real-index so reorder only swaps visible rows.
      const active: number[] = [];
      cur.forEach((s, i) => { if (!s.isDeleted) active.push(i); });
      if (fromIdx < 0 || fromIdx >= active.length || toIdx < 0 || toIdx >= active.length) return cur;
      const realFrom = active[fromIdx];
      const realTo = active[toIdx];
      const next = cur.slice();
      const [moved] = next.splice(realFrom, 1);
      next.splice(realTo > realFrom ? realTo - 1 : realTo, 0, moved);
      // Wait — splice on the same array shifts indices when removing first.
      // Simpler: rebuild from a fresh array, only touching active members.
      const rebuilt = cur.filter((s) => s.isDeleted);
      const activeOrder = cur.filter((s) => !s.isDeleted);
      const [pulled] = activeOrder.splice(fromIdx, 1);
      activeOrder.splice(toIdx, 0, pulled);
      return [...activeOrder, ...rebuilt];
    });
  }
  function toggleSelect(activeIdx: number) {
    setSelectedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(activeIdx)) next.delete(activeIdx); else next.add(activeIdx);
      return next;
    });
  }
  function selectAll(on: boolean) {
    if (on) setSelectedSteps(new Set(activeSteps.map((_, i) => i)));
    else setSelectedSteps(new Set());
  }
  function fireMerge() {
    if (selectedSteps.size < 2) return;
    const idxs = [...selectedSteps].sort((a, b) => a - b);
    const picked = idxs.map((i) => activeSteps[i]);
    if (picked.length < 2) return;
    const floorsSelected = picked.map((s) => s.floor).filter((f): f is string => !!f);
    const uniqueFloors = new Set(floorsSelected);
    const mergedFloor = uniqueFloors.size === 1 ? [...uniqueFloors][0] : null;
    const anyTime = picked.some((s) => Number.isFinite(s.std_time_min));
    const totalTime = anyTime
      ? picked.reduce((acc, s) => acc + (Number.isFinite(s.std_time_min) ? Number(s.std_time_min) : 0), 0)
      : null;
    const anyLoss = picked.some((s) => Number.isFinite(s.loss_pct));
    const maxLoss = anyLoss
      ? picked.reduce((acc, s) => Number.isFinite(s.loss_pct) ? Math.max(acc, Number(s.loss_pct)) : acc, 0)
      : null;
    const merged: Partial<StepDraft> = {
      process_name: picked.map((s) => s.process_name || "—").join(" + "),
      stage: picked[0].stage ?? null,
      floor: mergedFloor,
      std_time_min: totalTime,
      loss_pct: maxLoss,
    };
    // Apply: first selected gets the merged values; the rest get marked
    // isDeleted so the save flow DELETEs them.
    const firstActiveIdx = idxs[0];
    const restActiveIdxs = idxs.slice(1);
    // Translate active-index back to real-index in the full draft array.
    const activeToReal: number[] = [];
    stepDrafts.forEach((s, i) => { if (!s.isDeleted) activeToReal.push(i); });
    const firstRealIdx = activeToReal[firstActiveIdx];
    const restRealIdxs = restActiveIdxs.map((a) => activeToReal[a]);
    setStepDrafts((cur) =>
      cur.map((s, i) => {
        if (i === firstRealIdx) return { ...s, ...merged };
        if (restRealIdxs.includes(i)) return { ...s, isDeleted: true };
        return s;
      }),
    );
    setSelectedSteps(new Set());
  }

  async function onSave() {
    // Build diffs.
    const lineDiff: UpdatePlanLineBody = {};
    const origKg = line.planned_qty_kg != null ? Number(line.planned_qty_kg) : null;
    const origUnits = line.planned_qty_units != null ? Number(line.planned_qty_units) : null;
    const newKg = qtyKg !== "" ? Number(qtyKg) : null;
    const newUnits = qtyUnits !== "" ? Number(qtyUnits) : null;
    if (newKg != null && Number.isFinite(newKg) && newKg !== origKg) lineDiff.planned_qty_kg = newKg;
    if (newUnits != null && Number.isFinite(newUnits) && newUnits !== origUnits) lineDiff.planned_qty_units = newUnits;
    if (area !== (line.area ?? "") && area !== "") lineDiff.area = area;
    const origDeadline = line.deadline_date ? line.deadline_date.slice(0, 10) : "";
    if (deadline !== origDeadline && deadline !== "") lineDiff.deadline_date = deadline;

    // Step diffs: separate deletes, value changes, and reorder.
    const deletes: number[] = stepDrafts
      .filter((s) => s.isDeleted && s.step_id != null)
      .map((s) => s.step_id as number);

    const patches: { step_id: number; body: UpdatePlanStepBody }[] = [];
    const originalById = new Map<number, PlanStepRow>();
    (line.steps ?? []).forEach((s) => {
      if (s.step_id != null) originalById.set(s.step_id, s);
    });
    stepDrafts.forEach((d) => {
      if (d.isDeleted || d.step_id == null) return;
      const orig = originalById.get(d.step_id);
      if (!orig) return;
      const body: UpdatePlanStepBody = {};
      if ((d.process_name ?? "") !== (orig.process_name ?? "")) body.process_name = d.process_name ?? "";
      if ((d.stage ?? "") !== (orig.stage ?? "")) body.stage = d.stage ?? "";
      if ((d.floor ?? null) !== (orig.floor ?? null)) body.floor = d.floor;
      const origTime = orig.std_time_min != null ? Number(orig.std_time_min) : null;
      const origLoss = orig.loss_pct != null ? Number(orig.loss_pct) : null;
      if (d.std_time_min !== origTime) body.std_time_min = d.std_time_min;
      if (d.loss_pct !== origLoss) body.loss_pct = d.loss_pct;
      if (Object.keys(body).length > 0) patches.push({ step_id: d.step_id, body });
    });

    // New steps: drafts with step_id == null (created via Add Step).
    // Caller MUST have picked a process_name — server's StepV2Add
    // requires it. We validate up front so the POST round-trip
    // doesn't waste a request to surface a fixable error.
    const newSteps = stepDrafts.filter((s) => !s.isDeleted && s.step_id == null);
    for (const ns of newSteps) {
      if (!ns.process_name || !ns.process_name.trim()) {
        onMessage("Pick a process for every new step before saving.");
        return;
      }
    }

    // Reorder: surviving step_ids in their new order. Compare against the
    // original step_id sequence to know if reorder fired. New steps are
    // appended server-side AFTER reorder runs, so we don't need to
    // include them in the reorder body — they'll already be at the end.
    const survivingIds = stepDrafts
      .filter((s) => !s.isDeleted && s.step_id != null)
      .map((s) => s.step_id as number);
    const originalIds = (line.steps ?? [])
      .filter((s) => s.step_id != null && !deletes.includes(s.step_id))
      .map((s) => s.step_id as number);
    const orderChanged = survivingIds.length === originalIds.length &&
      survivingIds.some((id, i) => id !== originalIds[i]);

    if (
      Object.keys(lineDiff).length === 0 &&
      patches.length === 0 &&
      deletes.length === 0 &&
      newSteps.length === 0 &&
      !orderChanged
    ) {
      onMessage("Nothing to save.");
      return;
    }

    // Approved-plan path: route line-field changes through the R8
    // plan_field_change amendment. Step changes are blocked entirely on
    // approved plans because the amendment scope only covers line fields
    // — operator must cancel + recreate the plan if step structure needs
    // editing.
    if (requireApproval) {
      const stepsTouched = patches.length > 0 || deletes.length > 0
        || newSteps.length > 0 || orderChanged;
      if (stepsTouched) {
        onMessage(
          "Step edits aren't supported on approved plans yet. Cancel the plan and create a new revision, or revert the step changes and resubmit only line-level edits.",
        );
        return;
      }
      if (Object.keys(lineDiff).length === 0 || line.plan_line_id == null) {
        onMessage("Nothing to save.");
        return;
      }
      const reason = (window.prompt(
        "This plan is approved. Submit line edit for admin approval?\n\n"
        + "Provide a reason (≥ 20 characters):",
        "",
      ) ?? "").trim();
      if (!reason) {
        onMessage("Edit cancelled — no reason provided.");
        return;
      }
      if (reason.length < 20) {
        onMessage("Reason must be at least 20 characters.");
        return;
      }
      setBusy(true);
      onMessage(null);
      try {
        await submitPlanFieldChangeAmendment(
          {
            plan_id: planId,
            line_changes: [{ plan_line_id: line.plan_line_id, fields: lineDiff }],
          },
          reason,
        );
        onMessage("Line edit submitted for admin approval.");
        onSaved();
      } catch (e) {
        onMessage(`Submit failed: ${friendlyApiError(e)}`);
      } finally {
        setBusy(false);
      }
      return;
    }

    setBusy(true);
    onMessage(null);
    try {
      // Deletes first (so reorder only references existing step_ids).
      for (const id of deletes) {
        await deletePlanStep(id);
      }
      // Per-step PUTs in parallel.
      if (patches.length > 0) {
        await Promise.all(patches.map((p) => updatePlanStep(p.step_id, p.body)));
      }
      // Reorder before inserting new steps — the surviving-ids list
      // doesn't include the new ones yet, and the server appends
      // POSTed steps at the tail, so reorder + append gives the
      // correct final sequence in one pass.
      if (orderChanged && line.plan_line_id != null) {
        await reorderPlanSteps(line.plan_line_id, survivingIds);
      }
      // New steps appended sequentially so server-side step_number
      // assignment stays deterministic. (Parallel POSTs would race on
      // the per-line max+1 step_number SELECT.)
      if (newSteps.length > 0 && line.plan_line_id != null) {
        for (const ns of newSteps) {
          // Belt-and-braces stage derivation in case the dropdown
          // handler hadn't fired (e.g. operator pasted a value or the
          // draft was left in a partial state). Server has the same
          // fallback so this is purely to keep the wire payload clean.
          await addPlanStep(line.plan_line_id, {
            process_name: ns.process_name!,  // validated above
            stage:        ns.stage ?? stageFromProcess(ns.process_name),
            floor:        ns.floor ?? null,
            std_time_min: ns.std_time_min ?? null,
            loss_pct:     ns.loss_pct ?? null,
          });
        }
      }
      // Line PUT last so its successful response confirms the unit.
      if (Object.keys(lineDiff).length > 0 && line.plan_line_id != null) {
        await updatePlanLine(line.plan_line_id, lineDiff);
      }
      onMessage("Line saved.");
      onSaved();
    } catch (e) {
      onMessage(`Save failed: ${friendlyApiError(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="bg-white border-2 border-[var(--aws-orange)] rounded-md overflow-hidden">
      {/* Title strip — read-only SKU + customer; edit affordance row only */}
      <div className="px-3 py-2.5 flex items-start gap-3 border-b border-[var(--aws-border)] bg-[#fdf7f8]">
        <span className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full bg-[var(--aws-orange)] text-white text-[10px] font-bold mt-0.5">
          {idx}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-[var(--text-primary)] truncate" title={line.fg_sku_name ?? ""}>
            {line.fg_sku_name || "—"}
          </div>
          <div className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted)] truncate">
            {line.customer_name || "—"} · editing
          </div>
        </div>
      </div>

      {/* Line fields: qty + area + deadline */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 px-3 py-3 border-b border-[var(--aws-border)]">
        <label className="block">
          <span className="block text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)] mb-1">Qty (kg)</span>
          <input
            type="number"
            min={0}
            step="any"
            inputMode="decimal"
            value={qtyKg}
            onChange={(e) => setQtyKg(e.target.value)}
            className="w-full h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
          />
        </label>
        <label className="block">
          <span className="block text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)] mb-1">Qty (pcs)</span>
          <input
            type="number"
            min={0}
            step="1"
            inputMode="numeric"
            value={qtyUnits}
            onChange={(e) => setQtyUnits(e.target.value)}
            className="w-full h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
          />
        </label>
        <label className="block">
          <span className="block text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)] mb-1">Area / floor</span>
          {floors.length > 0 ? (
            <select
              value={area}
              onChange={(e) => setArea(e.target.value)}
              className="w-full h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
            >
              <option value="">— Any —</option>
              {floors.map((fl) => <option key={fl} value={fl}>{fl}</option>)}
            </select>
          ) : (
            <input
              type="text"
              value={area}
              onChange={(e) => setArea(e.target.value)}
              placeholder="Area name"
              className="w-full h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
            />
          )}
        </label>
        <label className="block">
          <span className="block text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)] mb-1">Deadline</span>
          <input
            type="date"
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
            className="w-full h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
          />
        </label>
      </div>

      {/* Editable steps */}
      {stepDrafts.length > 0 ? (
        <EditableStepsList
          activeSteps={activeSteps}
          floors={floors}
          mergeable={mergeable}
          selected={selectedSteps}
          dragOverIdx={dragOverIdx}
          onPatch={(activeIdx, patch) => {
            // Translate active idx → real idx in stepDrafts
            let active = -1;
            for (let i = 0; i < stepDrafts.length; i++) {
              if (!stepDrafts[i].isDeleted) {
                active++;
                if (active === activeIdx) {
                  patchStep(i, patch);
                  return;
                }
              }
            }
          }}
          onMove={(from, to) => moveStep(from, to)}
          onToggleSelect={toggleSelect}
          onSelectAll={selectAll}
          onMerge={fireMerge}
          onDragStartIdx={(idx) => { dragFromRef.current = idx; }}
          onDragOverIdx={(idx) => setDragOverIdx(idx)}
          onDragEnd={() => { dragFromRef.current = null; setDragOverIdx(null); }}
          onDrop={(toIdx) => {
            const from = dragFromRef.current;
            if (from != null && from !== toIdx) moveStep(from, toIdx);
            dragFromRef.current = null;
            setDragOverIdx(null);
          }}
        />
      ) : null}

      {/* Add Step row — sits just below the editable steps list, above
          Save/Cancel. Operator picks a process via the dropdown on the
          inserted row; the actual POST fires when they hit Save. Lives
          outside EditableStepsList so it renders even when the list is
          empty (e.g. a line that started with no steps for some reason). */}
      <div className="px-3 pb-2.5 pt-1 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={addStep}
          disabled={busy}
          className="inline-flex items-center gap-1 h-7 px-2.5 text-[11px] font-semibold rounded-[2px] border border-dashed border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-orange)] hover:text-[var(--aws-orange)] text-[var(--text-secondary)] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Add step
        </button>
        <p className="text-[10px] text-[var(--text-muted)] italic">
          New steps are appended at the end.
        </p>
      </div>

      {/* Save / Cancel footer */}
      <div className="px-3 py-2.5 bg-[var(--surface-subtle)] flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={busy}
          className="h-8 px-4 text-[12px] rounded-[2px] font-semibold border bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save line"}
        </button>
      </div>
    </li>
  );
}

// Editable steps list with reorder + merge + per-step floor / time / loss.
// Receives the *visible* (non-deleted) steps in display order; the parent
// translates active-index back to draft-index for state updates.
function EditableStepsList({
  activeSteps, floors, mergeable, selected, dragOverIdx,
  onPatch, onMove, onToggleSelect, onSelectAll, onMerge,
  onDragStartIdx, onDragOverIdx, onDragEnd, onDrop,
}: {
  activeSteps: StepDraft[];
  floors: readonly string[];
  mergeable: boolean;
  selected: Set<number>;
  dragOverIdx: number | null;
  onPatch: (activeIdx: number, patch: Partial<StepDraft>) => void;
  onMove: (from: number, to: number) => void;
  onToggleSelect: (activeIdx: number) => void;
  onSelectAll: (on: boolean) => void;
  onMerge: () => void;
  onDragStartIdx: (i: number) => void;
  onDragOverIdx: (i: number) => void;
  onDragEnd: () => void;
  onDrop: (i: number) => void;
}) {
  const allSelected = mergeable && selected.size === activeSteps.length;
  const anySelected = selected.size > 0;
  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)]">
          Process steps · {activeSteps.length}
        </span>
        <span className="text-[10px] text-[var(--text-muted)] hidden sm:inline">
          Drag to reorder · select 2+ to merge
        </span>
      </div>
      {mergeable ? (
        <div className="flex flex-wrap items-center gap-2 mb-1.5 px-2 py-1.5 bg-[var(--surface-subtle)] border border-[var(--aws-border)] rounded">
          <label className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)] cursor-pointer">
            <input
              type="checkbox"
              checked={allSelected}
              ref={(el) => { if (el) el.indeterminate = anySelected && !allSelected; }}
              onChange={(e) => onSelectAll(e.target.checked)}
              className="accent-[var(--aws-orange)]"
            />
            <span>Select all</span>
          </label>
          <span className="text-[11px] text-[var(--text-muted)]">·</span>
          <span className="text-[11px] text-[var(--text-secondary)]">
            <strong className="text-[var(--text-primary)]">{selected.size}</strong> selected
          </span>
          <div className="flex-1" />
          <button
            type="button"
            disabled={selected.size < 2}
            onClick={onMerge}
            title="Combine selected steps · time SUM, name joined with +"
            className={[
              "h-7 px-2.5 text-[11px] rounded-[2px] font-semibold border inline-flex items-center gap-1.5",
              selected.size < 2
                ? "bg-[var(--surface-disabled)] border-[var(--aws-border)] text-[var(--text-disabled)] cursor-not-allowed"
                : "bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white",
            ].join(" ")}
          >
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <polyline points="8 12 3 12 8 7" />
              <polyline points="16 12 21 12 16 17" />
              <line x1="3" y1="12" x2="21" y2="12" />
            </svg>
            Merge selected
          </button>
        </div>
      ) : null}
      <ol className="space-y-1">
        {activeSteps.map((s, i) => {
          const isDragOver = dragOverIdx === i;
          return (
            <li
              key={s.step_id ?? `new-${i}`}
              draggable
              onDragStart={(e) => {
                onDragStartIdx(i);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", String(i));
              }}
              onDragEnd={onDragEnd}
              onDragOver={(e) => { e.preventDefault(); onDragOverIdx(i); }}
              onDrop={(e) => { e.preventDefault(); onDrop(i); }}
              className={[
                "border rounded bg-white px-2 py-1.5 grid grid-cols-1 sm:grid-cols-[auto_auto_minmax(0,1fr)_auto_auto_auto_auto] gap-1.5 sm:gap-2 items-center",
                isDragOver ? "border-[var(--aws-orange)] bg-[#fdf0f1]" : "border-[var(--aws-border)]",
              ].join(" ")}
            >
              {mergeable ? (
                <label className="shrink-0 inline-flex items-center justify-center w-7 h-7 -m-1 cursor-pointer" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selected.has(i)}
                    onChange={() => onToggleSelect(i)}
                    className="accent-[var(--aws-orange)]"
                  />
                </label>
              ) : <span />}
              <span aria-hidden className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full bg-[var(--aws-navy)] text-white text-[10px] font-bold">{i + 1}</span>
              {/* process_name is now editable via PROCESS_OPTIONS
                  dropdown. Legacy BOM values not in the canonical list
                  get a synthetic "(custom)" option so they stay
                  visible. stage stays read-only — it's a BOM-level
                  identity tag the operator doesn't reclassify. */}
              <div className="flex-1 min-w-0 space-y-0.5">
                {(() => {
                  const current = s.process_name ?? "";
                  const inCatalog =
                    current === "" ||
                    PROCESS_OPTIONS.some(
                      (p) => p.toLowerCase() === current.toLowerCase(),
                    );
                  return (
                    <select
                      value={current}
                      onChange={(e) => {
                        // stage tracks process_name so the row stays
                        // valid for the downstream job_card_v2.stage
                        // NOT NULL constraint when the plan is approved.
                        const picked = canonProcess(e.target.value || null);
                        onPatch(i, {
                          process_name: picked,
                          stage: stageFromProcess(picked),
                        });
                      }}
                      title="Pick the process for this step"
                      className="w-full h-7 px-1.5 text-[12px] font-semibold rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] text-[var(--text-primary)]"
                    >
                      <option value="">— Process —</option>
                      {!inCatalog && current ? (
                        <option value={current}>{current} (custom)</option>
                      ) : null}
                      {PROCESS_OPTIONS.map((p) => (
                        <option key={p} value={p}>{p}</option>
                      ))}
                    </select>
                  );
                })()}
                {s.stage ? (
                  <div className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted)] truncate" title={s.stage}>
                    {s.stage}
                  </div>
                ) : null}
              </div>
              <select
                value={s.floor ?? ""}
                onChange={(e) => onPatch(i, { floor: e.target.value || null })}
                disabled={floors.length === 0}
                className="h-7 w-full sm:w-[160px] px-2 text-[11px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] disabled:bg-[var(--surface-disabled)] disabled:text-[var(--text-disabled)]"
              >
                <option value="">{floors.length === 0 ? "— Pick warehouse —" : "— Any floor —"}</option>
                {floors.map((fl) => <option key={fl} value={fl}>{fl}</option>)}
              </select>
              {/* Trailing trio: std_time, loss%, reorder buttons.
                  On mobile (< sm) the wrapper is a flex row so all three
                  fit on a single compact line instead of stacking into
                  three full-width grid rows. On sm+ `sm:contents` makes
                  the wrapper transparent to the grid so each child lands
                  in its own column as before. */}
              <div className="flex items-center gap-1.5 sm:contents">
                <input
                  type="number"
                  min={0}
                  step="any"
                  inputMode="decimal"
                  value={s.std_time_min ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    onPatch(i, { std_time_min: v === "" ? null : Number(v) });
                  }}
                  placeholder="min"
                  title="Standard time (min)"
                  className="h-7 flex-1 min-w-0 sm:flex-none sm:w-[60px] px-1.5 text-[11px] text-right font-mono rounded-[2px] bg-white border border-[var(--aws-border)] outline-none focus:border-[#9a393e]"
                />
                <input
                  type="number"
                  min={0}
                  max={100}
                  step="any"
                  inputMode="decimal"
                  value={s.loss_pct ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    onPatch(i, { loss_pct: v === "" ? null : Number(v) });
                  }}
                  placeholder="loss%"
                  title="Loss %"
                  className="h-7 flex-1 min-w-0 sm:flex-none sm:w-[60px] px-1.5 text-[11px] text-right font-mono rounded-[2px] bg-white border border-[var(--aws-border)] outline-none focus:border-[#9a393e]"
                />
                <div className="flex items-center gap-0.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => onMove(i, i - 1)}
                    disabled={i === 0}
                    aria-label="Move step up"
                    className="w-7 h-7 inline-flex items-center justify-center rounded-sm text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)] disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 15 12 9 18 15" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => onMove(i, i + 1)}
                    disabled={i === activeSteps.length - 1}
                    aria-label="Move step down"
                    className="w-7 h-7 inline-flex items-center justify-center rounded-sm text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)] disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function MetaKV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="px-3 py-1.5 min-w-0">
      <dt className="uppercase tracking-wide font-semibold text-[var(--text-muted)] text-[9px] leading-[12px]">
        {label}
      </dt>
      <dd className="text-[12px] text-[var(--text-primary)] truncate">{value}</dd>
    </div>
  );
}

// Steps as a precise table. Horizontal scroll on narrow viewports preserves
// column alignment — the previous step-card chain made fast scanning hard
// because each cell's position changed across cards.
function StepsTable({ steps }: { steps: PlanStepRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px] border-collapse">
        <thead className="bg-[var(--surface-subtle)] text-[var(--text-muted)]">
          <tr>
            <th className="px-3 py-1.5 text-left text-[10px] font-bold uppercase tracking-wide w-[36px]">#</th>
            <th className="px-3 py-1.5 text-left text-[10px] font-bold uppercase tracking-wide">Process</th>
            <th className="px-3 py-1.5 text-left text-[10px] font-bold uppercase tracking-wide">Stage</th>
            <th className="px-3 py-1.5 text-left text-[10px] font-bold uppercase tracking-wide">Floor</th>
            <th className="px-3 py-1.5 text-right text-[10px] font-bold uppercase tracking-wide whitespace-nowrap">Min</th>
            <th className="px-3 py-1.5 text-right text-[10px] font-bold uppercase tracking-wide whitespace-nowrap">Loss</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s, i) => {
            const hasFloor = !!s.floor;
            return (
              <tr key={s.step_id ?? i} className="border-t border-[var(--aws-border)]">
                <td className="px-3 py-1.5 font-mono text-[11px] text-[var(--text-muted)]">
                  {s.step_order ?? i + 1}
                </td>
                <td className="px-3 py-1.5 font-medium text-[var(--text-primary)] max-w-[220px] truncate" title={s.process_name ?? ""}>
                  {s.process_name || "—"}
                </td>
                <td className="px-3 py-1.5 text-[var(--text-secondary)] max-w-[160px] truncate" title={s.stage ?? ""}>
                  {s.stage || "—"}
                </td>
                <td className="px-3 py-1.5 max-w-[180px] truncate" title={s.floor ?? ""}>
                  {hasFloor ? (
                    <span className="text-[var(--text-primary)]">{s.floor}</span>
                  ) : (
                    <span className="text-[var(--aws-error)] italic text-[11px]">not set</span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-[11px] whitespace-nowrap">
                  {s.std_time_min != null ? String(s.std_time_min) : <span className="text-[var(--text-muted)]">—</span>}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-[11px] whitespace-nowrap">
                  {s.loss_pct != null && Number(s.loss_pct) > 0 ? `${String(s.loss_pct)}%` : <span className="text-[var(--text-muted)]">—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Confirm modal ──────────────────────────────────────────────────────

function ConfirmModal({
  kind, detail, reason, setReason, busy, onConfirm, onDismiss,
}: {
  kind: "approve" | "cancel" | "delete";
  detail: PlanDetail;
  reason: string;
  setReason: (s: string) => void;
  busy: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const planLabel = detail.plan_name || `Plan #${detail.plan_id}`;
  const lineCount = detail.lines?.length ?? 0;

  const title =
    kind === "approve" ? "Approve plan"
    : kind === "cancel"  ? "Cancel plan"
    :                       "Delete plan";

  const cta =
    kind === "approve" ? (busy ? "Approving…" : "Approve")
    : kind === "cancel"  ? (busy ? "Cancelling…" : "Cancel plan")
    :                       (busy ? "Deleting…"  : "Delete plan");

  const isDestructive = kind === "cancel" || kind === "delete";
  // Both cancel and delete need a reason. Approve doesn't.
  const needsReason = isDestructive;
  // Delete requires a non-empty reason (server enforces too).
  const submitDisabled = busy || (kind === "delete" && reason.trim().length === 0);

  return (
    <div
      className="fixed inset-0 z-30 bg-black/40 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onDismiss(); }}
    >
      <div className="w-full max-w-md bg-white border border-[var(--aws-border)] rounded-md shadow-[0_8px_24px_rgba(0,28,36,0.25)]">
        <div className="px-4 py-3 border-b border-[var(--aws-border)] flex items-center justify-between">
          <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">{title}</h3>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Close"
            className="w-7 h-7 inline-flex items-center justify-center rounded-sm text-[var(--text-muted)] hover:bg-[var(--surface-subtle)]"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="px-4 py-4">
          <p className="text-[13px] text-[var(--text-primary)] mb-1"><strong>{planLabel}</strong></p>
          <p className="text-[12px] text-[var(--text-secondary)] mb-3">
            {detail.warehouse ? `${detail.warehouse} · ` : ""}
            {lineCount} line{lineCount === 1 ? "" : "s"}
            {detail.total_planned_kg ? ` · ${fmtPlanKg(detail.total_planned_kg)} kg` : ""}
          </p>
          {kind === "approve" ? (
            <p className="text-[12px] text-[var(--text-secondary)]">
              Approving locks the plan and auto-generates per-floor job cards from the BOM process route.
              This cannot be reverted directly — to void an approved plan, cancel each generated job card.
            </p>
          ) : kind === "cancel" ? (
            <p className="text-[12px] text-[var(--text-secondary)] mb-2">
              Cancellation releases the reserved fulfillment quantity back to pending. Only valid while the plan is in <strong>draft</strong>.
            </p>
          ) : (
            // delete
            <div className="text-[12px] text-[var(--text-secondary)] space-y-2 mb-2">
              <p>
                Deletion releases the reserved fulfillment quantity back to pending and marks
                the plan as cancelled with an audit reason.
              </p>
              <div className="border border-[var(--aws-error)] bg-[#fdf3f1] rounded-sm px-2.5 py-2 text-[11px] text-[var(--text-primary)] flex items-start gap-2">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--aws-error)] mt-0.5">
                  <path d="M12 9v4" />
                  <path d="M12 17h.01" />
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                </svg>
                <span>
                  <strong>Admin notification:</strong> every active admin will receive an email
                  with the plan id, warehouse, your name, and the reason below. Per-floor job cards
                  already generated are <strong>NOT</strong> auto-cancelled — review them separately.
                </span>
              </div>
            </div>
          )}
          {needsReason ? (
            <label className="block">
              <span className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">
                Reason {kind === "delete" ? <span className="text-[var(--aws-error)]">*</span> : null}
              </span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                placeholder={kind === "delete"
                  ? "Why is this approved plan being deleted? (included in the admin email)"
                  : "Why is this plan being cancelled?"
                }
                className="w-full px-2 py-1.5 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] resize-none"
              />
            </label>
          ) : null}
        </div>
        <div className="px-4 py-3 border-t border-[var(--aws-border)] flex justify-end gap-2">
          <button
            type="button"
            onClick={onDismiss}
            disabled={busy}
            className="h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] disabled:opacity-50"
          >
            Dismiss
          </button>
          {kind === "approve" ? (
            <button
              type="button"
              onClick={onConfirm}
              disabled={submitDisabled}
              className="h-8 px-4 text-[12px] rounded-[2px] font-semibold border bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white disabled:opacity-50"
            >
              {cta}
            </button>
          ) : (
            <button
              type="button"
              onClick={onConfirm}
              disabled={submitDisabled}
              className="h-8 px-4 text-[12px] rounded-[2px] font-semibold border border-[var(--aws-error)] bg-white text-[var(--aws-error)] hover:bg-[#fdf3f1] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {cta}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Edit modal ──────────────────────────────────────────────────────────
//
// Lets the operator edit the four server-allowed header fields: plan_date,
// date_from, date_to, plan_type. The submit diffs against the original
// snapshot and forwards ONLY the changed values to updatePlan() — fields
// the operator didn't touch never appear on the wire, so the server's
// own None-filter leaves the corresponding columns unchanged.

function EditModal({
  detail, busy, onSubmit, onDismiss,
}: {
  detail: PlanDetail;
  busy: boolean;
  onSubmit: (patch: UpdatePlanBody) => void;
  onDismiss: () => void;
}) {
  const initial = {
    plan_date: (detail.plan_date ?? "").slice(0, 10),
    date_from: (detail.date_from ?? "").slice(0, 10),
    date_to:   (detail.date_to   ?? "").slice(0, 10),
    plan_type: detail.plan_type ?? "",
  };
  const [planDate, setPlanDate] = useState(initial.plan_date);
  const [dateFrom, setDateFrom] = useState(initial.date_from);
  const [dateTo,   setDateTo]   = useState(initial.date_to);
  const [planType, setPlanType] = useState(initial.plan_type);

  // Build the diff. Each field only goes on the wire if it actually
  // changed AND the new value is non-empty (we don't let an empty string
  // overwrite a populated server value).
  const patch: UpdatePlanBody = {};
  if (planDate && planDate !== initial.plan_date) patch.plan_date = planDate;
  if (dateFrom && dateFrom !== initial.date_from) patch.date_from = dateFrom;
  if (dateTo   && dateTo   !== initial.date_to)   patch.date_to   = dateTo;
  if (planType && planType !== initial.plan_type) patch.plan_type = planType;
  const changedCount = Object.keys(patch).length;
  const submitDisabled = busy || changedCount === 0;

  // Local validation: date_to must be >= date_from when both are set.
  const dateOrderError =
    dateFrom && dateTo && dateTo < dateFrom
      ? "End date must be on or after the start date."
      : null;

  return (
    <div
      className="fixed inset-0 z-30 bg-black/40 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onDismiss(); }}
    >
      <div className="w-full max-w-lg bg-white border border-[var(--aws-border)] rounded-md shadow-[0_8px_24px_rgba(0,28,36,0.25)]">
        <div className="px-4 py-3 border-b border-[var(--aws-border)] flex items-center justify-between">
          <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">Edit plan</h3>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Close"
            className="w-7 h-7 inline-flex items-center justify-center rounded-sm text-[var(--text-muted)] hover:bg-[var(--surface-subtle)]"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="px-4 py-4">
          <p className="text-[11px] text-[var(--text-muted)] mb-3">
            Only the fields you change are sent to the server. Everything else stays exactly as it was.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
            <label className="block">
              <span className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">Plan date</span>
              <input
                type="date"
                value={planDate}
                onChange={(e) => setPlanDate(e.target.value)}
                className="w-full h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
              />
            </label>
            <label className="block">
              <span className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">Plan type</span>
              <select
                value={planType}
                onChange={(e) => setPlanType(e.target.value)}
                className="w-full h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </label>
            <label className="block">
              <span className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">Period start</span>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="w-full h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
              />
            </label>
            <label className="block">
              <span className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">Period end</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-full h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
              />
            </label>
          </div>
          {dateOrderError ? (
            <p className="text-[11px] text-[var(--aws-error)] mb-2">{dateOrderError}</p>
          ) : null}
          <p className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)]">
            {changedCount === 0
              ? "No changes yet"
              : `${changedCount} field${changedCount === 1 ? "" : "s"} will be updated`}
          </p>
        </div>
        <div className="px-4 py-3 border-t border-[var(--aws-border)] flex justify-end gap-2">
          <button
            type="button"
            onClick={onDismiss}
            disabled={busy}
            className="h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] disabled:opacity-50"
          >
            Dismiss
          </button>
          <button
            type="button"
            onClick={() => onSubmit(patch)}
            disabled={submitDisabled || !!dateOrderError}
            className="h-8 px-4 text-[12px] rounded-[2px] font-semibold border bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Chrome ──────────────────────────────────────────────────────────────

function PageHeader({ initial, router }: { initial: string; router: ReturnType<typeof useRouter> }) {
  return (
    <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-6 gap-4">
      <BrandMark />
      <span className="text-[#d5dbdb] text-[13px] hidden sm:inline">Console</span>
      <nav className="text-[12px] text-[#d5dbdb] hidden md:flex items-center gap-2 ml-2">
        <button onClick={() => router.push("/modules")} className="hover:underline">Modules</button>
        <span>/</span>
        <button onClick={() => router.push("/modules/production")} className="hover:underline">Production</button>
        <span>/</span>
        <button onClick={() => router.push("/modules/production/plan-list")} className="hover:underline">Plan List</button>
        <span>/</span>
        <span className="text-white">Approval</span>
      </nav>
      <div className="flex-1" />
      <button
        onClick={() => router.push("/modules/profile")}
        aria-label="Open profile"
        title="Profile"
        className="w-8 h-8 rounded-full bg-[var(--aws-orange)] text-white text-[13px] font-bold flex items-center justify-center hover:bg-[var(--aws-orange-hover)]"
      >
        {initial}
      </button>
    </header>
  );
}

function Footer() {
  return (
    <footer className="border-t border-[var(--aws-border)] bg-white py-3 px-6 text-[11px] text-[var(--text-secondary)] flex flex-wrap justify-center gap-x-4 gap-y-1">
      <a href="#" className="hover:underline">Privacy</a>
      <span>© {new Date().getFullYear()}</span>
    </footer>
  );
}

function Centered({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return (
    <div
      className={[
        "bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[13px]",
        tone === "error" ? "text-[var(--aws-error)]" : "text-[var(--text-secondary)]",
      ].join(" ")}
    >
      {children}
    </div>
  );
}

// ── Badges ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status?: string | null }) {
  const s = (status || "draft").toLowerCase();
  const styles: Record<string, string> = {
    draft:     "text-[var(--aws-link)] bg-[#eaf3ff] border-[#bbd9f3]",
    approved:  "text-[#1d8102] bg-[#eaf6ed] border-[#b6dbb1]",
    executed:  "text-[#5752c4] bg-[#f0eef8] border-[#d2cef0]",
    cancelled: "text-[var(--text-muted)] bg-[var(--surface-subtle)] border-[var(--aws-border)]",
  };
  const cls = styles[s] ?? "text-[var(--text-secondary)] bg-[#f4f4f4] border-[#d5dbdb]";
  return (
    <span className={["inline-block text-[10px] font-semibold capitalize px-1.5 py-0.5 rounded-sm border", cls].join(" ")}>
      {s}
    </span>
  );
}

