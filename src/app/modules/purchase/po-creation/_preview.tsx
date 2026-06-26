"use client";

// PO Preview / Commit component — Task 2.2
// Mirrors frontend_replica/src/modules/purchase/po-creation/po-creation.js
// lines 134–727 as React. State management lifted to PoPreview root;
// sub-components are purely presentational / receive callbacks.

import { useState } from "react";
import {
  type PreviewResponse,
  type PreviewPo,
  type PreviewLine,
  type PreviewHeader,
  type CommitMode,
  type CommitResponse,
  type CommitPo,
  type PreviewSummary,
  commitPo,
  fmtNum,
} from "@/lib/po";

// ── Public interface ──────────────────────────────────────────────────────────

export interface PreviewProps {
  fileName: string;
  entity: string; // "cfpl" | "cdpl"
  preview: PreviewResponse;
  onCancel: () => void; // re-upload / cancel → parent returns to upload zone
  onCommitted: (r: CommitResponse) => void; // parent shows result banner + refreshes listing
}

// ── Internal working types ────────────────────────────────────────────────────

type WorkPo = PreviewPo & {
  _selected: boolean;
  _expanded: boolean;
  _diffOpen: boolean;
};

type FilterKind = "all" | "new" | "duplicate" | "warning" | "unmatched";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Mirror po-creation.js toNum — empty/null → null; non-numeric string → keep string */
function toNum(v: string): number | string | null {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return isNaN(n) ? v : n;
}

/** Mirror po-creation.js toDateInput — strip time portion from ISO datetime strings */
function toDateInput(v: unknown): string {
  if (v == null || v === "") return "";
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : s;
}

/** Mirror po-creation.js poMatchesFilter exactly */
function poMatchesFilter(po: WorkPo, f: FilterKind): boolean {
  if (f === "all") return true;
  if (f === "new") return !po.is_duplicate;
  if (f === "duplicate") return !!po.is_duplicate;
  if (f === "warning") return Array.isArray(po.warnings) && po.warnings.length > 0;
  if (f === "unmatched")
    return (po.lines || []).some(
      (l) => !l.matched_item || (l.match_score != null && l.match_score < 0.6),
    );
  return true;
}

/** Mirror po-creation.js countDiffFields */
function countDiffFields(diff: Record<string, unknown>): number {
  let n = 0;
  if (diff.header && typeof diff.header === "object") {
    n += Object.keys(diff.header as Record<string, unknown>).length;
  }
  if (Array.isArray(diff.lines)) {
    (diff.lines as unknown[]).forEach((ln) => {
      const lnObj = ln as Record<string, unknown>;
      const f = lnObj.fields ?? lnObj.changes ?? lnObj;
      if (typeof f === "object" && f !== null) {
        n += Object.keys(f as Record<string, unknown>).filter((k) => k !== "line_number").length;
      }
    });
  }
  if (n === 0 && typeof diff === "object") {
    Object.values(diff).forEach((v) => {
      if (
        typeof v === "object" &&
        v !== null &&
        ("before" in (v as object) ||
          "after" in (v as object) ||
          "old" in (v as object) ||
          "new" in (v as object))
      ) {
        n++;
      }
    });
  }
  return n;
}

/** Strip working UI meta from a WorkPo before sending to API */
function stripMeta(po: WorkPo): CommitPo {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _selected, _expanded, _diffOpen, ...rest } = po;
  // Coerce numeric line fields from raw strings to numbers/null at commit time.
  // Working state stores raw strings so decimals are typeable; the wire payload must be numeric.
  const numericLineFields = ["rate", "amount", "po_weight", "pack_count", "gst_rate", "line_number"] as const;
  const lines = rest.lines?.map((l) => {
    const coerced: Record<string, unknown> = { ...l };
    for (const f of numericLineFields) {
      if (f in coerced) {
        coerced[f] = toNum(String(coerced[f] ?? ""));
      }
    }
    return coerced as PreviewLine;
  });
  return { ...rest, lines } as CommitPo;
}

// ── Root component ────────────────────────────────────────────────────────────

export function PoPreview(props: PreviewProps): React.JSX.Element {
  const { fileName, entity, preview, onCancel, onCommitted } = props;

  // Cloned once on mount. The parent remounts PoPreview with key={fileName} per upload,
  // so a new parse always gets a fresh instance (no prop-driven reset needed here).
  const [pos, setPos] = useState<WorkPo[]>(() =>
    (preview.pos || []).map((po) => ({
      ...po,
      _selected: true,
      _expanded: false,
      _diffOpen: false,
    })),
  );

  const [activeFilter, setActiveFilter] = useState<FilterKind>("all");
  const [mode, setMode] = useState<CommitMode>("create_only");
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [lastAttemptFailed, setLastAttemptFailed] = useState(false);

  // ── Derived ────────────────────────────────────────────────────────────────

  const visiblePos = pos.filter((po) => poMatchesFilter(po, activeFilter));
  const selectedPos = pos.filter((po) => po._selected);
  const newSel = selectedPos.filter((p) => !p.is_duplicate).length;
  const dupSel = selectedPos.filter((p) => p.is_duplicate).length;

  // ── State mutators (immutable updates) ────────────────────────────────────

  function updatePo(idx: number, patch: Partial<WorkPo>) {
    setPos((prev) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  }

  function updateHeader(poIdx: number, field: string, value: string) {
    setPos((prev) =>
      prev.map((p, i) => {
        if (i !== poIdx) return p;
        return { ...p, header: { ...p.header, [field]: value } as PreviewHeader };
      }),
    );
  }

  function updateLine(
    poIdx: number,
    lineIdx: number,
    field: string,
    rawValue: string,
  ) {
    // Store the raw string for ALL fields (including numeric ones) so the user
    // can type decimals like "1." or "0.5" without the value being clamped.
    // Numeric coercion happens in stripMeta at commit time.
    setPos((prev) =>
      prev.map((p, i) => {
        if (i !== poIdx) return p;
        const lines = p.lines.map((l, li) =>
          li === lineIdx ? ({ ...l, [field]: rawValue } as PreviewLine) : l,
        );
        return { ...p, lines };
      }),
    );
  }

  // ── Bulk select (over visible POs only, per po-creation.js) ───────────────

  function selectAll() {
    setPos((prev) =>
      prev.map((p) =>
        poMatchesFilter(p, activeFilter) ? { ...p, _selected: true } : p,
      ),
    );
  }

  function selectNone() {
    setPos((prev) =>
      prev.map((p) =>
        poMatchesFilter(p, activeFilter) ? { ...p, _selected: false } : p,
      ),
    );
  }

  // ── Commit ─────────────────────────────────────────────────────────────────

  async function handleCommit() {
    if (selectedPos.length === 0) return;
    setCommitting(true);
    setCommitError(null);
    setLastAttemptFailed(false);
    try {
      const result = await commitPo({
        entity,
        mode,
        pos: selectedPos.map(stripMeta),
      });
      onCommitted(result);
    } catch (err) {
      setCommitError(err instanceof Error ? err.message : "Commit failed");
      setLastAttemptFailed(true);
    } finally {
      setCommitting(false);
    }
  }

  // ── Hint string ──────────────────────────────────────────────────────────

  let hint = "";
  if (mode === "create_only" && dupSel > 0)
    hint = ` · ${dupSel} duplicate${dupSel > 1 ? "s" : ""} will be skipped`;
  if (mode === "update_only" && newSel > 0)
    hint = ` · ${newSel} new will be skipped`;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="relative pb-24">
      {/* ── Header bar ────────────────────────────────────────────────── */}
      <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] p-4 mb-4 flex flex-wrap items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="inline-flex items-center h-5 px-2 text-[10px] font-bold uppercase tracking-wide rounded-full bg-[var(--aws-navy)] text-white">
              Step 2 of 2
            </span>
            <h2 className="text-[16px] font-semibold text-[var(--text-primary)]">
              Review &amp; commit
            </h2>
          </div>
          <p className="text-[12px] text-[var(--text-secondary)]">
            Parsed from{" "}
            <span className="font-semibold text-[var(--text-primary)]">{fileName}</span>
            {" · "}entity{" "}
            <span className="font-mono text-[var(--text-primary)] uppercase">{entity}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] flex items-center gap-1.5"
        >
          <svg
            viewBox="0 0 24 24"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Re-upload
        </button>
      </div>

      {/* ── Summary strip ─────────────────────────────────────────────── */}
      <SummaryStrip summary={preview.summary} />

      {/* ── Filter pills + bulk controls ──────────────────────────────── */}
      <FilterPills
        pos={pos}
        activeFilter={activeFilter}
        onFilter={(f) => setActiveFilter(f)}
        onSelectAll={selectAll}
        onSelectNone={selectNone}
      />

      {/* ── PO list ───────────────────────────────────────────────────── */}
      {visiblePos.length === 0 ? (
        <div className="bg-white border border-[var(--aws-border)] rounded-md p-8 text-center text-[var(--text-secondary)] text-[13px]">
          No POs match this filter.
        </div>
      ) : (
        <div className="space-y-2">
          {visiblePos.map((po) => {
            // Find original index in pos[] so mutations target the right item
            const originalIdx = pos.indexOf(po);
            return (
              <PreviewCard
                key={po.transaction_no || po.duplicate_key || originalIdx}
                po={po}
                onToggleSelect={() => updatePo(originalIdx, { _selected: !po._selected })}
                onToggleExpand={() => updatePo(originalIdx, { _expanded: !po._expanded })}
                onToggleDiff={() => updatePo(originalIdx, { _diffOpen: !po._diffOpen })}
                onHeaderChange={(field, value) => updateHeader(originalIdx, field, value)}
                onLineChange={(lineIdx, field, value) =>
                  updateLine(originalIdx, lineIdx, field, value)
                }
              />
            );
          })}
        </div>
      )}

      {/* ── Commit bar (sticky bottom) ────────────────────────────────── */}
      <CommitBar
        mode={mode}
        onMode={setMode}
        selected={selectedPos.length}
        newSel={newSel}
        dupSel={dupSel}
        hint={hint}
        committing={committing}
        lastAttemptFailed={lastAttemptFailed}
        commitError={commitError}
        onCommit={handleCommit}
        onCancel={onCancel}
      />
    </div>
  );
}

// ── SummaryStrip ──────────────────────────────────────────────────────────────

function SummaryStrip({
  summary,
}: {
  summary: PreviewSummary;
}): React.JSX.Element {
  const cards: { label: string; value: string; accent: string }[] = [
    { label: "Total POs", value: fmtNum(summary.total_pos), accent: "var(--clr-info, #0972d3)" },
    { label: "New", value: fmtNum(summary.new), accent: "var(--clr-ok, #1d8102)" },
    { label: "Duplicates", value: fmtNum(summary.duplicates), accent: "var(--clr-warning, #d13212)" },
    { label: "Matched lines", value: fmtNum(summary.matched_lines), accent: "var(--clr-info, #0972d3)" },
    { label: "Unmatched lines", value: fmtNum(summary.unmatched_lines), accent: "var(--clr-danger, #c2483c)" },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2 mb-4">
      {cards.map((c) => (
        <div
          key={c.label}
          className="bg-white border border-[var(--aws-border)] rounded-md p-3 shadow-[0_1px_1px_rgba(0,28,36,0.12)]"
          style={{ borderTopColor: c.accent, borderTopWidth: "3px" }}
        >
          <div className="text-[11px] text-[var(--text-secondary)] mb-1">{c.label}</div>
          <div
            className="text-[22px] font-bold leading-none"
            style={{ color: c.accent }}
          >
            {c.value}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── FilterPills ───────────────────────────────────────────────────────────────

function FilterPills({
  pos,
  activeFilter,
  onFilter,
  onSelectAll,
  onSelectNone,
}: {
  pos: WorkPo[];
  activeFilter: FilterKind;
  onFilter: (f: FilterKind) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
}): React.JSX.Element {
  const filters: { value: FilterKind; label: string }[] = [
    { value: "all", label: "All" },
    { value: "new", label: "New" },
    { value: "duplicate", label: "Duplicate" },
    { value: "warning", label: "Warning" },
    { value: "unmatched", label: "Unmatched" },
  ];

  function countFor(f: FilterKind) {
    return pos.filter((p) => poMatchesFilter(p, f)).length;
  }

  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.12)] p-3 mb-3 flex flex-wrap items-center gap-2">
      {filters.map((f) => {
        const count = countFor(f.value);
        const active = activeFilter === f.value;
        return (
          <button
            key={f.value}
            type="button"
            onClick={() => onFilter(f.value)}
            className={[
              "h-7 px-3 text-[12px] rounded-full border transition-colors flex items-center gap-1.5",
              active
                ? "bg-[var(--aws-navy)] text-white border-[var(--aws-navy)]"
                : "bg-white text-[var(--text-primary)] border-[var(--aws-border-strong)] hover:border-[var(--aws-navy)]",
            ].join(" ")}
          >
            {f.label}
            <span
              className="inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 text-[10px] rounded-full font-bold"
              style={{
                background: active ? "rgba(255,255,255,0.18)" : "var(--surface-disabled)",
                color: active ? "white" : "var(--text-secondary)",
              }}
            >
              {count}
            </span>
          </button>
        );
      })}

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={onSelectAll}
          className="h-7 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]"
        >
          Select all
        </button>
        <button
          type="button"
          onClick={onSelectNone}
          className="h-7 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]"
        >
          Deselect all
        </button>
      </div>
    </div>
  );
}

// ── PreviewCard ───────────────────────────────────────────────────────────────

function PreviewCard({
  po,
  onToggleSelect,
  onToggleExpand,
  onToggleDiff,
  onHeaderChange,
  onLineChange,
}: {
  po: WorkPo;
  onToggleSelect: () => void;
  onToggleExpand: () => void;
  onToggleDiff: () => void;
  onHeaderChange: (field: string, value: string) => void;
  onLineChange: (lineIdx: number, field: string, value: string) => void;
}): React.JSX.Element {
  const dup = !!po.is_duplicate;
  const warnings = po.warnings || [];
  const lines = po.lines || [];
  const header = po.header || {};
  const diff = po.diff && Object.keys(po.diff).length > 0 ? po.diff : null;

  const unmatchedCount = lines.filter(
    (l) => !l.matched_item || (l.match_score != null && l.match_score < 0.6),
  ).length;

  const diffChangeCount = diff ? countDiffFields(diff) : 0;

  return (
    <article
      className={[
        "bg-white border rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.12)] overflow-hidden transition-opacity",
        po._selected ? "border-[var(--aws-border)]" : "border-[var(--aws-border)] opacity-60",
      ].join(" ")}
    >
      {/* Card header */}
      <header
        className="flex items-start gap-3 p-3 cursor-pointer select-none hover:bg-[var(--surface-subtle)]"
        onClick={(e) => {
          if ((e.target as Element).closest("label, input, button")) return;
          onToggleExpand();
        }}
      >
        {/* Checkbox */}
        <label
          className="mt-0.5 flex-shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={po._selected}
            onChange={onToggleSelect}
            aria-label={`Select PO ${header.po_number || po.transaction_no}`}
            className="w-4 h-4 accent-[var(--aws-navy)] cursor-pointer"
          />
        </label>

        {/* Main */}
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 mb-1">
            <span className="font-mono text-[13px] font-semibold text-[var(--text-primary)]">
              {header.po_number || "—"}
            </span>
            {dup ? (
              <span className="inline-flex items-center h-5 px-1.5 text-[10px] font-bold rounded-[2px] bg-[#fff3e0] text-[#d13212] border border-[#f5c88a]">
                Duplicate · update
              </span>
            ) : (
              <span className="inline-flex items-center h-5 px-1.5 text-[10px] font-bold rounded-[2px] bg-[#eaf6ed] text-[#1d8102] border border-[#b6dbb1]">
                New
              </span>
            )}
            {warnings.length > 0 && (
              <span className="inline-flex items-center h-5 px-1.5 text-[10px] font-bold rounded-[2px] bg-[#fbeced] text-[#9a393e] border border-[#e6bcbe]">
                {warnings.length} warning{warnings.length > 1 ? "s" : ""}
              </span>
            )}
            {unmatchedCount > 0 && (
              <span className="inline-flex items-center h-5 px-1.5 text-[10px] font-bold rounded-[2px] bg-[var(--surface-disabled)] text-[var(--text-muted)] border border-[var(--aws-border)]">
                {unmatchedCount} unmatched
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[12px] text-[var(--text-secondary)]">
            <span>
              <strong className="text-[var(--text-primary)]">Supplier</strong>{" "}
              {String(header.vendor_supplier_name || header.supplier_id || "—")}
            </span>
            <span>
              <strong className="text-[var(--text-primary)]">Date</strong>{" "}
              {String(header.po_date || "—")}
            </span>
            <span>
              <strong className="text-[var(--text-primary)]">Lines</strong>{" "}
              {lines.length}
            </span>
            <span>
              <strong className="text-[var(--text-primary)]">Txn</strong>{" "}
              <span className="font-mono">{po.transaction_no || "—"}</span>
            </span>
          </div>
        </div>

        {/* Right controls */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {dup && diff && diffChangeCount > 0 && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onToggleDiff(); }}
              className="h-6 px-2 text-[11px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] flex items-center gap-1"
            >
              <svg
                viewBox="0 0 24 24"
                width="11"
                height="11"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                aria-hidden
                className={po._diffOpen ? "rotate-180" : ""}
                style={{ transition: "transform 0.15s" }}
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
              {diffChangeCount} change{diffChangeCount === 1 ? "" : "s"}
            </button>
          )}
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            aria-hidden
            className={po._expanded ? "rotate-180 text-[var(--text-muted)]" : "text-[var(--text-muted)]"}
            style={{ transition: "transform 0.15s" }}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </header>

      {/* Diff panel (duplicate with diff only) */}
      {dup && diff && po._diffOpen && (
        <DiffPanel diff={diff} />
      )}

      {/* Expanded body */}
      {po._expanded && (
        <div className="border-t border-[var(--aws-border)] p-4 space-y-5">
          <HeaderEditGrid header={header} onChange={onHeaderChange} />
          <LinesTable lines={lines} onChange={onLineChange} />
          {warnings.length > 0 && <WarningsList warnings={warnings} />}
        </div>
      )}
    </article>
  );
}

// ── HeaderEditGrid ────────────────────────────────────────────────────────────

type HeaderField = {
  f: string;
  label: string;
  mono?: boolean;
  wide?: boolean;
  type?: string;
};

const HEADER_FIELDS: HeaderField[] = [
  { f: "po_number",     label: "PO Number",     mono: true },
  { f: "po_date",       label: "PO Date",        type: "date" },
  { f: "delivery_date", label: "Delivery Date",  type: "date" },
  { f: "vendor_supplier_name", label: "Supplier" },
  { f: "remarks",       label: "Remarks",        wide: true },
];

function HeaderEditGrid({
  header,
  onChange,
}: {
  header: PreviewHeader;
  onChange: (field: string, value: string) => void;
}): React.JSX.Element {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)] mb-2">
        Header
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {HEADER_FIELDS.map(({ f, label, mono, wide, type }) => (
          <div key={f} className={wide ? "col-span-2 sm:col-span-4" : ""}>
            <label className="block text-[11px] font-semibold text-[var(--text-primary)] mb-0.5">
              {label}
            </label>
            <input
              type={type ?? "text"}
              value={toDateInput(header[f])}
              onChange={(e) => onChange(f, e.target.value)}
              spellCheck={false}
              className={[
                "w-full h-7 px-2 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] bg-white",
                mono ? "font-mono" : "",
              ].join(" ")}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── LinesTable ────────────────────────────────────────────────────────────────

function LinesTable({
  lines,
  onChange,
}: {
  lines: PreviewLine[];
  onChange: (lineIdx: number, field: string, value: string) => void;
}): React.JSX.Element {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)] mb-2">
        Lines · {lines.length}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px] border-collapse min-w-[700px]">
          <thead className="bg-[var(--surface-subtle)]">
            <tr className="border-b border-[var(--aws-border)]">
              <th className="text-left px-2 py-1.5 font-semibold text-[var(--text-primary)] w-[42px]">#</th>
              <th className="text-left px-2 py-1.5 font-semibold text-[var(--text-primary)]">SKU</th>
              <th className="text-left px-2 py-1.5 font-semibold text-[var(--text-primary)] w-[80px]">UOM</th>
              <th className="text-left px-2 py-1.5 font-semibold text-[var(--text-primary)] w-[90px]">Pack</th>
              <th className="text-left px-2 py-1.5 font-semibold text-[var(--text-primary)] w-[110px]">Weight</th>
              <th className="text-left px-2 py-1.5 font-semibold text-[var(--text-primary)] w-[110px]">Rate</th>
              <th className="text-left px-2 py-1.5 font-semibold text-[var(--text-primary)] w-[120px]">Amount</th>
              <th className="text-left px-2 py-1.5 font-semibold text-[var(--text-primary)] w-[80px]">GST %</th>
              <th className="text-left px-2 py-1.5 font-semibold text-[var(--text-primary)] w-[130px]">Match</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <LineRow key={i} line={l} lineIdx={i} onChange={onChange} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LineRow({
  line,
  lineIdx,
  onChange,
}: {
  line: PreviewLine;
  lineIdx: number;
  onChange: (lineIdx: number, field: string, value: string) => void;
}): React.JSX.Element {
  const score = line.match_score == null ? null : Number(line.match_score);
  const matchKind =
    score == null ? "none" : score >= 0.85 ? "good" : score >= 0.6 ? "fair" : "poor";
  const matchLabel =
    score == null
      ? "Unmatched"
      : `${Math.round(score * 100)}% · ${line.match_source || "auto"}`;

  const matchColors: Record<string, string> = {
    good: "text-[#1d8102] bg-[#eaf6ed]",
    fair: "text-[#d13212] bg-[#fff3e0]",
    poor: "text-[#9a393e] bg-[#fbeced]",
    none: "text-[var(--text-muted)] bg-[var(--surface-disabled)]",
  };

  const skuName = String(
    line.sku_name ||
      (line.matched_item && (line.matched_item as { sku_code?: string }).sku_code) ||
      "—",
  );

  function cellInput(
    field: string,
    value: string | number | null | undefined,
    type = "text",
  ) {
    return (
      <input
        type={type}
        step={type === "number" ? "any" : undefined}
        value={value == null ? "" : String(value)}
        onChange={(e) => onChange(lineIdx, field, e.target.value)}
        spellCheck={false}
        className="w-full h-6 px-1.5 text-[12px] font-mono rounded-[2px] border border-[var(--aws-border)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] bg-white"
      />
    );
  }

  return (
    <tr className="border-b border-[var(--aws-border)] last:border-b-0 hover:bg-[var(--surface-subtle)]">
      <td className="px-2 py-1 font-mono text-[var(--text-muted)]">
        {line.line_number ?? lineIdx + 1}
      </td>
      <td className="px-2 py-1">
        <div className="space-y-0.5">
          {cellInput("sku_name", skuName)}
          {line.matched_item && (line.matched_item as { sku_code?: string }).sku_code ? (
            <span className="block text-[10px] font-mono text-[var(--text-muted)] leading-none">
              {String((line.matched_item as { sku_code?: string }).sku_code)}
            </span>
          ) : null}
        </div>
      </td>
      <td className="px-2 py-1">{cellInput("uom", line.uom)}</td>
      <td className="px-2 py-1">{cellInput("pack_count", line.pack_count, "number")}</td>
      <td className="px-2 py-1">{cellInput("po_weight", line.po_weight, "number")}</td>
      <td className="px-2 py-1">{cellInput("rate", line.rate, "number")}</td>
      <td className="px-2 py-1">{cellInput("amount", line.amount, "number")}</td>
      <td className="px-2 py-1">{cellInput("gst_rate", line.gst_rate, "number")}</td>
      <td className="px-2 py-1">
        <span
          className={[
            "inline-flex items-center h-5 px-1.5 text-[10px] font-semibold rounded-[2px]",
            matchColors[matchKind],
          ].join(" ")}
          title={line.match_source || ""}
        >
          {matchLabel}
        </span>
      </td>
    </tr>
  );
}

// ── DiffPanel ─────────────────────────────────────────────────────────────────

type DiffRow = { scope: string; field: string; before: unknown; after: unknown };

function buildDiffRows(diff: Record<string, unknown>): DiffRow[] {
  const rows: DiffRow[] = [];

  // header diff
  if (diff.header && typeof diff.header === "object") {
    const hdr = diff.header as Record<string, unknown>;
    Object.entries(hdr).forEach(([k, v]) => {
      const vObj = v as Record<string, unknown>;
      rows.push({
        scope: "Header",
        field: k,
        before: vObj?.before ?? vObj?.old,
        after: vObj?.after ?? vObj?.new,
      });
    });
  }

  // lines diff
  if (Array.isArray(diff.lines)) {
    (diff.lines as unknown[]).forEach((ln, i) => {
      const lnObj = ln as Record<string, unknown>;
      const fields =
        (lnObj.fields as Record<string, unknown>) ??
        (lnObj.changes as Record<string, unknown>) ??
        lnObj;
      if (typeof fields === "object" && fields !== null) {
        Object.entries(fields).forEach(([k, v]) => {
          if (k === "line_number") return;
          const vObj = v as Record<string, unknown>;
          rows.push({
            scope: `Line ${lnObj.line_number != null ? String(lnObj.line_number) : String(i + 1)}`,
            field: k,
            before: vObj?.before ?? vObj?.old,
            after: vObj?.after ?? vObj?.new,
          });
        });
      }
    });
  }

  // flat fallback
  if (rows.length === 0 && typeof diff === "object") {
    Object.entries(diff).forEach(([k, v]) => {
      if (
        typeof v === "object" &&
        v !== null &&
        ("before" in (v as object) ||
          "after" in (v as object) ||
          "old" in (v as object) ||
          "new" in (v as object))
      ) {
        const vObj = v as Record<string, unknown>;
        rows.push({
          scope: "—",
          field: k,
          before: vObj.before ?? vObj.old,
          after: vObj.after ?? vObj.new,
        });
      }
    });
  }

  return rows;
}

function formatDiffVal(v: unknown): string {
  if (v == null || v === "") return "—";
  return String(v);
}

function DiffPanel({ diff }: { diff: Record<string, unknown> }): React.JSX.Element {
  const rows = buildDiffRows(diff);
  if (rows.length === 0) return <></>;

  return (
    <div className="border-t border-[var(--aws-border)] bg-[#fffaf0] px-4 py-3">
      <div className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)] mb-2">
        Changes vs current DB
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px] border-collapse">
          <thead>
            <tr className="border-b border-[var(--aws-border)]">
              <th className="text-left px-2 py-1 font-semibold text-[var(--text-primary)] w-[100px]">Scope</th>
              <th className="text-left px-2 py-1 font-semibold text-[var(--text-primary)] w-[140px]">Field</th>
              <th className="text-left px-2 py-1 font-semibold text-[var(--text-primary)]">Current</th>
              <th className="px-2 py-1 text-[var(--text-muted)] w-[20px]">→</th>
              <th className="text-left px-2 py-1 font-semibold text-[var(--text-primary)]">Incoming</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-[var(--aws-border)] last:border-b-0">
                <td className="px-2 py-1 text-[var(--text-secondary)]">{r.scope}</td>
                <td className="px-2 py-1 font-mono text-[var(--text-primary)]">{r.field}</td>
                <td className="px-2 py-1 font-mono text-[#9a393e]">
                  {formatDiffVal(r.before) === "—" ? (
                    <span className="text-[var(--text-muted)] italic">—</span>
                  ) : (
                    formatDiffVal(r.before)
                  )}
                </td>
                <td className="px-2 py-1 text-center text-[var(--text-muted)]">→</td>
                <td className="px-2 py-1 font-mono text-[#1d8102]">
                  {formatDiffVal(r.after) === "—" ? (
                    <span className="text-[var(--text-muted)] italic">—</span>
                  ) : (
                    formatDiffVal(r.after)
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── WarningsList ──────────────────────────────────────────────────────────────

function WarningsList({
  warnings,
}: {
  warnings: (string | Record<string, unknown>)[];
}): React.JSX.Element {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)] mb-1.5">
        Warnings
      </div>
      <ul className="space-y-1">
        {warnings.map((w, i) => {
          const msg =
            typeof w === "string"
              ? w
              : typeof w === "object" && w !== null
                ? String(
                    (w as Record<string, unknown>).message ??
                      (w as Record<string, unknown>).detail ??
                      JSON.stringify(w),
                  )
                : String(w);
          return (
            <li
              key={i}
              className="flex items-start gap-1.5 text-[12px] text-[#9a393e] bg-[#fbeced] border border-[#e6bcbe] rounded-[2px] px-2 py-1"
            >
              <svg
                viewBox="0 0 24 24"
                width="13"
                height="13"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                className="flex-shrink-0 mt-0.5"
                aria-hidden
              >
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              {msg}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── CommitBar ─────────────────────────────────────────────────────────────────

function CommitBar({
  mode,
  onMode,
  selected,
  newSel,
  dupSel,
  hint,
  committing,
  lastAttemptFailed,
  commitError,
  onCommit,
  onCancel,
}: {
  mode: CommitMode;
  onMode: (m: CommitMode) => void;
  selected: number;
  newSel: number;
  dupSel: number;
  hint: string;
  committing: boolean;
  lastAttemptFailed: boolean;
  commitError: string | null;
  onCommit: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const modes: { value: CommitMode; label: string }[] = [
    { value: "create_only", label: "Create only" },
    { value: "update_only", label: "Update only" },
    { value: "upsert",      label: "Upsert" },
  ];

  const btnLabel = committing
    ? "Committing…"
    : lastAttemptFailed
      ? "Retry commit"
      : `Commit ${selected} PO${selected === 1 ? "" : "s"}`;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-30 bg-white border-t border-[var(--aws-border)] shadow-[0_-2px_8px_rgba(0,28,36,0.12)] px-4 py-3">
      <div className="max-w-5xl mx-auto flex flex-wrap items-center gap-3">
        {/* Mode radio group */}
        <div className="flex items-center gap-1 rounded-[2px] border border-[var(--aws-border-strong)] overflow-hidden">
          {modes.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => onMode(m.value)}
              disabled={committing}
              className={[
                "h-8 px-3 text-[12px] transition-colors",
                mode === m.value
                  ? "bg-[var(--aws-navy)] text-white"
                  : "bg-white text-[var(--text-primary)] hover:bg-[var(--surface-subtle)] border-l border-[var(--aws-border-strong)] first:border-l-0",
              ].join(" ")}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* Stats */}
        <div className="flex-1 text-[12px] text-[var(--text-secondary)]">
          <strong className="text-[var(--text-primary)]">{selected}</strong> selected{" "}
          <span className="text-[var(--text-muted)]">
            ({newSel} new, {dupSel} duplicate){hint}
          </span>
        </div>

        {/* Error */}
        {commitError && (
          <span className="text-[12px] text-[var(--aws-error)]">{commitError}</span>
        )}

        {/* Cancel */}
        <button
          type="button"
          onClick={onCancel}
          disabled={committing}
          className="h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] disabled:opacity-50"
        >
          Cancel
        </button>

        {/* Commit */}
        <button
          type="button"
          onClick={onCommit}
          disabled={committing || selected === 0}
          className="h-8 px-4 text-[12px] font-semibold rounded-[2px] bg-[var(--aws-navy)] text-white hover:bg-[#002244] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {committing && (
            <span className="inline-block w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          )}
          {btnLabel}
        </button>
      </div>
    </div>
  );
}
