import { execSync } from 'node:child_process';
import type { NextConfig } from 'next';

/**
 * The commit this build was made from.
 *
 * Stamped in at build time and shown on the Administration → System screen, so
 * a running application can always state which build is being served. A live
 * demonstration hit two "missing route" failures that turned out to be a stale
 * server answering on the port; without a build stamp there is no way to tell
 * that apart from a genuine code fault.
 *
 * Wrapped because a deployment from a tarball or a Docker layer may have no
 * git directory — an unknown build is reported honestly rather than crashing
 * the build.
 */
const buildCommit = (): string => {
  if (typeof process.env.EJE_BUILD_COMMIT === 'string' && process.env.EJE_BUILD_COMMIT.length > 0) {
    return process.env.EJE_BUILD_COMMIT;
  }
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
};

/**
 * Demo-stage Next.js configuration.
 *
 * Lint and type checking run as their own pipeline steps (`npm run lint`,
 * `npm run typecheck`) rather than being folded into the build.
 *
 * Phase 2 additions expected here: PWA/service-worker registration, image
 * remote patterns for object storage, and security headers behind Caddy.
 */
/**
 * Security headers.
 *
 * Applied to every response, including the API. Each one is here because it
 * closes something specific, and nothing here breaks the parts of the
 * application that need real browser capabilities — the signature pad, the
 * camera, the PDF preview and the document download.
 *
 * WHAT IS DELIBERATELY NOT HERE: a Content-Security-Policy with a nonce.
 * Next.js inlines its own bootstrap and the Tailwind build emits inline styles,
 * so a strict policy needs nonce plumbing through the document and every
 * inline. That is worth doing, and it is worth doing properly rather than
 * shipping `unsafe-inline` and calling it a policy — which would forbid nothing
 * an injected script wants to do. The headers below are the ones that work
 * today; the CSP is recorded as outstanding in `docs/security.md`.
 */
const SECURITY_HEADERS = [
  // Stops a browser guessing that a JSON response is really a script.
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Nothing in this application is meant to be framed, and a job card inside
  // somebody else's page is a clickjacking target.
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  // A job URL carries a job number. It does not travel to another origin.
  { key: 'Referrer-Policy', value: 'same-origin' },
  /*
   * The camera stays allowed for this origin — a technician photographs the
   * machine — and everything else a page could ask for is refused.
   */
  {
    key: 'Permissions-Policy',
    value: 'camera=(self), microphone=(), geolocation=(self), payment=(), usb=()',
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /*
   * `X-Powered-By: Next.js` says which framework and, by implication, which
   * class of advisory to try first. It buys nobody anything.
   */
  poweredByHeader: false,
  env: {
    EJE_BUILD_COMMIT: buildCommit(),
    EJE_BUILD_TIME: new Date().toISOString(),
  },
  headers: () =>
    Promise.resolve([
      { source: '/:path*', headers: SECURITY_HEADERS },
      {
        // The API is never cached: every response is scoped to one session.
        source: '/api/:path*',
        headers: [
          ...SECURITY_HEADERS,
          { key: 'Cache-Control', value: 'no-store' },
          { key: 'Vary', value: 'Cookie' },
        ],
      },
    ]),
};

export default nextConfig;
