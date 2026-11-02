import 'server-only';
import { getServerRuntime } from '@/server/runtime';
import { drainOutboxQuietly } from '@/server/api/outbox-dispatch';
import { drainIntegrationsQuietly } from '@/server/api/integration-dispatch';
import { recordIntegrationConfiguration } from '@/server/integration-status';
import { readWhatsAppActivation } from '@/server/whatsapp-activation';
import { selectPersistenceBackend } from '@/data/backend';
import { runRetention } from '@/application/retention';

/**
 * THE BACKGROUND WORKER. INT-EMAIL-3, INT-WA-2, INT-MAP-1.
 *
 * Every minute: the customer email outbox, the WhatsApp outbox and the site
 * pins — the work an API mutation drains straight away, done again for
 * whatever is due later (a retry after a back-off) and for whatever was left
 * when the process stopped. Started once per process from `instrumentation.ts`.
 *
 * Nothing here sends what the stores do not say is due, so a restart never
 * repeats a send: an email interrupted mid-send is marked uncertain, not
 * re-sent (see `customer-email.ts`).
 */

const INTERVAL_MS = 60_000;
const KEY = Symbol.for('eje.integration.worker');

type Holder = { [KEY]?: ReturnType<typeof setInterval> };

let running = false;

const tick = async (): Promise<void> => {
  if (running) return; // never two ticks at once
  running = true;
  try {
    const runtime = getServerRuntime();
    // Whether the dedicated WhatsApp number has passed its real test (for `configured`).
    if (selectPersistenceBackend() !== 'demo') await readWhatsAppActivation(runtime).catch(() => undefined);
    await drainOutboxQuietly(runtime);
    await drainIntegrationsQuietly(runtime);
    // RETAIN-1/2: notifications after 15 days, activity after 7 — each purge only when it is due.
    await runtime
      .write((unit) => runRetention(unit.repos, unit.services.clock.now()))
      .catch((cause: unknown) => console.error('[worker] retention failed', cause instanceof Error ? cause.message : cause));
  } catch (cause) {
    console.error('[worker] integration tick failed', cause instanceof Error ? cause.message : cause);
  } finally {
    running = false;
  }
};

export const startIntegrationWorker = (): void => {
  const holder = globalThis as Holder;
  if (holder[KEY] !== undefined) return;
  if (process.env.EJE_INTEGRATION_WORKER === 'off') {
    console.log('[worker] integration worker disabled (EJE_INTEGRATION_WORKER=off)');
    return;
  }
  holder[KEY] = setInterval(() => void tick(), INTERVAL_MS);
  // Do not keep a process alive that is otherwise finished (tests, scripts).
  holder[KEY].unref?.();
  // A first pass shortly after start: whatever was queued before a restart.
  setTimeout(() => {
    void recordIntegrationConfiguration().catch((cause: unknown) =>
      console.error('[worker] could not record the integration configuration', cause instanceof Error ? cause.message : cause),
    );
    void tick();
  }, 5_000).unref?.();
  console.log('[worker] integration worker started (every 60 s)');
};
