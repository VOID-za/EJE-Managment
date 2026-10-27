import type { OfflineAction } from './offline-rules';

/**
 * CAPTURING ON A JOB OPENED WITH NO SIGNAL. OFF-2, completed 27 October 2026.
 *
 * OFF-2 was partial for one reason: a technician could hold labour, travel, a
 * part or a note only from a job screen they already had open, because the job
 * page itself is never cached. Since OFF-DETAIL-1 the offline page shows the
 * technician's own job from the tablet's copy; this is what lets them capture
 * against it from there.
 *
 * WHAT THIS FILE IS: the four forms' rules, as pure functions — the same limits
 * the server's command schemas apply (`commands/jobs.ts`: hours 0–24,
 * kilometres 0–10 000, a whole quantity 1–10 000, a price in whole cents, a
 * note of at most 4 000 characters), so a capture that would be refused for
 * its shape on arrival is never held. Whether it may be applied at all is still
 * the server's decision on the replay, exactly as for a capture made on the
 * job screen.
 *
 * NO NEW IDENTIFIER IS KEPT. The capture names the job by its NUMBER, which
 * the tablet's copy already holds and every job command accepts as its target
 * (`loadVisibleJob`). The cached copy deliberately keeps no internal id
 * (`cached-job.ts`), and this does not change that.
 */

export type OfflineCaptureKind = 'labour' | 'travel' | 'part' | 'note';

export interface OfflineCaptureFields {
  readonly date: string;
  readonly hours: string;
  readonly rateType: string;
  readonly kilometres: string;
  readonly partNumber: string;
  readonly description: string;
  /** Rands, as typed. Converted to whole cents for the server. */
  readonly unitPrice: string;
  readonly quantity: string;
  readonly body: string;
  readonly internal: boolean;
}

export type OfflineCaptureBuild =
  | {
      readonly ok: true;
      readonly action: OfflineAction;
      readonly payload: Readonly<Record<string, unknown>>;
      readonly summary: string;
    }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RATE_LABEL: Readonly<Record<string, string>> = {
  normal: 'normal',
  overtime: 'overtime',
  double: 'double time',
};

const number = (value: string): number => Number.parseFloat(value.replace(',', '.'));

/** The four captures, validated and shaped exactly as the API takes them. */
export const buildOfflineCapture = (
  kind: OfflineCaptureKind,
  fields: OfflineCaptureFields,
): OfflineCaptureBuild => {
  const errors: Record<string, string> = {};
  const description = fields.description.trim();
  if (description.length > 500) errors.description = 'Keep the description under 500 characters.';

  if (kind === 'labour') {
    const hours = number(fields.hours);
    if (!ISO_DATE.test(fields.date)) errors.date = 'Choose the day the work was done.';
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24) errors.hours = 'Enter the hours, more than 0 and at most 24.';
    if (RATE_LABEL[fields.rateType] === undefined) errors.rateType = 'Choose the rate.';
    if (Object.keys(errors).length > 0) return { ok: false, errors };
    return {
      ok: true,
      action: 'add_labour',
      payload: { date: fields.date, rateType: fields.rateType, hours, description },
      summary: `${hours} h ${RATE_LABEL[fields.rateType]}${description.length > 0 ? ` — ${description}` : ''}`,
    };
  }

  if (kind === 'travel') {
    const kilometres = number(fields.kilometres);
    if (!ISO_DATE.test(fields.date)) errors.date = 'Choose the day of the trip.';
    if (!Number.isFinite(kilometres) || kilometres <= 0 || kilometres > 10_000) {
      errors.kilometres = 'Enter the kilometres, more than 0.';
    }
    if (Object.keys(errors).length > 0) return { ok: false, errors };
    return {
      ok: true,
      action: 'add_travel',
      payload: { date: fields.date, kilometres, description },
      summary: `${kilometres} km${description.length > 0 ? ` — ${description}` : ''}`,
    };
  }

  if (kind === 'part') {
    const partNumber = fields.partNumber.trim();
    const quantity = Number(fields.quantity);
    const price = number(fields.unitPrice);
    if (partNumber.length === 0) errors.partNumber = 'Enter the part number.';
    if (partNumber.length > 120) errors.partNumber = 'Keep the part number under 120 characters.';
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10_000) errors.quantity = 'Enter a whole quantity.';
    if (!Number.isFinite(price) || price < 0) errors.unitPrice = 'Enter a unit price.';
    if (Object.keys(errors).length > 0) return { ok: false, errors };
    return {
      ok: true,
      action: 'add_part',
      payload: { partNumber, description, quantity, unitPrice: Math.round(price * 100) },
      summary: `${quantity} × ${partNumber}${description.length > 0 ? ` — ${description}` : ''}`,
    };
  }

  const body = fields.body.trim();
  if (body.length === 0) errors.body = 'Write the note.';
  if (body.length > 4000) errors.body = 'Keep the note under 4 000 characters.';
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    action: 'add_note',
    payload: { body, internal: fields.internal },
    summary: `${fields.internal ? 'Internal note' : 'Note'} — ${body.slice(0, 80)}`,
  };
};

export const emptyOfflineCaptureFields = (today: string): OfflineCaptureFields => ({
  date: today,
  hours: '',
  rateType: 'normal',
  kilometres: '',
  partNumber: '',
  description: '',
  unitPrice: '',
  quantity: '1',
  body: '',
  internal: false,
});
