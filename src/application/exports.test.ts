import { beforeEach, describe, expect, it } from 'vitest';
import {
  EXPORT_ROW_LIMIT,
  closedJobColumnsFor,
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

  it('is served to the office, with that role’s own columns', async () => {
    /*
     * THE HEADER IS THE ROLE'S COLUMN LIST, not the base one. Since BD-17 was
     * answered both office roles hold `jobs.exportPrices`, so their file
     * carries the four price columns after the base ones — and asserting
     * against `closedJobColumnsFor` is what keeps this case honest whichever
     * roles EJE name.
     */
    for (const actor of [master, coordinator]) {
      const file = await exportClosedJobs(harness.repos, actor, closedFilters());
      expect(file.rowCount).toBeGreaterThan(0);
      expect(file.csv.replace(CSV_BOM, '').split('\r\n')[0]).toBe(
        closedJobColumnsFor(actor)
          .map((column) => column.header)
          .join(','),
      );
    }
  });

  /*
   * THE MONEY IS BEHIND A CAPABILITY, AND THE BASE LIST STILL HAS NONE OF IT.
   *
   * BD-17 was answered on 23 October 2026: the office may export the issued
   * prices. What remains true, and is what this case now guards, is that the
   * figures arrive ONLY through `jobs.exportPrices` — the base column list
   * carries no money at all, so a role that does not hold the capability gets
   * a file with none in it. `export-prices-and-audit.test.ts` asserts the
   * granted and refused roles against the bytes.
   *
   * ALSO STILL TRUE: the RATES are never exported. `ClosedJobRow` carries the
   * pricing snapshot so a historical document re-renders at its own rates, and
   * none of those rate figures reaches the file — what the office gets is the
   * four issued TOTALS, not the hourly rates behind them.
   */
  it('keeps the money out of the base column list, and the RATES out of the file', async () => {
    const file = await exportClosedJobs(harness.repos, master, closedFilters());
    const snapshots = await harness.repos.jobs.listPricingSnapshots(
      (await harness.repos.jobs.listSummaries({ statuses: ['closed'] })).map((job) => job.id),
    );
    const rates = [...snapshots.values()]
      .flatMap((snapshot) => (snapshot === null ? [] : Object.values(snapshot)))
      .filter((value): value is number => typeof value === 'number' && value > 1000);

    expect(rates.length).toBeGreaterThan(0);
    for (const rate of rates) {
      // The rate in cents, as the snapshot holds it, appears nowhere.
      expect(file.csv).not.toContain(String(rate));
    }

    // And the base list — what a role without the capability receives — names
    // no figure of any kind.
    expect(closedJobsExportColumns.join(' ').toLowerCase()).not.toMatch(
      /total|price|rate|amount|vat/,
    );
  });

  it('carries the Test & Repair unit, so the archive can be reconciled. TR-1', async () => {
    /*
     * "PERSIST THROUGH ... RELEVANT EXPORTS" is the requirement, and the
     * archive is the relevant one: it is where the office reconciles work
     * after it is done. A spreadsheet of closed jobs that cannot say WHICH
     * UNIT was booked in is no use for the job type it describes.
     *
     * The four columns are EMPTY on every other job type, exactly as Order
     * number and Reference number already are — and they are references and
     * quantities, not money, so they are not what BD-17 gates.
     */
    const file = await exportClosedJobs(harness.repos, master, closedFilters());
    const header = file.csv.replace('\uFEFF', '').split('\r\n')[0] ?? '';
    expect(header).toContain('Quote number');
    expect(header).toContain('Part number');
    expect(header).toContain('Part description');
    expect(header).toContain('Quantity');
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
