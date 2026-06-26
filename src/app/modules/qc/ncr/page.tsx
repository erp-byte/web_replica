"use client";

// NCR list page shell. Owns the list query / filter state + search debounce
// and renders <NcrList> inside <QcChrome>. Mirrors the inward-inspection page
// shell: a `mounted` hydration gate (cache-free loading shell) and a 300 ms
// debounce on the search box → query.q.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import { type NcrListQuery } from "@/lib/qc";
import { BackLink } from "@/components/BackLink";
import { QcChrome } from "../_chrome";
import { NcrList } from "./_list";

// ── Constants ─────────────────────────────────────────────────────────────────

const SEARCH_DEBOUNCE_MS = 300;

const DEFAULT_QUERY: NcrListQuery = {
  page: 1,
  page_size: 20,
  status: "",
};

// ── Page ──────────────────────────────────────────────────────────────────────

export default function NcrListPage(): React.JSX.Element {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);

  // Hydration guard — defer client-only render to avoid SSR/client mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    queueMicrotask(() => setMounted(true));
  }, []);

  const [query, setQuery] = useState<NcrListQuery>(DEFAULT_QUERY);
  const [search, setSearch] = useState("");

  // reloadKey is bumped on return from a detail page to re-fetch the list.
  const [reloadKey] = useState(0);

  // Debounce search → query.q
  const isFirstSearch = useRef(true);
  useEffect(() => {
    if (isFirstSearch.current) { isFirstSearch.current = false; return; }
    const t = setTimeout(() => {
      setQuery((prev) => ({ ...prev, q: search.trim() || undefined, page: 1 }));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  function handleQueryChange(patch: Partial<NcrListQuery>) {
    setQuery((prev) => {
      const resetPage = patch.page === undefined ? { page: 1 } : {};
      return { ...prev, ...patch, ...resetPage };
    });
  }

  // Loading shell (pre-mount / pre-auth)
  if (!mounted) {
    return (
      <QcChrome title="NCR">
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
    <QcChrome title="NCR">
      {/* Back link */}
      <div className="mb-3">
        <BackLink parentHref="/modules/qc" label="QC" />
      </div>

      {/* Page header */}
      <div className="mb-5">
        <h1 className="text-[22px] leading-[28px] font-semibold text-(--text-primary)">
          Non-Conformance Reports
        </h1>
        <p className="text-[13px] text-(--text-secondary) mt-1">
          Document inward non-conformances, drive supplier CAPA, and close the loop with a disposition and sign-off.
        </p>
      </div>

      <NcrList
        query={query}
        onQueryChange={handleQueryChange}
        search={search}
        onSearch={setSearch}
        reloadKey={reloadKey}
      />
    </QcChrome>
  );
}
