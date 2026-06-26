"use client";

// Full breadcrumb trail rendered below the nav bar. Unlike BackLink (a single
// "Back to {parent}" affordance), this shows the whole path from the Modules
// root down to the current page, each ancestor clickable. The last crumb is the
// current page (not a link).

import { useRouter } from "next/navigation";

export interface Crumb {
  label: string;
  /** Omit on the current (last) crumb so it renders as plain text. */
  href?: string;
}

export function Breadcrumbs({ items, className }: { items: Crumb[]; className?: string }) {
  const router = useRouter();
  return (
    <nav
      aria-label="Breadcrumb"
      className={["flex flex-wrap items-center gap-1.5 text-[12px] -ml-0.5", className ?? ""].join(" ").trim()}
    >
      {items.map((c, i) => {
        const last = i === items.length - 1;
        return (
          <span key={`${c.label}-${i}`} className="inline-flex items-center gap-1.5">
            {c.href && !last ? (
              <button type="button" onClick={() => router.push(c.href!)}
                className="text-[var(--aws-link)] hover:underline">{c.label}</button>
            ) : (
              <span className={last ? "text-[var(--text-secondary)] font-medium" : "text-[var(--aws-link)]"} aria-current={last ? "page" : undefined}>{c.label}</span>
            )}
            {!last && <span className="text-[var(--text-muted)]" aria-hidden>/</span>}
          </span>
        );
      })}
    </nav>
  );
}

// Shared root crumbs every sample-module page starts from.
export const SAMPLE_ROOT: Crumb[] = [
  { label: "Modules", href: "/modules" },
  { label: "Sample", href: "/modules/sample" },
];

// Root crumbs for the standalone NPD Development module.
export const NPD_DEV_ROOT: Crumb[] = [
  { label: "Modules", href: "/modules" },
  { label: "NPD Development", href: "/modules/npd-development" },
];
