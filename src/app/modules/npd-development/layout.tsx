"use client";

// Route guard for the entire NPD Development module. Only npd_team /
// business_head / inventory_manager / admin may enter; everyone else is
// redirected to /modules. Mirrors the per-page `mounted` + useRequireAuth
// hydration pattern so SSR (authed=true, me=null) doesn't flash a redirect.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useRequireAuth, useMe } from "@/lib/user";
import { canSeeNpdModule } from "@/lib/sample-roles";

export default function NpdDevelopmentLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);
  const me = useMe();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { queueMicrotask(() => setMounted(true)); }, []);

  const allowed = canSeeNpdModule(me);
  useEffect(() => {
    // useRequireAuth owns the unauthenticated redirect. Once we have the
    // profile, bounce anyone outside the allowed role set.
    if (!mounted || !authed) return;
    if (me !== null && !allowed) router.replace("/modules");
  }, [mounted, authed, me, allowed, router]);

  if (!mounted || !authed || me === null) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "#666", fontFamily: "Arial, sans-serif", fontSize: 13 }}>
        Loading…
      </div>
    );
  }
  if (!allowed) return null; // redirect in flight
  return <>{children}</>;
}
