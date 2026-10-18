import { beforeEach, describe, expect, it } from 'vitest';
import {
  EXPORT_ROW_LIMIT,
  closedJobsExportColumns,
  exportClosedJobs,
  exportJobList,
  jobListExportColumns,
} from './exports';
import { emptyClosedJobFilters, type ClosedJobFilters } from './closed-jobs';
import { emptyJobListFilters, type JobListFilters } from './job-list-filters';
import { WorkflowError } from './errors';
import { buildHarness, seedUser, type Harness } from './test-harness';
import { CSV_BOM } from '@/lib/csv';
import { asJobId, type Job } from '@/domain';

/**
 * SPREADSHEET EXPORTS. MASTER SCOPE SEARCH-4.
 *
 * What these prove, in the order it matters:
 *
 *   1. The file is the SCREEN'S OWN READ. A technician's job-list export holds
 *      the jobs a technician may see, and the archive refuses a technician
 *      outright — both because the export calls the same read model the screen
 *      calls, not because a column was left out.
 *   2. NOTHING COMMERCIAL, NOTHING INTERNAL, NOTHING TO DO WITH A SESSION is
 *      in the bytes. Asserted against the bytes themselves, not against a list
 *      of columns somebody maintained.
 *   3. The awkward data survives: a comma, a line break, a quote, an umlaut and
 *      a formula all come back as data rather than as broken rows or as code.
 *   4. The filters are honoured, an empty result is a valid file, and a result
 *      too large to carry is REFUSED rather than silently cut off.
 */
const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');
const sipho = seedUser('user-tech-sipho');
const riaan = seedUser('user-tech-riaan');

const jobFilters = (overrides: Partial<JobListFilters> = {}): JobListFilters => ({
  ...emptyJobListFilters,
  status: 'all',
  ...overrides,
});

const closedFilters = (overrides: Partial<ClosedJobFilters> = {}): ClosedJobFilters => ({
  ...emptyClosedJobFilters,
  ...overrides,
});

/** The data rows, without the header and without the trailing blank. */
const dataLines = (csv: string): readonly string[] =>
  csv.replace(CSV_BOM, '').trimEnd().split('\r\n').slice(1);

const seededJob = async (harness: Harness, jobNumber: string): Promise<Job> => {
  const job = await harness.repos.jobs.findByJobNumber(jobNumber);
  if (job === null) throw new Error(`${jobNumber} is not seeded`);
  return job;
};

describe('the Jobs list export', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  it('writes the columns the screen shows, in a stable order', async () => {
    const file = await exportJobList(harness.repos, master, jobFilters());
    expect(file.csv.replace(CSV_BOM, '').split('\r\n')[0]).toBe(jobListExportColumns.join(','));
  });

  it('names the file for the business day it was taken', async () => {
    const file = await exportJobList(harness.repos, master, jobFilters());
    expect(file.fileName).toMatch(/^eje-jobs-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it('carries no money, no contact details and nothing about a session', async () => {
    const file = await exportJobList(harness.repos, master, jobFilters());
    const bytes = file.csv.toLowerCase();
    for (const forbidden of ['cents', 'rate', 'vat', 'password', 'token', 'session', '@eje-demo']) {
      expect(bytes).not.toContain(forbidden);
    }
    // And the headers themselves name nothing commercial.
    expect(jobListExportColumns.join(' ').toLowerCase()).not.toMatch(/total|price|rate|amount/);
  });

  /*
   * THE EXPORT IS SCOPED BY THE READ, AND THIS IS THE DISCRIMINATING TEST.
   *
   * A technician sees the open pool, their own work and the machines they have
   * worked on — DECISION 5. If the export ever stopped going through
   * `loadActiveJobList`, this comparison is what fails.
   */
  it('gives a technician the jobs a technician may see, and no others', async () => {
    const office = await exportJobList(harness.repos, master, jobFilters());
    const field = await exportJobList(harness.repos, sipho, jobFilters());

    expect(dataLines(field.rowCount === 0 ? '' : field.csv).length).toBe(field.rowCount);
    expect(field.rowCount).toBeGreaterThan(0);
    expect(field.rowCount).toBeLessThan(office.rowCount);

    const officeNumbers = new Set(dataLines(office.csv).map((line) => line.split(',')[0]));
    for (const line of dataLines(field.csv)) {
      expect(officeNumbers.has(line.split(',')[0] ?? '')).toBe(true);
    }
  });

  it('honours the "only mine" filter the screen offers', async () => {
    const mine = await exportJobList(
      harness.repos,
      riaan,
      jobFilters({ mineOnly: true }),
    );
    const all = await exportJobList(harness.repos, riaan, jobFilters());
    expect(mine.rowCount).toBeGreaterThan(0);
    expect(mine.rowCount).toBeLessThan(all.rowCount);
  });

  it('honours a job-type filter', async () => {
    const parts = await exportJobList(harness.repos, master, jobFilters({ jobType: 'parts' }));
    for (const line of dataLines(parts.csv)) {
      expect(line).toContain('Parts');
    }
  });

  it('is a valid file with a header when nothing matches', async () => {
    const file = await exportJobList(
      harness.repos,
      master,
      jobFilters({ term: 'nothing-matches-this-at-all' }),
    );
    expect(file.rowCount).toBe(0);
    expect(file.csv).toBe(`${CSV_BOM}${jobListExportColumns.join(',')}\r\n`);
  });

  it('keeps a comma, a line break and a quote inside one field instead of breaking the row', async () => {
    const job = await seededJob(harness, 'EJE-1048');
    await harness.repos.jobs.save({
      ...job,
      faultDescription: 'Spindle alarm, intermittent.\nThe "Z" axis drifts.',
    });

    const file = await exportJobList(harness.repos, master, jobFilters({ term: 'EJE-1048' }));
    expect(file.rowCount).toBe(1);
    expect(file.csv).toContain('"Spindle alarm, intermittent.\nThe ""Z"" axis drifts."');
    // One record, even though the value inside it holds a line break.
    expect(dataLines(file.csv).join('\r\n').startsWith('EJE-1048')).toBe(true);
  });

  it('neutralises a formula somebody typed into a field', async () => {
    const job = await seededJob(harness, 'EJE-1048');
    await harness.repos.jobs.save({ ...job, orderNumber: '=1+1' });

    const file = await exportJobList(harness.repos, master, jobFilters({ term: 'EJE-1048' }));
    expect(file.csv).toContain(",'=1+1,");
    expect(file.csv).not.toContain(',=1+1,');
  });

  it('refuses rather than truncating when the result is too large to carry', async () => {
    const job = await seededJob(harness, 'EJE-1048');
    const rows: readonly Job[] = Array.from({ length: EXPORT_ROW_LIMIT + 1 }, (_unused, index) => ({
      ...job,
      id: asJobId(`job-bulk-${index}`),
      jobNumber: `EJE-9${String(index).padStart(5, '0')}`,
    }));
    for (const bulk of rows) await harness.repos.jobs.save(bulk);

    const refusal = await exportJobList(harness.repos, master, jobFilters()).catch(
      (cause: unknown) => cause,
    );
    expect(refusal).toBeInstanceOf(WorkflowError);
    // The refusal names the remedy, because "too large" on its own is useless.
    expect((refusal as WorkflowError).violations[0]?.code).toBe('export_too_large');
    expect((refusal as WorkflowError).violations[0]?.message).toMatch(/at most 5000/);
    expect((refusal as WorkflowError).violations[0]?.message).toMatch(/Narrow the filters/);
  });
});

describe('the closed-job archive export', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  it('refuses a technician, with the archive screen’s own wording', async () => {
    await expect(
      exportClosedJobs(harness.repos, sipho, closedFilters()),
    ).rejects.toBeInstanceOf(WorkflowError);
    await expect(
      exportClosedJobs(harness.repos, sipho, closedFilters()),
    ).rejects.toThrowError(/office screen/);
  });

  it('is served to the office', async () => {
    for (const actor of [master, coordinator]) {
      const file = await exportClosedJobs(harness.repos, actor, closedFilters());
      expect(file.rowCount).toBeGreaterThan(0);
      expect(file.csv.replace(CSV_BOM, '').split('\r\n')[0]).toBe(
        closedJobsExportColumns.join(','),
      );
    }
  });

  /*
   * THE ONE EXCLUSION THAT IS A DECISION RATHER THAN AN OVERSIGHT.
   *
   * `ClosedJobRow` carries the pricing snapshot the job was issued at — it is
   * there so a historical document re-renders at its own rates. The archive
   * SCREEN shows no figures, so the file does not either, and who may have a
   * spreadsheet of what every job was charged at is a question for EJE.
   */
  it('carries no part of the issued price, although the read model holds it', async () => {
    const file = await exportClosedJobs(harness.repos, master, closedFilters());
    const snapshots = await harness.repos.jobs.listPricingSnapshots(
      (await harness.repos.jobs.listSummaries({ statuses: ['closed'] })).map((job) => job.id),
    );
    const amounts = [...snapshots.values()]
      .flatMap((snapshot) => (snapshot === null ? [] : Object.values(snapshot)))
      .filter((value): value is number => typeof value === 'number' && value > 1000);

    expect(amounts.length).toBeGreaterThan(0);
    for (const amount of amounts) {
      expect(file.csv).not.toContain(String(amount));
    }
    expect(closedJobsExportColumns.join(' ').toLowerCase()).not.toMatch(
      /total|price|rate|amount|vat/,
    );
  });

  it('says whether the final job card exists, and never where it is stored', async () => {
    const file = await exportClosedJobs(harness.repos, master, closedFilters());
    expect(file.csv).toContain('Final job card');
    expect(file.csv.toLowerCase()).not.toContain('storage');
    expect(file.csv.toLowerCase()).not.toContain('.pdf');
  });

  it('honours the archive’s own filters', async () => {
    const all = await exportClosedJobs(harness.repos, master, closedFilters());
    const narrowed = await exportClosedJobs(
      harness.repos,
      master,
      closedFilters({ customerId: 'cust-abc' }),
    );
    expect(narrowed.rowCount).toBeGreaterThan(0);
    expect(narrowed.rowCount).toBeLessThan(all.rowCount);
  });
});
