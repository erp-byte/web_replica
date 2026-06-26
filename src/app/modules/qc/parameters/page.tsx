"use client";

// QC Parameters reference page (read-only).
// Lists the RM-check parameter catalog from listParameters(), grouped by
// param_group, with a client-side search filter (name / code / group).
// Mirrors the inward-inspection page shell: QcChrome + useRequireAuth +
// the `mounted` SSR-hydration gate, and the list loading/error/empty states.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import { type ParameterItem, listParameters } from "@/lib/qc";
import { BackLink } from "@/components/BackLink";
import { QcChrome } from "../_chrome";

// ── Grouping ──────────────────────────────────────────────────────────────────

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

function matches(it: ParameterItem, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    (it.name?.toLowerCase().includes(needle) ?? false) ||
    (it.code?.toLowerCase().includes(needle) ?? false) ||
    (it.param_group?.toLowerCase().includes(needle) ?? false)
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ParametersPage(): React.JSX.Element {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);

  // ── Hydration guard (mirrors inward-inspection page) ──────────────────────────
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    queueMicrotask(() => setMounted(true));
  }, []);

  // ── Catalog fetch state ───────────────────────────────────────────────────────
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<ParameterItem[]>([]);

  const [search, setSearch] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!mounted || !authed) return;
    const controller = new AbortController();
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const resp = await listParameters(true, controller.signal);
        if (controller.signal.aborted) return;
        setItems(resp);
      } catch (e) {
        if (controller.signal.aborted) return;
        if (e instanceof Error && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Failed to load parameters");
        setItems([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [mounted, authed]);

  // ── Filtered + grouped view ───────────────────────────────────────────────────
  const groups = useMemo(() => {
    const filtered = items.filter((it) => matches(it, search.trim()));
    return groupParameters(filtered);
  }, [items, search]);

  const totalShown = useMemo(
    () => groups.reduce((n, g) => n + g.items.length, 0),
    [groups],
  );

  // ── Loading shell (pre-mount / pre-auth) ──────────────────────────────────────
  if (!mounted) {
    return (
      <QcChrome title="Parameters">
        <div className="bg-white border border-(--aws-border) rounded-md p-10 text-center text-(--text-secondary)">
          <span className="inline-flex items-center gap-2 text-[13px]">
            <span className="inline-block w-4 h-4 border-2 border-(--aws-border-strong) border-t-(--aws-orange) rounded-full animate-spin" />
            Loading…
          </span>
        </div>
      </QcChrome>
    );
  }

  if (!authed) return <></>;

  return (
    <QcChrome title="Parameters">
      {/* Back link */}
      <div className="mb-3">
        <BackLink parentHref="/modules/qc" label="QC" />
      </div>

      {/* Page header */}
      <div className="mb-5">
        <h1 className="text-[22px] leading-[28px] font-semibold text-(--text-primary)">
          Parameters
        </h1>
        <p className="text-[13px] text-(--text-secondary) mt-1">
          RM-check parameter catalogue — the master list of QC parameters by group, with units, value types, and spec notes.
        </p>
      </div>

      {/* Search toolbar */}
      <div className="bg-white border border-(--aws-border) rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] mb-4 p-3">
        <div className="relative flex-1 min-w-[220px]">
          <svg
            viewBox="0 0 24 24"
            className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-(--text-muted)"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, code, or group…"
            className="w-full h-8 pl-7 pr-2 text-[13px] rounded-[2px] bg-white border border-(--aws-border-strong) outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
          />
        </div>
      </div>

      {/* Content */}
      {loading && items.length === 0 ? (
        <div className="bg-white border border-(--aws-border) rounded-md p-10 text-center text-(--text-secondary)">
          <span className="inline-flex items-center gap-2 text-[13px]">
            <span className="inline-block w-4 h-4 border-2 border-(--aws-border-strong) border-t-(--aws-orange) rounded-full animate-spin" />
            Loading parameters…
          </span>
        </div>
      ) : error ? (
        <div className="bg-white border border-(--aws-border) rounded-md p-6 text-center text-(--aws-error) text-[13px]">
          {error}
        </div>
      ) : totalShown === 0 ? (
        <div className="bg-white border border-(--aws-border) rounded-md p-12 text-center text-(--text-secondary)">
          <p className="font-semibold text-[14px] mb-1">No Parameters</p>
          <p className="text-[12px]">
            {search.trim() ? "No parameters match your search." : "The parameter catalogue is empty."}
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {groups.map((g) => (
            <ParameterGroupCard key={g.group} group={g} />
          ))}
        </div>
      )}
    </QcChrome>
  );
}

// ── Group card (heading + desktop table + mobile cards) ───────────────────────

function ParameterGroupCard({ group }: { group: ParamGroup }): React.JSX.Element {
  return (
    <section className="bg-white border border-(--aws-border) rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] overflow-hidden">
      {/* Group heading */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-(--aws-border) bg-(--surface-subtle)">
        <h2 className="text-[13px] font-semibold text-(--text-primary)">{group.group}</h2>
        <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 text-[10px] font-bold rounded-full bg-(--aws-border-strong) text-(--text-secondary)">
          {group.items.length}
        </span>
      </div>

      {/* Desktop table */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-[13px] border-collapse">
          <thead className="bg-(--surface-subtle) text-(--text-primary)">
            <tr className="border-b border-(--aws-border)">
              <Th>Code</Th>
              <Th>Parameter</Th>
              <Th>Unit</Th>
              <Th>Type</Th>
              <Th>Value</Th>
              <Th>Spec note</Th>
            </tr>
          </thead>
          <tbody>
            {group.items.map((it) => (
              <tr
                key={it.parameter_id}
                className="border-b border-(--aws-border) last:border-b-0 hover:bg-(--surface-subtle)"
              >
                <td className="px-3 py-2 whitespace-nowrap">
                  <span className="font-mono text-[12px] text-(--aws-link)">{it.code || "—"}</span>
                </td>
                <td className="px-3 py-2">
                  <span className="text-(--text-primary)">{it.name || "—"}</span>
                </td>
                <td className="px-3 py-2 whitespace-nowrap font-mono text-[12px] text-(--text-secondary)">
                  {it.unit || "—"}
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-(--text-secondary)">
                  {it.data_type || "—"}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <ValueKindBadge valueKind={it.value_kind} />
                </td>
                <td className="px-3 py-2 max-w-[280px] text-(--text-secondary)">
                  {it.spec_note ? (
                    <span className="break-words">{it.spec_note}</span>
                  ) : (
                    <span className="text-(--text-muted)">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden divide-y divide-(--aws-border)">
        {group.items.map((it) => (
          <div key={it.parameter_id} className="p-3 space-y-1.5">
            <div className="flex items-start justify-between gap-2">
              <span className="font-medium text-[13px] text-(--text-primary)">
                {it.name || "—"}
                {it.unit ? (
                  <span className="ml-1 text-(--text-muted) text-[11px] font-mono">{it.unit}</span>
                ) : null}
              </span>
              <ValueKindBadge valueKind={it.value_kind} />
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-(--text-secondary)">
              <span>
                Code: <span className="font-mono text-(--aws-link)">{it.code || "—"}</span>
              </span>
              <span>Type: {it.data_type || "—"}</span>
            </div>
            {it.spec_note ? (
              <p className="text-[12px] text-(--text-secondary) italic">{it.spec_note}</p>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Value-kind badge ──────────────────────────────────────────────────────────

function ValueKindBadge({ valueKind }: { valueKind: string | null }): React.JSX.Element {
  if (!valueKind) return <span className="text-(--text-muted)">—</span>;
  const isText = valueKind === "text";
  return (
    <span
      className={[
        "inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded-sm border",
        isText
          ? "bg-[#eef2fb] border-[#c3d3ef] text-[#2c5fa8]"
          : "bg-[#eaf6ed] border-[#b6dbb1] text-(--text-success)",
      ].join(" ")}
    >
      {isText ? "text" : "num"}
    </span>
  );
}

// ── Table Th ──────────────────────────────────────────────────────────────────

function Th({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <th className="px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-(--text-secondary) whitespace-nowrap">
      {children}
    </th>
  );
}
