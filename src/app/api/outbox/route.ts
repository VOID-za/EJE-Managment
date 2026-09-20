import { readRoute } from '@/server/api/handler';
import { getServerRuntime } from '@/server/runtime';

/**
 * The simulated outbox.
 *
 * NOTHING IS EVER SENT. Microsoft Graph and WhatsApp Business are later phases;
 * until then every message the application "sends" is recorded here instead, so
 * a demonstration can show exactly what would have gone out and to whom.
 *
 * It is served to signed-in users only, because it contains customers' email
 * addresses and the contents of their job cards.
 */
export const GET = readRoute('outbox', async () => {
  const entries = await getServerRuntime().outbox.list();
  return { entries };
});
