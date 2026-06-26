// Role-based capability gating for the Sample module UI. Mirrors the backend
// permission grants in server_replica/app/db/samples/035_sample_roles.sql so the
// UI only offers actions a role can actually perform (the server is still the
// source of truth — these gates are UX, not security).

import type { MeResponse, MeRoleEnvelope } from "./auth";

export function roleNameOf(me: MeResponse | null): string | null {
  if (!me) return null;
  if (typeof me.role_name === "string" && me.role_name) return me.role_name;
  const roles = Array.isArray(me.roles) ? me.roles : null;
  if (roles) {
    for (const r of roles) {
      const code = typeof r === "string" ? r : (r as MeRoleEnvelope).code ?? (r as MeRoleEnvelope).role_name;
      if (code) return code;
    }
  }
  return null;
}

export function isAdminMe(me: MeResponse | null): boolean {
  if (!me) return false;
  if (me.is_admin === true) return true;
  const roles = Array.isArray(me.roles) ? me.roles : null;
  if (!roles) return false;
  for (const r of roles) {
    if (typeof r === "string") {
      if (r === "admin") return true;
      continue;
    }
    const env = r as MeRoleEnvelope;
    if (env.is_admin === true || env.code === "admin" || env.role_name === "admin") return true;
  }
  return false;
}

export interface SampleCaps {
  isAdmin: boolean;
  /** create / edit / submit / cancel a requisition */
  canRequest: boolean;
  /** edit a request body from the queue — the Sales / business requesting side
   *  (business_head + planner), NOT the NPD reviewer. No dedicated "sales" role
   *  exists yet; this is the closest analog. */
  canEdit: boolean;
  /** business-head approve / reject + conversion */
  canApprove: boolean;
  canConvert: boolean;
  /** floor: start-production / mark-packing */
  canProduction: boolean;
  /** inventory: outward / dispatch / mark-ready / inv-verify / gate-pass / close */
  canInventory: boolean;
  /** NPD draft author / promote + dev job cards */
  canNpd: boolean;
  /** may SEE & navigate the NPD Development module */
  canSeeNpd: boolean;
  /** may download the NPD dev-JC outpass (gate pass) */
  canOutpass: boolean;
}

// All role codes the user holds (string entries + envelope code/role_name).
// Multi-role aware — gating decisions must use this, not roleNameOf (which
// returns only the first role and is for display).
export function roleNamesOf(me: MeResponse | null): string[] {
  if (!me) return [];
  const out: string[] = [];
  if (typeof me.role_name === "string" && me.role_name) out.push(me.role_name);
  const roles = Array.isArray(me.roles) ? me.roles : null;
  if (roles) {
    for (const r of roles) {
      const code = typeof r === "string" ? r : (r as MeRoleEnvelope).code ?? (r as MeRoleEnvelope).role_name;
      if (code) out.push(code);
    }
  }
  return out;
}

export function sampleCaps(me: MeResponse | null): SampleCaps {
  const isAdmin = isAdminMe(me);
  const roles = roleNamesOf(me);
  const is = (...names: string[]) => isAdmin || names.some((n) => roles.includes(n));
  return {
    isAdmin,
    canRequest: is("planner", "business_head", "npd_team"),
    canEdit: is("business_head", "planner"),
    canApprove: is("business_head"),
    canConvert: is("business_head"),
    canProduction: is("floor_manager"),
    canInventory: is("inventory_manager"),
    canNpd: is("npd_team"),
    canSeeNpd: is("npd_team", "business_head", "inventory_manager"),
    canOutpass: is("npd_team"),
  };
}

// Module-tile / route-guard predicate for NPD Development.
export function canSeeNpdModule(me: MeResponse | null): boolean {
  return sampleCaps(me).canSeeNpd;
}
