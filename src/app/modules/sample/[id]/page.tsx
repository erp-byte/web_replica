"use client";

// Sample requisition detail. A clean view of the REQUEST itself: its fields
// (the same ones the create form collects), an inline Edit for DRAFT/BH_REJECTED,
// the role-gated lifecycle action bar (submit/approve/reject/cancel + issuance
// actions), approval chain and audit timeline. NPD recipe authoring lives on the
// dedicated /[id]/develop page (reached via the "Develop" button), not here.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { Breadcrumbs, SAMPLE_ROOT, NPD_DEV_ROOT } from "@/components/Breadcrumbs";
import { useRequireAuth, useUserInitial, useMe, useIsAdmin } from "@/lib/user";
import { listUsers } from "@/lib/admin-api";
import { sampleCaps } from "@/lib/sample-roles";
import {
  getRequisition, submitRequisition, cancelRequisition, closeRequisition,
  approveRequisition, npdReview, issueOutward, dispatchInternal, startProduction,
  markPacking, markReady, invVerify, issueGatePass, convertFull, convertPartial,
  printGatePassBlob, updateRequisition, WAREHOUSES,
  type Requisition, type RecipientBody, type RequisitionCreate,
  type PurposeTag, type Warehouse,
} from "@/lib/sample";
import { StatusPill, NpdStatusPill, TYPE_LABEL } from "../_shared";
import { BillingFields, billingError, billingPayload, billingFrom, type BillingValue } from "../_form";

type ModalMode =
  | null | "reject" | "cancel" | "gatePass" | "convertFull" | "convertPartial"
  | "npdReject" | "npdHold";

const PURPOSE_OPTIONS: { value: PurposeTag; label: string }[] = [
  { value: "CUSTOMER_DISPLAY", label: "Customer display" },
  { value: "CUSTOMER_ISSUE", label: "Customer issue" },
  { value: "TASTING_SENSORY", label: "Tasting / sensory" },
  { value: "PHYSICAL_PARAMETERS", label: "Physical parameters" },
  { value: "INTERNAL_OTHER", label: "Internal / other" },
];

export default function SampleDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const authed = useRequireAuth(router.replace);
  const initial = useUserInitial();
  const me = useMe();
  const caps = useMemo(() => sampleCaps(me), [me]);

  const [req, setReq] = useState<Requisition | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<ModalMode>(null);
  const [editing, setEditing] = useState(false);

  // Hydration gate. This page is server-rendered, where useRequireAuth returns
  // true (no token store) but the first browser render starts authed=false — so
  // a bare `if (!authed) return null` made the server HTML (full shell) and the
  // first client render (null) diverge, and the stale prerendered shell wasn't
  // cleanly replaced (you'd scroll past a ghost "Loading…" into the real view).
  // Mirroring the list pages, we hold the auth/data branches until after mount
  // so SSR and the first client paint are byte-identical.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { queueMicrotask(() => setMounted(true)); }, []);

  const refresh = useCallback(async () => {
    try {
      const r = await getRequisition(id);
      setReq(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (!authed || !Number.isFinite(id)) return;
    queueMicrotask(() => { void refresh(); });
  }, [authed, id, refresh]);

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try {
      await fn();
      await refresh();
      setModal(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const saveEdit = useCallback(async (patch: Partial<RequisitionCreate>) => {
    setBusy(true); setError(null);
    try {
      await updateRequisition(id, patch);
      await refresh();
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }, [id, refresh]);

  async function printGatePass() {
    if (!req?.linked_gate_pass_id) return;
    setBusy(true); setError(null);
    try {
      const blob = await printGatePassBlob(req.linked_gate_pass_id);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Print failed");
    } finally {
      setBusy(false);
    }
  }

  // Only enforce the auth redirect AFTER mount — before then SSR and the first
  // client paint must agree (see the `mounted` note above).
  if (mounted && !authed) return null;

  const isNpdTrial = req != null && (req.sample_type === "NPD" || req.sample_type === "TRIAL");
  // Edit is for the Business head + admin (caps.canApprove), on the early
  // request states before it's been actioned downstream.
  const canEdit = req != null && caps.canApprove
    && (req.status === "DRAFT" || req.status === "SUBMITTED" || req.status === "BH_REJECTED");
  // Most recent HOLD remark (approvals are ordered by sequence_no asc).
  const holdReason = req?.status === "ON_HOLD"
    ? ((req.approvals ?? []).filter((a) => a.action === "HOLD").at(-1)?.remarks ?? null)
    : null;

  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-4 sm:px-6 gap-4">
        <BrandMark />
        <nav className="text-[12px] text-[#d5dbdb] hidden sm:flex items-center gap-2 ml-2">
          <button onClick={() => router.push("/modules/sample")} className="hover:underline">Sample</button>
          <span>/</span><span className="text-white">{req?.request_id ?? id}</span>
        </nav>
        <div className="flex-1" />
        <button onClick={() => router.push("/modules/profile")} aria-label="Profile"
          className="w-8 h-8 rounded-full bg-[var(--aws-orange)] text-white text-[13px] font-bold flex items-center justify-center hover:bg-[var(--aws-orange-hover)]">{initial}</button>
      </header>

      <main className="flex-1 max-w-[980px] w-full mx-auto px-4 sm:px-6 py-6">
        <Breadcrumbs items={[
          ...(isNpdTrial ? NPD_DEV_ROOT : SAMPLE_ROOT),
          { label: req?.request_id != null ? String(req.request_id) : String(id) },
        ]} className="mb-3" />

        {error && <div className="mb-4 rounded-md border border-[#f0c7be] bg-[#fdf3f1] px-3 py-2 text-[13px] text-[#b1361e]">{error}</div>}

        {loading || !req ? (
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[13px] text-[var(--text-secondary)]">
            {loading ? "Loading…" : "Not found."}
          </div>
        ) : (
          <div className="space-y-5">
            {/* Header / request fields card */}
            <section className="bg-white border border-[var(--aws-border)] rounded-md overflow-hidden shadow-[0_1px_2px_rgba(0,28,36,0.06)]">
              <div className="p-5">
                <div className="flex flex-wrap items-start gap-4">
                  <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)] mb-1">Request</div>
                    <div className="flex flex-wrap items-center gap-2.5">
                      <h1 className="text-[28px] leading-none font-semibold text-[var(--text-primary)] tabular-nums">{req.request_id ?? id}</h1>
                      {isNpdTrial
                        ? <NpdStatusPill status={req.status} holdReason={holdReason} />
                        : <StatusPill status={req.status} />}
                      <span className="text-[11px] font-medium px-2 py-0.5 rounded bg-[var(--surface-divider)] text-[var(--text-secondary)]">{TYPE_LABEL[req.sample_type] ?? req.sample_type}</span>
                    </div>
                  </div>
                  <div className="flex-1" />
                  <div className="flex items-center gap-2">
                    {isNpdTrial && caps.canNpd && req.linked_dev_jc_id != null && (
                      <button onClick={() => router.push(`/modules/npd-development/job-cards/${req.linked_dev_jc_id}`)}
                        className="h-9 px-3.5 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] font-medium hover:bg-[var(--surface-subtle)] inline-flex items-center gap-1.5">
                        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6" /><path d="M10 14L21 3" /><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" /></svg>
                        Open
                      </button>
                    )}
                    {isNpdTrial && caps.canNpd && req.linked_dev_jc_id == null && req.status === "BH_APPROVED" && (
                      <button onClick={() => router.push(`/modules/npd-development/job-cards/new?req=${id}`)}
                        className="h-9 px-3.5 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] font-medium hover:bg-[var(--surface-subtle)] inline-flex items-center gap-1.5">
                        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2.5l2.7 6.1 6.6.6-5 4.4 1.5 6.5L12 17.3 6.2 20.6l1.5-6.5-5-4.4 6.6-.6z" /></svg>
                        Develop
                      </button>
                    )}
                    {canEdit && !editing && (
                      <button onClick={() => setEditing(true)}
                        className="h-9 px-3.5 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] font-medium hover:bg-[var(--surface-subtle)] inline-flex items-center gap-1.5">
                        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
                        Edit
                      </button>
                    )}
                    {/* Cancel — Sales / BH only, while the request is still live. */}
                    {isNpdTrial && caps.canEdit && !editing && req.status !== "CANCELLED" && req.status !== "CLOSED" && (
                      <button onClick={() => setModal("cancel")}
                        className="h-9 px-3.5 rounded-[2px] border border-[#f0c7be] bg-[#fdf3f1] text-[#b1361e] text-[13px] font-medium hover:bg-[#fbe9e4] inline-flex items-center gap-1.5">
                        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {editing ? (
                <div className="border-t border-[var(--surface-divider)] px-5 pb-5">
                  <EditCard req={req} busy={busy} onSave={saveEdit} onCancel={() => setEditing(false)} />
                </div>
              ) : (
                <>
                  <dl className="border-t border-[var(--surface-divider)] px-5 py-4 grid grid-cols-2 sm:grid-cols-4 gap-y-4 gap-x-4">
                    <Field label="Warehouse" value={req.warehouse ?? "—"} />
                    <Field label="Target NPD article name" value={req.npd_target_name ?? "—"} />
                    <Field label="Pcs" value={req.pcs != null ? String(req.pcs) : "—"} />
                    <Field label="Weight per piece (kg)" value={req.weight_per_piece != null ? String(req.weight_per_piece) : "—"} />
                    <Field label="Quantity (kg)" value={req.quantity != null ? String(req.quantity) : "—"} />
                    <Field label="Requestor" value={req.requestor_team ?? "—"} />
                    <Field label="Purpose" value={req.purpose_tag ? req.purpose_tag.replace(/_/g, " ") : "—"} />
                    <Field label="Created" value={(req.created_at ?? "").slice(0, 10)} />
                  </dl>
                  {isNpdTrial && (
                    <dl className="border-t border-[var(--surface-divider)] px-5 py-4 grid grid-cols-2 sm:grid-cols-4 gap-y-4 gap-x-4">
                      <Field label="Company" value={req.company_name ?? "—"} />
                      <Field label="Customer" value={req.customer_name ?? "—"} />
                      <Field label="Customer contact" value={req.customer_contact ?? "—"} />
                      <Field label="Mode of transport" value={req.mode_of_transport ?? "—"} />
                      <Field label="Expected dispatch (BD)" value={req.expected_dispatch_date ? String(req.expected_dispatch_date).slice(0, 10) : "—"} />
                      <Field label="Confirmed dispatch (NPD)" value={req.confirmed_dispatch_date ? String(req.confirmed_dispatch_date).slice(0, 10) : "—"} />
                      <Field label="Return type" value={req.returnable ? "Returnable" : req.non_returnable ? "Non-returnable" : "—"} />
                      <Field label="Paid" value={req.paid ? "Yes" : "No"} />
                      <Field label="Amount" value={req.paid && req.amount != null ? Number(req.amount).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"} />
                      <div className="col-span-2 sm:col-span-4 min-w-0">
                        <dt className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)] mb-0.5">Ship-to address</dt>
                        <dd className="text-[13px] font-medium text-[var(--text-primary)]">{req.customer_ship_to_address ?? "—"}</dd>
                      </div>
                    </dl>
                  )}
                  {req.description && (
                    <div className="border-t border-[var(--surface-divider)] px-5 py-3 bg-[var(--surface-subtle)]">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)] mb-0.5">Description</div>
                      <p className="text-[13px] text-[var(--text-secondary)]">{req.description}</p>
                    </div>
                  )}
                  {req.status === "ON_HOLD" && (
                    <div className="border-t border-[#fde68a] px-5 py-3 bg-[#fef9c3]">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-[#854d0e] mb-0.5">
                        On hold{req.hold_start_date ? ` · from ${String(req.hold_start_date).slice(0, 10)}` : ""}
                      </div>
                      <p className="text-[13px] text-[#854d0e]">{holdReason || "No reason recorded."}</p>
                    </div>
                  )}
                </>
              )}
            </section>

            {/* Action bar — issuance lifecycle (issue/gate-pass/convert/close…).
                NPD/TRIAL requests have NO approve/reject here; the only action is
                Edit (Business head + admin) in the header, plus Develop for NPD. */}
            {!isNpdTrial && (
              <ActionBar req={req} caps={caps} busy={busy} run={run} setModal={setModal} printGatePass={printGatePass} />
            )}

            {/* NPD review of a BH-sent request — the NPD team's verdict. */}
            {isNpdTrial && caps.canNpd && (req.status === "SUBMITTED" || req.status === "ON_HOLD") && (
              <Card title="NPD review">
                <p className="-mt-1 mb-3 text-[12px] text-[var(--text-muted)]">Record the NPD team&apos;s decision on this request — a reason is required to hold.</p>
                <div className="flex flex-wrap gap-2">
                  <button disabled={busy} onClick={() => run(() => npdReview(req.id, "ACCEPT"))}
                    className="h-9 px-4 rounded-[2px] text-[13px] font-medium inline-flex items-center gap-1.5 bg-[var(--aws-orange)] text-white hover:bg-[var(--aws-orange-hover)] disabled:opacity-50">
                    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
                    Accept
                  </button>
                  {req.status === "SUBMITTED" && (
                    <button disabled={busy} onClick={() => setModal("npdHold")}
                      className="h-9 px-4 rounded-[2px] text-[13px] font-medium inline-flex items-center gap-1.5 border border-[#fde68a] bg-[#fef9c3] text-[#854d0e] hover:bg-[#fdf08a] disabled:opacity-50">
                      <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M8 5v14M16 5v14" /></svg>
                      Hold
                    </button>
                  )}
                </div>
              </Card>
            )}

            {/* Articles — only when the requisition actually has lines (issuance types) */}
            {(req.articles?.length ?? 0) > 0 && (
              <Card title="Articles">
                <table className="w-full text-[13px]">
                  <thead><tr className="text-left text-[12px] text-[var(--text-secondary)]">
                    <th className="py-1.5 font-semibold">Article</th><th className="py-1.5 font-semibold">Role</th>
                    <th className="py-1.5 font-semibold text-right">Required</th><th className="py-1.5 font-semibold text-right">Issued</th><th className="py-1.5 font-semibold">UOM</th>
                  </tr></thead>
                  <tbody>
                    {req.articles!.map((a) => (
                      <tr key={a.id ?? a.sku_id} className="border-t border-[var(--surface-divider)]">
                        <td className="py-1.5">{a.sku_name}</td><td className="py-1.5">{a.article_role}</td>
                        <td className="py-1.5 text-right">{a.required_qty}</td>
                        <td className="py-1.5 text-right">{a.issued_qty ?? "—"}</td><td className="py-1.5">{a.uom}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}

          </div>
        )}
      </main>

      {modal && req && (
        <ActionModal mode={modal} busy={busy} onClose={() => setModal(null)}
          onSubmit={(data) => {
            if (modal === "reject") return run(() => approveRequisition(req.id, "REJECTED", data.remarks));
            if (modal === "npdReject") return run(() => npdReview(req.id, "REJECT", data.reason));
            if (modal === "npdHold") return run(() => npdReview(req.id, "HOLD", data.reason));
            if (modal === "cancel") return run(() => cancelRequisition(req.id, data.reason ?? ""));
            if (modal === "gatePass") return run(() => issueGatePass(req.id, data as RecipientBody));
            if (modal === "convertFull") return run(() => convertFull(req.id, data));
            if (modal === "convertPartial") return run(() => convertPartial(req.id, { ...(data as RecipientBody), qty: Number(data.qty) }));
          }} />
      )}
    </div>
  );
}

// ── Inline edit of the request fields ────────────────────────────────────────
function EditCard({ req, busy, onSave, onCancel }: {
  req: Requisition; busy: boolean;
  onSave: (patch: Partial<RequisitionCreate>) => void; onCancel: () => void;
}) {
  const [warehouse, setWarehouse] = useState<string>(req.warehouse ?? "");
  const [target, setTarget] = useState(req.npd_target_name ?? "");
  const [pcs, setPcs] = useState(req.pcs != null ? String(req.pcs) : "");
  const [weightPerPiece, setWeightPerPiece] = useState(req.weight_per_piece != null ? String(req.weight_per_piece) : "");
  const [purposeTag, setPurposeTag] = useState<string>(req.purpose_tag ?? "");
  const [requestorTeam, setRequestorTeam] = useState(req.requestor_team ?? "");
  const [description, setDescription] = useState(req.description ?? "");
  const [companyName, setCompanyName] = useState(req.company_name ?? "");
  const [customerName, setCustomerName] = useState(req.customer_name ?? "");
  const [customerContact, setCustomerContact] = useState(req.customer_contact ?? "");
  const [shipTo, setShipTo] = useState(req.customer_ship_to_address ?? "");
  const [modeOfTransport, setModeOfTransport] = useState(req.mode_of_transport ?? "");
  const [expectedDispatch, setExpectedDispatch] = useState((req.expected_dispatch_date ?? "").slice(0, 10));
  // Billing checklist — only edited on NPD/TRIAL requisitions.
  const isNpd = req.sample_type === "NPD" || req.sample_type === "TRIAL";
  const [billing, setBilling] = useState<BillingValue>(() => billingFrom(req));
  // Requestor dropdown — business heads only (mirrors the create form). Admin-gated
  // because /users is admin-only; non-admins keep the free-text input.
  const isAdmin = useIsAdmin();
  const [reqOptions, setReqOptions] = useState<string[]>([]);
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    listUsers().then((users) => {
      if (cancelled) return;
      setReqOptions(Array.from(new Set(users
        .filter((u) => u.role_name === "business_head")
        .map((u) => (u.full_name ?? "").trim())
        .filter(Boolean))));
    }).catch(() => { /* leave empty — the placeholder prompts a selection */ });
    return () => { cancelled = true; };
  }, [isAdmin]);
  // Keep the currently-saved requestor selectable even if it isn't (or is no longer)
  // a business head, so editing never silently blanks an existing value.
  const currentReq = (req.requestor_team ?? "").trim();
  const reqChoices = currentReq && !reqOptions.includes(currentReq)
    ? [currentReq, ...reqOptions] : reqOptions;
  // Quantity is derived = pcs × weight per piece (kg).
  const pcsNum = Number(pcs), wppNum = Number(weightPerPiece);
  const qtyNum = (pcs.trim() !== "" && weightPerPiece.trim() !== "" && Number.isFinite(pcsNum) && Number.isFinite(wppNum))
    ? Number((pcsNum * wppNum).toFixed(3)) : 0;
  const billErr = isNpd ? billingError(billing) : null;

  function save() {
    if (billErr) return;
    onSave({
      warehouse: (warehouse || undefined) as Warehouse | undefined,
      npd_target_name: target.trim() || undefined,
      pcs: pcs.trim() ? pcsNum : undefined,
      weight_per_piece: weightPerPiece.trim() ? wppNum : undefined,
      quantity: qtyNum > 0 ? qtyNum : undefined,
      purpose_tag: (purposeTag || undefined) as PurposeTag | undefined,
      requestor_team: requestorTeam.trim() || undefined,
      description: description.trim() || undefined,
      company_name: companyName.trim() || undefined,
      customer_name: customerName.trim() || undefined,
      customer_contact: customerContact.trim() || undefined,
      customer_ship_to_address: shipTo.trim() || undefined,
      mode_of_transport: modeOfTransport.trim() || undefined,
      expected_dispatch_date: expectedDispatch || undefined,
      // Billing only for NPD/TRIAL (always sent together so the paid/amount lock holds).
      ...(isNpd ? billingPayload(billing) : {}),
    });
  }

  return (
    <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
      <label className="text-[12px] text-[var(--text-secondary)]">Warehouse
        <select className="form-input mt-0.5" value={warehouse} onChange={(e) => setWarehouse(e.target.value)}>
          <option value="">Select…</option>
          {WAREHOUSES.map((w) => <option key={w} value={w}>{w}</option>)}
        </select>
      </label>
      <label className="text-[12px] text-[var(--text-secondary)]">Target NPD article name
        <input className="form-input mt-0.5" value={target} onChange={(e) => setTarget(e.target.value)} />
      </label>
      <label className="text-[12px] text-[var(--text-secondary)]">Pcs
        <input className="form-input mt-0.5" type="number" min="0" step="1" value={pcs}
          onChange={(e) => setPcs(e.target.value)} onWheel={(e) => e.currentTarget.blur()} />
      </label>
      <label className="text-[12px] text-[var(--text-secondary)]">Weight per piece (kg)
        <input className="form-input mt-0.5" type="number" min="0" step="0.001" value={weightPerPiece}
          onChange={(e) => setWeightPerPiece(e.target.value)} onWheel={(e) => e.currentTarget.blur()} />
      </label>
      <label className="text-[12px] text-[var(--text-secondary)]">Quantity (kg)
        <input className="form-input mt-0.5 bg-[var(--surface-subtle)] cursor-not-allowed" value={qtyNum > 0 ? qtyNum.toLocaleString("en-IN") : "—"} readOnly tabIndex={-1} />
      </label>
      <label className="text-[12px] text-[var(--text-secondary)]">Purpose
        <select className="form-input mt-0.5" value={purposeTag} onChange={(e) => setPurposeTag(e.target.value)}>
          <option value="">Select…</option>
          {PURPOSE_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
      </label>
      <label className="text-[12px] text-[var(--text-secondary)]">Requestor
        {isAdmin ? (
          <select className="form-input mt-0.5" value={requestorTeam} onChange={(e) => setRequestorTeam(e.target.value)}>
            <option value="">Select a business head…</option>
            {reqChoices.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        ) : (
          <input className="form-input mt-0.5" value={requestorTeam} onChange={(e) => setRequestorTeam(e.target.value)} />
        )}
      </label>
      <label className="text-[12px] text-[var(--text-secondary)]">Company name
        <input className="form-input mt-0.5" value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
      </label>
      <label className="text-[12px] text-[var(--text-secondary)]">Customer name
        <input className="form-input mt-0.5" value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
      </label>
      <label className="text-[12px] text-[var(--text-secondary)]">Customer contact
        <input className="form-input mt-0.5" value={customerContact} onChange={(e) => setCustomerContact(e.target.value)} />
      </label>
      <label className="text-[12px] text-[var(--text-secondary)]">Mode of transport
        <input className="form-input mt-0.5" value={modeOfTransport} onChange={(e) => setModeOfTransport(e.target.value)} />
      </label>
      <label className="text-[12px] text-[var(--text-secondary)]">Expected dispatch date <span className="text-[var(--text-muted)]">(BD)</span>
        <input className="form-input mt-0.5" type="date" value={expectedDispatch} onChange={(e) => setExpectedDispatch(e.target.value)} />
      </label>
      <label className="text-[12px] text-[var(--text-secondary)] sm:col-span-2">Customer ship-to address
        <textarea className="form-input mt-0.5 min-h-[56px] resize-y" value={shipTo} onChange={(e) => setShipTo(e.target.value)} />
      </label>
      <label className="text-[12px] text-[var(--text-secondary)] sm:col-span-2">Description
        <textarea className="form-input mt-0.5 min-h-[56px] resize-y" value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      {isNpd && (
        <div className="sm:col-span-2">
          <BillingFields value={billing} onChange={setBilling} />
        </div>
      )}
      <div className="sm:col-span-2 flex items-center gap-2">
        <button disabled={busy} onClick={onCancel}
          className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] hover:bg-[var(--surface-subtle)] disabled:opacity-50">Cancel</button>
        <div className="flex-1" />
        <button disabled={busy || !warehouse || !!billErr} onClick={save}
          className="h-9 px-5 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] font-medium hover:bg-[var(--aws-orange-hover)] disabled:opacity-50">{busy ? "Saving…" : "Save"}</button>
      </div>
    </div>
  );
}

// ── Action bar ──────────────────────────────────────────────────────────────
function ActionBar({ req, caps, busy, run, setModal, printGatePass }: {
  req: Requisition; caps: ReturnType<typeof sampleCaps>; busy: boolean;
  run: (fn: () => Promise<unknown>) => void; setModal: (m: ModalMode) => void; printGatePass: () => void;
}) {
  const s = req.status, t = req.sample_type;
  const btns: React.ReactNode[] = [];
  const P = (key: string, label: string, onClick: () => void, primary = false) => btns.push(
    <button key={key} disabled={busy} onClick={onClick}
      className={`h-9 px-4 rounded-[2px] text-[13px] font-medium disabled:opacity-50 ${primary ? "bg-[var(--aws-orange)] text-white hover:bg-[var(--aws-orange-hover)]" : "border border-[var(--aws-border-strong)] bg-white hover:bg-[var(--surface-subtle)]"}`}>{label}</button>
  );

  if (s === "DRAFT" && caps.canRequest) P("submit", "Submit", () => run(() => submitRequisition(req.id)), true);
  if (s === "BH_REJECTED" && caps.canRequest) P("resubmit", "Re-submit", () => run(() => submitRequisition(req.id)), true);
  if (s === "SUBMITTED" && caps.canApprove) {
    P("approve", "Approve", () => run(() => approveRequisition(req.id, "APPROVED")), true);
    P("reject", "Reject", () => setModal("reject"));
  }
  if (s === "BH_APPROVED") {
    if ((t === "BASIS_RM" || t === "INTERNAL") && caps.canInventory) P("outward", "Issue outward", () => run(() => issueOutward(req.id)), true);
    if ((t === "BASIS_FG" || t === "NPD" || t === "TRIAL") && caps.canProduction) P("startprod", "Start production", () => run(() => startProduction(req.id)), true);
  }
  if (s === "IN_PRODUCTION" && caps.canProduction) P("packing", "Mark packing", () => run(() => markPacking(req.id)), true);
  if (s === "PACKING" && caps.canInventory) P("ready", "Mark ready", () => run(() => markReady(req.id)), true);
  if (s === "READY_FOR_DISPATCH" && caps.canInventory) {
    P("verify", "Inv verify", () => run(() => invVerify(req.id)));
    P("gp", "Issue gate pass", () => setModal("gatePass"), true);
    if (t === "INTERNAL") P("dispatch", "Dispatch internal", () => run(() => dispatchInternal(req.id)));
  }
  if (s === "INTERNALLY_DISPATCHED") {
    if (caps.canConvert) { P("cfull", "Convert (full)", () => setModal("convertFull"), true); P("cpart", "Convert (partial)", () => setModal("convertPartial")); }
    if (caps.canInventory) P("close1", "Close", () => run(() => closeRequisition(req.id)));
  }
  if (s === "PARTIALLY_CONVERTED" && caps.canInventory) P("close2", "Close", () => run(() => closeRequisition(req.id)));
  if (s === "GATE_PASS_ISSUED" && caps.canInventory) P("close3", "Close", () => run(() => closeRequisition(req.id)));

  if (req.linked_gate_pass_id && caps.canInventory) P("print", "Print gate pass", printGatePass);
  const CANCELLABLE = ["DRAFT", "SUBMITTED", "BH_REJECTED", "BH_APPROVED", "IN_PRODUCTION", "PACKING", "READY_FOR_DISPATCH"];
  if (CANCELLABLE.includes(s) && caps.canRequest) P("cancel", "Cancel", () => setModal("cancel"));

  if (btns.length === 0) return null;
  return <div className="flex flex-wrap gap-2">{btns}</div>;
}

// ── Action modal ─────────────────────────────────────────────────────────────
type ModalData = { remarks?: string; reason?: string; qty?: string } & RecipientBody;

function ActionModal({ mode, busy, onClose, onSubmit }: {
  mode: ModalMode; busy: boolean; onClose: () => void; onSubmit: (d: ModalData) => void;
}) {
  const [d, setD] = useState<ModalData>({});
  const set = (k: keyof ModalData, v: string) => setD((p) => ({ ...p, [k]: v }));
  const recipient = mode === "gatePass" || mode === "convertFull" || mode === "convertPartial";
  const title = mode === "reject" ? "Reject requisition" : mode === "cancel" ? "Cancel requisition"
    : mode === "npdReject" ? "Reject request" : mode === "npdHold" ? "Hold request"
    : mode === "gatePass" ? "Issue gate pass" : mode === "convertFull" ? "Convert to gate pass (full)" : "Convert to gate pass (partial)";

  const valid = mode === "reject" ? !!d.remarks?.trim()
    : mode === "cancel" ? !!d.reason?.trim()
    : (mode === "npdReject" || mode === "npdHold") ? !!d.reason?.trim()
    : mode === "convertPartial" ? Number(d.qty) > 0
    : true;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-3" onClick={onClose}>
      <div className="bg-white rounded-md w-full max-w-md p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-[15px] font-semibold mb-3">{title}</h3>
        <div className="space-y-2">
          {mode === "reject" && <Textarea label="Remarks (required)" value={d.remarks ?? ""} onChange={(v) => set("remarks", v)} />}
          {mode === "cancel" && <Textarea label="Reason (required)" value={d.reason ?? ""} onChange={(v) => set("reason", v)} />}
          {(mode === "npdReject" || mode === "npdHold") && <Textarea label="Reason (required)" value={d.reason ?? ""} onChange={(v) => set("reason", v)} />}
          {mode === "convertPartial" && (
            <Input label="Quantity (≤ issued)" type="number" value={d.qty ?? ""} onChange={(v) => set("qty", v)} />
          )}
          {recipient && (
            <>
              <Input label="Recipient name" value={d.recipient_name ?? ""} onChange={(v) => set("recipient_name", v)} />
              <Input label="Recipient contact" value={d.recipient_contact ?? ""} onChange={(v) => set("recipient_contact", v)} />
              <div className="grid grid-cols-2 gap-2">
                <Input label="Vehicle / carrier" value={d.vehicle_carrier ?? ""} onChange={(v) => set("vehicle_carrier", v)} />
                <Input label="Driver" value={d.driver_name ?? ""} onChange={(v) => set("driver_name", v)} />
              </div>
              <Input label="From location" value={d.from_location ?? ""} onChange={(v) => set("from_location", v)} />
            </>
          )}
          {(mode === "convertFull" || mode === "convertPartial") && <Textarea label="Remarks (optional)" value={d.remarks ?? ""} onChange={(v) => set("remarks", v)} />}
        </div>
        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] hover:bg-[var(--surface-subtle)]">Cancel</button>
          <div className="flex-1" />
          <button disabled={busy || !valid} onClick={() => onSubmit(d)}
            className="h-9 px-5 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] font-medium disabled:opacity-50 hover:bg-[var(--aws-orange-hover)]">{busy ? "Working…" : "Confirm"}</button>
        </div>
      </div>
    </div>
  );
}

// ── Small presentational helpers ─────────────────────────────────────────────
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white border border-[var(--aws-border)] rounded-md p-4">
      <h2 className="text-[13px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide mb-3">{title}</h2>
      {children}
    </section>
  );
}
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)] mb-0.5">{label}</dt>
      <dd className="text-[13px] font-medium text-[var(--text-primary)] truncate" title={value}>{value}</dd>
    </div>
  );
}

function Input({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return <label className="block text-[11px] text-[var(--text-secondary)]">{label}<input className="form-input mt-0.5" type={type} value={value} onChange={(e) => onChange(e.target.value)} /></label>;
}
function Textarea({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return <label className="block text-[11px] text-[var(--text-secondary)]">{label}<textarea className="form-input mt-0.5 !h-20 py-1.5" value={value} onChange={(e) => onChange(e.target.value)} /></label>;
}
