"use client";

// Shared chrome for the SFG / WIP screens — mirrors the header/footer shell used
// by modules/production/page.tsx so the SFG module looks native. Not a route
// (only page.tsx/layout.tsx are special in the App Router), just a component.

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { BrandMark } from "@/components/BrandMark";
import { BackLink } from "@/components/BackLink";
import { useRequireAuth, useUserInitial } from "@/lib/user";

export function SfgShell({
  title,
  subtitle,
  crumb,
  backHref = "/modules/sfg",
  backLabel = "SFG / WIP",
  children,
}: {
  title: string;
  subtitle?: string;
  crumb: string;
  backHref?: string;
  backLabel?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const initial = useUserInitial();
  useRequireAuth(router.replace);

  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-6 gap-4">
        <BrandMark />
        <span className="text-[#d5dbdb] text-[13px] hidden sm:inline">Console</span>
        <nav className="text-[12px] text-[#d5dbdb] hidden md:flex items-center gap-2 ml-2">
          <button onClick={() => router.push("/modules")} className="hover:underline">Modules</button>
          <span>/</span>
          <button onClick={() => router.push("/modules/sfg")} className="hover:underline">SFG / WIP</button>
          <span>/</span>
          <span className="text-white">{crumb}</span>
        </nav>
        <div className="flex-1" />
        <button
          onClick={() => router.push("/modules/profile")}
          aria-label="Open profile"
          title="Profile"
          className="w-8 h-8 rounded-full bg-[var(--aws-orange)] text-white text-[13px] font-bold flex items-center justify-center hover:bg-[var(--aws-orange-hover)]"
        >
          {initial}
        </button>
      </header>

      <main className="flex-1 max-w-[1280px] w-full mx-auto px-4 sm:px-6 py-6">
        <div className="mb-3">
          <BackLink parentHref={backHref} label={backLabel} />
        </div>
        <div className="mb-6">
          <h1 className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)]">{title}</h1>
          {subtitle ? (
            <p className="text-[13px] text-[var(--text-secondary)] mt-1">{subtitle}</p>
          ) : null}
        </div>
        {children}
      </main>

      <footer className="border-t border-[var(--aws-border)] bg-white py-3 px-6 text-[11px] text-[var(--text-secondary)] flex flex-wrap justify-center gap-x-4 gap-y-1">
        <a href="#" className="hover:underline">Privacy</a>
        <span>© {new Date().getFullYear()}</span>
      </footer>
    </div>
  );
}

// Shared entity selector used by the WIP-stock screen (cfpl/cdpl), matching the
// filter styling used elsewhere.
export const ENTITIES = ["cfpl", "cdpl"] as const;
export type Entity = (typeof ENTITIES)[number];
