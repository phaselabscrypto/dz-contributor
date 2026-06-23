import type { NextConfig } from "next";

/**
 * Build a Content-Security-Policy string.
 *
 * Production policy is intentionally tight: the app only fetches from
 * its own `/api/*` routes (which proxy external services server-side),
 * loads self-hosted Google Fonts via `next/font/google`, and renders
 * images from itself + data URIs. Nothing else is needed.
 *
 * In non-production builds, we relax `script-src` and `connect-src` so
 * Vercel preview comments + dev hot-reload (websocket) keep working.
 */
function buildCsp(isProduction: boolean): string {
  // Preview comment overlay + Pusher (websocket) for Vercel non-prod.
  const previewScript = isProduction
    ? ""
    : " https://vercel.live https://*.pusher.com";
  const previewConnect = isProduction
    ? ""
    : " https://vercel.live https://*.pusher.com wss://*.pusher.com";

  // `'unsafe-eval'` is needed by dev tooling (React Fast Refresh / the dev
  // bundler) but NOT by the production bundle — drop it in prod to harden
  // against eval-based XSS. (`'unsafe-inline'` stays: Next still emits inline
  // hydration scripts; a nonce-based policy is the follow-up.)
  const devEval = isProduction ? "" : " 'unsafe-eval'";

  const directives: Record<string, string> = {
    "default-src": "'self'",
    // Next.js still emits some inline scripts (hydration glue, route
    // tree). Tracking a stricter nonce-based policy is a follow-up.
    "script-src": `'self' 'unsafe-inline'${devEval}${previewScript}`,
    // Tailwind v4 + radix injects inline <style> blocks.
    "style-src": "'self' 'unsafe-inline'",
    "img-src": "'self' data: blob:",
    "font-src": "'self' data:",
    "connect-src": `'self'${previewConnect}`,
    "frame-ancestors": "'none'",
    "base-uri": "'self'",
    "form-action": "'self'",
    "object-src": "'none'",
    "upgrade-insecure-requests": "",
  };

  return Object.entries(directives)
    .map(([k, v]) => (v ? `${k} ${v}` : k))
    .join("; ");
}

const isProduction = process.env.NODE_ENV === "production";

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: buildCsp(isProduction),
  },
  {
    // Belt-and-suspenders alongside CSP's frame-ancestors — older
    // browsers ignore frame-ancestors but honour X-Frame-Options.
    key: "X-Frame-Options",
    value: "DENY",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    // We don't use any of these device APIs. Lock them off.
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
  {
    // 2 years, includeSubDomains, preload-eligible. Vercel terminates
    // TLS at the edge so this is safe.
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
];

const nextConfig: NextConfig = {
  // Suppress the X-Powered-By: Next.js fingerprint — small info-leak win.
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
