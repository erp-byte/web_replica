"use client";

// Material In page — read-only PO listing with per-row article summaries and
// Send intimation action. Part of the Purchase module.
//
// Owns query/search/expanded state and renders MaterialInList.
// No upload zone, no entity selector, no preview/commit, no result banner.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import { type PoListQuery } from "@/lib/po";
import { BackLink } from "@/components/BackLink";
import { PurchaseChrome } from "../_chrome";
import { MaterialInList } from "./_MaterialInList";

// ── Constants ─────────────────────────────────────────────────────────────────

const SEARCH_DEBOUNCE_MS = 300;

const DEFAULT_QUERY: PoListQuery = {
  sort: "po_date:desc",
  page: 1,
  page_size: 50,
  entity: "",
};

// ── Page ──────────────────────────────────────────────────────────────────────

export default function MaterialInPage(): React.JSX.Element {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);

  // ── Hydration guard (SSR/client match) ────────────────────────────────────
  // No sessionStorage cache for this page — simple mount guard avoids
  // any potential SSR/client mismatch if state is later extended.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    queueMicrotask(() => setMounted(true));
  }, []);

  // ── Listing state (controlled) ────────────────────────────────────────────
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState<PoListQuery>(DEFAULT_QUERY);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // ── Debounce search → query.po_number_contains ────────────────────────────
  const isFirstSearch = useRef(true);
  useEffect(() => {
    if (isFirstSearch.current) { isFirstSearch.current = false; return; }
    const t = setTimeout(() => {
      setQuery((prev) => ({ ...prev, po_number_contains: search.trim(), page: 1 }));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  // ── Listing callbacks ─────────────────────────────────────────────────────

  function handleQueryChange(patch: Partial<PoListQuery>) {
    setQuery((prev) => {
      const resetPage = patch.page === undefined ? { page: 1 } : {};
      return { ...prev, ...patch, ...resetPage };
    });
  }

  function handleToggleExpand(txn: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(txn)) next.delete(txn); else next.add(txn);
      return next;
    });
  }

  // ── Loading shell (pre-mount) ─────────────────────────────────────────────
  if (!mounted) {
    return (
      <PurchaseChrome title="Material In">
        <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[var(--text-secondary)]">
          <span className="inline-flex items-center gap-2 text-[13px]">
            <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
            Loading…
          </span>
        </div>
      </PurchaseChrome>
    );
  }

  if (!authed) return <></>;

  return (
    <PurchaseChrome title="Material In">
      {/* Back link */}
      <div className="mb-3">
        <BackLink parentHref="/modules/purchase" label="Purchase" />
      </div>

      {/* Page header */}
      <div className="mb-5">
        <h1 className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)]">
          Material In
        </h1>
        <p className="text-[13px] text-[var(--text-secondary)] mt-1">
          Browse purchase orders by article and send arrival intimations.
        </p>
      </div>

      {/* Listing */}
      <MaterialInList
        query={query}
        onQueryChange={handleQueryChange}
        search={search}
        onSearch={setSearch}
        expanded={expanded}
        onToggleExpand={handleToggleExpand}
      />
    </PurchaseChrome>
  );
}
