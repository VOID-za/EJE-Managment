import { can } from '@/domain';
import { forbidden } from '@/server/api/errors';
import { readRoute } from '@/server/api/handler';
import { getServerRuntime } from '@/server/runtime';

/**
 * The simulated outbox.
 *
 * NOTHING IS EVER SENT. Microsoft Graph and WhatsApp Business are later phases;
 * until then every message the application "sends" is recorded here instead, so
 * a demonstration can show exactly what would have gone out and to whom.
 *
 * THE OFFICE ONLY. MASTER SCOPE §17 (authorized file/communication access).
 *
 * Every row carries a customer's email address or telephone number and a
 * preview of what EJE said to them, for EVERY job — so serving it to any
 * signed-in user hands a technician the correspondence on jobs DECISION 5 says
 * they may not even see. It was authenticated-only, which the audit against
 * `95e9848` measured as a 200 for a technician; it happened to be empty in the
 * demo seed, which is luck rather than a control.
 *
 * `jobs.viewAll` rather than a new capability: "may this person see every job"
 * is exactly the question being asked, and it is already answered once.
 */
export const GET = readRoute('outbox', async (context) => {
  if (!can(context.actor.user.role, 'jobs.viewAll')) {
    throw forbidden('The outbox is an office screen.', [
      {
        code: 'not_permitted',
        message: 'Your role does not have access to customer correspondence.',
      },
    ]);
  }
  const entries = await getServerRuntime().outbox.list();
  return { entries };
});
