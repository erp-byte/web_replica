// C12 cost-metric UI gate. Mirrors the backend B13 gate at
// `server_replica/app/modules/production/services/response_filters.py`.
//
// Purpose: defense-in-depth + clean UX.
//
//   * Defense in depth — the backend already strips cost-bearing fields
//     from every response when the caller is in the deny list. If a
//     future endpoint forgets to call `strip_cost_fields` on the way out,
//     a UI gate keeps the leakage from reaching the screen. The
//     `stripCostFields` helper below is the symmetric client copy.
//
//   * Clean UX — when a role isn't allowed to see cost, we want the cost
//     COLUMN to vanish (not render an empty "—" / 0.00 cell). Pages call
//     `useSeesCost()` and wrap each currency-bearing render in
//     `{seesCost && (…)}` — or filter the column array with
//     `columns.filter(c => !c.gated || seesCost)` for table headers.
//
// Role plumbing (read from cached `me` in `userStore`):
//
//   me.is_admin         → admin bypass (sees everything).
//   me.role_name        → preferred. The Android client uses this shape.
//   me.roles[*].code    → server `/me` payload (see _role_payload in
//                         server_replica/app/modules/auth/services/
//                         auth_service.py). Each role's `code` is the
//                         role_name. A user has 0-or-1 today (the schema
//                         is many-to-many ready but only the legacy
//                         single-role link is populated).
//
// Default-deny: an unknown role is treated as deny.
// Adding a role to the allow list is an explicit opt-in.

import { useEffect, useState } from "react";
import { userStore, type MeResponse, type MeRoleEnvelope } from "./auth";

// ── Role lists (mirror backend response_filters.py) ──────────────────────

export const COST_FIELDS_DENY_ROLES: ReadonlySet<string> = new Set([
  "team_leader", "qc_inspector", "floor_manager", "viewer",
]);

export const COST_FIELDS_ALLOW_ROLES: ReadonlySet<string> = new Set([
  "admin", "planner", "purchase_manager", "inventory_manager",
  // sample module — business_head is a management role and sees cost
  // (npd_team is intentionally omitted → default-deny).
  "business_head",
  // future commercial roles — explicit opt-in so adding the
  // role on the backend doesn't silently expose ₹ in the UI.
  "commercial_manager", "cost_controller",
]);

// ── Cost-bearing fields (mirror backend response_filters.COST_BEARING_FIELDS)
//
// Kept in the same logical groups as the Python file so adding a new
// field there → here is a one-line mechanical edit. Length must match
// the backend (47 fields at the time of writing). If you add a field
// here, add it there (and vice versa).

export const COST_BEARING_FIELDS: ReadonlySet<string> = new Set([
  // Variance / consumption costing
  "unit_cost_at_consumption", "variance_cost_impact", "cost_basis",
  // Currency-denominated INR fields surfaced by JC v2 detail
  "rate_inr", "amount_inr", "total_amount_inr",
  // Generic rate / price columns
  "rate", "price", "unit_price", "selling_price", "mrp", "list_price",
  // Inventory ledger valuations
  "landed_cost", "ledger_value", "stock_value", "valuation",
  "wac_cost", "fifo_cost", "standard_cost",
  // Aggregate amount fields
  "amount", "gross_amount", "net_amount",
  "batch_total_cost", "total_cost",
  // Per-unit cost ratios
  "unit_cost", "cost_per_unit", "cost_per_pack", "cost_per_kg",
  // Material / labour / overhead breakdown
  "material_cost", "labour_cost", "overhead_cost",
  // Margin (percentage but derived from cost)
  "margin_pct",
  // Tax & charges (currency in INR) — GST split + APMC + packing/freight/
  // processing surcharges that ride along on every SO/PO line. Added with
  // the C12 SO router gating so deny-listed roles can't reconstruct the
  // line total from the per-component amounts.
  "igst_amount", "sgst_amount", "cgst_amount",
  "apmc_amount", "packing_amount", "freight_amount", "processing_amount",
  // SFG / WIP valuation (RESERVED — Slice 1, enforced in Slice 5). Reserved up
  // front so the gate exists before any cost value flows on the SFG/WIP surface.
  // Mirror EXACTLY in server_replica response_filters.COST_BEARING_FIELDS.
  "sfg_unit_cost", "wip_unit_cost",
  "sfg_cost_per_kg", "wip_cost_per_kg",
  "sfg_valuation", "wip_valuation",
  "wip_stock_value", "wip_batch_value",
]);

// ── Role extraction from the cached `me` payload ─────────────────────────
//
// Tolerant of three wire shapes the backend has shipped:
//
//   1. `role_name` at the top level (some legacy paths, mirrors the
//      Android client's MeResponse).
//   2. `roles: [{ code }]` — the canonical /me payload (auth_service's
//      _role_payload helper). `code` is the canonical role_name.
//   3. `roles: ["team_leader"]` — a defensive fallback for older builds /
//      tests that drop the per-role envelope.
//
// Anywhere the role is `is_admin: true` we shortcut to allow.

// Re-export the envelope type under the local name we used to declare so
// existing call sites stay source-compatible.
type RoleEnvelope = MeRoleEnvelope;

// Admin precedence (documented):
//
//   me.is_admin === true                       → admin (wins immediately)
//   OR any roles[].is_admin === true           → admin
//   OR any roles[].code === "admin"            → admin (string-shape fallback)
//
// Role resolution: iterate EVERY role envelope and prefer the most-
// permissive one (the first allow-listed entry). H1 fix — the legacy
// implementation only inspected `rolesAny[0]`, so a user whose
// allow-listed role landed at index ≥ 1 was wrongly denied.
//
// `userStore.save` already normalises `me.is_admin` (see lib/auth.ts
// _normaliseAdmin), so the cached snapshot is authoritative — we still
// re-walk here defensively for callers that pass a fresh (un-normalised)
// response straight into `seesCostFor`.
function extractRoleName(me: MeResponse | null): { role: string | null; isAdmin: boolean } {
  if (!me) return { role: null, isAdmin: false };

  let isAdmin = me.is_admin === true;
  let resolvedRole: string | null = null;

  // Shape 1 — `role_name` at the root. Treat as a candidate; it can still
  // lose to an allow-listed entry in the `roles` array (rare but possible
  // when the wire ships both — `roles` is authoritative server-side).
  if (typeof me.role_name === "string" && me.role_name.length > 0) {
    resolvedRole = me.role_name;
    if (COST_FIELDS_ALLOW_ROLES.has(me.role_name)) {
      // Already allow-listed — short-circuit further iteration.
      return { role: me.role_name, isAdmin };
    }
  }

  // Shapes 2 + 3 — iterate every entry. Bare strings become a synthetic
  // envelope with just `code`. We prefer the FIRST allow-listed role we
  // encounter (breaks out early); otherwise we fall through and keep the
  // first non-empty code as a deny-side baseline so `extractRoleName`
  // returns a stable string rather than null.
  const rolesAny = me.roles;
  if (Array.isArray(rolesAny)) {
    for (const r of rolesAny) {
      const env: RoleEnvelope = typeof r === "string" ? { code: r } : (r as RoleEnvelope);
      if (env.is_admin === true) isAdmin = true;
      const code = env.code ?? env.role_name;
      if (code && code.length > 0) {
        if (COST_FIELDS_ALLOW_ROLES.has(code)) {
          resolvedRole = code;
          break;
        }
        if (!resolvedRole) resolvedRole = code;
      }
    }
  }

  return { role: resolvedRole, isAdmin };
}

// ── Decision ────────────────────────────────────────────────────────────

export function seesCostFor(me: MeResponse | null): boolean {
  const { role, isAdmin } = extractRoleName(me);
  if (isAdmin) return true;
  if (!role) return false;
  // Default-deny: an unknown role can't see cost. Adding a new role to
  // the allow list is the only way to surface ₹ to a fresh persona.
  return COST_FIELDS_ALLOW_ROLES.has(role);
}

// ── React hook ──────────────────────────────────────────────────────────
//
// Reads from the same cached `me` slot as `useMe()` (lib/user.ts) so a
// single localStorage read serves both.
//
// H4 fix: SSR hydration flash. The original queueMicrotask + setState
// caused a render pass with `seesCost: false` even for allow-listed users,
// flashing the gated UI for one frame on every navigation. We now load
// synchronously in the lazy state initialiser so the first render already
// has the correct answer in the browser. `loaded` is exposed for the SSR
// pass (where the initialiser returns null) — callers that want to keep
// the conservative default-deny render until hydration completes can use
// it, but most consumers can ignore it (legacy destructure stays valid).
//
// M3: subscribes to `userStore` events so a fresh `/me` fetch on another
// screen (e.g. profile page) propagates here without a reload. Listens to
// the window `storage` event for cross-tab sync.

export function useSeesCost(): { seesCost: boolean; loaded: boolean } {
  const [me, setMe] = useState<MeResponse | null>(() =>
    typeof window !== "undefined" ? userStore.load() : null,
  );
  // `loaded` flips true once we've completed at least one client-side
  // read. During SSR it stays false so the conservative default-deny
  // posture holds; on first mount in the browser the lazy initialiser
  // already returned the cached value, so we flip immediately.
  const [loaded, setLoaded] = useState<boolean>(() => typeof window !== "undefined");

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Defensive re-read on mount — handles the (rare) case where the
    // lazy initialiser ran before `auth.me` was populated (e.g. a tab
    // restored mid-login).
    if (!loaded) {
      // Deferred past the synchronous effect body (react-hooks/set-state-in-effect)
      // — same queueMicrotask pattern as lib/user.ts::useMe.
      queueMicrotask(() => {
        setMe(userStore.load());
        setLoaded(true);
      });
    }
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
  }, [loaded]);

  return { seesCost: loaded && seesCostFor(me), loaded };
}

// ── Client-side defense-in-depth stripper ───────────────────────────────
//
// Walks an arbitrary JSON tree and drops every key whose name is in
// `COST_BEARING_FIELDS`. The backend filter already runs (B13), so this
// is a belt-and-braces guard for endpoints that haven't been wired
// through `strip_cost_fields` server-side yet.
//
// Behaviour:
//   * `seesCost=true` (admin / allow-list) → returns `payload` unchanged.
//   * `seesCost=false` → returns a deep-cloned, scrubbed tree. The input
//     is never mutated.
//   * Non-object / non-array values pass through untouched at every depth.
//   * Cycle detection is intentionally NOT included — API payloads are
//     pure JSON, so cycles can't appear.

export function stripCostFields<T>(payload: T, seesCost: boolean): T {
  if (seesCost) return payload;
  return _scrub(payload) as T;
}

function _scrub(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(_scrub);
  }
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (COST_BEARING_FIELDS.has(k)) continue;
      out[k] = _scrub(v);
    }
    return out;
  }
  return node;
}

// ── Field-level helper ──────────────────────────────────────────────────
//
// Tiny boundary check used by table column specs:
//
//   const visible = columns.filter(c => !c.gated || seesCost);
//
// — where `gated` is a static flag set by the column author. Use this
// helper to derive that flag from a wire key the column reads:
//
//   { key: "rate_inr", label: "Rate", gated: isCostField("rate_inr") }

export function isCostField(name: string): boolean {
  return COST_BEARING_FIELDS.has(name);
}
