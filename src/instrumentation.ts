/**
 * Runs once when a Next.js server starts (Next.js "instrumentation"). Starts
 * the integrations' background worker — customer emails, WhatsApp, site pins —
 * on the Node.js runtime only. See `server/integration-worker.ts`.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startIntegrationWorker } = await import('./server/integration-worker');
    startIntegrationWorker();
  }
}
