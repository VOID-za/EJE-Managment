import { describe, expect, it } from 'vitest';
import { migrateDatabase, OLDEST_MIGRATABLE_VERSION } from './migrations';
import { SCHEMA_VERSION } from './store';

/**
 * Upgrading a persisted demonstration, rather than throwing it away.
 *
 * The thing being proved is that nothing is lost: the customer somebody added
 * on Tuesday, the job they worked, and the job card they issued are all still
 * there afterwards, with the new fields filled in from what the snapshot
 * already knew.
 */

/** A v8 snapshot: the shape before office addresses, machine numbers and delivery. */
const v8Snapshot = () => ({
  customers: [
    {
      id: 'cust-1',
      name: 'ABC Engineering',
      accountNumber: 'ABC001',
      phone: '+27 11 555 0210',
      email: 'accounts@abc-demo.co.za',
      industry: 'Engineering',
      paymentTerms: '30 days',
      active: true,
      notes: [],
      documents: [],
      createdAt: '2024-01-01T08:00:00.000Z',
    },
  ],
  sites: [
    {
      id: 'site-1',
      customerId: 'cust-1',
      name: 'Johannesburg',
      addressLine1: 'Unit 7, Steelpark',
      addressLine2: '112 Foundry Road',
      city: 'Johannesburg',
      province: 'Gauteng',
      postalCode: '2094',
      accessNotes: '',
      latitude: null,
      longitude: null,
    },
  ],
  contacts: [{ id: 'contact-1', customerId: 'cust-1', siteId: 'site-1', firstName: 'Pieter' }],
  machines: [{ id: 'machine-1', customerId: 'cust-1', siteId: 'site-1', serialNumber: 'LW-1' }],
  jobs: [
    {
      id: 'job-1',
      jobNumber: 'EJE-1044',
      status: 'closed',
      createdBy: 'user-master-1',
      labour: [
        {
          id: 'lab-1',
          technicianId: 'user-tech-1',
          hours: 3,
          capturedAt: '2024-02-01T09:00:00.000Z',
        },
      ],
      travel: [
        {
          id: 'trv-1',
          technicianId: 'user-tech-1',
          kilometres: 40,
          capturedAt: '2024-02-01T09:00:00.000Z',
        },
      ],
      parts: [{ id: 'prt-1', partNumber: 'FAN-1', capturedAt: '2024-02-01T09:00:00.000Z' }],
      finalDocument: { fileName: 'EJE-1044-Final-Job-Card.pdf' },
    },
  ],
  users: [{ id: 'user-tech-1' }],
  files: { 'jobs/EJE-1044.pdf': { fileName: 'EJE-1044.pdf', base64: 'AAAA' } },
});

describe('migrating a persisted snapshot', () => {
  it('keeps every record it was given', () => {
    const migrated = migrateDatabase(8, v8Snapshot(), SCHEMA_VERSION);

    expect(migrated).not.toBeNull();
    expect(migrated!.customers).toHaveLength(1);
    expect(migrated!.sites).toHaveLength(1);
    expect(migrated!.contacts).toHaveLength(1);
    expect(migrated!.machines).toHaveLength(1);
    expect(migrated!.jobs).toHaveLength(1);
    // The job card that was issued is still on the demo's disk.
    expect(Object.keys(migrated!.files)).toContain('jobs/EJE-1044.pdf');
  });

  it('takes the office address from the customer’s first site', () => {
    const migrated = migrateDatabase(8, v8Snapshot(), SCHEMA_VERSION)!;
    expect(migrated.customers[0]!.officeAddress).toEqual({
      line1: 'Unit 7, Steelpark',
      line2: '112 Foundry Road',
      city: 'Johannesburg',
      province: 'Gauteng',
      postalCode: '2094',
    });
  });

  it('gives every register record an archive marker, set to live', () => {
    const migrated = migrateDatabase(8, v8Snapshot(), SCHEMA_VERSION)!;
    expect(migrated.sites[0]!.archivedAt).toBeNull();
    expect(migrated.contacts[0]!.archivedAt).toBeNull();
    expect(migrated.machines[0]!.archivedAt).toBeNull();
  });

  it('gives machines an empty machine number rather than inventing one', () => {
    const migrated = migrateDatabase(8, v8Snapshot(), SCHEMA_VERSION)!;
    expect(migrated.machines[0]!.machineNumber).toBe('');
  });

  it('says nothing is known about an old job’s delivery', () => {
    const migrated = migrateDatabase(8, v8Snapshot(), SCHEMA_VERSION)!;
    expect(migrated.jobs[0]!.delivery).toBeNull();
    // And a closed job stays closed.
    expect(migrated.jobs[0]!.status).toBe('closed');
  });

  it('credits an old captured line to the technician it was already attributed to', () => {
    const migrated = migrateDatabase(8, v8Snapshot(), SCHEMA_VERSION)!;
    expect(migrated.jobs[0]!.labour[0]!.capturedBy).toBe('user-tech-1');
    expect(migrated.jobs[0]!.travel[0]!.capturedBy).toBe('user-tech-1');
    // A part carries no technician, so it falls back to whoever raised the job.
    expect(migrated.jobs[0]!.parts[0]!.capturedBy).toBe('user-master-1');
  });

  it('never overwrites a value the snapshot already had', () => {
    const snapshot = v8Snapshot();
    const withNumber = {
      ...snapshot,
      machines: [{ ...snapshot.machines[0]!, machineNumber: 'STM1', archivedAt: 'yesterday' }],
    };
    const migrated = migrateDatabase(8, withNumber, SCHEMA_VERSION)!;
    expect(migrated.machines[0]!.machineNumber).toBe('STM1');
    expect(migrated.machines[0]!.archivedAt).toBe('yesterday');
  });

  it('is a no-op path for a snapshot that is already current', () => {
    const migrated = migrateDatabase(SCHEMA_VERSION, v8Snapshot(), SCHEMA_VERSION);
    expect(migrated).not.toBeNull();
  });

  it('refuses a snapshot older than the oldest step it carries', () => {
    expect(migrateDatabase(OLDEST_MIGRATABLE_VERSION - 1, v8Snapshot(), SCHEMA_VERSION)).toBeNull();
  });

  it('refuses a snapshot from the future and anything that is not an object', () => {
    expect(migrateDatabase(SCHEMA_VERSION + 1, v8Snapshot(), SCHEMA_VERSION)).toBeNull();
    expect(migrateDatabase(8, null, SCHEMA_VERSION)).toBeNull();
    expect(migrateDatabase(8, 'not a snapshot', SCHEMA_VERSION)).toBeNull();
  });
});
