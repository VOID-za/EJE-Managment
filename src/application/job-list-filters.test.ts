import { beforeAll, describe, expect, it } from 'vitest';
import { emptyJobListFilters, filterJobListRows, matchesJobListStatus, type JobListFilters } from './job-list-filters';
import { loadActiveJobList, type JobListRow } from './job-view';
import { buildHarness, seedUser } from './test-harness';

/**
 * THE JOBS PAGE FILTERS. JOBS-FILTER-1 moved Status, Job type, Priority and
 * "Only jobs assigned to me" into a folded section; this is what each does,
 * alone and together with the search and the status tabs — one function, the
 * same one the export uses (SEARCH-4).
 */
const master = seedUser('user-master-elmarie');
const sipho = seedUser('user-tech-sipho');

let rows: readonly JobListRow[] = [];
beforeAll(async () => {
  const harness = buildHarness();
  rows = await loadActiveJobList(harness.repos, master);
});

const run = (over: Partial<JobListFilters>, actor = master.id) =>
  filterJobListRows(rows, { ...emptyJobListFilters, ...over }, actor);

describe('JOBS-FILTER-1: the Jobs page filters', () => {
  it('has active jobs to filter', () => {
    expect(rows.length).toBeGreaterThan(5);
  });

  it('each filter narrows to exactly the rows it describes', () => {
    const all = run({ status: 'all' });
    const type = all[0]!.job.jobType;
    expect(run({ status: 'all', jobType: type }).every((row) => row.job.jobType === type)).toBe(true);
    expect(run({ status: 'all', jobType: type })).toHaveLength(all.filter((row) => row.job.jobType === type).length);
    const graded = all.find((row) => row.job.priority !== null)!;
    expect(run({ status: 'all', priority: graded.job.priority! }).every((row) => row.job.priority === graded.job.priority)).toBe(true);
    const mine = run({ status: 'all', mineOnly: true }, sipho.id);
    expect(mine.every((row) => row.job.primaryTechnicianId === sipho.id || row.job.additionalTechnicianIds.includes(sipho.id))).toBe(true);
  });

  it('combines the search, the status tab and the folded filters as an intersection', () => {
    const all = run({ status: 'all' });
    const sample = all.find((row) => row.job.priority !== null)!;
    const combined = run({
      status: sample.job.status,
      jobType: sample.job.jobType,
      priority: sample.job.priority!,
      term: sample.job.jobNumber,
    });
    expect(combined.map((row) => row.job.jobNumber)).toEqual([sample.job.jobNumber]);
    const expected = all.filter(
      (row) =>
        matchesJobListStatus(row.job.status, sample.job.status, row.job.scheduledDate) &&
        row.job.jobType === sample.job.jobType &&
        row.job.priority === sample.job.priority,
    );
    expect(run({ status: sample.job.status, jobType: sample.job.jobType, priority: sample.job.priority! })).toHaveLength(expected.length);
  });

  it('searches the job number, the customer and the machine serial', () => {
    const sample = run({ status: 'all' }).find((row) => row.machineSerial.length > 0)!;
    expect(run({ status: 'all', term: sample.job.jobNumber.toLowerCase() }).map((row) => row.job.jobNumber)).toContain(sample.job.jobNumber);
    expect(run({ status: 'all', term: sample.customerName }).map((row) => row.job.jobNumber)).toContain(sample.job.jobNumber);
    expect(run({ status: 'all', term: sample.machineSerial }).map((row) => row.job.jobNumber)).toContain(sample.job.jobNumber);
  });

  it('cleared, leaves nothing filtering: the empty filters give the default tab exactly', () => {
    const narrowed = run({ status: 'all', jobType: 'service', priority: 'urgent', mineOnly: true });
    const cleared = run({});
    expect(cleared.length).toBeGreaterThanOrEqual(narrowed.length);
    expect(cleared).toEqual(filterJobListRows(rows, emptyJobListFilters, master.id));
    expect(cleared.every((row) => matchesJobListStatus(row.job.status, 'open-work', row.job.scheduledDate))).toBe(true);
  });
});
