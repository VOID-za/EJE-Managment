import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Tests that drive a real browser live in `*.browser.test.ts` and run under
    // `npm run pdf-pixels`, alongside the other browser checks, so `npm test`
    // needs nothing installed beyond the project itself.
    exclude: ['**/node_modules/**', 'src/**/*.browser.test.ts'],
  },
});
