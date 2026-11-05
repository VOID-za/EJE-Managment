import { z } from 'zod';
import { loadSubmittedPayrollDocument } from '@/application/payroll-forms';
import { downloadRoute, parseWith } from '@/server/api/handler';

/**
 * A SUBMITTED FORM, EXACTLY AS IT WENT (PAYROLL-ONE-1): the PDF stored when it
 * was submitted, under the name it was submitted with, its checksum verified.
 * The person's own, or the office's. Writes nothing.
 */
export const GET = downloadRoute('payroll.submission.pdf', async (context) => {
  const stored = await loadSubmittedPayrollDocument(
    { repos: context.repos, services: context.services, actor: context.actor.user },
    context.params.submissionId ?? '',
    parseWith(z.enum(['timesheet', 'attendance']), context.params.kind ?? ''),
  );
  return {
    fileName: stored.fileName,
    contentType: 'application/pdf',
    body: stored.bytes,
    headers: { 'X-Page-Count': String(stored.pageCount), 'X-Content-SHA256': stored.sha256 },
  };
});
