import { loadMyCompletedForms } from '@/application/payroll-completions';
import { readRoute } from '@/server/api/handler';

/**
 * `GET /api/payroll/forms/:userId/completed` — FORM-LIFECYCLE-1: the forms
 * completed and awaiting Submit to Office, and whether (and why not) both may
 * be submitted now. The person's own, or the office's to read.
 */
export const GET = readRoute('payroll.forms.completed', (context) =>
  loadMyCompletedForms({ repos: context.repos, services: context.services, actor: context.actor.user }, context.params.userId ?? ''),
);
