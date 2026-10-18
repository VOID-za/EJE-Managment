import { beforeEach, describe, expect, it } from 'vitest';
import { EXPORT_AUDIT, describeExport, recordExport } from './export-audit';
import { exportClosedJobs, closedJobsExportColumns } from './exports';
import { emptyClosedJobFilters } from './closed-jobs';
import { buildHarness, seedUser, type Harness } from './test-harness';

/**
 * THE EXPORT-AUDIT MECHANISM, AND THE FACT THAT IT IS OFF. BD-18.
 *
 * Issue #25 asked whether a spreadsheet export belongs on the audit trail.
 * Nobody has answered, so this is a mechanism and not a feature: the export
 * routes call it, it writes nothing, and these tests hold both halves of that
 * — the record it WOULD write is right, and the trail is untouched.
 *
 * The second half is the one worth having. An audit event that appeared
 * quietly would change what the trail means (today it records CHANGES, never
 * reads), what the office's activity screen shows, and what EJE retain about
 * their own staff. None of those is an implementation detail.
 */
const master = seedUser('user-master-elmarie');

describe('what an export record would say', () => {
  it('carries who, what, how many and which filters — and no rows', () => {
    const record = describeExport({
      kind: 'closed-jobs',
      actor: master,
      filters: { customerId: 'cust-abc', jobType: 'service' },
      rowCount: 42,
      columns: [...closedJobsExportColumns],
      takenAt: '2026-10-18T08:00:00.000Z',
    });

    expect(record.kind).toBe('closed-jobs');
    expect(record.actorId).toBe(master.id);
    expect(record.actorRole).toBe('master');
    expect(record.rowCount).toBe(42);
    expect(record.filters).toEqual({ customerId: 'cust-abc', jobType: 'service' });
    expect(record.takenAt).toBe('2026-10-18T08:00:00.000Z');

    /*
     * NOT THE DATA. A trail entry holding a copy of the exported rows would be
     * a second, unreviewed store of the same customer information.
     */
    expect(JSON.stringify(record)).not.toContain('EJE-10');
    // And no money, for the same reason the export itself carries none (BD-17).
    expect(record.columns.join(' ').toLowerCase()).not.toMatch(/total|price|rate|amount|vat/);
  });

  it('copies the filters rather than holding the caller’s object', () => {
    const filters: Record<string, string> = { customerId: 'cust-abc' };
    const record = describeExport({
      kind: 'jobs',
      actor: master,
      filters,
      rowCount: 1,
      columns: ['Job number'],
      takenAt: '2026-10-18T08:00:00.000Z',
    });

    filters.customerId = 'cust-highveld';
    expect(record.filters.customerId).toBe('cust-abc');
  });
});

describe('the boundary, while BD-18 is open', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  it('is off, and says why', () => {
    expect(EXPORT_AUDIT.recording).toBe(false);
    expect(EXPORT_AUDIT.reason).toMatch(/BD-18/);
  });

  it('writes nothing, and hands back the record it would have written', async () => {
    const before = await harness.repos.activity.list();

    const outcome = await recordExport(
      harness.as(master),
      describeExport({
        kind: 'jobs',
        actor: master,
        filters: { status: 'all' },
        rowCount: 7,
        columns: ['Job number'],
        takenAt: harness.services.clock.now(),
      }),
    );

    expect(outcome.written).toBe(false);
    expect(outcome.reason).toMatch(/open business decision/i);
    expect(outcome.record.rowCount).toBe(7);

    const after = await harness.repos.activity.list();
    expect(after).toHaveLength(before.length);
  });

  /*
   * THE DISCRIMINATING TEST. Taking a real export through the real operation
   * must leave the trail exactly as it was — if an event is ever written
   * without BD-18 being answered, this is what fails.
   */
  it('leaves the audit trail untouched when an export is actually taken', async () => {
    const before = await harness.repos.activity.list();

    const file = await exportClosedJobs(harness.repos, master, emptyClosedJobFilters);
    expect(file.rowCount).toBeGreaterThan(0);

    await recordExport(
      harness.as(master),
      describeExport({
        kind: 'closed-jobs',
        actor: master,
        filters: {},
        rowCount: file.rowCount,
        columns: [...closedJobsExportColumns],
        takenAt: harness.services.clock.now(),
      }),
    );

    const after = await harness.repos.activity.list();
    expect(after).toHaveLength(before.length);
    expect(JSON.stringify(after)).not.toMatch(/export/i);
  });
});
