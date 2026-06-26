"use client";

import { useEffect, useMemo, useState } from "react";
import { BrandMark } from "@/components/BrandMark";
import { useRouter } from "next/navigation";
import { fetchMe, signOut, userStore, type MeResponse } from "@/lib/auth";
// `signOut` is still used by the unauthorised-/me fallback below.
import { useRequireAuth, useUserInitial } from "@/lib/user";
import { MODULES } from "@/lib/modules";
import { roleNamesOf } from "@/lib/sample-roles";

export default function ModulesPage() {
  const router = useRouter();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  const authed = useRequireAuth(router.replace);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!authed) return;
    let cancelled = false;
    (async () => {
      const cached = userStore.load();
      if (cached && !cancelled) setMe(cached);
      try {
        const fresh = await fetchMe();
        if (!cancelled) {
          userStore.save(fresh);
          setMe(fresh);
          // If an admin flipped must_change_password mid-session, the
          // initial useRequireAuth check (which reads cached me) won't
          // catch it. Re-gate on the fresh response.
          if (fresh.must_change_password === true) {
            router.replace("/change-password");
            return;
          }
        }
      } catch {
        signOut();
        router.replace("/");
        return;
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router, authed]);

  const greeting = useMemo(() => {
    const h = new Date().getHours();
    const stem = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
    const name = me?.full_name?.trim();
    return name ? `${stem}, ${name}` : stem;
  }, [me]);

  const initial = useUserInitial();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Hide admin-only tiles (Admin / Purchase / QC / Sample / Transfer) from
    // non-admins, and allowedRoles tiles (NPD Development) from users who hold
    // none of the listed roles. Each module's root page also inline-gates itself
    // for direct navigation; suppressing the entry point keeps the grid honest.
    const myRoles = roleNamesOf(me);
    const visible = me?.is_admin
      ? MODULES
      : MODULES.filter((m) =>
          !m.adminOnly &&
          (!m.allowedRoles || m.allowedRoles.some((r) => myRoles.includes(r))));
    if (!q) return visible;
    return visible.filter((m) => m.title.toLowerCase().includes(q));
  }, [query, me]);

  function onOpen(m: (typeof MODULES)[number]) {
    if (m.implemented) {
      router.push(`/modules/${m.route}`);
      return;
    }
    // Other modules are stubs; mirror Android's toast.
    alert(`Opening ${m.route} module…`);
  }

  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-6 gap-4">
        <BrandMark />
        <span className="text-[#d5dbdb] text-[13px] hidden sm:inline">Console</span>
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

      <main className="flex-1 max-w-[1100px] w-full mx-auto px-4 sm:px-6 py-8">
        <div className="mb-6">
          <h1 className="text-[24px] leading-[30px] font-semibold text-[var(--text-primary)]">
            {loading && !me ? "Loading…" : greeting}
          </h1>
          <p className="text-[13px] text-[var(--text-secondary)] mt-1">
            Select a module to get started.
          </p>
        </div>

        <div className="mb-6">
          <label htmlFor="module-search" className="sr-only">
            Search modules
          </label>
          <input
            id="module-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search modules"
            className="w-full sm:max-w-sm h-9 px-3 text-[14px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filtered.map((m) => (
            <button
              key={m.route}
              onClick={() => onOpen(m)}
              className="group text-left bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] p-5 hover:border-[var(--aws-orange)] hover:shadow-[0_2px_6px_rgba(0,28,36,0.18)] transition focus:outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_2px_#9a393e]"
            >
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-md bg-[#fbeced] text-[var(--aws-orange)] flex items-center justify-center shrink-0">
                  <m.Icon className="w-7 h-7" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h2 className="text-[16px] font-semibold text-[var(--text-primary)]">
                      {m.title}
                    </h2>
                    <span className="text-[10px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded-sm bg-[#eaf3ff] text-[#9a393e]">
                      {m.badge}
                    </span>
                  </div>
                  <p className="text-[13px] leading-[19px] text-[var(--text-secondary)]">
                    {m.description}
                  </p>
                  <p className="mt-3 text-[12px] font-medium text-[var(--aws-orange)] group-hover:text-[var(--aws-orange-active)]">
                    {m.stat} →
                  </p>
                </div>
              </div>
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="col-span-full text-[13px] text-[var(--text-secondary)] py-8 text-center">
              No modules match &ldquo;{query}&rdquo;.
            </p>
          )}
        </div>
      </main>

      <footer className="border-t border-[var(--aws-border)] bg-white py-3 px-6 text-[11px] text-[var(--text-secondary)] flex flex-wrap justify-center gap-x-4 gap-y-1">
        <a href="#" className="hover:underline">
          Terms of Use
        </a>
        <a href="#" className="hover:underline">
          Privacy
        </a>
        <span>© {new Date().getFullYear()}</span>
      </footer>
    </div>
  );
}
