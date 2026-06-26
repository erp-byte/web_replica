"use client";

// PO Upload page — Task 2.3
// Wires together: entity selector, upload zone, PoPreview (Task 2.2),
// PoListing (Task 2.1), result banner, and cache hydrate/persist.
//
// Flow mirrors frontend_replica/src/modules/purchase/po-creation/po-creation.js
// lines 1–168 (landing) and showCommitResult (658–727) for the result banner.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import {
  type PreviewResponse,
  type CommitResponse,
  type PoListQuery,
  previewPo,
} from "@/lib/po";
import {
  loadPoListCache,
  savePoListCache,
  type PoListCache,
} from "@/lib/po-list-cache";
import { BackLink } from "@/components/BackLink";
import { PurchaseChrome } from "../_chrome";
import { PoPreview } from "./_preview";
import { PoListing } from "./_listing";

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB
const SEARCH_DEBOUNCE_MS = 300;

// Default query — matches PoListQuery shape. Entity "" means "all".
const DEFAULT_QUERY: PoListQuery = {
  sort: "po_date:desc",
  page: 1,
  page_size: 50,
  entity: "",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a stable fingerprint for the five advanced filter fields. */
function advKey(q: PoListQuery): string {
  return [
    q.vendor_supplier_name_contains ?? "",
    q.order_reference_no_contains ?? "",
    q.narration_contains ?? "",
    q.supplier_id ?? "",
    q.voucher_type ?? "",
  ].join("|");
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PoCreationPage(): React.JSX.Element {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);

  // ── Mode: landing or preview ──────────────────────────────────────────────

  const [mode, setMode] = useState<"landing" | "preview">("landing");

  // ── Preview state ─────────────────────────────────────────────────────────

  const [uploadNonce, setUploadNonce] = useState(0);
  const [previewData, setPreviewData] = useState<{
    fileName: string;
    entity: string;
    preview: PreviewResponse;
  } | null>(null);

  // ── Entity selector for upload zone ──────────────────────────────────────

  const [entity, setEntity] = useState<"cfpl" | "cdpl">("cfpl");

  // ── Upload zone state ─────────────────────────────────────────────────────

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  // ── Result banner (shown on landing after commit) ─────────────────────────

  const [commitResult, setCommitResult] = useState<CommitResponse | null>(null);

  // ── Listing reload trigger ─────────────────────────────────────────────────

  const [reloadKey, setReloadKey] = useState(0);

  // ── Cache hydration (one snapshot on mount — anti-request-storm) ──────────

  const [cache] = useState<PoListCache | null>(() =>
    typeof window !== "undefined" ? loadPoListCache() : null,
  );

  // Hydration guard. The cache above is sessionStorage-only, so seeding render
  // state from it diverges between the server (cache-less) and the client's
  // first render → hydration mismatch. Render a cache-free shell until mounted,
  // then reveal the hydrated UI (deferred setState avoids the
  // react-hooks/set-state-in-effect lint).
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    queueMicrotask(() => setMounted(true));
  }, []);

  // ── Listing state (controlled) ────────────────────────────────────────────

  const [search, setSearch] = useState<string>(cache?.search ?? "");

  const [query, setQuery] = useState<PoListQuery>(() => {
    if (!cache) return DEFAULT_QUERY;
    return {
      ...DEFAULT_QUERY,
      sort: cache.sort ?? DEFAULT_QUERY.sort,
      page: cache.page ?? 1,
      page_size: DEFAULT_QUERY.page_size,
      entity: cache.entity ?? "",
      po_number_contains: cache.search ?? "",
      po_date_from: cache.dateFrom ?? "",
      po_date_to: cache.dateTo ?? "",
      vendor_supplier_name_contains: cache.adv?.vendor_supplier_name_contains ?? "",
      order_reference_no_contains: cache.adv?.order_reference_no_contains ?? "",
      narration_contains: cache.adv?.narration_contains ?? "",
      supplier_id: cache.adv?.supplier_id ?? "",
      voucher_type: cache.adv?.voucher_type ?? "",
    };
  });

  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(cache?.expanded ?? []),
  );

  // ── Debounce search → query.po_number_contains ────────────────────────────

  const isFirstSearch = useRef(true);
  useEffect(() => {
    if (isFirstSearch.current) { isFirstSearch.current = false; return; }
    const t = setTimeout(() => {
      setQuery((prev) => ({ ...prev, po_number_contains: search.trim(), page: 1 }));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  // ── Persist listing state to cache ────────────────────────────────────────

  // Stable fingerprints for advfilter fields and expanded rows
  const advFp = advKey(query);
  const expandedFp = useMemo(
    () => [...expanded].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(","),
    [expanded],
  );

  useEffect(() => {
    savePoListCache({
      search,
      entity: (query.entity as "" | "cfpl" | "cdpl") ?? "",
      dateFrom: query.po_date_from ?? "",
      dateTo: query.po_date_to ?? "",
      adv: {
        vendor_supplier_name_contains: query.vendor_supplier_name_contains ?? "",
        order_reference_no_contains: query.order_reference_no_contains ?? "",
        narration_contains: query.narration_contains ?? "",
        supplier_id: query.supplier_id ?? "",
        voucher_type: query.voucher_type ?? "",
      },
      sort: query.sort ?? DEFAULT_QUERY.sort!,
      page: query.page ?? 1,
      expanded: [...expanded],
    });
    // advFp + expandedFp are stable fingerprints — avoids wiring Set/object
    // references into the dep array (which would trip exhaustive-deps).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    search,
    query.entity,
    query.po_date_from,
    query.po_date_to,
    advFp,
    query.sort,
    query.page,
    expandedFp,
  ]);

  // ── Listing callbacks ─────────────────────────────────────────────────────

  function handleQueryChange(patch: Partial<PoListQuery>) {
    setQuery((prev) => {
      // If patch changes anything except page, reset to page 1.
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

  // ── File handling ─────────────────────────────────────────────────────────

  async function handleFile(file: File) {
    // Reset prior error
    setUploadError(null);

    // Validate extension (.xlsx only, case-insensitive)
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      setUploadError("Only .xlsx workbooks are accepted.");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    // Validate size
    if (file.size > MAX_FILE_BYTES) {
      setUploadError("File too large — maximum 50 MB.");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    setUploading(true);
    try {
      const preview = await previewPo(file, entity);
      // Bump nonce so PoPreview always remounts fresh
      setUploadNonce((n) => n + 1);
      setPreviewData({ fileName: file.name, entity, preview });
      setMode("preview");
      setCommitResult(null);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Preview failed.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  // ── Preview callbacks ─────────────────────────────────────────────────────

  function handleCancel() {
    setMode("landing");
    setPreviewData(null);
  }

  function handleCommitted(result: CommitResponse) {
    setMode("landing");
    setPreviewData(null);
    setCommitResult(result);
    setReloadKey((k) => k + 1);
  }

  // Hydration guard — render a cache-free shell on the first (server + client)
  // render so hydration matches; the cache-hydrated UI mounts one frame later.
  // Placed before the auth guard so the first render is deterministic.
  if (!mounted) {
    return (
      <PurchaseChrome title="Purchase Order Upload">
        <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[var(--text-secondary)]">
          <span className="inline-flex items-center gap-2 text-[13px]">
            <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
            Loading purchase orders…
          </span>
        </div>
      </PurchaseChrome>
    );
  }

  // ── Guard until auth is confirmed ─────────────────────────────────────────

  if (!authed) return <></>;

  // ── Render ────────────────────────────────────────────────────────────────

  const hasErrors = (commitResult?.errors?.length ?? 0) > 0;

  return (
    <PurchaseChrome title="Purchase Order Upload">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="mb-3">
        <BackLink parentHref="/modules/purchase" label="Purchase" />
      </div>
      <div className="mb-5">
        <h1 className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)]">
          Purchase Order Upload
        </h1>
        <p className="text-[13px] text-[var(--text-secondary)] mt-1">
          Drop a PO workbook (.xlsx) — preview SKU matches and diffs, edit, then commit.
        </p>
      </div>

      {/* ── Result banner (landing only, shown after commit) ───────────── */}
      {mode === "landing" && commitResult ? (
        <CommitResultBanner
          result={commitResult}
          hasErrors={hasErrors}
          onDismiss={() => setCommitResult(null)}
        />
      ) : null}

      {/* ── Landing mode ────────────────────────────────────────────────── */}
      {mode === "landing" ? (
        <>
          {/* Entity selector */}
          <EntitySelector entity={entity} onEntity={setEntity} />

          {/* Upload zone */}
          <UploadZone
            uploading={uploading}
            error={uploadError}
            drag={drag}
            fileInputRef={fileInputRef}
            onDragOver={() => setDrag(true)}
            onDragLeave={() => setDrag(false)}
            onDrop={(file) => { setDrag(false); void handleFile(file); }}
            onFileChosen={(file) => void handleFile(file)}
            onBrowse={() => fileInputRef.current?.click()}
          />

          {/* Recent PO listing */}
          <PoListing
            query={query}
            onQueryChange={handleQueryChange}
            search={search}
            onSearch={setSearch}
            expanded={expanded}
            onToggleExpand={handleToggleExpand}
            reloadKey={reloadKey}
          />
        </>
      ) : null}

      {/* ── Preview mode ────────────────────────────────────────────────── */}
      {mode === "preview" && previewData ? (
        <PoPreview
          key={`${previewData.fileName}-${uploadNonce}`}
          fileName={previewData.fileName}
          entity={previewData.entity}
          preview={previewData.preview}
          onCancel={handleCancel}
          onCommitted={handleCommitted}
        />
      ) : null}
    </PurchaseChrome>
  );
}

// ── EntitySelector ────────────────────────────────────────────────────────────

function EntitySelector({
  entity,
  onEntity,
}: {
  entity: "cfpl" | "cdpl";
  onEntity: (e: "cfpl" | "cdpl") => void;
}): React.JSX.Element {
  const opts: { value: "cfpl" | "cdpl"; label: string }[] = [
    { value: "cfpl", label: "CFPL" },
    { value: "cdpl", label: "CDPL" },
  ];
  return (
    <div className="flex items-center gap-2 mb-4">
      <span className="text-[12px] font-semibold text-[var(--text-secondary)] mr-1">Entity</span>
      {opts.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={entity === o.value}
          onClick={() => onEntity(o.value)}
          className={[
            "h-8 px-4 text-[12px] rounded-full border font-semibold transition-colors",
            entity === o.value
              ? "bg-[var(--aws-navy)] text-white border-[var(--aws-navy)]"
              : "bg-white text-[var(--text-primary)] border-[var(--aws-border-strong)] hover:border-[var(--aws-navy)]",
          ].join(" ")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── UploadZone ────────────────────────────────────────────────────────────────

function UploadZone({
  uploading,
  error,
  drag,
  fileInputRef,
  onDragOver,
  onDragLeave,
  onDrop,
  onFileChosen,
  onBrowse,
}: {
  uploading: boolean;
  error: string | null;
  drag: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onDragOver: () => void;
  onDragLeave: () => void;
  onDrop: (file: File) => void;
  onFileChosen: (file: File) => void;
  onBrowse: () => void;
}): React.JSX.Element {
  return (
    <div className="mb-5">
      <div
        onClick={onBrowse}
        onDragOver={(e) => { e.preventDefault(); onDragOver(); }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) onDragLeave();
        }}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files?.[0];
          if (f) onDrop(f);
        }}
        className={[
          "relative bg-white border-2 border-dashed rounded-md p-6 text-center cursor-pointer transition",
          drag
            ? "border-[var(--aws-orange)] bg-[#fbeced]"
            : "border-[var(--aws-border-strong)] hover:border-[var(--aws-navy)]",
          uploading ? "pointer-events-none opacity-70" : "",
        ].join(" ")}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFileChosen(f);
            e.target.value = "";
          }}
        />

        {/* Upload icon */}
        <svg
          viewBox="0 0 24 24"
          width="32"
          height="32"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.4}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="mx-auto text-[var(--text-muted)] mb-2"
          aria-hidden
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>

        {uploading ? (
          <p className="text-[14px] font-semibold text-[var(--text-primary)]">
            <span className="inline-flex items-center gap-2">
              <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
              Parsing…
            </span>
          </p>
        ) : (
          <>
            <p className="text-[14px] font-semibold text-[var(--text-primary)]">
              Drop your PO workbook here
            </p>
            <p className="text-[12px] text-[var(--text-secondary)] mt-1">
              or click to browse — <strong>.xlsx only</strong>, max 50 MB
            </p>
          </>
        )}
      </div>

      {/* Inline validation / API error */}
      {error ? (
        <p className="mt-2 text-[12px] text-[var(--aws-error)]">{error}</p>
      ) : null}
    </div>
  );
}

// ── CommitResultBanner ────────────────────────────────────────────────────────
// Mirrors po-creation.js showCommitResult (lines 658–727).

function CommitResultBanner({
  result,
  hasErrors,
  onDismiss,
}: {
  result: CommitResponse;
  hasErrors: boolean;
  onDismiss: () => void;
}): React.JSX.Element {
  const created = result.created?.length ?? 0;
  const updated = result.updated?.length ?? 0;
  const skipDup = result.skipped_duplicates?.length ?? 0;
  const skipMiss = result.skipped_missing?.length ?? 0;
  const errorCount = result.errors?.length ?? 0;

  const kpis: { label: string; value: number; accent: string }[] = [
    { label: "Created",             value: created,   accent: "var(--clr-ok, #1d8102)" },
    { label: "Updated",             value: updated,   accent: "var(--clr-info, #0972d3)" },
    { label: "Skipped duplicates",  value: skipDup,   accent: "var(--text-muted, #6c7778)" },
    { label: "Skipped missing",     value: skipMiss,  accent: "var(--text-muted, #6c7778)" },
    { label: "Errors",              value: errorCount, accent: hasErrors ? "var(--clr-danger, #c2483c)" : "var(--text-muted, #6c7778)" },
  ];

  return (
    <div
      role={hasErrors ? "alert" : "status"}
      aria-live={hasErrors ? "assertive" : "polite"}
      className={[
        "mb-5 bg-white border rounded-md shadow-[0_1px_4px_rgba(0,28,36,0.14)] overflow-hidden",
        hasErrors ? "border-[#c2483c]" : "border-[#b6dbb1]",
      ].join(" ")}
    >
      {/* Banner header */}
      <div
        className={[
          "flex items-center gap-2 px-4 py-3 border-b",
          hasErrors
            ? "bg-[#fbeced] border-[#c2483c]"
            : "bg-[#eaf6ed] border-[#b6dbb1]",
        ].join(" ")}
      >
        {/* Icon */}
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke={hasErrors ? "#c2483c" : "#1d8102"}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          {hasErrors ? (
            <>
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </>
          ) : (
            <polyline points="20 6 9 17 4 12" />
          )}
        </svg>
        <span
          className={[
            "text-[14px] font-semibold flex-1",
            hasErrors ? "text-[#9a393e]" : "text-[#1d5a1d]",
          ].join(" ")}
        >
          {hasErrors ? "Commit completed with errors" : "Commit complete"}
        </span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="h-7 px-3 text-[12px] rounded-[2px] border bg-white hover:border-[var(--aws-navy)] border-[var(--aws-border-strong)] text-[var(--text-secondary)]"
        >
          Dismiss
        </button>
      </div>

      {/* KPI grid */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-0 divide-x divide-[var(--aws-border)] px-0">
        {kpis.map((k) => (
          <div key={k.label} className="px-4 py-3 text-center">
            <div
              className="text-[22px] font-bold leading-none mb-1"
              style={{ color: k.accent }}
            >
              {k.value}
            </div>
            <div className="text-[11px] text-[var(--text-secondary)]">{k.label}</div>
          </div>
        ))}
      </div>

      {/* Error list */}
      {hasErrors && result.errors && result.errors.length > 0 ? (
        <div className="px-4 py-3 border-t border-[var(--aws-border)]">
          <div className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)] mb-2">
            Errors
          </div>
          <ul className="space-y-1">
            {result.errors.map((e, i) => (
              <li
                key={e.po_number ?? e.transaction_no ?? e.duplicate_key ?? i}
                className="flex items-start gap-2 text-[12px] text-[#9a393e] bg-[#fbeced] border border-[#e6bcbe] rounded-[2px] px-2 py-1"
              >
                <span className="font-mono font-semibold shrink-0">
                  {e.po_number ?? "—"}
                </span>
                <span className="text-[var(--text-secondary)]">{e.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
