import { can, type SystemSettings } from '@/domain';
import type { OperationContext } from './context';
import { audit, changesBetween } from './audit';
import { WorkflowError } from './errors';

/**
 * System settings: charge-out rates, travel, call-out and VAT.
 *
 * These are the commercial terms EJE trades on, so they belong to a Master and
 * to nobody else — a Coordinator runs the office but does not set the prices.
 * The check lives here, in the operation, rather than in the screen that calls
 * it: a hidden tab is not authorisation, and the repository has no opinion
 * about who is writing to it.
 */
export const updateSettings = async (
  context: OperationContext,
  settings: SystemSettings,
): Promise<SystemSettings> => {
  if (!can(context.actor.role, 'settings.manage')) {
    throw new WorkflowError('Only a Master can change the charge-out rates.', [
      {
        code: 'not_permitted',
        message:
          'Rates, travel, call-out and VAT are commercial terms and are set by a Master.',
      },
    ]);
  }

  const previous = await context.repos.settings.get();
  const saved = await context.repos.settings.save(settings);

  const changes: string[] = [];
  if (previous.labourRates.normal !== saved.labourRates.normal) changes.push('normal labour');
  if (previous.labourRates.overtime !== saved.labourRates.overtime) changes.push('overtime');
  if (previous.labourRates.double !== saved.labourRates.double) changes.push('double time');
  if (previous.calloutRate !== saved.calloutRate) changes.push('call-out');
  if (previous.kilometreRate !== saved.kilometreRate) changes.push('travel');
  if (previous.vatPercentage !== saved.vatPercentage) changes.push('VAT');

  await audit(context, {
    jobId: null,
    type: 'settings_updated',
    summary: 'Charge-out rates updated',
    detail:
      changes.length === 0
        ? 'Saved with no change to any rate.'
        : `Changed: ${changes.join(', ')}. Jobs already signed keep the rates they were signed at.`,
    /*
     * THE RATES THEMSELVES, not only their names. AUDIT-2.
     *
     * The sentence above has always said WHICH rates moved. It has never said
     * what they moved from, so the only record of yesterday's charge-out rate
     * was whatever job happened to be signed at it. These are the commercial
     * terms EJE trades on; what they used to be is worth keeping.
     */
    changes: changesBetween(
      'rates',
      {
        labourNormal: previous.labourRates.normal,
        labourOvertime: previous.labourRates.overtime,
        labourDouble: previous.labourRates.double,
        callout: previous.calloutRate,
        kilometre: previous.kilometreRate,
        vatPercentage: previous.vatPercentage,
      },
      {
        labourNormal: saved.labourRates.normal,
        labourOvertime: saved.labourRates.overtime,
        labourDouble: saved.labourRates.double,
        callout: saved.calloutRate,
        kilometre: saved.kilometreRate,
        vatPercentage: saved.vatPercentage,
      },
    ),
  });
  return saved;
};
