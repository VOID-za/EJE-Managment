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
const nextConfig: NextConfig = {
  reactStrictMode: true,
  env: {
    EJE_BUILD_COMMIT: buildCommit(),
    EJE_BUILD_TIME: new Date().toISOString(),
  },
};

export default nextConfig;
