import { describe, expect, it } from 'vitest';
import { CACHED_JOB_FIELDS, toCachedJob } from './cached-job';
import type { JobListRow } from '@/application/job-view';

/**
 * WHAT LEAVES THE SERVER AND STAYS ON A TABLET. PWA-6.
 *
 * The projection is a whitelist built field by field, and these tests exist
 * because the failure mode is silent: somebody adds a field to the job summary
 * for a screen, and a spread would put it on every tablet in the field without
 * anybody deciding it should be there. A field appears in IndexedDB only if it
 * is named here AND in `CACHED_JOB_FIELDS`.
 */
const row = (overrides: Record<string, unknown> = {}): JobListRow =>
  ({
    job: {
      id: 'job-1',
      jobNumber: 'EJE-1042',
      status: 'in_progress',
      jobType: 'breakdown',
      priority: 'urgent',
      scheduledDate: '2026-10-20',
      faultDescription: 'Spindle drive alarming.',
      customerId: 'cust-abc',
      siteId: 'site-abc-jhb',
      machineId: 'machine-abc-lv40',
      primaryTechnicianId: 'user-tech-sipho',
      additionalTechnicianIds: ['user-tech-riaan'],
      signatureRefusals: [{ reason: 'The customer disputes the hours.' }],
      finalDocument: { storageKey: 'uploads/final-EJE-1042.pdf' },
      ...((overrides.job as Record<string, unknown>) ?? {}),
    },
    customerName: 'ABC Manufacturing',
    siteName: 'Johannesburg plant',
    machineLabel: 'Haas VF-2',
    machineSerial: 'LV40-9981',
    contactName: 'Thandi Nkosi',
    contactMobile: '+27 82 555 0100',
    ...overrides,
  }) as unknown as JobListRow;

describe('narrowing a job to what a tablet may keep', () => {
  it('keeps what a technician at the machine needs to read', () => {
    expect(toCachedJob(row())).toEqual({
      jobNumber: 'EJE-1042',
      status: 'in_progress',
      jobType: 'breakdown',
      priority: 'urgent',
      scheduledDate: '2026-10-20',
      faultDescription: 'Spindle drive alarming.',
      customerName: 'ABC Manufacturing',
      siteName: 'Johannesburg plant',
      machineLabel: 'Haas VF-2',
      machineSerial: 'LV40-9981',
    });
  });

  it('keeps nothing else, however much the row carries', () => {
    const cached = toCachedJob(row()) as unknown as Record<string, unknown>;
    expect(Object.keys(cached).sort()).toEqual([...CACHED_JOB_FIELDS].sort());
  });

  /* -- the specific things that must not be on a shared device ------------- */

  it('drops a signature refusal, which is a dispute in progress', () => {
    const serialised = JSON.stringify(toCachedJob(row()));
    expect(serialised).not.toContain('disputes the hours');
  });

  it('drops the pointer to the customer’s signed job card', () => {
    const serialised = JSON.stringify(toCachedJob(row()));
    expect(serialised).not.toContain('final-EJE-1042.pdf');
    expect(serialised).not.toContain('storageKey');
  });

  it('drops the customer’s staff and their telephone numbers', () => {
    const serialised = JSON.stringify(toCachedJob(row()));
    expect(serialised).not.toContain('Thandi');
    expect(serialised).not.toContain('555 0100');
  });

  it('drops every identifier a client could send back as if it were authority', () => {
    const cached = toCachedJob(row()) as unknown as Record<string, unknown>;
    for (const key of [
      'id',
      'customerId',
      'siteId',
      'machineId',
      'primaryTechnicianId',
      'additionalTechnicianIds',
    ]) {
      expect(cached).not.toHaveProperty(key);
    }
  });

  it('ignores a field the server adds later rather than caching it', () => {
    // The whole reason this is not a spread. A new field on the summary is a
    // decision for whoever adds it, not a default.
    const cached = toCachedJob(
      row({ job: { internalMargin: 4120.55, customerCreditNote: 'CN-9' } }),
    ) as unknown as Record<string, unknown>;
    expect(cached).not.toHaveProperty('internalMargin');
    expect(JSON.stringify(cached)).not.toContain('CN-9');
  });

  it('keeps a job with nothing scheduled, rather than dropping the row', () => {
    expect(toCachedJob(row({ job: { scheduledDate: null } })).scheduledDate).toBeNull();
  });
});
