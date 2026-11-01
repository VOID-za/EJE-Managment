import { readRoute } from '@/server/api/handler';
import { listJobEmails } from '@/application/customer-email';
import { listJobWhatsAppMessages } from '@/application/whatsapp-messages';
import { loadVisibleJob } from '@/server/api/commands/jobs';

/**
 * A job's email history and WhatsApp messages. INT-EMAIL-4, INT-WA-2. For the
 * office (`jobs.officeHandling`), enforced by the operations; the job itself
 * must be visible to the actor first, as for every job read.
 */
export const GET = readRoute('jobs.emails', async (context) => {
  const operation = { repos: context.repos, services: context.services, actor: context.actor.user };
  const job = await loadVisibleJob(
    { repos: context.repos, services: context.services, actor: context.actor.user, operation },
    context.params.jobId ?? '',
  );
  const [emails, whatsapp] = await Promise.all([listJobEmails(operation, job), listJobWhatsAppMessages(operation, job.id)]);
  return { emails, whatsapp };
});
