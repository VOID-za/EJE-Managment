import { loadCompletedFormPdf } from '@/application/payroll-completions';
import { downloadRoute } from '@/server/api/handler';

/**
 * A COMPLETED FORM'S PDF (FORM-LIFECYCLE-1), exactly as it was stored when it
 * was completed, under the name it was completed with. Preview, Print,
 * Download and Save PDF on My Monthly Forms all read this — never a live
 * working copy. The person's own, or the office's. Writes nothing.
 */
export const GET = downloadRoute('payroll.completion.pdf', async (context) => {
  const stored = await loadCompletedFormPdf(
    { repos: context.repos, services: context.services, actor: context.actor.user },
    context.params.completionId ?? '',
  );
  return { fileName: stored.fileName, contentType: 'application/pdf', body: stored.bytes };
});
