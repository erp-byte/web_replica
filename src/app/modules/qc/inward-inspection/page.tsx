"use client";

// Inward Inspection page shell.
// Owns: mode (list|detail), selectedId, list query/filter state, reloadKey.
// Renders <InwardInspectionList> in list mode and <InwardInspectionDetail> in
// detail mode. Debounces the search input → query.transaction_no (300 ms).

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import { type InspectionListQuery } from "@/lib/qc";
import { BackLink } from "@/components/BackLink";
import { QcChrome } from "../_chrome";
import { InwardInspectionList } from "./_list";
import { InwardInspectionDetail } from "./_detail";

// ── Constants ─────────────────────────────────────────────────────────────────

const SEARCH_DEBOUNCE_MS = 300;

const DEFAULT_QUERY: InspectionListQuery = {
  page: 1,
  page_size: 20,
  status: "",
};

// ── Page ──────────────────────────────────────────────────────────────────────

export default function InwardInspectionPage(): React.JSX.Element {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);

  // ── Hydration guard ──────────────────────────────────────────────────────────
  // Defers client-only render to avoid SSR/client hydration mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    queueMicrotask(() => setMounted(true));
  }, []);

  // ── View mode ────────────────────────────────────────────────────────────────
  const [mode, setMode] = useState<"list" | "detail">("list");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // ── List query / filter state ────────────────────────────────────────────────
  const [query, setQuery] = useState<InspectionListQuery>(DEFAULT_QUERY);
  const [search, setSearch] = useState("");

  // reloadKey is bumped when the detail view signals a change so the list
  // re-fetches on return without losing the current query.
  const [reloadKey, setReloadKey] = useState(0);

  // ── Debounce search → query.transaction_no ────────────────────────────────────
  const isFirstSearch = useRef(true);
  useEffect(() => {
    if (isFirstSearch.current) { isFirstSearch.current = false; return; }
    const t = setTimeout(() => {
      setQuery((prev) => ({ ...prev, transaction_no: search.trim() || undefined, page: 1 }));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  // ── Callbacks ────────────────────────────────────────────────────────────────

  function handleQueryChange(patch: Partial<InspectionListQuery>) {
    setQuery((prev) => {
      const resetPage = patch.page === undefined ? { page: 1 } : {};
      return { ...prev, ...patch, ...resetPage };
    });
  }

  function handleView(id: number) {
    setSelectedId(id);
    setMode("detail");
  }

  function handleBack() {
    setMode("list");
    setSelectedId(null);
  }

  function handleChanged() {
    setReloadKey((k) => k + 1);
  }

  // ── Loading shell (pre-mount / pre-auth) ─────────────────────────────────────
  if (!mounted) {
    return (
      <QcChrome title="Inward Inspection">
        <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[var(--text-secondary)]">
          <span className="inline-flex items-center gap-2 text-[13px]">
            <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
            Loading…
          </span>
        </div>
      </QcChrome>
    );
  }

  if (!authed) return <></>;

  return (
    <QcChrome title="Inward Inspection">
      {/* Back link */}
      <div className="mb-3">
        <BackLink parentHref="/modules/qc" label="QC" />
      </div>

      {/* Page header */}
      <div className="mb-5">
        <h1 className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)]">
          Inward Inspection
        </h1>
        <p className="text-[13px] text-[var(--text-secondary)] mt-1">
          Manage QC inspections for inward consignments — capture readings, attach a COA, and set the verdict.
        </p>
      </div>

      {/* Content */}
      {mode === "list" ? (
        <InwardInspectionList
          query={query}
          onQueryChange={handleQueryChange}
          search={search}
          onSearch={setSearch}
          reloadKey={reloadKey}
          onView={handleView}
        />
      ) : (
        <InwardInspectionDetail
          inspectionId={selectedId}
          onBack={handleBack}
          onChanged={handleChanged}
        />
      )}
    </QcChrome>
  );
}
