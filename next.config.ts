import type { NextConfig } from 'next';

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
};

export default nextConfig;
