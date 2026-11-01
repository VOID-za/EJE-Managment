import { z } from 'zod';
import { readRoute, writeRoute } from '@/server/api/handler';
import {
  activateEmailTemplate,
  deactivateEmailTemplate,
  getEmailTemplate,
  saveEmailTemplateVersion,
} from '@/application/email-templates';

/**
 * One email template. INT-EMAIL-1. GET: it, with every version. PATCH: save
 * the editor as the next version (refused when somebody saved since it was
 * opened). POST: activate, make default, deactivate.
 */
export const GET = readRoute('emailTemplates.get', (context) =>
  getEmailTemplate(
    { repos: context.repos, services: context.services, actor: context.actor.user },
    context.params.templateId ?? '',
  ),
);

export const PATCH = writeRoute({
  operation: 'emailTemplates.save',
  schema: z
    .object({
      name: z.string().max(200),
      description: z.string().max(600),
      subject: z.string().max(400),
      body: z.string().max(25_000),
      changeNote: z.string().max(400),
      expectedVersion: z.number().int().min(1),
    })
    .strict(),
  handler: (context) => saveEmailTemplateVersion(context.operation, context.params.templateId ?? '', context.input),
});

export const POST = writeRoute({
  operation: 'emailTemplates.state',
  schema: z.object({ op: z.enum(['activate', 'make_default', 'deactivate']) }).strict(),
  handler: (context) => {
    const id = context.params.templateId ?? '';
    return context.input.op === 'deactivate'
      ? deactivateEmailTemplate(context.operation, id)
      : activateEmailTemplate(context.operation, id, { makeDefault: context.input.op === 'make_default' });
  },
});
