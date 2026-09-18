import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Browser-dependent tests.
 *
 * These render a PDF through a real PDF engine and count the pixels, which is
 * the only way to prove the customer's signature is actually visible in the
 * file that gets downloaded. They need a Chromium install, so they are kept
 * out of `npm test` and run by `npm run pdf-pixels` with the other browser
 * checks.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.browser.test.ts'],
    // A PDF render plus a pixel scan is seconds, not milliseconds.
    testTimeout: 180000,
    hookTimeout: 60000,
  },
});
