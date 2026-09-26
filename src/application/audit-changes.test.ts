import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptJob,
  addLabour,
  addPart,
  addTravel,
  updateLabour,
  updatePart,
  updateTravel,
} from './job-operations';
import { updateSettings } from './settings-operations';
import { changesBetween } from './audit';
import { buildHarness, seedUser, type Harness } from './test-harness';
import type { ActivityEvent, FieldChange, Job } from '@/domain';

/**
 * WHAT A VALUE USED TO BE. MASTER SCOPE AUDIT-2.
 *
 * The audit trail has always said what happened, in a sentence resolved at write
 * time. What it could not say is what a value USED TO BE: `audit_events.metadata`
 * — a `jsonb` column — existed and was never written to, so amending a labour
 * line from three hours to five left no record of the three, and dropping the
 * charge-out rate left no record of yesterday's price. CR-10 confirmed it:
 * "`audit_events.metadata` is a `jsonb` column that exists and is not used for
 * structured before/after values. The trail is narrative."
 *
 * It is now written, sparingly and deliberately:
 *
 *   - ONLY where an existing recorded value was REPLACED. A job being accepted
 *     or a document being generated records that something happened, not that a
 *     value moved, and carries nothing.
 *   - ONLY the fields that actually moved. A form posted back unchanged records
 *     no changes at all, rather than a dozen "from X to X" entries.
 *   - BESIDE the sentence, never instead of it. `summary` and `detail` remain
 *     the record a person reads; the screens are unchanged.
 */
const technician = seedUser('user-tech-sipho');
const master = seedUser('user-master-elmarie');

const trailFor = async (harness: Harness, job: Job): Promise<readonly ActivityEvent[]> =>
  harness.repos.activity.list(job.id);

const changeFor = (
  events: readonly ActivityEvent[],
  type: ActivityEvent['type'],
  field: string,
): FieldChange | undefined =>
  events
    .filter((event) => event.type === type)
    .flatMap((event) => event.changes)
    .find((change) => change.field === field);

describe('the audit trail records what a value used to be', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  const acceptedJob = async (): Promise<Job> => {
    const opened = await harness.repos.jobs.findByJobNumber('EJE-1048');
    return acceptJob(harness.as(technician), opened!);
  };

  /* -- line items ---------------------------------------------------------- */

  it('records every field of an amended labour line, and only those that moved', async () => {
    const context = harness.as(technician);
    let job = await acceptedJob();
    job = await addLabour(context, job, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 3,
      description: 'Replaced the coolant pump.',
    });
    const lineId = job.labour[0]!.id;

    job = await updateLabour(context, job, lineId, {
      date: '2026-09-17',
      rateType: 'overtime',
      hours: 5,
      description: 'Replaced the coolant pump.',
    });

    const trail = await trailFor(harness, job);
    expect(changeFor(trail, 'labour_added', 'labour.hours')).toEqual({
      field: 'labour.hours',
      from: 3,
      to: 5,
    });
    expect(changeFor(trail, 'labour_added', 'labour.rateType')).toEqual({
      field: 'labour.rateType',
      from: 'normal',
      to: 'overtime',
    });
    // The date and the description did not move, so they are not in the trail.
    expect(changeFor(trail, 'labour_added', 'labour.date')).toBeUndefined();
    expect(changeFor(trail, 'labour_added', 'labour.description')).toBeUndefined();
  });

  it('records the price each on an amended part, which the sentence never said', async () => {
    const context = harness.as(technician);
    let job = await acceptedJob();
    job = await addPart(context, job, {
      partNumber: 'PMP-4410',
      description: 'Coolant pump',
      quantity: 1,
      unitPrice: 185_000,
    });
    const lineId = job.parts[0]!.id;

    job = await updatePart(context, job, lineId, {
      partNumber: 'PMP-4410',
      description: 'Coolant pump',
      quantity: 1,
      unitPrice: 240_000,
    });

    const trail = await trailFor(harness, job);
    expect(changeFor(trail, 'part_added', 'part.unitPrice')).toEqual({
      field: 'part.unitPrice',
      from: 185_000,
      to: 240_000,
    });
    // Cents, not "R2 400,00": a formatted string could never be compared.
    expect(typeof changeFor(trail, 'part_added', 'part.unitPrice')?.from).toBe('number');
    expect(changeFor(trail, 'part_added', 'part.quantity')).toBeUndefined();
  });

  it('records an amended travel line', async () => {
    const context = harness.as(technician);
    let job = await acceptedJob();
    job = await addTravel(context, job, {
      date: '2026-09-17',
      kilometres: 84,
      description: 'Benoni and back.',
    });
    const lineId = job.travel[0]!.id;

    job = await updateTravel(context, job, lineId, {
      date: '2026-09-17',
      kilometres: 112,
      description: 'Benoni and back, via the depot.',
    });

    const trail = await trailFor(harness, job);
    expect(changeFor(trail, 'travel_added', 'travel.kilometres')).toEqual({
      field: 'travel.kilometres',
      from: 84,
      to: 112,
    });
    expect(changeFor(trail, 'travel_added', 'travel.description')?.from).toBe('Benoni and back.');
  });

  it('records nothing structured when an amendment changes nothing', async () => {
    const context = harness.as(technician);
    let job = await acceptedJob();
    job = await addLabour(context, job, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 3,
      description: 'Replaced the coolant pump.',
    });
    const lineId = job.labour[0]!.id;

    // The form posted straight back, unchanged.
    job = await updateLabour(context, job, lineId, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 3,
      description: 'Replaced the coolant pump.',
    });

    const amendments = (await trailFor(harness, job)).filter(
      (event) => event.type === 'labour_added' && event.summary.includes('amended'),
    );
    expect(amendments).toHaveLength(1);
    expect(amendments[0]?.changes).toEqual([]);
  });

  /* -- events that record that something HAPPENED -------------------------- */

  it('carries no changes on an event that is not a value moving', async () => {
    const job = await acceptedJob();
    const trail = await trailFor(harness, job);

    const accepted = trail.find((event) => event.type === 'job_accepted');
    expect(accepted).toBeDefined();
    expect(accepted?.changes).toEqual([]);
    // And the sentence a person reads is untouched by any of this.
    expect(accepted?.summary).toBe('Job accepted');
  });

  /* -- the charge-out rates ------------------------------------------------ */

  it('records what a charge-out rate used to be', async () => {
    const context = harness.as(master);
    const before = await harness.repos.settings.get();

    await updateSettings(context, {
      ...before,
      labourRates: { ...before.labourRates, normal: 99_900 },
      calloutRate: 55_000,
    });

    const trail = await harness.repos.activity.list();
    const rates = trail.filter((event) => event.type === 'settings_updated');
    expect(rates).toHaveLength(1);

    const normal = rates[0]?.changes.find((change) => change.field === 'rates.labourNormal');
    expect(normal?.from).toBe(before.labourRates.normal);
    expect(normal?.to).toBe(99_900);

    const callout = rates[0]?.changes.find((change) => change.field === 'rates.callout');
    expect(callout?.from).toBe(before.calloutRate);
    expect(callout?.to).toBe(55_000);

    // VAT did not move.
    expect(rates[0]?.changes.map((change) => change.field)).not.toContain('rates.vatPercentage');
  });

  it('records no rate changes when the rates are saved untouched', async () => {
    const context = harness.as(master);
    const before = await harness.repos.settings.get();

    await updateSettings(context, { ...before });

    const trail = await harness.repos.activity.list();
    const rates = trail.filter((event) => event.type === 'settings_updated');
    expect(rates[0]?.changes).toEqual([]);
    expect(rates[0]?.detail).toContain('no change');
  });

  /* -- the helper the operations share ------------------------------------- */

  describe('changesBetween', () => {
    it('reports only the keys that differ, namespaced', () => {
      expect(
        changesBetween('rates', { normal: 100, callout: 50 }, { normal: 120, callout: 50 }),
      ).toEqual([{ field: 'rates.normal', from: 100, to: 120 }]);
    });

    it('keeps a value absent on one side as null, not as an empty string', () => {
      expect(changesBetween('part', { note: null }, { note: 'Fitted.' })).toEqual([
        { field: 'part.note', from: null, to: 'Fitted.' },
      ]);
    });

    it('treats false and 0 as values, not as absence', () => {
      expect(changesBetween('job', { callout: true }, { callout: false })).toEqual([
        { field: 'job.callout', from: true, to: false },
      ]);
      expect(changesBetween('part', { quantity: 3 }, { quantity: 0 })).toEqual([
        { field: 'part.quantity', from: 3, to: 0 },
      ]);
    });
  });
});
