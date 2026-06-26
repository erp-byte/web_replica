"use client";

// Manual SO update. Mirrors
// frontend_replica/src/modules/production/so-creation/so-manual-update.html
// + so-manual-update.js. Loads /api/v1/so/{soId}, splits into editable
// header + lines forms, sends a PUT /api/v1/so/update with both the old
// snapshot and the new values. A 409 from the backend means the DB
// changed under the operator and they need to reload.

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import { useSeesCost, seesCostFor } from "@/lib/cost-gate";
import {
  COMPANY_OPTIONS, VOUCHER_TYPE_OPTIONS,
  type SoLine,
  type SoLineEntry,
  type SoRow,
  SoStaleError,
  getSo,
  updateSo,
} from "@/lib/so";
import { registerOnSignOut, userStore } from "@/lib/auth";
import { friendlyApiError } from "@/lib/apiErrors";
import { sessionLoad, sessionSave, sessionClear } from "@/lib/session-state";

// Detail endpoint and list endpoint both return wrapped { line, gst_recon }
// entries today; older builds shipped plain SoLine[]. Tolerate both.
function unwrapLines(raw: SoRow["lines"]): SoLine[] {
  if (!raw || raw.length === 0) return [];
  const first = raw[0] as unknown;
  if (first && typeof first === "object" && "line" in (first as Record<string, unknown>)) {
    return (raw as SoLineEntry[]).map((e) => e.line);
  }
  return raw as SoLine[];
}
import { SoChrome } from "../../_chrome";
import { SoLineEditor, emptyLine, lineFromExisting, lineToWire, stripLineCostFields, type LineRow } from "../../_SoLineForm";

interface HeaderForm {
  so_date: string;
  customer_name: string;
  common_customer_name: string;
  company: string;
  voucher_type: string;
}

function headerFromRow(r: SoRow): HeaderForm {
  return {
    so_date: r.so_date ?? "",
    customer_name: r.customer_name ?? "",
    common_customer_name: r.common_customer_name ?? "",
    company: r.company ?? "",
    voucher_type: r.voucher_type ?? "",
  };
}

// Form-draft slot — per-soId so editing SO #123 then SO #456 doesn't
// cross-contaminate. Drained on successful submit, Cancel, and sign-out.
//
// CRITICAL: only the operator's edits (header + lines) are persisted. The
// server snapshot (`original`) is the optimistic-concurrency baseline for
// updateSo's old_header/old_lines payload — it MUST come from a fresh fetch
// each page mount, never from sessionStorage, or stale-detection breaks.
interface ManualUpdateDraft {
  header: HeaderForm;
  lines: LineRow[];
}
function draftKeyFor(soId: number): string {
  return `so.draft.manual-update.${soId}`;
}

export default function ManualSoUpdatePage() {
  const router = useRouter();
  useRequireAuth(router.replace);
  // C12 cost-metric gate. Same reasoning as manual entry — deny-list
  // roles can't edit Rate (the input is hidden by `_SoLineForm`), so we
  // can't require it on submit.
  const { seesCost } = useSeesCost();
  const params = useParams<{ soId: string }>();
  const search = useSearchParams();
  const soId = Number(params?.soId);
  const focusSection = search?.get("section") ?? null;

  // Draft hydration ONCE on mount. soId is read from URL params and is
  // stable for the page's lifetime (a route change to a different soId
  // remounts the component).
  const [initialDraft] = useState<ManualUpdateDraft | null>(() => {
    if (typeof window === "undefined" || !Number.isFinite(soId)) return null;
    const raw = sessionLoad<ManualUpdateDraft>(draftKeyFor(soId));
    if (!raw) return null;
    // C12-fix H3: synchronous strip on draft hydrate. Mirrors the manual
    // entry page — drafts are tab-scoped but share a device across users,
    // so a stale draft authored by an allow-listed teammate must not leak
    // its cost columns to a deny-list operator on rehydration.
    if (seesCostFor(userStore.load())) return raw;
    return { header: raw.header, lines: raw.lines.map(stripLineCostFields) };
  });
  // hadDraft flag is consumed inside the fetch effect to decide whether to
  // overwrite header/lines with server values. After the first fetch this
  // flag flips off so refetches behave normally (none today, but safe).
  const hadDraftRef = useRef(!!initialDraft);

  const [original, setOriginal] = useState<SoRow | null>(null);
  const [header, setHeader] = useState<HeaderForm | null>(initialDraft?.header ?? null);
  const [lines, setLines] = useState<LineRow[]>(initialDraft?.lines ?? []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  const headerSecRef = useRef<HTMLElement>(null);
  const linesSecRef  = useRef<HTMLElement>(null);

  // Persist on change. Guarded on `header` being non-null so we don't
  // clobber an existing draft with `{header: null, lines: []}` during the
  // brief window before the first fetch returns (when no draft was found).
  useEffect(() => {
    if (!Number.isFinite(soId)) return;
    if (!header) return;
    sessionSave<ManualUpdateDraft>(draftKeyFor(soId), { header, lines });
  }, [soId, header, lines]);

  // Sign-out drains this slot. Captures `soId` in the closure — page
  // remount on soId change re-registers with the new key.
  useEffect(() => {
    if (!Number.isFinite(soId)) return;
    return registerOnSignOut(() => sessionClear(draftKeyFor(soId)));
  }, [soId]);

  function clearDraft() {
    if (!Number.isFinite(soId)) return;
    sessionClear(draftKeyFor(soId));
  }

  // Fetch + initial scroll target. Single fetch per soId; if the operator
  // navigates between SO ids the component re-mounts via the dynamic route.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!Number.isFinite(soId)) {
      // Defer past the synchronous effect body so the
      // react-hooks/set-state-in-effect rule stays happy.
      queueMicrotask(() => {
        setError("Invalid SO id.");
        setLoading(false);
      });
      return;
    }
    const controller = new AbortController();
    void (async () => {
      setLoading(true); setError(null);
      try {
        const r = await getSo(soId, controller.signal);
        if (controller.signal.aborted) return;
        // `original` is ALWAYS refreshed — it's the staleness baseline for
        // updateSo's old_header/old_lines payload. Persisting it would
        // defeat 409 SoStaleError detection.
        setOriginal(r);
        // header/lines come from the server only when there's no live draft
        // to restore. After this first pass we flip the flag off so any
        // future refetch (none today, but safe) uses server values.
        if (!hadDraftRef.current) {
          setHeader(headerFromRow(r));
          setLines(unwrapLines(r.lines).map(lineFromExisting));
        }
        hadDraftRef.current = false;
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(friendlyApiError(e));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [soId]);

  // After paint, scroll to the requested section. We use rAF so layout
  // has settled and the offset is correct.
  useEffect(() => {
    if (!header || !focusSection) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = focusSection === "lines" ? linesSecRef.current : headerSecRef.current;
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
    }));
  }, [header, focusSection]);

  function setHeaderField<K extends keyof HeaderForm>(k: K, v: HeaderForm[K]) {
    setHeader((h) => (h ? { ...h, [k]: v } : h));
  }

  function addLine() {
    setLines((ls) => [...ls, { ...emptyLine(), line_number: ls.length + 1 }]);
  }
  function updateLine(i: number, next: LineRow) {
    setLines((ls) => ls.map((l, j) => (j === i ? next : l)));
  }
  function removeLine(i: number) {
    setLines((ls) => ls.filter((_, j) => j !== i));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!original || !header) return;
    setFeedback(null);

    for (const k of ["so_date", "customer_name", "common_customer_name", "company", "voucher_type"] as const) {
      if (!header[k].trim()) {
        setFeedback({ kind: "err", msg: `Header field "${k.replace(/_/g, " ")}" is required.` });
        return;
      }
    }
    if (lines.length === 0) { setFeedback({ kind: "err", msg: "At least one line item is required." }); return; }
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (!l.sku_name.trim()) { setFeedback({ kind: "err", msg: `Line ${i + 1}: Particulars is required.` }); return; }
      if (!l.quantity.trim()) { setFeedback({ kind: "err", msg: `Line ${i + 1}: Pack count is required.` }); return; }
      // Rate is only required when the operator can see / edit cost
      // fields. Deny-list roles (team_leader, qc_inspector, etc.) get
      // the Rate input hidden by `_SoLineForm` (C12), so making it a
      // required field would dead-lock them.
      if (seesCost && !l.rate_inr.trim()) { setFeedback({ kind: "err", msg: `Line ${i + 1}: Rate is required.` }); return; }
    }

    setSubmitting(true);
    try {
      const oldHeader = headerFromRow(original);
      const oldLines: SoLine[] = unwrapLines(original.lines);
      // C12-fix H3: belt-and-braces strip before mapping to the wire
      // shape — same reasoning as manual entry. Deny-list operators
      // submit without `*_amount` / `rate_inr` values even if the live
      // LineRow state somehow carries them (stale draft, future bug).
      const wireLines = lines
        .map((l) => (seesCost ? l : stripLineCostFields(l)))
        .map(lineToWire);
      const r = await updateSo({
        so_number: original.so_number ?? "",
        old_header: oldHeader,
        new_header: header,
        old_lines: oldLines,
        new_lines: wireLines,
      });
      setFeedback({ kind: "ok", msg: `${original.so_number} updated — ${(r.header_changes ?? 0) + (r.line_changes ?? 0)} change${(r.header_changes ?? 0) + (r.line_changes ?? 0) === 1 ? "" : "s"} applied.` });
      // Drop the draft now that the edits are applied — no need to keep it
      // around past the brief delay before the navigation fires.
      clearDraft();
      setTimeout(() => router.push("/modules/production/so-creation"), 900);
    } catch (e) {
      if (e instanceof SoStaleError) {
        setFeedback({ kind: "err", msg: "The SO changed in the database since you opened it. Reload and re-apply your edits." });
      } else {
        setFeedback({ kind: "err", msg: friendlyApiError(e) });
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SoChrome title={original ? `Update ${original.so_number ?? `SO #${soId}`}` : "Manual Update"} showBackToSoCreation>
      <div className="mb-5">
        <h1 className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)]">
          {original ? `Update ${original.so_number ?? `SO #${soId}`}` : "Manual Update"}
        </h1>
        <p className="text-[13px] text-[var(--text-secondary)] mt-1">
          SO ID {soId} — edit fields and submit. The backend rejects the update if the SO changed under you.
        </p>
      </div>

      {loading ? (
        <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[var(--text-secondary)]">
          <span className="inline-flex items-center gap-2 text-[13px]">
            <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
            Loading SO…
          </span>
        </div>
      ) : error ? (
        <div className="bg-white border border-[var(--aws-border)] rounded-md p-8 text-center text-[var(--aws-error)] text-[14px]">{error}</div>
      ) : header && original ? (
        <form onSubmit={onSubmit}>
          <section ref={headerSecRef} className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] p-5 mb-4">
            <h2 className="text-[12px] uppercase tracking-wide font-semibold text-[var(--text-secondary)] mb-3">Header</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <div>
                <span className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">SO Number</span>
                <input
                  type="text"
                  className="w-full h-8 px-2 text-[13px] rounded-[2px] bg-[var(--surface-subtle)] border border-[var(--aws-border)] text-[var(--text-secondary)] font-mono"
                  value={original.so_number ?? ""}
                  readOnly
                />
              </div>
              <Field label="SO Date *"           value={header.so_date}              onChange={(v) => setHeaderField("so_date", v)} type="date" />
              <Field label="Customer Name *"     value={header.customer_name}        onChange={(v) => setHeaderField("customer_name", v)} />
              <Field label="Common Customer *"   value={header.common_customer_name} onChange={(v) => setHeaderField("common_customer_name", v)} />
              <Selector label="Company *"        value={header.company}              options={COMPANY_OPTIONS as unknown as string[]}      onChange={(v) => setHeaderField("company", v)} />
              <Selector label="Voucher Type *"   value={header.voucher_type}         options={VOUCHER_TYPE_OPTIONS as unknown as string[]} onChange={(v) => setHeaderField("voucher_type", v)} />
            </div>
          </section>

          <section ref={linesSecRef} className="mb-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-[12px] uppercase tracking-wide font-semibold text-[var(--text-secondary)]">Line Items</h2>
              <button
                type="button"
                onClick={addLine}
                disabled={submitting}
                className="h-7 px-3 rounded-[2px] text-[12px] font-semibold border bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white disabled:opacity-50"
              >
                + Add line
              </button>
            </div>
            {lines.length === 0 ? (
              <div className="bg-white border border-dashed border-[var(--aws-border-strong)] rounded-md p-8 text-center text-[var(--text-muted)] text-[12px]">
                No lines on this SO. Add one to start.
              </div>
            ) : (
              lines.map((l, i) => (
                <SoLineEditor
                  key={i}
                  line={l}
                  index={i}
                  onChange={(next) => updateLine(i, next)}
                  onRemove={() => removeLine(i)}
                  disabled={submitting}
                />
              ))
            )}
          </section>

          <div className="flex items-center gap-3 mb-8">
            <button
              type="button"
              onClick={() => {
                // Cancel is explicit abandon — drop the draft so it
                // doesn't resurrect on the next visit to this SO.
                clearDraft();
                router.push("/modules/production/so-creation");
              }}
              disabled={submitting}
              className="h-9 px-3 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className={[
                "h-9 px-4 rounded-[2px] text-[13px] font-bold border tracking-wide",
                submitting
                  ? "bg-[#c98f92] border-[#c98f92] cursor-not-allowed text-[var(--text-primary)]"
                  : "bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white",
              ].join(" ")}
            >
              {submitting ? "Submitting…" : "Submit update"}
            </button>
            {feedback ? (
              <span className={["text-[12px]", feedback.kind === "ok" ? "text-[var(--text-success)]" : "text-[var(--aws-error)]"].join(" ")}>
                {feedback.msg}
              </span>
            ) : null}
          </div>
        </form>
      ) : null}
    </SoChrome>
  );
}

const headerInputCls =
  "w-full h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]";

function Field({
  label, value, onChange, type = "text",
}: { label: string; value: string; onChange: (v: string) => void; type?: "text" | "date" }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">{label}</span>
      <input type={type} className={headerInputCls} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function Selector({
  label, value, options, onChange,
}: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">{label}</span>
      <select className={headerInputCls} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">— Select —</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}
