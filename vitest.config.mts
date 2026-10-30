import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // `server-only` throws unless React's `react-server` condition is set.
      // The build still resolves the real package; the runner gets a no-op.
      'server-only': fileURLToPath(new URL('./src/test/server-only.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Tests that drive a real browser live in `*.browser.test.ts` and run under
    // `npm run pdf-pixels`; tests that need a real PostgreSQL live in
    // `*.db.test.ts` and run under `npm run db:test`. Both are excluded here so
    // `npm test` needs nothing installed beyond the project itself.
    exclude: ['**/node_modules/**', 'src/**/*.browser.test.ts', 'src/**/*.db.test.ts'],
    /*
     * 15 s, not Vitest's 5 s. The API suites build the whole application per
     * test; with every core busy (the suite in parallel, or a browser suite
     * running beside it) eleven healthy tests crossed 5 s on 29 October 2026
     * and passed alone, 96 of 96. A real hang still fails, three times later.
     */
    testTimeout: 15_000,
  },
});
