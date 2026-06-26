// Mirrors the Android client's auth flow:
//   1. POST /api/v1/auth/login  →  store tokens
//   2. GET  /api/v1/auth/me     →  hydrate user, route on must_change_password / inactive
// Error envelope codes (invalid_credentials, account_locked, rate_limit_exceeded,
// account_suspended, account_disabled) are mapped to user-visible strings, matching
// LoginActivity.handleLoginError.

// Resolve the API origin. Normally this is `NEXT_PUBLIC_API_BASE_URL`, but we
// guard against the mixed-content trap: if the page is served over HTTPS while
// the configured base is a plain-HTTP origin (e.g. a bare-IP backend), the
// browser blocks every request and the app is dead before any call leaves the
// page. In that case fall back to "" (same-origin), which routes through the
// Next.js `/api/*` proxy declared in next.config.ts — the browser sees only
// same-origin HTTPS, and Next forwards to the backend server-side.
//
// Local dev is unaffected: the page is http://localhost there, so the guard
// never trips and direct http://localhost:8000 calls keep working.
function resolveApiBase(): string {
  const configured = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
  if (
    typeof window !== "undefined" &&
    window.location.protocol === "https:" &&
    configured.startsWith("http://")
  ) {
    return "";
  }
  return configured;
}

const API_BASE = resolveApiBase();

const TOKEN_KEYS = {
  access: "auth.access_token",
  refresh: "auth.refresh_token",
  accessExpiresAt: "auth.access_expires_at",
  refreshExpiresAt: "auth.refresh_expires_at",
} as const;

// Tiny safe-storage shim — returns null / no-ops during SSR so callers can
// stay synchronous without scattering `typeof window` checks. localStorage
// access is also wrapped in try/catch so Safari private mode (which throws
// QuotaExceededError on every write) doesn't crash the app.
function safeGet(k: string): string | null {
  if (typeof window === "undefined") return null;
  try { return localStorage.getItem(k); } catch { return null; }
}
function safeSet(k: string, v: string): void {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(k, v); } catch { /* private mode or quota — swallow */ }
}
function safeRemove(k: string): void {
  if (typeof window === "undefined") return;
  try { localStorage.removeItem(k); } catch { /* ignore */ }
}

export interface DeviceInfo {
  device_id: string;
  device_name: string;
  app_version: string;
  platform: string;
}

export interface LoginRequest {
  phone: string;
  password: string;
  device_info?: DeviceInfo;
}

export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  refresh_expires_in: number;
  must_change_password: boolean;
  user?: unknown;
}

// Role-envelope shape returned by `/me` (server: auth_service._role_payload).
// Each entry has `code` (the canonical role_name) and optionally `is_admin`.
// Older builds shipped just the bare string; we tolerate both at the call
// site (see lib/cost-gate.ts:extractRoleName).
export interface MeRoleEnvelope {
  code?: string;
  role_name?: string;
  is_admin?: boolean;
}

export interface MeResponse {
  user_id?: string;
  phone?: string;
  full_name?: string;
  email?: string;
  status: string;
  must_change_password: boolean;
  is_admin?: boolean;
  // C12-fix M6: typed `role_name` + `roles` so consumers no longer cast
  // inline. `roles` is heterogeneous on the wire (envelope objects on new
  // builds, bare strings on old ones); the cost-gate normaliser handles
  // both shapes.
  role_name?: string;
  roles?: (string | MeRoleEnvelope)[];
  permissions?: unknown[];
  [key: string]: unknown;
}

const ME_KEY = "auth.me";

// C12-fix M2: normalise `is_admin` once on save so every consumer (cost
// gate, scope hooks, route guards) reads the same flag without having to
// re-walk the `roles` envelope. Precedence — admin wins:
//
//   me.is_admin === true                       → admin
//   any roles[].is_admin === true              → admin
//   any roles[].code === "admin" (or string)   → admin
//
// `_normaliseAdmin` returns a SHALLOW copy with the flag set; the original
// object is left untouched so callers (e.g. profile page) can keep using
// the response they got from `/me`.
function _normaliseAdmin(me: MeResponse): MeResponse {
  if (me.is_admin === true) return me;
  const roles = Array.isArray(me.roles) ? me.roles : null;
  if (!roles) return me;
  for (const r of roles) {
    if (typeof r === "string") {
      if (r === "admin") return { ...me, is_admin: true };
      continue;
    }
    if (r && typeof r === "object") {
      const env = r as MeRoleEnvelope;
      if (env.is_admin === true) return { ...me, is_admin: true };
      if (env.code === "admin" || env.role_name === "admin") {
        return { ...me, is_admin: true };
      }
    }
  }
  return me;
}

// C12-fix M3: tiny pub-sub. `useMe` / `useSeesCost` subscribe so a fresh
// `/me` fetch propagates into already-mounted screens (e.g. the profile
// page hydrates faster than the avatar dropdown). Cross-tab sync comes for
// free via the `storage` event in the hook.
type MeListener = (me: MeResponse | null) => void;
const meListeners = new Set<MeListener>();
function _notifyMeListeners(me: MeResponse | null): void {
  for (const fn of meListeners) {
    try { fn(me); } catch { /* one listener failure shouldn't stop the rest */ }
  }
}

export const userStore = {
  save(me: MeResponse) {
    const normalised = _normaliseAdmin(me);
    safeSet(ME_KEY, JSON.stringify(normalised));
    _notifyMeListeners(normalised);
  },
  load(): MeResponse | null {
    const raw = safeGet(ME_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as MeResponse;
    } catch {
      return null;
    }
  },
  clear() {
    safeRemove(ME_KEY);
    _notifyMeListeners(null);
  },
  // Subscribe to save/clear events. Returns an unsubscribe callback so
  // hooks (and tests) can clean up on unmount.
  subscribe(fn: MeListener): () => void {
    meListeners.add(fn);
    return () => { meListeners.delete(fn); };
  },
};

export interface ErrorEnvelope {
  error?: string;
  message?: string;
  locked_until?: string;
  retry_after_seconds?: number;
}

export class AuthError extends Error {
  code: string;
  envelope: ErrorEnvelope;
  httpStatus: number;
  constructor(code: string, envelope: ErrorEnvelope, httpStatus: number) {
    super(envelope.message || code);
    this.code = code;
    this.envelope = envelope;
    this.httpStatus = httpStatus;
  }
}

export const tokenStore = {
  save(r: LoginResponse) {
    const now = Date.now();
    safeSet(TOKEN_KEYS.access, r.access_token);
    safeSet(TOKEN_KEYS.refresh, r.refresh_token);
    safeSet(TOKEN_KEYS.accessExpiresAt, String(now + r.expires_in * 1000));
    safeSet(TOKEN_KEYS.refreshExpiresAt, String(now + r.refresh_expires_in * 1000));
  },
  clear() {
    Object.values(TOKEN_KEYS).forEach(safeRemove);
  },
  accessToken(): string | null {
    return safeGet(TOKEN_KEYS.access);
  },
  hasRefreshToken(): boolean {
    return !!safeGet(TOKEN_KEYS.refresh);
  },
  isRefreshExpired(): boolean {
    const exp = Number(safeGet(TOKEN_KEYS.refreshExpiresAt) ?? 0);
    return !exp || Date.now() >= exp;
  },
};

// ── Sign-out + scoped-cache cleanup ─────────────────────────────────────
//
// Module-scoped registry of "things that need clearing when a user signs
// out". Each module that holds tab-scoped state in sessionStorage (the JC
// list cache today; future modules will follow) registers its cleanup once
// at import time, and `signOut()` drains the registry. This keeps the auth
// module from importing `lib/jc-list-cache` (would be a cycle) while still
// giving us a single place to call from every sign-out button.
const cacheCleanups = new Set<() => void>();
// Returns an unregister callback so test or hot-reload scenarios can avoid
// leaking stale closures into the registry. Production modules typically
// call this once at import time and never need the return value.
export function registerOnSignOut(fn: () => void): () => void {
  cacheCleanups.add(fn);
  return () => { cacheCleanups.delete(fn); };
}
export function signOut(): void {
  tokenStore.clear();
  userStore.clear();
  for (const fn of cacheCleanups) {
    try { fn(); } catch { /* one cleanup failure shouldn't stop the others */ }
  }
}

function stableDeviceId(): string {
  // Best-effort browser analogue of Android's ANDROID_ID — a per-install UUID
  // persisted in localStorage. Good enough for /sessions device tagging.
  const KEY = "auth.device_id";
  let id = safeGet(KEY);
  if (!id) {
    id =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2);
    safeSet(KEY, id);
  }
  return id;
}

function deviceName(): string {
  if (typeof navigator === "undefined") return "web";
  return navigator.userAgent.slice(0, 200);
}

export function buildDeviceInfo(): DeviceInfo {
  return {
    device_id: stableDeviceId(),
    device_name: deviceName(),
    app_version: "web-0.1.0",
    platform: "web",
  };
}

async function parseEnvelope(res: Response): Promise<ErrorEnvelope> {
  try {
    return (await res.json()) as ErrorEnvelope;
  } catch {
    return { error: "unknown_error", message: `HTTP ${res.status}` };
  }
}

// W4-HIGH-2: shared error envelope reader used by any caller that wants the
// canonical {message} or {error} string out of a failed response. Reads the
// JSON body in a try; falls through to `fallback` if the body is empty or
// non-JSON. Centralised here so a `res.text()`-style probe never goes back
// onto the wire for an HTML error page (which used to be alert()-ed verbatim).
//
// Handles the three envelope shapes the server uses across modules:
//   1. RequestContextMiddleware (`{error, message, details, request_id}`)
//      — wrapping unhandled exceptions and many app-level errors.
//   2. FastAPI HTTPException(detail=str) → `{detail: "..."}`.
//   3. FastAPI HTTPException(detail={...}) → `{detail: {message, ...}}`.
// Surfacing all three means a 500 from a raw asyncpg error (envelope #1)
// and a 400 from a clean HTTPException (envelopes #2/#3) both reach the
// user as readable text rather than a generic "HTTP 500".
export async function readApiErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as {
      message?: string;
      error?: string;
      detail?: string | { message?: string; error?: string };
    } | null;
    if (data) {
      if (typeof data.detail === "string" && data.detail) return data.detail;
      if (data.detail && typeof data.detail === "object") {
        if (data.detail.message) return String(data.detail.message);
        if (data.detail.error)   return String(data.detail.error);
      }
      if (data.message) return String(data.message);
      if (data.error)   return String(data.error);
    }
  } catch {
    /* non-JSON body — fall through to fallback */
  }
  return fallback;
}

export async function login(phone: string, password: string): Promise<LoginResponse> {
  const res = await fetch(`${API_BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, password, device_info: buildDeviceInfo() }),
  });
  if (!res.ok) {
    const env = await parseEnvelope(res);
    throw new AuthError(env.error ?? "unknown_error", env, res.status);
  }
  return (await res.json()) as LoginResponse;
}

export async function fetchMe(): Promise<MeResponse> {
  const res = await apiFetch("/api/v1/auth/me");
  if (!res.ok) {
    const env = await parseEnvelope(res);
    throw new AuthError(env.error ?? "unknown_error", env, res.status);
  }
  return (await res.json()) as MeResponse;
}

// ── Silent refresh ──────────────────────────────────────────────────────
//
// Mirrors frontend_replica/src/shared/js/auth.js:authFetch — on 401, peek
// the error envelope, branch on the code, and either hard sign-out (for
// `token_reuse_detected` / `invalid_refresh_token`) or silently refresh
// the access token and retry the original request exactly once.
//
// Concurrency dedupe: when N requests 401 at the same time, only ONE
// `/auth/refresh` call fires — the rest await the same shared promise. We
// keep the resolved promise reachable for 1s after completion so straggler
// 401s arriving on the heels of the first refresh consume the cached result
// instead of triggering a second refresh (which would arm the server's
// reuse-detection if rotation already occurred).

let refreshPromise: Promise<LoginResponse> | null = null;

async function refreshTokens(): Promise<LoginResponse> {
  const refresh = safeGet(TOKEN_KEYS.refresh);
  if (!refresh) throw new Error("no_refresh_token");
  const res = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refresh }),
  });
  if (!res.ok) {
    const env = await parseEnvelope(res);
    throw new AuthError(env.error ?? "refresh_failed", env, res.status);
  }
  const next = (await res.json()) as LoginResponse;
  // Rotation: the new refresh token replaces the old one. The server may
  // also revoke the old refresh token server-side, so we must store the
  // new one before any further request fires.
  tokenStore.save(next);
  return next;
}

function _dedupedRefresh(): Promise<LoginResponse> {
  if (!refreshPromise) {
    refreshPromise = refreshTokens();
    refreshPromise.finally(() => {
      // Hold the resolved promise for ~1s so straggler 401s share it.
      const p = refreshPromise;
      setTimeout(() => { if (refreshPromise === p) refreshPromise = null; }, 1000);
    });
  }
  return refreshPromise;
}

// Authed fetch:
//   1. Attaches the current access token (if any)
//   2. On 401 + non-terminal envelope, silently refreshes and retries once
//   3. Only signs out + redirects when refresh actually fails or the
//      envelope reports a terminal code (token_reuse_detected /
//      invalid_refresh_token / refresh_token_expired)
//
// Window-level signingOut flag prevents redirect loops when multiple
// in-flight requests all fail refresh simultaneously.
let signingOut = false;

function _hardSignOutAndRedirect(): void {
  if (signingOut || typeof window === "undefined") return;
  signingOut = true;
  try {
    const dest = window.location.pathname + window.location.search;
    if (dest && dest !== "/") {
      sessionStorage.setItem("auth.redirect_after_login", dest);
    }
  } catch { /* sessionStorage disabled */ }
  signOut();
  window.location.assign("/");
}

async function _doFetch(path: string, init: RequestInit, token: string | null): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  // Default JSON for string bodies, but NEVER for FormData — the browser must
  // set multipart/form-data with its own boundary, and forcing a Content-Type
  // here would strip that boundary and break file uploads (preview/upload).
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`${API_BASE}${path}`, { ...init, headers });
}

// Terminal error codes — refresh cannot recover. Anything else means the
// access token expired or was rejected for a benign reason; we attempt the
// silent refresh path.
const TERMINAL_AUTH_ERRORS = new Set([
  "token_reuse_detected",
  "invalid_refresh_token",
  "refresh_token_expired",
]);

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const first = await _doFetch(path, init, tokenStore.accessToken());
  if (first.status !== 401) return first;
  if (signingOut) return first;

  // Peek the envelope on a clone so the caller can still consume the
  // original body if we end up returning it (we don't on the happy path,
  // but defensive cloning is cheap).
  let env: ErrorEnvelope = {};
  try { env = await first.clone().json() as ErrorEnvelope; } catch { /* non-JSON */ }

  if (env.error && TERMINAL_AUTH_ERRORS.has(env.error)) {
    _hardSignOutAndRedirect();
    return first;
  }

  // If we have no refresh token to begin with, there's nothing to recover.
  if (!safeGet(TOKEN_KEYS.refresh) || tokenStore.isRefreshExpired()) {
    _hardSignOutAndRedirect();
    return first;
  }

  // Silent refresh + retry once.
  try {
    await _dedupedRefresh();
  } catch {
    _hardSignOutAndRedirect();
    return first;
  }
  return _doFetch(path, init, tokenStore.accessToken());
}

// ── OTP-based password reset ────────────────────────────────────────────
//
// Both endpoints are unauthenticated — the user is locked out when they
// request a reset, so apiFetch (which assumes a bearer token) is the wrong
// transport. We hit them directly with `fetch` and translate the error
// envelope into AuthError for the UI.

export interface SendResetOtpResponse {
  message: string;
  expires_in_seconds: number;
}

export async function sendResetOtp(phone: string): Promise<SendResetOtpResponse> {
  const res = await fetch(`${API_BASE}/api/v1/auth/password/reset/send-otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone }),
  });
  if (!res.ok) {
    const env = await parseEnvelope(res);
    throw new AuthError(env.error ?? "unknown_error", env, res.status);
  }
  return (await res.json()) as SendResetOtpResponse;
}

export interface VerifyResetOtpResponse {
  message: string;
  revoked_count: number;
}

export async function verifyResetOtp(
  phone: string,
  otp: string,
  new_password: string,
): Promise<VerifyResetOtpResponse> {
  const res = await fetch(`${API_BASE}/api/v1/auth/password/reset/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, otp, new_password }),
  });
  if (!res.ok) {
    const env = await parseEnvelope(res);
    throw new AuthError(env.error ?? "unknown_error", env, res.status);
  }
  return (await res.json()) as VerifyResetOtpResponse;
}

// Mirrors LoginActivity.handleLoginError — keep messages generic enough that
// invalid_credentials does NOT distinguish unknown phone vs wrong password.
export function describeLoginError(err: unknown): string {
  if (!(err instanceof AuthError)) {
    return err instanceof Error ? `Connection failed: ${err.message}` : "Connection failed.";
  }
  const env = err.envelope;
  switch (err.code) {
    case "invalid_credentials":
      return "Incorrect phone number or password.";
    case "account_locked":
      return env.locked_until
        ? `Account locked until ${env.locked_until}.`
        : "Account locked. Try again later.";
    case "rate_limit_exceeded":
      return env.retry_after_seconds && env.retry_after_seconds > 0
        ? `Too many attempts. Retry in ${env.retry_after_seconds}s.`
        : "Too many attempts. Try again shortly.";
    case "account_suspended":
      return "Your account is suspended. Contact your admin.";
    case "account_disabled":
      return "Your account is disabled.";
    default:
      return env.message || `Sign-in failed (${err.code || err.httpStatus}).`;
  }
}
