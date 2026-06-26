"use client";

// Add Readings modal — catalog-driven parameter picker.
// Parameters offered come from listParameters() (fetched on open) and are
// grouped by param_group. The inspector ticks the parameters they want to
// record; each selected parameter renders a value input typed by value_kind
// ('text' → text input → observed_value_text, otherwise numeric → observed_value_num),
// plus the optional method / instrument / notes fields. Submit builds
// ReadingInput[] and calls addReadings(...) exactly as before.
//
// Preserves the existing { inspectionId, onClose, onDone } contract and the
// existing busy / error / success handling.

import { useEffect, useMemo, useState } from "react";
import {
  type ReadingInput,
  type ParameterItem,
  addReadings,
  listParameters,
} from "@/lib/qc";

// ── Per-parameter draft (only for selected parameters) ────────────────────────

interface DraftEntry {
  observed_value_num: string;
  observed_value_text: string;
  method: string;
  instrument: string;
  notes: string;
}

function emptyEntry(): DraftEntry {
  return {
    observed_value_num: "",
    observed_value_text: "",
    method: "",
    instrument: "",
    notes: "",
  };
}

const UNGROUPED = "Ungrouped";

interface ParamGroup {
  group: string;
  items: ParameterItem[];
}

function groupParameters(items: ParameterItem[]): ParamGroup[] {
  const map = new Map<string, ParameterItem[]>();
  for (const it of items) {
    const key = it.param_group?.trim() || UNGROUPED;
    const bucket = map.get(key);
    if (bucket) bucket.push(it);
    else map.set(key, [it]);
  }
  return Array.from(map.entries()).map(([group, groupItems]) => ({ group, items: groupItems }));
}

export function AddReadingsModal({
  inspectionId,
  onClose,
  onDone,
}: {
  inspectionId: number;
  onClose: () => void;
  onDone: () => void;
}): React.JSX.Element {
  const titleId = "add-readings-modal-title";

  // ── Catalog ─────────────────────────────────────────────────────────────────
  const [params, setParams] = useState<ParameterItem[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  // Selected parameter_id → draft entry.
  const [selected, setSelected] = useState<Record<number, DraftEntry>>({});

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // ── Escape to close ───────────────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // ── Fetch catalog on open ─────────────────────────────────────────────────────
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      setCatalogLoading(true);
      setCatalogError(null);
      try {
        const resp = await listParameters(true, controller.signal);
        if (controller.signal.aborted) return;
        setParams(resp);
      } catch (e) {
        if (controller.signal.aborted) return;
        if (e instanceof Error && e.name === "AbortError") return;
        setCatalogError(e instanceof Error ? e.message : "Failed to load parameters");
        setParams([]);
      } finally {
        if (!controller.signal.aborted) setCatalogLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  const groups = useMemo(() => groupParameters(params), [params]);
  const paramById = useMemo(() => {
    const m = new Map<number, ParameterItem>();
    for (const p of params) m.set(p.parameter_id, p);
    return m;
  }, [params]);

  // ── Selection + per-entry edits ───────────────────────────────────────────────
  function toggleParam(id: number) {
    setSelected((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = emptyEntry();
      return next;
    });
  }

  function updateEntry(id: number, patch: Partial<DraftEntry>) {
    setSelected((prev) => {
      const cur = prev[id];
      if (!cur) return prev;
      return { ...prev, [id]: { ...cur, ...patch } };
    });
  }

  const selectedIds = Object.keys(selected).map(Number);

  // ── Validation ────────────────────────────────────────────────────────────────
  function validate(): string | null {
    if (selectedIds.length === 0) return "Select at least one parameter to record.";
    for (const id of selectedIds) {
      const param = paramById.get(id);
      const entry = selected[id];
      const label = param?.name ?? `Parameter ${id}`;
      if (param?.value_kind === "text") {
        if (entry.observed_value_text.trim() === "") return `${label}: enter a text value.`;
      } else {
        if (entry.observed_value_num.trim() === "") return `${label}: enter a numeric value.`;
      }
    }
    return null;
  }

  async function submit() {
    const validationError = validate();
    if (validationError) { setErr(validationError); return; }
    setBusy(true);
    setErr(null);
    const readings: ReadingInput[] = selectedIds.map((id) => {
      const param = paramById.get(id);
      const entry = selected[id];
      const isText = param?.value_kind === "text";
      return {
        parameter_id: id,
        observed_value_num: isText
          ? null
          : entry.observed_value_num.trim() !== ""
          ? Number(entry.observed_value_num)
          : null,
        observed_value_text: isText ? entry.observed_value_text.trim() || null : null,
        method: entry.method.trim() || null,
        instrument: entry.instrument.trim() || null,
        notes: entry.notes.trim() || null,
      };
    });
    try {
      const res = await addReadings(inspectionId, readings);
      setSuccess(`${res.inserted_count} added · ${res.out_of_spec_count} out-of-spec`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to add readings");
      setBusy(false);
      return;
    }
    setBusy(false);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-white rounded-md shadow-[0_8px_32px_rgba(0,28,36,0.28)] w-full max-w-[640px] flex flex-col max-h-[90vh]"
      >
        {/* Header */}
        <div className="px-5 pt-5 pb-3 border-b border-(--aws-border) shrink-0">
          <h2 id={titleId} className="text-[15px] font-semibold text-(--text-primary)">
            Add Readings
          </h2>
          <p className="text-[12px] text-(--text-secondary) mt-0.5">
            Pick the parameters to record from the catalogue, then enter the observed value for each.
          </p>
        </div>

        {/* Body */}
        <div className="px-5 py-4 overflow-y-auto flex-1">
          {catalogLoading ? (
            <div className="py-10 text-center text-(--text-secondary)">
              <span className="inline-flex items-center gap-2 text-[13px]">
                <span className="inline-block w-4 h-4 border-2 border-(--aws-border-strong) border-t-(--aws-orange) rounded-full animate-spin" />
                Loading parameters…
              </span>
            </div>
          ) : catalogError ? (
            <p className="py-8 text-center text-[13px] text-(--aws-error)">{catalogError}</p>
          ) : params.length === 0 ? (
            <p className="py-8 text-center text-[13px] text-(--text-secondary)">
              No parameters available in the catalogue.
            </p>
          ) : (
            <div className="space-y-4">
              {groups.map((g) => (
                <div key={g.group}>
                  <p className="text-[10px] font-bold uppercase tracking-wide text-(--text-muted) mb-1.5">
                    {g.group}
                  </p>
                  <div className="space-y-1.5">
                    {g.items.map((p) => (
                      <ParameterPickerRow
                        key={p.parameter_id}
                        param={p}
                        entry={selected[p.parameter_id]}
                        onToggle={() => toggleParam(p.parameter_id)}
                        onChange={(patch) => updateEntry(p.parameter_id, patch)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Inline messages */}
          {err ? (
            <p className="text-[12px] text-(--aws-error) mt-3">{err}</p>
          ) : null}
          {success ? (
            <p className="text-[12px] text-(--text-success) mt-3 font-semibold">{success}</p>
          ) : null}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-(--aws-border) flex items-center justify-between gap-2 shrink-0">
          <span className="text-[12px] text-(--text-muted)">
            {selectedIds.length > 0 ? `${selectedIds.length} selected` : ""}
          </span>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={success ? onDone : onClose}
              disabled={busy}
              className="h-8 px-4 text-[13px] rounded-[2px] border border-(--aws-border-strong) bg-white hover:border-(--aws-navy) disabled:opacity-50"
            >
              {success ? "Close" : "Cancel"}
            </button>
            {!success ? (
              <button
                type="button"
                disabled={busy || catalogLoading}
                onClick={() => void submit()}
                className="h-8 px-4 text-[13px] rounded-[2px] border border-(--aws-orange) bg-(--aws-orange) text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {busy ? (
                  <span className="inline-block w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                ) : null}
                Submit Readings
              </button>
            ) : (
              <button
                type="button"
                onClick={onDone}
                className="h-8 px-4 text-[13px] rounded-[2px] border border-(--aws-orange) bg-(--aws-orange) text-white hover:opacity-90"
              >
                Done
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Picker row: checkbox + (when selected) value + optional fields ────────────

function ParameterPickerRow({
  param,
  entry,
  onToggle,
  onChange,
}: {
  param: ParameterItem;
  entry: DraftEntry | undefined;
  onToggle: () => void;
  onChange: (patch: Partial<DraftEntry>) => void;
}): React.JSX.Element {
  const checked = entry != null;
  const isText = param.value_kind === "text";
  const inputId = `param-${param.parameter_id}-value`;

  return (
    <div
      className={[
        "rounded-[2px] border p-2",
        checked ? "border-(--aws-border-strong) bg-(--surface-subtle)" : "border-(--aws-border) bg-white",
      ].join(" ")}
    >
      {/* Checkbox header */}
      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="mt-0.5 shrink-0"
          aria-label={`Record ${param.name}`}
        />
        <span className="flex-1 min-w-0">
          <span className="text-[13px] font-medium text-(--text-primary)">
            {param.name}
            {param.unit ? (
              <span className="ml-1 text-(--text-muted) text-[11px] font-mono">{param.unit}</span>
            ) : null}
          </span>
          <span className="ml-2 font-mono text-[11px] text-(--text-muted)">{param.code}</span>
          {param.spec_note ? (
            <span className="block text-[11px] text-(--text-secondary) mt-0.5">{param.spec_note}</span>
          ) : null}
        </span>
      </label>

      {/* Value + optional fields (only when selected) */}
      {checked && entry ? (
        <div className="mt-2 pl-6 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          {isText ? (
            <input
              id={inputId}
              type="text"
              value={entry.observed_value_text}
              onChange={(e) => onChange({ observed_value_text: e.target.value })}
              placeholder="Observed value (text)"
              aria-label={`${param.name} observed value`}
              className="h-7 px-1.5 text-[12px] rounded-[2px] border border-(--aws-border-strong) outline-none focus:border-[#9a393e] w-full sm:col-span-2"
            />
          ) : (
            <input
              id={inputId}
              type="number"
              step="any"
              value={entry.observed_value_num}
              onChange={(e) => onChange({ observed_value_num: e.target.value })}
              placeholder="Observed value (numeric)"
              aria-label={`${param.name} observed value`}
              className="h-7 px-1.5 text-[12px] rounded-[2px] border border-(--aws-border-strong) outline-none focus:border-[#9a393e] w-full sm:col-span-2"
            />
          )}
          <input
            type="text"
            value={entry.method}
            onChange={(e) => onChange({ method: e.target.value })}
            placeholder="Method (optional)"
            aria-label={`${param.name} method`}
            className="h-7 px-1.5 text-[12px] rounded-[2px] border border-(--aws-border-strong) outline-none focus:border-[#9a393e] w-full"
          />
          <input
            type="text"
            value={entry.instrument}
            onChange={(e) => onChange({ instrument: e.target.value })}
            placeholder="Instrument (optional)"
            aria-label={`${param.name} instrument`}
            className="h-7 px-1.5 text-[12px] rounded-[2px] border border-(--aws-border-strong) outline-none focus:border-[#9a393e] w-full"
          />
          <input
            type="text"
            value={entry.notes}
            onChange={(e) => onChange({ notes: e.target.value })}
            placeholder="Notes (optional)"
            aria-label={`${param.name} notes`}
            className="h-7 px-1.5 text-[12px] rounded-[2px] border border-(--aws-border-strong) outline-none focus:border-[#9a393e] w-full sm:col-span-2"
          />
        </div>
      ) : null}
    </div>
  );
}
