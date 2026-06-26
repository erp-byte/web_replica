"use client";

// C11 (Wave 4) — R8 maker-checker amendments UI for the JC detail page.
//
// Wires the five backend endpoints (mounted at /api/v1/production/amendments):
//
//   POST   /amendments                  - create (maker)
//   GET    /amendments?job_card_id=…    - list for this JC
//   POST   /amendments/{id}/approve     - approve (checker1 → pending_final
//                                          → final approve closes the loop)
//   POST   /amendments/{id}/reject      - reject (any checker)
//   POST   /amendments/{id}/withdraw    - withdraw (maker)
//
// Server status vocabulary (bom_amendment_request_v2.status):
//   pending_review → first checker pending
//   pending_final  → first approved; final checker pending (two-checker only)
//   approved       → final approved, payload applied
//   rejected       → any checker rejected
//   withdrawn      → maker withdrew before approval
//
// Maker / checker role matrix mirrors router_amendments.py (single-source-
// of-truth on the server — we replicate the lookup here only for which
// CTAs to render; the server still enforces every transition).
//
// Responsive contract (memory: web-replica-responsive-design):
//   - Modal full-screen on sm; centred dialog on md+.
//   - List cards stack on sm; grid 2-col on lg+.
//   - Reason / payload textareas grow vertically; never overflow horizontally.
//   - 360px stress-tested: textarea + buttons reflow without overflow-x.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/auth";
import { useMe } from "@/lib/user";
import { friendlyApiError } from "@/lib/apiErrors";
import { ActionButton } from "./_ActionButton";

// ── Role matrix (mirrors server_replica/router_amendments.py) ────────────

const MAKER_ROLES: Record<string, ReadonlySet<string>> = {
  one_off_material_add:      new Set(["team_leader"]),
  one_off_material_remove:   new Set(["team_leader"]),
  permanent_bom_add:         new Set(["floor_manager"]),
  permanent_bom_remove:      new Set(["floor_manager"]),
  permanent_bom_qty_change:  new Set(["floor_manager"]),
  plan_delete:               new Set(["planner"]),
  stop_process:              new Set(["floor_manager"]),
  force_unlock:              new Set(["floor_manager"]),
  uom_correction:            new Set(["planner"]),
  ncr_disposition:           new Set(["qc_inspector"]),
  unbalanced_close_override: new Set(["floor_manager"]),
  ega_override:              new Set(["team_leader"]),
};

const CHECKER1_ROLES: Record<string, ReadonlySet<string>> = {
  one_off_material_add:      new Set(["floor_manager"]),
  one_off_material_remove:   new Set(["floor_manager"]),
  permanent_bom_add:         new Set(["planner"]),
  permanent_bom_remove:      new Set(["planner"]),
  permanent_bom_qty_change:  new Set(["planner"]),
  plan_delete:               new Set(["admin", "production_manager"]),
  stop_process:              new Set(["admin", "production_manager"]),
  force_unlock:              new Set(["admin"]),
  uom_correction:            new Set(["admin"]),
  ncr_disposition:           new Set(["floor_manager"]),
  unbalanced_close_override: new Set(["admin", "production_manager"]),
  ega_override:              new Set(["floor_manager"]),
};

const CHECKER2_ROLES: Record<string, ReadonlySet<string>> = {
  permanent_bom_add:         new Set(["admin"]),
  permanent_bom_remove:      new Set(["admin"]),
  permanent_bom_qty_change:  new Set(["admin"]),
};

// Union of every maker role across all request types — used to gate the
// "Propose Amendment" CTA itself (admin bypass is handled by ActionButton).
const ANY_MAKER_ROLES_LIST = Array.from(
  new Set(Object.values(MAKER_ROLES).flatMap((s) => Array.from(s))),
).sort();
const ANY_MAKER_ROLES_ALLOW = ANY_MAKER_ROLES_LIST.join(",");

const REQUEST_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "one_off_material_add",      label: "One-off material — Add" },
  { value: "one_off_material_remove",   label: "One-off material — Remove" },
  { value: "permanent_bom_add",         label: "Permanent BOM — Add" },
  { value: "permanent_bom_remove",      label: "Permanent BOM — Remove" },
  { value: "permanent_bom_qty_change",  label: "Permanent BOM — Qty change" },
  { value: "plan_delete",               label: "Plan delete" },
  { value: "stop_process",              label: "Stop process" },
  { value: "force_unlock",              label: "Force unlock" },
  { value: "uom_correction",            label: "UoM correction" },
  { value: "ncr_disposition",           label: "NCR disposition" },
  { value: "unbalanced_close_override", label: "Unbalanced close override" },
  { value: "ega_override",              label: "EGA override" },
];

const STATUS_STYLES: Record<string, { bg: string; fg: string; ring: string }> = {
  pending_review: { bg: "#eaf3ff", fg: "#5752c4", ring: "#bbd9f3" },
  pending_final:  { bg: "#fff8e1", fg: "#7a5d0c", ring: "#f3d27a" },
  approved:       { bg: "#eaf6ed", fg: "#1d8102", ring: "#b6dbb1" },
  rejected:       { bg: "#fdf3f1", fg: "#b1361e", ring: "#f0c7be" },
  withdrawn:      { bg: "#f4f4f4", fg: "#687078", ring: "#d5dbdb" },
};

// ── Types ────────────────────────────────────────────────────────────────

export interface AmendmentRow {
  request_id: number;
  request_type: string;
  job_card_id: number | null;
  bom_id: number | null;
  status: string;
  payload: Record<string, unknown> | null;
  reason: string | null;
  maker_user_id: number | null;
  maker_name: string | null;
  checker1_user_id: number | null;
  checker1_name: string | null;
  checker1_note: string | null;
  checker2_user_id: number | null;
  checker2_name: string | null;
  checker2_note: string | null;
  rejection_reason: string | null;
  created_at: string | null;
  updated_at: string | null;
}

type ListResponse = {
  results?: AmendmentRow[];
  total?: number;
};

// ── Shared error envelope reader (matches detail page readErrMsg) ────────

async function readErrMsg(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { message?: string; error?: string } | null;
    if (data && (data.message || data.error)) {
      return String(data.message || data.error);
    }
  } catch {
    /* fall through */
  }
  return fallback;
}

// ── Role-membership helpers ───────────────────────────────────────────────

function userRoleCodes(me: ReturnType<typeof useMe>): Set<string> {
  const codes = new Set<string>();
  if (!me) return codes;
  if (typeof me.role_name === "string") codes.add(me.role_name);
  const roles = Array.isArray(me.roles) ? me.roles : [];
  for (const r of roles) {
    if (typeof r === "string") {
      codes.add(r);
    } else if (r && typeof r === "object") {
      const c = (r.code ?? r.role_name ?? "") as string;
      if (c) codes.add(c);
    }
  }
  return codes;
}

function isAdminMe(me: ReturnType<typeof useMe>): boolean {
  if (!me) return false;
  if (me.is_admin === true) return true;
  const roles = Array.isArray(me.roles) ? me.roles : [];
  return roles.some((r) => {
    if (typeof r === "string") return r === "admin";
    if (!r || typeof r !== "object") return false;
    if (r.is_admin === true) return true;
    const c = (r.code ?? r.role_name ?? "") as string;
    return c === "admin";
  });
}

// ── Tab component ────────────────────────────────────────────────────────

export function AmendmentsTab({ jcId }: { jcId: number }) {
  const me = useMe();
  const myRoles = useMemo(() => userRoleCodes(me), [me]);
  const isAdmin = useMemo(() => isAdminMe(me), [me]);

  const [rows, setRows] = useState<AmendmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/v1/production/amendments?job_card_id=${jcId}&page_size=100`, { signal });
      if (signal?.aborted) return;
      if (!res.ok) {
        const msg = await readErrMsg(res, `HTTP ${res.status}`);
        throw new Error(msg);
      }
      const data = (await res.json()) as ListResponse | AmendmentRow[];
      const results = Array.isArray(data) ? data : data.results ?? [];
      // Newest first — backend may return either order depending on version.
      const sorted = [...results].sort((a, b) => {
        const at = a.created_at ?? "";
        const bt = b.created_at ?? "";
        if (at !== bt) return at < bt ? 1 : -1;
        return b.request_id - a.request_id;
      });
      setRows(sorted);
    } catch (e) {
      if (signal?.aborted) return;
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(friendlyApiError(e));
      setRows([]);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [jcId]);

  useEffect(() => {
    const ctrl = new AbortController();
    // Deferred past the synchronous effect body so the
    // react-hooks/set-state-in-effect lint stays happy (refresh() flips
    // setLoading(true) inline). Same pattern the detail page's fetch
    // effect uses.
    queueMicrotask(() => { void refresh(ctrl.signal); });
    return () => ctrl.abort();
  }, [refresh]);

  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] p-4 sm:p-5 mb-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div>
          <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">
            Amendments
          </h3>
          <p className="text-[11px] text-[var(--text-secondary)] mt-0.5">
            Maker-checker proposals to modify BOM, plan, or JC state.
          </p>
        </div>
        <ActionButton
          roleAllow={ANY_MAKER_ROLES_ALLOW}
          onClick={() => {
            setFeedback(null);
            setModalOpen(true);
          }}
          variant="primary"
        >
          Propose amendment
        </ActionButton>
      </div>

      {feedback ? (
        <div
          className={[
            "mb-3 px-3 py-2 rounded-sm border text-[12px]",
            feedback.kind === "ok"
              ? "bg-[#eaf6ed] border-[#b6dbb1] text-[var(--text-success)]"
              : "bg-[#fdf3f1] border-[#f0c7be] text-[var(--aws-error)]",
          ].join(" ")}
        >
          {feedback.msg}
        </div>
      ) : null}

      {loading ? (
        <div className="text-[12px] text-[var(--text-muted)] italic py-6 text-center">
          Loading amendments…
        </div>
      ) : error ? (
        <div className="text-[12px] text-[var(--aws-error)] py-6 text-center">
          {error}{" "}
          <button onClick={() => void refresh()} className="underline ml-2 text-[var(--aws-link)]">
            retry
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div className="text-[12px] text-[var(--text-muted)] italic py-6 text-center">
          No amendments proposed for this JC.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {rows.map((row) => (
            <AmendmentCard
              key={row.request_id}
              row={row}
              myRoles={myRoles}
              isAdmin={isAdmin}
              meUserId={me?.user_id != null ? String(me.user_id) : null}
              onActed={(ok, msg) => {
                setFeedback({ kind: ok ? "ok" : "err", msg });
                if (ok) void refresh();
              }}
            />
          ))}
        </div>
      )}

      {modalOpen ? (
        <ProposeAmendmentModal
          jcId={jcId}
          myRoles={myRoles}
          isAdmin={isAdmin}
          onClose={() => setModalOpen(false)}
          onCreated={(msg) => {
            setModalOpen(false);
            setFeedback({ kind: "ok", msg });
            void refresh();
          }}
        />
      ) : null}
    </div>
  );
}

// ── Per-amendment card ───────────────────────────────────────────────────

function AmendmentCard({
  row,
  myRoles,
  isAdmin,
  meUserId,
  onActed,
}: {
  row: AmendmentRow;
  myRoles: Set<string>;
  isAdmin: boolean;
  meUserId: string | null;
  onActed: (ok: boolean, msg: string) => void;
}) {
  const [payloadOpen, setPayloadOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const status = row.status ?? "";
  const style = STATUS_STYLES[status] ?? { bg: "#f4f4f4", fg: "#414d5c", ring: "#d5dbdb" };

  // Decide which CTA(s) to surface. The server is the authority — these
  // gates just decide visibility so checkers see actionable items only.
  //   pending_review → first-checker approve / reject visible to checker1
  //                    roles for this request_type.
  //   pending_final  → second-checker approve / reject visible to checker2
  //                    roles for this request_type (two-checker types only).
  //   any pending    → withdraw visible to the maker.
  const checker1Allow = CHECKER1_ROLES[row.request_type] ?? new Set<string>();
  const checker2Allow = CHECKER2_ROLES[row.request_type] ?? new Set<string>();
  const meIsChecker1 = isAdmin || Array.from(checker1Allow).some((r) => myRoles.has(r));
  const meIsChecker2 = isAdmin || Array.from(checker2Allow).some((r) => myRoles.has(r));
  const meIsMaker = meUserId != null && String(row.maker_user_id) === meUserId;

  const showApproveReject =
    (status === "pending_review" && meIsChecker1) ||
    (status === "pending_final" && meIsChecker2);
  const showWithdraw =
    (status === "pending_review" || status === "pending_final") && meIsMaker;

  async function call(action: "approve" | "reject" | "withdraw") {
    if (busy) return;
    let body: Record<string, unknown> = {};
    if (action === "reject") {
      const reason = window.prompt("Reject amendment — reason:");
      if (reason == null) return;
      if (!reason.trim()) {
        onActed(false, "Rejection reason is required.");
        return;
      }
      body = { rejection_reason: reason.trim() };
    } else if (action === "approve") {
      const note = window.prompt("Approval note (optional):", "");
      if (note == null) return; // user cancelled
      body = note.trim() ? { note: note.trim() } : {};
    }
    setBusy(true);
    try {
      const res = await apiFetch(`/api/v1/production/amendments/${row.request_id}/${action}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const msg = await readErrMsg(res, `HTTP ${res.status}`);
        throw new Error(msg);
      }
      onActed(true, `Amendment ${action}d.`);
    } catch (e) {
      onActed(false, friendlyApiError(e));
    } finally {
      setBusy(false);
    }
  }

  const requestLabel =
    REQUEST_TYPE_OPTIONS.find((o) => o.value === row.request_type)?.label
    ?? row.request_type.replace(/_/g, " ");

  return (
    <div className="border border-[var(--aws-border)] rounded-md bg-[var(--surface-subtle)] p-3 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2 min-w-0">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-[var(--text-primary)] truncate" title={requestLabel}>
            {requestLabel}
          </div>
          <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mt-0.5">
            #{row.request_id} · {row.maker_name ?? "—"} · {fmtDate(row.created_at)}
          </div>
        </div>
        <span
          className="shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-sm capitalize"
          style={{ background: style.bg, color: style.fg, border: `1px solid ${style.ring}` }}
        >
          {status.replace(/_/g, " ")}
        </span>
      </div>

      {row.reason ? (
        <div className="text-[12px] text-[var(--text-primary)] whitespace-pre-wrap break-words">
          <span className="font-semibold text-[var(--text-muted)] mr-1">Reason:</span>
          {row.reason}
        </div>
      ) : null}

      {row.checker1_note ? (
        <div className="text-[11px] text-[var(--text-secondary)] break-words">
          <span className="font-semibold mr-1">Checker 1 ({row.checker1_name ?? "—"}):</span>
          {row.checker1_note}
        </div>
      ) : null}
      {row.checker2_note ? (
        <div className="text-[11px] text-[var(--text-secondary)] break-words">
          <span className="font-semibold mr-1">Checker 2 ({row.checker2_name ?? "—"}):</span>
          {row.checker2_note}
        </div>
      ) : null}
      {row.rejection_reason ? (
        <div className="text-[11px] text-[var(--aws-error)] break-words">
          <span className="font-semibold mr-1">Rejected:</span>
          {row.rejection_reason}
        </div>
      ) : null}

      {/* Payload preview — collapsible JSON. */}
      <div>
        <button
          type="button"
          onClick={() => setPayloadOpen((v) => !v)}
          className="text-[11px] text-[var(--aws-link)] hover:underline"
        >
          {payloadOpen ? "Hide" : "Show"} payload
        </button>
        {payloadOpen ? (
          <pre className="mt-1 text-[10px] bg-white border border-[var(--aws-border)] rounded-sm p-2 max-h-[200px] overflow-auto whitespace-pre-wrap break-words font-mono">
            {row.payload ? JSON.stringify(row.payload, null, 2) : "(no payload)"}
          </pre>
        ) : null}
      </div>

      {/* Footer actions */}
      {(showApproveReject || showWithdraw) ? (
        <div className="flex flex-wrap items-center gap-2 mt-1 pt-2 border-t border-[var(--aws-border)]">
          {showApproveReject ? (
            <>
              <ActionButton
                variant="primary"
                busy={busy}
                onClick={() => void call("approve")}
              >
                Approve
              </ActionButton>
              <ActionButton
                variant="danger"
                busy={busy}
                onClick={() => void call("reject")}
              >
                Reject
              </ActionButton>
            </>
          ) : null}
          {showWithdraw ? (
            <ActionButton
              variant="secondary"
              busy={busy}
              onClick={() => void call("withdraw")}
            >
              Withdraw
            </ActionButton>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ── Propose modal ────────────────────────────────────────────────────────

function ProposeAmendmentModal({
  jcId,
  myRoles,
  isAdmin,
  onClose,
  onCreated,
}: {
  jcId: number;
  myRoles: Set<string>;
  isAdmin: boolean;
  onClose: () => void;
  onCreated: (msg: string) => void;
}) {
  // Filter the dropdown to request types this user is permitted to make.
  // Admins see everything; otherwise the union of their roles × maker
  // matrix. Keeps the dropdown sane and the server's role-gate happy.
  const visibleTypes = useMemo(() => {
    if (isAdmin) return REQUEST_TYPE_OPTIONS;
    return REQUEST_TYPE_OPTIONS.filter((opt) => {
      const allow = MAKER_ROLES[opt.value] ?? new Set<string>();
      return Array.from(allow).some((r) => myRoles.has(r));
    });
  }, [isAdmin, myRoles]);

  const [requestType, setRequestType] = useState<string>(visibleTypes[0]?.value ?? "");
  const [payloadText, setPayloadText] = useState<string>("{}");
  const [reason, setReason] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // W4-MED-7 — reconcile the selected request type when visibleTypes changes
  // (e.g. JC moves to a state that disallows certain types under
  // MAKER_ROLES). Without this, the dropdown would keep displaying a value
  // no longer in the option list (the <select> falls back silently but the
  // server would 400 on submit). Empty visibleTypes resets to '' so the
  // submit button stays disabled via the existing visibleTypes.length gate.
  useEffect(() => {
    if (!visibleTypes.some((o) => o.value === requestType)) {
      setRequestType(visibleTypes[0]?.value ?? "");
    }
  }, [visibleTypes, requestType]);

  // W4-MED-1 — modal a11y: ESC to close, focus trap, restore focus on close.
  // `triggerRef` captures the element that had focus when the modal opened so
  // we can hand focus back to it on close (keyboard-only operators jump back
  // to the "Propose amendment" CTA they pressed). `dialogRef` is the focus-trap
  // boundary used by the Tab/Shift-Tab handler. `firstFieldRef` is the select
  // we focus on open per spec.
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLSelectElement>(null);
  const triggerRef = useRef<Element | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") return;
    triggerRef.current = document.activeElement;
    // Focus the first interactive field once the dialog is in the DOM. Defer
    // past the synchronous effect body so layout has settled.
    queueMicrotask(() => { firstFieldRef.current?.focus(); });
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("aria-hidden"));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !root.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Restore focus to the element that opened the modal.
      const t = triggerRef.current;
      if (t instanceof HTMLElement) t.focus();
    };
  }, [onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!requestType) {
      setError("Pick a request type.");
      return;
    }
    if (reason.trim().length < 20) {
      setError("Reason must be at least 20 characters.");
      return;
    }
    let parsedPayload: Record<string, unknown>;
    try {
      const v = JSON.parse(payloadText);
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        throw new Error("Payload must be a JSON object.");
      }
      parsedPayload = v as Record<string, unknown>;
    } catch (e) {
      setError(`Payload is not valid JSON: ${e instanceof Error ? e.message : "parse error"}`); // local parse error stays raw — not an API error
      return;
    }
    // W4-MED-8 — best-effort per-request-type required-keys check. The
    // backend is the authority (router_amendments.py validates each shape
    // against a Pydantic model and 400s on a missing key), but failing in
    // the browser saves a round-trip and gives a more readable error.
    //
    // TODO(C11-followup) — promote this from a hand-maintained dict into
    // the per-type Zod schemas the audit roadmap calls for. Each entry
    // below mirrors the minimum field set the corresponding server
    // handler reads off the payload:
    //   one_off_material_add          : material_code, qty, uom
    //   one_off_material_remove       : material_code
    //   permanent_bom_add             : material_code, qty, uom
    //   permanent_bom_remove          : material_code
    //   permanent_bom_qty_change      : material_code, qty
    //   plan_delete                   : plan_id
    //   stop_process                  : reason_code
    //   force_unlock                  : authority
    //   uom_correction                : from_uom, to_uom
    //   ncr_disposition               : ncr_id, disposition
    //   unbalanced_close_override     : output_kg
    //   ega_override                  : ega_kg
    const REQUIRED_KEYS_BY_TYPE: Record<string, string[]> = {
      one_off_material_add:      ["material_code", "qty", "uom"],
      one_off_material_remove:   ["material_code"],
      permanent_bom_add:         ["material_code", "qty", "uom"],
      permanent_bom_remove:      ["material_code"],
      permanent_bom_qty_change:  ["material_code", "qty"],
      plan_delete:               ["plan_id"],
      stop_process:              ["reason_code"],
      force_unlock:              ["authority"],
      uom_correction:            ["from_uom", "to_uom"],
      ncr_disposition:           ["ncr_id", "disposition"],
      unbalanced_close_override: ["output_kg"],
      ega_override:              ["ega_kg"],
    };
    const required = REQUIRED_KEYS_BY_TYPE[requestType];
    if (required) {
      const missing = required.filter((k) => !(k in parsedPayload));
      if (missing.length > 0) {
        setError(`Payload is missing required keys for ${requestType}: ${missing.join(", ")}`);
        return;
      }
    }
    setSubmitting(true);
    try {
      const res = await apiFetch(`/api/v1/production/amendments`, {
        method: "POST",
        body: JSON.stringify({
          request_type: requestType,
          payload: parsedPayload,
          job_card_id: jcId,
          reason: reason.trim(),
        }),
      });
      if (!res.ok) {
        const msg = await readErrMsg(res, `HTTP ${res.status}`);
        throw new Error(msg);
      }
      onCreated("Amendment proposed.");
    } catch (e) {
      setError(friendlyApiError(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="propose-amendment-title"
      // Mobile: full-screen overlay so the long payload textarea has room.
      // md+: centred dialog with backdrop.
      className="fixed inset-0 z-50 bg-black/40 flex items-stretch md:items-center justify-center md:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white w-full md:max-w-[640px] md:rounded-md md:shadow-xl flex flex-col max-h-screen md:max-h-[90vh] overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--aws-border)]">
          <h3 id="propose-amendment-title" className="text-[14px] font-semibold text-[var(--text-primary)]">
            Propose amendment
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-7 h-7 flex items-center justify-center rounded-sm hover:bg-[var(--surface-subtle)] text-[var(--text-secondary)]"
          >
            ×
          </button>
        </div>
        <form onSubmit={submit} className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3">
          {visibleTypes.length === 0 ? (
            <div className="text-[12px] text-[var(--aws-error)]">
              Your role is not permitted to propose any amendment type.
            </div>
          ) : (
            <>
              <label className="block">
                <span className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">Section / request type</span>
                <select
                  ref={firstFieldRef}
                  className="w-full h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
                  value={requestType}
                  onChange={(e) => setRequestType(e.target.value)}
                  disabled={submitting}
                >
                  {visibleTypes.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">
                  Payload (JSON object)
                </span>
                <textarea
                  className="w-full min-h-[160px] sm:min-h-[200px] px-2 py-1.5 text-[12px] font-mono rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
                  value={payloadText}
                  onChange={(e) => setPayloadText(e.target.value)}
                  disabled={submitting}
                  spellCheck={false}
                  placeholder='{"key": "value"}'
                />
                <span className="block text-[10px] text-[var(--text-muted)] mt-1">
                  Schema depends on request type — see ops runbook. Minimum: a JSON object.
                </span>
              </label>
              <label className="block">
                <span className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">
                  Reason (≥ 20 chars, required)
                </span>
                <textarea
                  className="w-full min-h-[80px] px-2 py-1.5 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  disabled={submitting}
                  placeholder="Why is this amendment being proposed?"
                />
                <span className="block text-[10px] text-[var(--text-muted)] mt-1">
                  {reason.trim().length}/20
                </span>
              </label>
              {error ? (
                <div className="text-[12px] text-[var(--aws-error)] break-words">{error}</div>
              ) : null}
            </>
          )}
        </form>
        <div className="px-4 py-3 border-t border-[var(--aws-border)] flex flex-wrap items-center justify-end gap-2">
          <ActionButton variant="secondary" onClick={onClose}>
            Cancel
          </ActionButton>
          <ActionButton
            variant="primary"
            type="submit"
            busy={submitting}
            busyLabel="Submitting…"
            onClick={() => {
              // form-submit pathway — let the native submit fire so the
              // form-level validation runs. We rebind onClick to trigger
              // submit programmatically when the button is rendered
              // outside the <form> footer.
              const formEl = (document.querySelector('[aria-labelledby="propose-amendment-title"] form') as HTMLFormElement | null);
              formEl?.requestSubmit();
            }}
            disabled={visibleTypes.length === 0}
          >
            Submit amendment
          </ActionButton>
        </div>
      </div>
    </div>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
