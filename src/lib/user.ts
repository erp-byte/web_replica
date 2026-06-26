// User-and-session hooks. Three concerns each page used to handle ad-hoc:
//
//   1. Avatar initial (first letter of the cached full name)
//   2. Scope info (`is_admin`, `warehouses`) for filter banners
//   3. Boot-time auth gate ("if no refresh token, send them back to /")
//
// They all read from the same source (the `auth.me` localStorage entry
// hydrated at login + on every successful /me response). useMe() is the
// canonical reader so subsequent hooks don't trigger separate effects.
//
// C1 (Wave 4): the page-level scripts (JC list + detail) used to call
// `userStore.load()` directly from inside their render bodies. That worked
// but produced subtle drift — the list page might have a fresh `me`
// snapshot while the detail page still saw the SSR cache, and there was no
// re-render trigger when /me refreshed mid-session. The hooks below now
// subscribe to `userStore` so every consumer flips together; `useMe()`,
// `useIsAdmin()` and `useSeesCost()` (cost-gate) all share the same store.

import { useEffect, useMemo, useState } from "react";
import { tokenStore, userStore, type MeResponse, type MeRoleEnvelope } from "./auth";
import { userMayForceUnlock } from "@/app/modules/job-card/_useLockState";

// Type-safe accessor for the warehouses + floors aliases the backend uses
// on /me (aliases of allowed_warehouses / allowed_floors). Kept here so
// callers don't repeat the inline cast each time.
interface MeWithScope extends MeResponse {
  warehouses?: string[];
  floors?: string[];
}

export function initialFromName(name: string | null | undefined): string {
  const trimmed = name?.trim();
  if (!trimmed) return "?";
  return trimmed[0].toUpperCase();
}

// Load the cached `me` once on mount. Returns null on SSR and until the
// localStorage read completes (a single microtask). Subsequent re-renders
// see a stable reference because `me` is held in component state.
//
// C1 (Wave 4): also subscribes to `userStore` so a fresh /me on another
// page propagates without a reload, and listens to the `storage` event so
// cross-tab logins/logouts flip too. Mirrors the pattern in
// lib/cost-gate.ts::useSeesCost so the two hooks stay in lock-step.
export function useMe(): MeResponse | null {
  const [me, setMe] = useState<MeResponse | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    queueMicrotask(() => setMe(userStore.load()));
    const unsubscribe = userStore.subscribe((next) => setMe(next));
    const onStorage = (e: StorageEvent) => {
      if (e.key === "auth.me" || e.key === null) {
        setMe(userStore.load());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      unsubscribe();
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return me;
}

export function useUserInitial(): string {
  return initialFromName(useMe()?.full_name);
}

// C1 (Wave 4): memoised admin selector — pages use this instead of
// inlining `me?.is_admin === true`, which used to disagree with the
// cost-gate's extractRoleName helper (the former missed the
// `roles[].is_admin === true` envelope shape). userStore.save already
// normalises `is_admin` at write-time (see lib/auth.ts::_normaliseAdmin),
// but we re-walk defensively here for callers that compose a fresh
// (un-normalised) MeResponse straight into the hook.
export function useIsAdmin(): boolean {
  const me = useMe();
  return useMemo(() => {
    if (!me) return false;
    if (me.is_admin === true) return true;
    const roles = Array.isArray(me.roles) ? me.roles : null;
    if (!roles) return false;
    for (const r of roles) {
      if (typeof r === "string") {
        if (r === "admin") return true;
        continue;
      }
      if (r && typeof r === "object") {
        const env = r as MeRoleEnvelope;
        if (env.is_admin === true) return true;
        if (env.code === "admin" || env.role_name === "admin") return true;
      }
    }
    return false;
  }, [me]);
}

// Role membership selector. Returns true when the signed-in user holds the
// given role_name (or is an admin, who supersedes every role gate). Walks the
// same MeResponse shapes as useIsAdmin (bare string roles + role envelopes).
export function useHasRole(roleName: string): boolean {
  const me = useMe();
  const isAdmin = useIsAdmin();
  return useMemo(() => {
    if (isAdmin) return true;
    if (!me) return false;
    const roles = Array.isArray(me.roles) ? me.roles : null;
    if (!roles) return false;
    for (const r of roles) {
      if (typeof r === "string") {
        if (r === roleName) return true;
        continue;
      }
      if (r && typeof r === "object") {
        const env = r as MeRoleEnvelope;
        if (env.code === roleName || env.role_name === roleName) return true;
      }
    }
    return false;
  }, [me, isAdmin, roleName]);
}

// Convenience: QC manager (or admin). Gates the verdict control and the
// post-approval readings edit/add/delete actions in the QC module.
export function useIsQcManager(): boolean {
  return useHasRole("qc_manager");
}

// C1 (Wave 4): extracted helper used by the JC list page row actions and
// the detail-page Force-Unlock CTA. Returns the canonical effective lock
// state for a row record — needs only the four fields the list endpoint
// already returns, which keeps it independent of the heavier
// `JobCardDetail` shape consumed by useLockState() on the detail page.
//
// Mirrors the assert_not_locked rule on the server (see
// server_replica/app/modules/production/services/job_card_v2.py:59):
// operationally locked = `is_locked && !force_unlocked`. We surface the
// raw reason text for hover-tooltips on the list-page lock chip and the
// admin/floor-manager force-unlock CTA gating via `mayForceUnlock`.
export type RowLockSource = {
  status?: string | null;
  // `locked_reason` is the canonical column; `lock_reason` is the
  // shorter alias the list endpoint returns. Accept both so a v1 row that
  // sneaks through still renders the indicator correctly.
  locked_reason?: string | null;
  lock_reason?: string | null;
  is_locked?: boolean | null;
  force_unlocked?: boolean | null;
};

export interface RowLockIndicator {
  /** True when the JC row is operationally locked. */
  isLocked: boolean;
  /** Server reason — surfaced on hover. Null when none. */
  lockedReason: string | null;
  /** True when an admin / floor_manager / plant_manager / inventory_manager
   *  is signed in and can act on the row's Force-Unlock CTA. */
  mayForceUnlock: boolean;
  /** True when the row is locked AND the user can act on the CTA AND the
   *  row has not already been force-unlocked. Mirrors the gating used by
   *  the detail-page OverflowMenu (see _useLockState::userMayForceUnlock). */
  shouldShowForceUnlock: boolean;
}

// W4-MED-3/M10: now pure — the caller passes the user's force-unlock
// capability bit in (computed once via UserCtx in the JC pages) so this
// helper no longer adds N pub-sub subscriptions on a row-dense list page.
//
// The old useMe()-internal subscription pattern is preserved on the
// useRowLockIndicatorWithMe variant for any external caller (none today —
// every site has been migrated) that doesn't have a UserCtx ancestor.
export function deriveRowLockIndicator(
  row: RowLockSource | null | undefined,
  mayForceUnlock: boolean,
): RowLockIndicator {
  if (!row) {
    return { isLocked: false, lockedReason: null, mayForceUnlock: false, shouldShowForceUnlock: false };
  }
  const isLocked = !!row.is_locked && !row.force_unlocked;
  const lockedReason = (row.locked_reason ?? row.lock_reason ?? null) || null;
  return {
    isLocked,
    lockedReason,
    mayForceUnlock,
    shouldShowForceUnlock: isLocked && mayForceUnlock && !row.force_unlocked,
  };
}

// Legacy hook — kept as a thin wrapper so any out-of-module caller still
// works. Inside the JC module callers go through deriveRowLockIndicator
// + the UserCtx-provided mayForceUnlock flag instead.
export function useRowLockIndicator(row: RowLockSource | null | undefined): RowLockIndicator {
  const me = useMe();
  return useMemo<RowLockIndicator>(
    () => deriveRowLockIndicator(row, userMayForceUnlock(me)),
    [row, me],
  );
}

export interface UserScope {
  isAdmin: boolean;
  warehouses: string[];
  // Allowed shop-floor / area names — empty means "no floor restriction".
  // Planning's per-step floor dropdown intersects this list with the
  // selected factory's full floor set.
  floors: string[];
}

export function useUserScope(): UserScope {
  const me = useMe() as MeWithScope | null;
  // useIsAdmin walks the same MeResponse but tolerates more wire shapes
  // than the bare `is_admin` flag — keeps the scope banner in sync with
  // the rest of the role-aware UI.
  const isAdmin = useIsAdmin();
  return {
    isAdmin,
    warehouses: me?.warehouses ?? [],
    floors: me?.floors ?? [],
  };
}

// Boot-time guard. Mounts once, redirects to "/" when there is no usable
// refresh token. Returns the boolean so callers that want to gate render
// can do so; pages that always render through the redirect can ignore it.
// Stashes the path the user was trying to reach so the login page can
// bounce them back after re-authenticating.
const REDIRECT_KEY = "auth.redirect_after_login";

export function stashRedirectAfterLogin(path: string): void {
  if (typeof window === "undefined") return;
  if (!path || path === "/") return;
  try { sessionStorage.setItem(REDIRECT_KEY, path); } catch { /* ignore */ }
}
export function takeRedirectAfterLogin(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const v = sessionStorage.getItem(REDIRECT_KEY);
    if (v) sessionStorage.removeItem(REDIRECT_KEY);
    return v;
  } catch {
    return null;
  }
}

export function useRequireAuth(replace: (href: string) => void): boolean {
  // W4-HIGH-4 — start as `false` so list/detail fetch effects don't fire BEFORE
  // the token check has run. Pre-check, every page had a one-paint window where
  // `allowed === true` (the old default) but the redirect was still pending,
  // causing a wasted authed fetch that would 401 / be aborted. The happy-path
  // flip happens in a microtask so React's set-state-in-effect lint stays mute.
  const [allowed, setAllowed] = useState<boolean>(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const ok = tokenStore.hasRefreshToken() && !tokenStore.isRefreshExpired();
    if (!ok) {
      stashRedirectAfterLogin(window.location.pathname + window.location.search);
      // Stay !allowed; the redirect fires this tick.
      replace("/");
      return;
    }
    // Force-change-password gate: if the cached me snapshot says the
    // operator still owes us a fresh password, bounce them to the
    // dedicated page regardless of where they tried to land. The
    // /change-password route deliberately does NOT call this hook (it
    // would loop), so its own inline gate covers the inverse case (user
    // visits /change-password after they've already changed it). The
    // background /me refresh inside each page keeps the cached flag
    // honest if an admin flips it server-side mid-session.
    const cached = userStore.load();
    if (cached && cached.must_change_password === true) {
      replace("/change-password");
      return;
    }
    // Happy path: defer the flip past the synchronous effect body so the
    // react-hooks/set-state-in-effect rule stays happy.
    queueMicrotask(() => setAllowed(true));
  }, [replace]);
  // SSR: there's no token store to read, no redirect to fire, and the server
  // render would otherwise hang on a perpetually-false gate. Return true on
  // the server pass; the browser pass starts at false and flips true after
  // the token check above. The `useState` call still ran above so the hook
  // order stays stable across SSR/CSR.
  if (typeof window === "undefined") return true;
  return allowed;
}
