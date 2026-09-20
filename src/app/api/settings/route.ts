import { writeRoute } from '@/server/api/handler';
import { runUpdateSettings, settingsSchema } from '@/server/api/commands/office';

/**
 * Charge-out rates, VAT and the company details. Masters only.
 *
 * `updateSettings` enforces that; changing a rate does not re-price a job the
 * customer has already signed, because the price was frozen onto it.
 */
export const PATCH = writeRoute({
  operation: 'settings.update',
  schema: settingsSchema,
  handler: (context) =>
    runUpdateSettings(
      {
        repos: context.repos,
        services: context.services,
        actor: context.actor.user,
        operation: context.operation,
      },
      context.input,
    ),
});
