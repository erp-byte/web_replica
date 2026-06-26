This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Environment variables

The app reads a single client-side env var:

| Variable | Purpose | Example |
|---|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | Origin of the FastAPI backend. Leave empty when backend is same-origin. | `https://api.candorfoods.in` |

For local dev, copy `.env.example` to `.env.local` and edit:

```bash
cp .env.example .env.local
```

## Deploy on Netlify

The repo ships a `netlify.toml` that pins the build command, Node version, and security headers. To deploy:

1. **Create a new Netlify site** from this repo (`web_replica` subdirectory). Netlify auto-detects Next.js 16 and applies the Next.js Runtime — no manual plugin selection.
2. **Set environment variables** in Site Configuration → Environment variables:
   - `NEXT_PUBLIC_API_BASE_URL` = your backend URL (the same value you'd put in `.env.local`)
3. **Trigger deploy.** Netlify runs `npm run build` from the repo root context with `NODE_VERSION=20`.

The Next.js Runtime maps dynamic routes (`/modules/job-card/[id]`, `/modules/admin/users/[userId]`, `/modules/production/plan-list/[planId]`, `/modules/production/so-creation/manual-update/[soId]`) to Netlify Functions automatically. Static routes are prerendered at build time.

### Security headers

`netlify.toml` adds:
- `X-Frame-Options: DENY` (clickjacking)
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy` with camera/mic/geo/payment/usb denied
- `Strict-Transport-Security` with a 1-year max-age + subdomains

No CSP is set — Next.js inlines hydration scripts and a tightly-tuned CSP would need per-route nonces. Add a `Content-Security-Policy` header here once the app stops inlining (or wire up nonces).
