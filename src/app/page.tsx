"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { BrandMark } from "@/components/BrandMark";
import { useRouter } from "next/navigation";
import {
  AuthError,
  describeLoginError,
  fetchMe,
  login,
  tokenStore,
  userStore,
} from "@/lib/auth";
import { takeRedirectAfterLogin } from "@/lib/user";

type Banner = { kind: "error" | "info"; text: string } | null;

export default function LoginPage() {
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner>(null);
  const [loading, setLoading] = useState(false);
  const [hydrating, setHydrating] = useState(true);

  const routeAfterMe = useCallback(
    (me: Awaited<ReturnType<typeof fetchMe>>) => {
      if (me.status && me.status !== "active") {
        tokenStore.clear();
        userStore.clear();
        setBanner({
          kind: "error",
          text: `Your account is ${me.status}. Contact your admin.`,
        });
        return;
      }
      // Save first either way — the change-password page reads me from
      // localStorage to gate itself, so we need it on disk before we route.
      userStore.save(me);
      if (me.must_change_password) {
        // Force-change-password gate. We do NOT consume any stashed
        // redirect target here — the user has to set a new password first;
        // the post-change flow signs them out and the next login picks up
        // the redirect normally.
        router.replace("/change-password");
        return;
      }
      // If apiFetch's 401 handler (or useRequireAuth's redirect) stashed
      // the path the user came from, bounce them straight back; otherwise
      // land on the modules grid.
      const dest = takeRedirectAfterLogin() ?? "/modules";
      router.replace(dest);
    },
    [router],
  );

  // Cold-start hydration: matches LoginActivity.onCreate — if a non-expired
  // refresh token survives in storage, try /me to see if the session is still
  // good. On any failure, fall back to the form silently.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (
        typeof window !== "undefined" &&
        tokenStore.hasRefreshToken() &&
        !tokenStore.isRefreshExpired()
      ) {
        try {
          const me = await fetchMe();
          if (!cancelled) routeAfterMe(me);
        } catch {
          tokenStore.clear();
        }
      }
      if (!cancelled) setHydrating(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [routeAfterMe]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBanner(null);
    setPhoneError(null);
    setPasswordError(null);

    const trimmedPhone = phone.trim();
    if (!trimmedPhone) {
      setPhoneError("Enter your phone number");
      return;
    }
    if (!password) {
      setPasswordError("Enter your password");
      return;
    }

    setLoading(true);
    try {
      const r = await login(trimmedPhone, password);
      tokenStore.save(r);
      try {
        const me = await fetchMe();
        routeAfterMe(me);
      } catch (meErr) {
        tokenStore.clear();
        userStore.clear();
        // The login itself succeeded — this is a /me failure (network,
        // server error, etc.). describeLoginError is keyed to login codes
        // (invalid_credentials, account_locked, …) so using it here would
        // surface confusing "Incorrect phone number or password" text
        // after the password actually worked. Show a flat message instead.
        setBanner({
          kind: "error",
          text:
            meErr instanceof AuthError && meErr.envelope.message
              ? meErr.envelope.message
              : "Signed in, but couldn't load your profile. Please try again.",
        });
      }
    } catch (err) {
      setBanner({ kind: "error", text: describeLoginError(err) });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-6">
        <BrandMark />
      </header>

      <main className="flex-1 flex justify-center pt-10 pb-16 px-4">
        <div className="w-full max-w-[420px]">
          <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.3)] px-7 pt-7 pb-6">
            <h1 className="text-[28px] leading-[34px] font-semibold text-[var(--text-primary)] mb-5">
              Sign in
            </h1>

            {hydrating ? (
              <div className="flex items-center gap-3 py-4 text-sm text-[var(--text-secondary)]">
                <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
                Restoring session…
              </div>
            ) : (
              <form onSubmit={onSubmit} noValidate>
                {banner && (
                  <div
                    role={banner.kind === "error" ? "alert" : "status"}
                    className={
                      banner.kind === "error"
                        ? "mb-4 border-l-4 border-[var(--aws-error)] bg-[#fdf3f1] text-[var(--text-primary)] text-[13px] px-3 py-2 rounded-sm"
                        : "mb-4 border-l-4 border-[var(--aws-link)] bg-[#f1faff] text-[var(--text-primary)] text-[13px] px-3 py-2 rounded-sm"
                    }
                  >
                    {banner.text}
                  </div>
                )}

                <Field
                  id="phone"
                  label="Phone number"
                  type="tel"
                  autoComplete="tel"
                  value={phone}
                  onChange={(v) => {
                    setPhone(v);
                    if (phoneError) setPhoneError(null);
                  }}
                  error={phoneError}
                  disabled={loading}
                  autoFocus
                  inputMode="tel"
                />

                <Field
                  id="password"
                  label="Password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(v) => {
                    setPassword(v);
                    if (passwordError) setPasswordError(null);
                  }}
                  error={passwordError}
                  disabled={loading}
                />

                <button
                  type="submit"
                  disabled={loading}
                  className={[
                    "w-full mt-1 h-9 rounded-[2px] text-[14px] font-semibold",
                    "text-white border",
                    "shadow-[inset_0_-1px_0_rgba(0,0,0,0.18)]",
                    "transition-colors",
                    loading
                      ? "bg-[#c98f92] border-[#c98f92] cursor-not-allowed"
                      : "bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] active:bg-[var(--aws-orange-active)]",
                  ].join(" ")}
                >
                  {loading ? "Signing in…" : "Sign in"}
                </button>
              </form>
            )}
          </div>

          <p className="mt-4 text-[12px] leading-[18px] text-[var(--text-secondary)] text-center">
            By continuing, you agree to the{" "}
            <a
              href="#"
              className="text-[var(--aws-link)] hover:underline hover:text-[var(--aws-link-hover)]"
            >
              Terms of Use
            </a>
            .
          </p>
          <p className="mt-2 text-[12px] leading-[18px] text-[var(--text-secondary)] text-center">
            Forgot your password?{" "}
            <button
              type="button"
              onClick={() => router.push("/forgot-password")}
              className="text-[var(--aws-link)] hover:underline hover:text-[var(--aws-link-hover)]"
            >
              Reset it via WhatsApp OTP
            </button>
          </p>
        </div>
      </main>

      <footer className="border-t border-[var(--aws-border)] bg-white py-3 px-6 text-[11px] text-[var(--text-secondary)] flex flex-wrap justify-center gap-x-4 gap-y-1">
        {/* Terms link already appears in the card area above; the footer
            only carries Privacy + copyright so we don't repeat it. */}
        <a href="#" className="hover:underline">
          Privacy
        </a>
        <span>© {new Date().getFullYear()}</span>
      </footer>
    </div>
  );
}

function Field({
  id,
  label,
  type,
  value,
  onChange,
  error,
  disabled,
  autoComplete,
  autoFocus,
  inputMode,
}: {
  id: string;
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  error: string | null;
  disabled?: boolean;
  autoComplete?: string;
  autoFocus?: boolean;
  inputMode?: "tel" | "text" | "numeric" | "email";
}) {
  // Show/hide toggle for password fields. The eye button sits inside
  // the input border so the field shape stays consistent across
  // text/tel/password types. Flips input.type between "password" and
  // "text" — browsers handle the autocomplete + masking transition
  // natively without breaking the saved-password popup.
  const [showPassword, setShowPassword] = useState(false);
  const isPassword = type === "password";
  const effectiveType = isPassword && showPassword ? "text" : type;
  return (
    <div className="mb-4">
      <label
        htmlFor={id}
        className="block text-[13px] font-bold text-[var(--text-primary)] mb-1"
      >
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          name={id}
          type={effectiveType}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          inputMode={inputMode}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
          className={[
            "w-full h-9 px-2 text-[14px] rounded-[2px] bg-white",
            "border outline-none transition-shadow",
            isPassword ? "pr-10" : "",
            error
              ? "border-[var(--aws-error)] shadow-[0_0_0_1px_var(--aws-error)]"
              : "border-[var(--aws-border-strong)] focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]",
            "disabled:bg-[#f4f4f4] disabled:text-[#879596]",
          ].join(" ")}
        />
        {isPassword ? (
          <button
            type="button"
            onClick={() => setShowPassword((s) => !s)}
            disabled={disabled}
            aria-label={showPassword ? "Hide password" : "Show password"}
            aria-pressed={showPassword}
            title={showPassword ? "Hide password" : "Show password"}
            className="absolute inset-y-0 right-0 px-2.5 inline-flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {showPassword ? (
              // Eye-off (hide)
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-10-8-10-8a18.45 18.45 0 0 1 5.06-5.94" />
                <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19" />
                <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                <line x1="1" y1="1" x2="23" y2="23" />
              </svg>
            ) : (
              // Eye (show)
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            )}
          </button>
        ) : null}
      </div>
      {error && (
        <p
          id={`${id}-error`}
          className="mt-1 text-[12px] text-[var(--aws-error)]"
        >
          {error}
        </p>
      )}
    </div>
  );
}
