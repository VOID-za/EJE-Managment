import { beforeEach, describe, expect, it } from 'vitest';
import { describeExport, recordExport } from './export-audit';
import { exportClosedJobs, closedJobsExportColumns } from './exports';
import { emptyClosedJobFilters } from './closed-jobs';
import { buildHarness, seedUser, type Harness } from './test-harness';

/**
 * THE EXPORT AUDIT, NOW THAT IT WRITES. BD-18, ANSWERED.
 *
 * Issue #25 asked whether a spreadsheet export belongs on the audit trail, and
 * the owner answered on 23 October 2026: audit all exports, keep the records
 * indefinitely. These cases used to assert the opposite — that the mechanism
 * was built and wrote NOTHING — and the inversion is the decision, not a
 * relaxation: the discriminating test still takes a REAL export through the
 * real operation and then reads the trail, it just expects to find the event
 * now instead of expecting the trail to be untouched.
 *
 * WHAT DID NOT CHANGE, and is still the important half: the record carries who,
 * when, which export, the filters, the row count and the columns — and NEVER
 * THE ROWS. An audit entry holding a copy of the exported data would be a
 * second, unreviewed store of the same customer information.
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

describe('the boundary, now that BD-18 is answered', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  it('writes the event, and reports that it wrote', async () => {
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

    expect(outcome.written).toBe(true);
    expect(outcome.record.rowCount).toBe(7);

    const after = await harness.repos.activity.list();
    expect(after).toHaveLength(before.length + 1);
  });

  it('has NO configuration that turns it off, which is what "audit all" means', async () => {
    // The variable that used to control this is no longer read anywhere. Set
    // it to the old "off" and the export is still recorded.
    const previous = process.env.EJE_EXPORT_AUDIT;
    process.env.EJE_EXPORT_AUDIT = 'off';
    try {
      const before = await harness.repos.activity.list();
      await recordExport(
        harness.as(master),
        describeExport({
          kind: 'jobs',
          actor: master,
          filters: {},
          rowCount: 1,
          columns: ['Job number'],
          takenAt: harness.services.clock.now(),
        }),
      );
      expect(await harness.repos.activity.list()).toHaveLength(before.length + 1);
    } finally {
      if (previous === undefined) delete process.env.EJE_EXPORT_AUDIT;
      else process.env.EJE_EXPORT_AUDIT = previous;
    }
  });

  /*
   * THE DISCRIMINATING TEST, inverted. Taking a REAL export through the real
   * operation must now leave an event on the trail — and that event must not
   * contain any of the exported data.
   */
  it('records a real export, naming what was taken and not what was in it', async () => {
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

    const events = await harness.repos.activity.list();
    const event = events.find((candidate) => candidate.type === 'data_exported');
    expect(event).toBeDefined();
    expect(event!.summary).toMatch(/closed-job archive/i);
    expect(event!.summary).toContain(String(file.rowCount));
    expect(event!.detail).toMatch(/elmarie/i);

    /*
     * AND NOT THE GOODS. A job number out of the real exported file must not
     * appear anywhere in the trail entry — which is the assertion that would
     * catch somebody "improving" the record by attaching the rows.
     */
    const firstDataLine = file.csv.split('\r\n')[1] ?? '';
    const jobNumber = firstDataLine.split(',')[0]?.replace(/"/gu, '') ?? '';
    expect(jobNumber).toMatch(/^EJE-/u);
    expect(JSON.stringify(event)).not.toContain(jobNumber);
  });

  it('is a READ on a trail of changes, so it carries no job id', async () => {
    await recordExport(
      harness.as(master),
      describeExport({
        kind: 'jobs',
        actor: master,
        filters: {},
        rowCount: 3,
        columns: ['Job number'],
        takenAt: harness.services.clock.now(),
      }),
    );

    const event = (await harness.repos.activity.list()).find(
      (candidate) => candidate.type === 'data_exported',
    );
    expect(event!.jobId).toBeNull();
  });
});
