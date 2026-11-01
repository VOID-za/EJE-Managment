import { z } from 'zod';
import { readRoute, writeRoute } from '@/server/api/handler';
import {
  createEmailTemplate,
  listEmailTemplates,
  previewEmailTemplate,
  restoreSystemEmailTemplate,
} from '@/application/email-templates';
import { EMAIL_EVENTS, EMAIL_PLACEHOLDERS } from '@/domain';

/**
 * Administration → Email templates. INT-EMAIL-1. The Master and the
 * Coordinator alike (`emailTemplates.manage`), enforced by the operations.
 *
 * GET lists every template with its current version, which job types have a
 * default (and so are emailed), the events and the placeholders.
 * POST creates a template (inactive), previews one, or restores a default.
 */
export const GET = readRoute('emailTemplates.list', async (context) => {
  const operation = { repos: context.repos, services: context.services, actor: context.actor.user };
  const listed = await listEmailTemplates(operation);
  return { ...listed, events: EMAIL_EVENTS, placeholders: EMAIL_PLACEHOLDERS };
});

const text = (max: number) => z.string().max(max);

const schema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('create'),
      event: text(60),
      jobType: text(60),
      name: text(200),
      description: text(600),
      subject: text(400),
      body: text(25_000),
    })
    .strict(),
  z.object({ op: z.literal('preview'), name: text(200), subject: text(400), body: text(25_000) }).strict(),
  z.object({ op: z.literal('restore'), event: text(60), jobType: text(60) }).strict(),
]);

export const POST = writeRoute({
  operation: 'emailTemplates.write',
  schema,
  handler: async (context) => {
    const input = context.input;
    switch (input.op) {
      case 'create':
        return createEmailTemplate(context.operation, input);
      case 'preview':
        return previewEmailTemplate(context.operation, input);
      case 'restore':
        return restoreSystemEmailTemplate(context.operation, input);
    }
  },
});
