// ── Admin API client ──
//
// Thin typed wrapper around the auth router's admin endpoints. Mirrors
// `frontend_replica/src/admin/admin.js` and `user-detail.js` but uses the
// silent-refresh-enabled `apiFetch` from lib/auth.ts so admin sessions
// also benefit from token rotation.
//
// Endpoints intentionally restricted to what `server_replica/app/modules/
// auth/router.py` actually exposes. The legacy admin.js calls some routes
// the backend never shipped (e.g. /users/{id}/activate, multi-role add/
// remove); we deliberately don't reproduce those — admin edits go through
// PUT /users/{id} (status flip) and PUT /users/{id}/scope.

import { apiFetch } from "@/lib/auth";

// ── shared shapes ────────────────────────────────────────────────────────

export interface AdminRole {
  role_id: number;
  role_name: string;
  description?: string;
  is_admin: boolean;
  permission_count?: number;
}

export interface AdminUser {
  user_id: number;
  phone: string;
  full_name: string | null;
  email: string | null;
  // server returns both legacy + nested shapes; we keep both keys + a
  // derived helper (`primaryRole`) for the UI.
  role_id?: number | null;
  role_name?: string | null;
  // Multi-role: a user can hold several roles. `role_codes` / `roles` carry
  // the full set (primary first); `role_name`/`role_id` stay the primary for
  // legacy single-role displays. `is_admin` is the aggregated flag.
  role_codes?: string[];
  role_ids?: number[];
  roles?: { role_id: string; code: string; is_admin: boolean }[];
  is_admin?: boolean;
  entity?: string | null;
  entities?: string[];
  allowed_entities?: string[] | null;
  warehouses?: string[];
  allowed_warehouses?: string[] | null;
  floors?: string[];
  allowed_floors?: string[] | null;
  is_active?: boolean;
  status?: string;
  last_login_at?: string | null;
  password_changed_at?: string | null;
  must_change_password?: boolean;
  created_at?: string | null;
  // Lock-state surfaced by /users (added alongside the unlock endpoint).
  // locked_until is an ISO timestamp; the UI compares against `now` to
  // decide whether the user is CURRENTLY locked. failed_login_count is
  // the running counter — non-zero is informational even when no longer
  // locked (e.g. 3 failures so far, lock at 5).
  locked_until?: string | null;
  failed_login_count?: number | null;
}

export interface AdminPermission {
  permission_id: number;
  module: string;
  sub_module: string | null;
  sub_sub_module: string | null;
  action: string;
  description: string | null;
}

export interface AdminModule {
  module: string;
  sub_modules: string[];
  permission_count: number;
}

// ── fetch helper ─────────────────────────────────────────────────────────

async function adminJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    let body: { message?: string; detail?: string; error?: string; details?: { rules?: string[] } } = {};
    try { body = await res.json(); } catch { /* not JSON */ }
    const msg = body.message
      || (Array.isArray(body.details?.rules) ? `Weak password: ${body.details.rules.join("; ")}` : null)
      || body.detail
      || body.error
      || `HTTP ${res.status}`;
    const err = new Error(msg) as Error & { status?: number; code?: string };
    err.status = res.status;
    err.code = body.error;
    throw err;
  }
  return (await res.json()) as T;
}

// ── users ────────────────────────────────────────────────────────────────

export async function listUsers(): Promise<AdminUser[]> {
  // /users returns a flat array (admin contract from auth_router.list_users)
  return adminJson<AdminUser[]>("/api/v1/auth/users");
}

export async function getUser(userId: string | number): Promise<AdminUser> {
  return adminJson<AdminUser>(`/api/v1/auth/users/${encodeURIComponent(String(userId))}`);
}

export interface CreateUserPayload {
  phone: string;
  password: string;
  full_name: string;
  email?: string | null;
  role_codes: string[];     // single-role: [role_name]
  entities?: string[];
  warehouses?: string[];
  floors?: string[];
  must_change_password?: boolean;
}

export async function createUser(p: CreateUserPayload): Promise<AdminUser> {
  return adminJson<AdminUser>("/api/v1/auth/users", {
    method: "POST",
    body: JSON.stringify(p),
  });
}

export interface EditUserPayload {
  full_name?: string;
  email?: string | null;
  // Single primary role (legacy). For multi-role assignment send `role_codes`
  // (role names) or `role_ids`; the server replaces the whole set and the
  // first becomes the primary/display role.
  role_id?: number;
  role_codes?: string[];
  role_ids?: number[];
  // `status` is the canonical edit; `is_active` is the legacy flag the
  // server's allowlist also accepts.
  status?: "active" | "suspended";
  is_active?: boolean;
}

export async function editUser(userId: number, patch: EditUserPayload): Promise<{ user_id: number; updated: boolean }> {
  return adminJson(`/api/v1/auth/users/${userId}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export async function replaceUserScope(
  userId: number,
  scope: { entities?: string[] | null; warehouses?: string[] | null; floors?: string[] | null },
): Promise<{ user_id: number; scope_updated: boolean }> {
  return adminJson(`/api/v1/auth/users/${userId}/scope`, {
    method: "PUT",
    body: JSON.stringify(scope),
  });
}

export async function deactivateUser(userId: number): Promise<{ user_id: number; deactivated: boolean }> {
  return adminJson(`/api/v1/auth/users/${userId}`, { method: "DELETE" });
}

export interface AdminResetPasswordResponse {
  user_id: string;
  message: string;
  revoked_count: number;
  temp_password_set: boolean;
}

export async function adminResetPassword(
  userId: number,
  newPassword: string,
): Promise<AdminResetPasswordResponse> {
  return adminJson(`/api/v1/auth/users/${userId}/reset-password`, {
    method: "POST",
    body: JSON.stringify({ new_password: newPassword }),
  });
}

// Immediately clear locked_until + failed_login_count for the target
// user. Doesn't touch their password (unlike reset-password) and
// doesn't revoke live sessions — purely lifts the login-gate lockout
// so the user can attempt login right away.
//
// was_locked tells the caller whether locked_until > NOW() before the
// update — useful for differentiating "actually unlocked" from
// "cleared stale counters on an already-unlocked account" in toasts.
export interface AdminUnlockUserResponse {
  user_id: number;
  unlocked: boolean;
  was_locked: boolean;
}

export async function unlockUser(userId: number): Promise<AdminUnlockUserResponse> {
  return adminJson(`/api/v1/auth/users/${userId}/unlock`, { method: "POST" });
}

// Pure helper: is the user currently locked per their locked_until
// timestamp? Used by the admin row to decide whether to render the
// Locked chip + Unlock CTA.
export function userIsLocked(u: AdminUser): boolean {
  if (!u.locked_until) return false;
  const t = Date.parse(u.locked_until);
  return Number.isFinite(t) && t > Date.now();
}

// ── roles ────────────────────────────────────────────────────────────────

export async function listRoles(): Promise<AdminRole[]> {
  return adminJson<AdminRole[]>("/api/v1/auth/roles");
}

export async function createRole(p: {
  role_name: string;
  description?: string;
  is_admin?: boolean;
}): Promise<{ role_id: number; role_name: string }> {
  return adminJson("/api/v1/auth/roles", {
    method: "POST",
    body: JSON.stringify(p),
  });
}

export interface RolePermissionsResponse {
  role: AdminRole & { allowed_entities?: string[] | null; allowed_warehouses?: string[] | null; allowed_floors?: string[] | null };
  permissions: (AdminPermission & {
    allowed_entities?: string[] | null;
    allowed_warehouses?: string[] | null;
    allowed_floors?: string[] | null;
  })[];
}

export async function getRolePermissions(roleId: number): Promise<RolePermissionsResponse> {
  return adminJson<RolePermissionsResponse>(`/api/v1/auth/roles/${roleId}/permissions`);
}

export async function setRolePermissions(
  roleId: number,
  payload: {
    permission_ids: number[];
    allowed_entities?: string[] | null;
    allowed_warehouses?: string[] | null;
    allowed_floors?: string[] | null;
  },
): Promise<{ role_id: number; permissions_set: number }> {
  return adminJson(`/api/v1/auth/roles/${roleId}/permissions`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

// ── permissions + modules ────────────────────────────────────────────────

export async function listPermissions(module?: string): Promise<AdminPermission[]> {
  const q = module ? `?module=${encodeURIComponent(module)}` : "";
  return adminJson<AdminPermission[]>(`/api/v1/auth/permissions${q}`);
}

export async function listModules(): Promise<AdminModule[]> {
  return adminJson<AdminModule[]>("/api/v1/auth/modules");
}

export async function createModule(p: {
  module: string;
  sub_modules?: string[] | null;
}): Promise<{ module: string; sub_modules: string[]; permissions_created: number }> {
  return adminJson("/api/v1/auth/modules", {
    method: "POST",
    body: JSON.stringify(p),
  });
}

export async function createPermission(p: {
  module: string;
  sub_module?: string | null;
  sub_sub_module?: string | null;
  action: string;
  description?: string;
}): Promise<{ permission_id: number; module: string; sub_module: string | null; action: string }> {
  return adminJson("/api/v1/auth/permissions/create", {
    method: "POST",
    body: JSON.stringify(p),
  });
}

export async function editPermission(
  permissionId: number,
  patch: {
    module?: string;
    sub_module?: string | null;
    sub_sub_module?: string | null;
    action?: string;
    description?: string;
  },
): Promise<{ permission_id: number; updated: boolean }> {
  return adminJson(`/api/v1/auth/permissions/${permissionId}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export async function deletePermission(permissionId: number): Promise<{ permission_id: number; deleted: boolean }> {
  return adminJson(`/api/v1/auth/permissions/${permissionId}`, { method: "DELETE" });
}

// ── helpers ──────────────────────────────────────────────────────────────

export function userPrimaryRoleName(u: AdminUser): string {
  return u.role_name || "";
}

// All role names a user holds (primary first). Falls back to the single
// primary role for records the server returned without the multi-role set.
export function userRoleNames(u: AdminUser): string[] {
  if (u.role_codes && u.role_codes.length) return u.role_codes;
  if (u.roles && u.roles.length) return u.roles.map((r) => r.code);
  return u.role_name ? [u.role_name] : [];
}

export function userIsAdmin(u: AdminUser): boolean {
  return u.is_admin === true;
}

export function userEntities(u: AdminUser): string[] {
  return u.entities ?? u.allowed_entities ?? (u.entity ? [u.entity] : []);
}

export function userWarehouses(u: AdminUser): string[] {
  return u.warehouses ?? u.allowed_warehouses ?? [];
}

export function userFloors(u: AdminUser): string[] {
  return u.floors ?? u.allowed_floors ?? [];
}

// ── canonical scope option lists ─────────────────────────────────────────
//
// Mirrors `_MODAL_*` constants in frontend_replica/src/admin/admin.js. The
// auth router doesn't expose a /warehouses or /floors endpoint, so the UI
// works against this canonical list. When floors change we filter by the
// selected warehouses so an admin can't pick a floor that's unreachable
// from any of the user's assigned factories.

export const ENTITY_OPTIONS: { value: string; label: string }[] = [
  { value: "cfpl", label: "CFPL" },
  { value: "cdpl", label: "CDPL" },
];

// Canonical warehouse codes (match the sample backend's WAREHOUSES list + the
// transfer module). Production floors are only defined for the two production
// sites (W202, A185); the remaining sites are warehouse/cold-storage with no
// shop-floor breakdown, so floorsAvailable() returns [] for them.
export const WAREHOUSE_OPTIONS: { value: string; label: string }[] = [
  { value: "W202", label: "W202" },
  { value: "A185", label: "A185" },
  { value: "A68", label: "A68" },
  { value: "A101", label: "A101" },
  { value: "F53", label: "F53" },
  { value: "D-39", label: "D-39" },
  { value: "D-514", label: "D-514" },
  { value: "Rishi", label: "Rishi" },
  { value: "Supreme", label: "Supreme" },
];

export const FLOORS_BY_WAREHOUSE: Record<string, string[]> = {
  "W202": [
    "Lower Basement", "Upper Basement", "First Floor", "First Floor Mezz",
    "Second Floor", "Second Floor Mezz", "Terrace",
  ],
  "A185": [
    "Roasting Area", "Mezzanine", "Sorting Area", "Printing Area",
    "Dmart Production Area", "Dmart Packing Area", "Cheese Floor",
    "FG store", "FFS Packing Area",
  ],
};

export function floorsAvailable(selectedWarehouses: string[]): string[] {
  const out: string[] = [];
  for (const wh of selectedWarehouses) {
    for (const f of FLOORS_BY_WAREHOUSE[wh] ?? []) {
      if (!out.includes(f)) out.push(f);
    }
  }
  return out;
}

// 16-char temp password, biased to readable ASCII (no 0/O/1/l/I) and
// guaranteed to contain at least one letter + one digit. Matches the
// legacy `generateTempPassword()` helper.
export function generateTempPassword(): string {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz";
  const digits = "23456789";
  const all = letters + digits;
  const buf = new Uint8Array(16);
  (typeof window !== "undefined" ? window.crypto : crypto).getRandomValues(buf);
  let out = "";
  out += letters[buf[0] % letters.length];
  out += digits[buf[1] % digits.length];
  for (let i = 2; i < 16; i++) out += all[buf[i] % all.length];
  return out;
}

export function fmtAdminDate(d: string | null | undefined): string {
  if (!d) return "—";
  return String(d).slice(0, 16).replace("T", " ");
}
