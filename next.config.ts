import type { NextConfig } from "next";

// Kept minimal on purpose. The Netlify Next.js Runtime auto-discovers the
// app and handles SSR / image optimization / function bundling out of the
// box — we don't need `output: "standalone"` for Netlify deploys.
//
// Add `images.remotePatterns` here ONLY if a future change starts pulling
// images via next/image from a remote origin. The current app uses only
// /public assets and SVG-inlined icons.
// Backend origin for the server-side API proxy (see `rewrites` below).
// Kept as a NON-public env var so it is NOT baked into the client bundle —
// the browser only ever sees same-origin `/api/...` HTTPS URLs. Falls back to
// the known prod backend so a missing Netlify env var can't silently break
// the proxy. Plain HTTP here is fine: this hop is server→server (Netlify edge
// → EC2), never browser→HTTP, so there is no mixed-content exposure.
const API_PROXY_TARGET =
  process.env.API_PROXY_TARGET ?? "http://65.0.86.156";

const nextConfig: NextConfig = {
  // reactStrictMode defaults to `true` in App Router for Next.js 13+, so
  // we don't set it explicitly. If we ever add Pages Router routes we'll
  // need to add `reactStrictMode: true` to keep the strict checks on.

  // Same-origin API proxy. The web app calls `/api/v1/...` (relative, so
  // same HTTPS origin as the page — no mixed-content block); Next forwards
  // it to the FastAPI backend server-side. Requires the client to use a
  // relative API base, i.e. NEXT_PUBLIC_API_BASE_URL="" in the Netlify
  // environment. WebSocket (`/ws`) is intentionally NOT proxied here — Next
  // rewrites don't carry the Upgrade handshake; the desktop app talks to the
  // backend directly for realtime.
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${API_PROXY_TARGET}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
