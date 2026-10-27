import { describe, expect, it } from 'vitest';
import { CACHED_JOB_FIELDS, toCachedJob, toCachedJobDetail } from './cached-job';
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

/**
 * AND THE SAME DISCIPLINE FOR ONE JOB'S DETAIL. OFF-DETAIL-1.
 *
 * A bigger projection, so a bigger surface to get wrong — and the fields it
 * must NEVER carry are the ones that would matter most if it did: prices, the
 * customer's signature, a pointer to the issued document, the customer's
 * staff, and any identifier a client could hand back as authority.
 */
const detailSource = (overrides: Record<string, unknown> = {}) =>
  ({
    job: {
      id: 'job-1',
      jobNumber: 'EJE-1042',
      status: 'in_progress',
      jobType: 'service',
      priority: 'high',
      scheduledDate: '2026-10-20',
      faultDescription: 'Spindle drive alarming.',
      orderNumber: 'PO-5512',
      referenceNumber: 'ABC-SVC-9',
      completionReport: {
        workPerformed: 'Replaced the drive fan.',
        faultFindings: 'Fan seized.',
        diagnosis: 'Bearing failure.',
        recommendations: 'Service the filters.',
        generalNotes: 'Running normally.',
      },
      labour: [
        {
          id: 'lab-1',
          technicianId: 'user-tech-sipho',
          date: '2026-10-19',
          hours: 2.5,
          rateType: 'normal',
          description: 'Fault finding',
          capturedBy: 'user-tech-sipho',
        },
      ],
      travel: [
        {
          id: 'trv-1',
          technicianId: 'user-tech-sipho',
          date: '2026-10-19',
          kilometres: 48,
          description: 'Isando return',
        },
      ],
      parts: [
        {
          id: 'prt-1',
          partNumber: 'FAN-220',
          description: 'Drive fan',
          quantity: 2,
          unitPrice: 48_500,
        },
      ],
      notes: [{ id: 'note-1', body: 'Gate 4 access.', internal: true, createdAt: '2026-10-19T08:00:00.000Z', authorId: 'user-tech-sipho' }],
      photos: [{ id: 'att-1', caption: 'Burnt contactor', fileName: 'contactor.jpg', storageKey: 'uploads/att-1' }],
      signature: { customerName: 'Thandi', strokeData: 'M0,0 L10,10' },
      signatureRefusals: [{ reason: 'The customer disputes the hours.' }],
      finalDocument: { storageKey: 'uploads/final-EJE-1042.pdf' },
      pricingSnapshot: { labourRates: { normal: 95_000 } },
      calloutApplied: true,
      ...((overrides.job as Record<string, unknown>) ?? {}),
    },
    customerName: 'ABC Manufacturing',
    siteName: 'Johannesburg plant',
    siteAddress: '12 Isando Road, Johannesburg',
    machineLabel: 'Haas VF-2',
    machineSerial: 'LV40-9981',
    contactName: 'Thandi Nkosi',
    contactMobile: '+27 82 555 0100',
    checklist: {
      name: 'Service checklist',
      templateVersion: '2.0-DEMO',
      answered: 3,
      total: 10,
      completed: false,
      outstanding: ['"Emergency stops functional" has not been answered.'],
    },
    ...overrides,
  }) as unknown as Parameters<typeof toCachedJobDetail>[1];

describe('narrowing one job’s DETAIL to what a tablet may keep', () => {
  const detail = () =>
    toCachedJobDetail('user-tech-sipho', detailSource(), '2026-10-20T06:30:00.000Z');

  it('keeps the work a technician needs to read with no signal', () => {
    const kept = detail();

    expect(kept.key).toBe('user-tech-sipho:EJE-1042');
    expect(kept.userId).toBe('user-tech-sipho');
    expect(kept.capturedAt).toBe('2026-10-20T06:30:00.000Z');
    expect(kept.jobNumber).toBe('EJE-1042');
    expect(kept.siteAddress).toBe('12 Isando Road, Johannesburg');
    expect(kept.workPerformed).toBe('Replaced the drive fan.');
    expect(kept.labour).toEqual([
      { date: '2026-10-19', hours: 2.5, rateType: 'normal', description: 'Fault finding' },
    ]);
    expect(kept.travel[0]?.kilometres).toBe(48);
    expect(kept.parts).toEqual([
      { partNumber: 'FAN-220', description: 'Drive fan', quantity: 2 },
    ]);
    expect(kept.notes[0]?.body).toBe('Gate 4 access.');
    expect(kept.photoCaptions).toEqual(['Burnt contactor']);
    expect(kept.checklist?.answered).toBe(3);
    expect(kept.checklist?.outstanding[0]).toContain('Emergency stops');
  });

  it('keeps NO price, of any kind', () => {
    const blob = JSON.stringify(detail());

    expect(blob).not.toContain('unitPrice');
    expect(blob).not.toContain('48500');
    expect(blob).not.toContain('pricingSnapshot');
    expect(blob).not.toContain('calloutApplied');
    expect(blob).not.toContain('95000');
  });

  it('keeps no signature, no refusal and no document pointer', () => {
    const blob = JSON.stringify(detail());

    expect(blob).not.toContain('strokeData');
    expect(blob).not.toContain('Thandi');
    expect(blob).not.toContain('disputes the hours');
    expect(blob).not.toContain('final-EJE-1042.pdf');
    expect(blob).not.toContain('finalDocument');
  });

  it('keeps whether work may be held, as two booleans and nothing more (OFF-2)', () => {
    const kept = toCachedJobDetail('user-tech-sipho', detailSource({ signed: true, capturesLabourAndTravel: false }), '2026-10-20T06:30:00.000Z');
    expect(kept.signed).toBe(true);
    expect(kept.capturesLabourAndTravel).toBe(false);
    // Whether it was signed — never who signed or what.
    expect(JSON.stringify(kept)).not.toContain('strokeData');
  });

  it('keeps no identifier a client could hand back as authority', () => {
    const blob = JSON.stringify(detail());

    for (const identifier of [
      'job-1',
      'cust-abc',
      'site-abc',
      'machine-abc',
      'lab-1',
      'trv-1',
      'prt-1',
      'note-1',
      'att-1',
      'uploads/',
    ]) {
      expect(blob, identifier).not.toContain(identifier);
    }
    // The owner's id IS kept, and has to be: it is what scopes the record to
    // the person it belongs to, and it is this device's own session, not a
    // claim about anybody else.
    expect(blob).toContain('user-tech-sipho');
  });

  it('keeps no customer contact details', () => {
    const blob = JSON.stringify(detail());

    expect(blob).not.toContain('Thandi Nkosi');
    expect(blob).not.toContain('+27 82 555 0100');
  });

  it('carries no checklist where the job has none', () => {
    const none = toCachedJobDetail(
      'user-tech-sipho',
      detailSource({ checklist: null }),
      '2026-10-20T06:30:00.000Z',
    );
    expect(none.checklist).toBeNull();
  });
});
