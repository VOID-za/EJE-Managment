import { beforeEach, describe, expect, it } from 'vitest';
import {
  CLOSED_JOBS_PAGE_SIZE,
  emptyClosedJobFilters,
  isArchivedJob,
  loadClosedJobs,
  type ClosedJobFilters,
} from './closed-jobs';
import { loadJobView } from './job-view';
import { publishTemplate, startNewVersion } from './checklist-admin';
import { cancelJob } from './job-operations';
import { buildHarness, seedUser, type Harness } from './test-harness';
import { calculateJobTotals, canEditJob, toJobSummary, type Job } from '@/domain';

/**
 * The closed-job archive.
 *
 * These tests are about a business record, not a screen: a job that has been
 * issued is the paperwork EJE has to be able to find again years later, and it
 * has to come back reading exactly as it read on the day it was issued.
 */

const master = seedUser('user-master-elmarie');

const filters = (overrides: Partial<ClosedJobFilters> = {}): ClosedJobFilters => ({
  ...emptyClosedJobFilters,
  ...overrides,
});

const jobNumbers = async (harness: Harness, overrides: Partial<ClosedJobFilters> = {}) => {
  const page = await loadClosedJobs(harness.repos, master, filters(overrides));
  return page.rows.map((row) => row.job.jobNumber);
};

const seededJob = async (harness: Harness, jobNumber: string): Promise<Job> => {
  const job = await harness.repos.jobs.findByJobNumber(jobNumber);
  if (job === null) throw new Error(`${jobNumber} is not seeded`);
  return job;
};

describe('what belongs in the archive', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('lists a closed job', async () => {
    // EJE-1056 is seeded closed.
    expect(await jobNumbers(harness)).toContain('EJE-1056');
  });

  it('does not list an open job', async () => {
    const open = await seededJob(harness, 'EJE-1048');
    expect(open.status).toBe('open');
    expect(await jobNumbers(harness)).not.toContain('EJE-1048');
  });

  it('does not list a job that is still in Master Review', async () => {
    const submitted = await seededJob(harness, 'EJE-1055');
    expect(submitted.status).toBe('submitted');
    expect(await jobNumbers(harness)).not.toContain('EJE-1055');
  });

  it('does not list a cancelled job, because it never happened', async () => {
    const cancelled = await seededJob(harness, 'EJE-1045');
    expect(cancelled.status).toBe('cancelled');
    expect(isArchivedJob(cancelled)).toBe(false);
    expect(await jobNumbers(harness)).not.toContain('EJE-1045');
  });

  it('does not list a job cancelled during this session either', async () => {
    const open = await seededJob(harness, 'EJE-1058');
    await cancelJob(harness.as(master), open, {
      reason: 'duplicate',
      description: 'Raised twice by the office.',
    });
    expect(await jobNumbers(harness)).not.toContain('EJE-1058');
  });

  /*
   * REWRITTEN FOR THE CONFIRMED BUSINESS DECISION.
   *
   * This asserted that the archive excluded a job MARKED deleted. There is no
   * such state any more: a deleted job is removed, so the property to hold is
   * simply that a removed job is not in the archive.
   *
   * Deleting a closed job is refused by the workflow — only an unaccepted job
   * may be deleted — so this drives the repository directly. The archive must
   * not list what is not there.
   */
  it('does not list a job that has been removed', async () => {
    const closed = await seededJob(harness, 'EJE-1057');
    expect(await jobNumbers(harness)).toContain('EJE-1057');

    await harness.repos.jobs.delete(closed.id);

    expect(await jobNumbers(harness)).not.toContain('EJE-1057');
  });

  it('puts the most recently closed job first', async () => {
    const page = await loadClosedJobs(harness.repos, master, filters());
    const closedAts = page.rows.map((row) => row.job.closedAt ?? '');
    const descending = [...closedAts].sort((a, b) => b.localeCompare(a));
    expect(closedAts).toEqual(descending);
  });

  it('reports how many matched and whether the page was capped', async () => {
    const page = await loadClosedJobs(harness.repos, master, filters());
    expect(page.matched).toBe(page.rows.length);
    expect(page.truncated).toBe(false);
    expect(page.matched).toBeLessThan(CLOSED_JOBS_PAGE_SIZE);

    // A page smaller than the archive must say so rather than imply the rest
    // does not exist.
    const capped = await loadClosedJobs(harness.repos, master, filters(), 2);
    expect(capped.rows).toHaveLength(2);
    expect(capped.matched).toBe(page.matched);
    expect(capped.truncated).toBe(true);
  });
});

describe('finding a closed job again', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('finds it by job number', async () => {
    expect(await jobNumbers(harness, { term: 'EJE-1056' })).toEqual(['EJE-1056']);
  });

  it('finds it by job number without the prefix, and ignoring case', async () => {
    expect(await jobNumbers(harness, { term: '1056' })).toEqual(['EJE-1056']);
    expect(await jobNumbers(harness, { term: 'eje-1056' })).toEqual(['EJE-1056']);
  });

  it('finds every closed job for a customer by name', async () => {
    const found = await jobNumbers(harness, { term: 'Kruger' });
    expect(found).toContain('EJE-1057');
    expect(found).not.toContain('EJE-1039');
  });

  it('finds it by site', async () => {
    const found = await jobNumbers(harness, { term: 'Midrand Line 2' });
    expect(found).toEqual(['EJE-1039']);
  });

  it('finds it by machine serial number', async () => {
    const found = await jobNumbers(harness, { term: 'HA-VF2-11742' });
    expect(found).toEqual(['EJE-1057']);
  });

  it('finds it by machine make and model', async () => {
    const found = await jobNumbers(harness, { term: 'Haas' });
    expect(found).toContain('EJE-1057');
  });

  it('finds it by customer order number', async () => {
    expect(await jobNumbers(harness, { term: 'PO-87740' })).toEqual(['EJE-1056']);
  });

  it('finds it by EJE reference number', async () => {
    expect(await jobNumbers(harness, { term: 'ABC-SVC-JHB-06' })).toEqual(['EJE-1044']);
  });

  it('finds it by the technician who did the work', async () => {
    const found = await jobNumbers(harness, { term: 'Francois' });
    expect(found).toEqual(['EJE-1039']);
  });

  it('returns nothing, rather than everything, for a term that matches nothing', async () => {
    const page = await loadClosedJobs(harness.repos, master, filters({ term: 'no-such-thing' }));
    expect(page.rows).toEqual([]);
    expect(page.matched).toBe(0);
  });

  it('ignores surrounding whitespace', async () => {
    expect(await jobNumbers(harness, { term: '  EJE-1056  ' })).toEqual(['EJE-1056']);
  });
});

describe('narrowing the archive with filters', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('filters by customer', async () => {
    const found = await jobNumbers(harness, { customerId: 'cust-abc' });
    expect(found).toContain('EJE-1044');
    expect(found).toContain('EJE-1056');
    expect(found).not.toContain('EJE-1039');
  });

  it('filters by site', async () => {
    const found = await jobNumbers(harness, { siteId: 'site-abc-jhb' });
    expect(found).toContain('EJE-1056');
    expect(found).not.toContain('EJE-1057');
  });

  it('filters by job type', async () => {
    expect(await jobNumbers(harness, { jobType: 'installation' })).toEqual(['EJE-1039']);
    expect(await jobNumbers(harness, { jobType: 'parts' })).toEqual(['EJE-1062']);
  });

  it('filters by technician', async () => {
    const found = await jobNumbers(harness, { technicianId: 'user-tech-deon' });
    expect(found).toEqual(['EJE-1057']);
  });

  it('filters by an additional technician, not only the primary one', async () => {
    // EJE-1039 was installed by Francois with Thabo as a second technician.
    // Thabo was on the job, so Thabo's name has to find it.
    const closed = await seededJob(harness, 'EJE-1039');
    expect(closed.primaryTechnicianId).not.toBe('user-tech-thabo');
    expect(closed.additionalTechnicianIds).toContain('user-tech-thabo');

    const found = await jobNumbers(harness, { technicianId: 'user-tech-thabo' });
    expect(found).toEqual(['EJE-1039']);
  });

  it('filters by closed date, inclusively at both ends', async () => {
    const all = await loadClosedJobs(harness.repos, master, filters());
    const target = all.rows.find((row) => row.job.jobNumber === 'EJE-1056');
    const day = (target?.job.closedAt ?? '').slice(0, 10);
    expect(day).not.toBe('');

    const exact = await jobNumbers(harness, { closedFrom: day, closedTo: day });
    expect(exact).toEqual(['EJE-1056']);
  });

  it('excludes a job closed before the from-date', async () => {
    const found = await jobNumbers(harness, { closedFrom: '2026-09-01' });
    // EJE-1062 was closed two days ago; EJE-1044 six months ago.
    expect(found).toContain('EJE-1062');
    expect(found).not.toContain('EJE-1044');
  });

  it('excludes a job closed after the to-date', async () => {
    const found = await jobNumbers(harness, { closedTo: '2026-04-01' });
    expect(found).toContain('EJE-1044');
    expect(found).not.toContain('EJE-1062');
  });

  it('combines a search term with filters, rather than choosing one', async () => {
    const found = await jobNumbers(harness, { term: 'ABC', jobType: 'parts' });
    expect(found).toEqual(['EJE-1062']);
  });

  it('offers the customers, sites and technicians the filters need', async () => {
    const page = await loadClosedJobs(harness.repos, master, filters());
    expect(page.customers.length).toBeGreaterThan(0);
    expect(page.sites.some((site) => site.customerId === 'cust-abc')).toBe(true);
    expect(page.technicians.every((user) => user.role === 'technician')).toBe(true);
    // Sites carry their customer so the screen can narrow one by the other.
    expect(page.sites.every((site) => site.customerId.length > 0)).toBe(true);
  });
});

describe('opening a closed job', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('returns the complete historical record', async () => {
    const view = await loadJobView(harness.repos, 'EJE-1044');
    expect(view).not.toBeNull();
    const { job } = view!;

    expect(job.status).toBe('closed');
    expect(view!.customer.name).toContain('ABC Engineering');
    expect(view!.site.name).toBe('Johannesburg');
    expect(view!.machine?.serialNumber).toBe('LW-V40-70214');
    expect(view!.primaryTechnician?.firstName).toBe('Riaan');
    expect(job.labour.length).toBeGreaterThan(0);
    expect(job.completionReport.workPerformed.length).toBeGreaterThan(0);
    expect(job.signature).not.toBeNull();
    expect(job.checklist).not.toBeNull();
    expect(job.closedAt).not.toBeNull();
  });

  it('is read-only, for a Master as well as a technician', async () => {
    const closed = await seededJob(harness, 'EJE-1044');
    expect(canEditJob('master', closed.status)).toBe(false);
    expect(canEditJob('technician', closed.status)).toBe(false);
  });

  it('keeps its own signature rather than the current one', async () => {
    const closed = await seededJob(harness, 'EJE-1044');
    expect(closed.signature?.customerName).toBe('Pieter');
    expect(closed.signature?.signedAt).not.toBeNull();
    expect(closed.signature?.declaration.length).toBeGreaterThan(0);
  });

  it('keeps its own pricing when the Master later changes the rates', async () => {
    const closed = await seededJob(harness, 'EJE-1044');
    const before = calculateJobTotals(closed, await harness.repos.settings.get());
    expect(before.priceFrozen).toBe(true);

    await harness.repos.settings.save({
      ...(await harness.repos.settings.get()),
      labourRates: { normal: 250000, overtime: 375000, double: 500000 },
      calloutRate: 200000,
      kilometreRate: 5000,
      vatPercentage: 25,
    });

    const reopened = await seededJob(harness, 'EJE-1044');
    const after = calculateJobTotals(reopened, await harness.repos.settings.get());

    expect(after.total).toBe(before.total);
    expect(after.labourTotal).toBe(before.labourTotal);
    expect(after.vat).toBe(before.vat);
    expect(after.pricing.vatPercentage).toBe(before.pricing.vatPercentage);
  });

  it('every closed job carries the rates it was priced at', async () => {
    const page = await loadClosedJobs(harness.repos, master, filters());
    expect(page.rows.length).toBeGreaterThan(0);
    for (const row of page.rows) {
      /*
       * Without a snapshot an old job card would silently re-price at today's
       * rates, changing an invoice that has already been issued.
       *
       * The snapshot now travels on the ARCHIVE ROW rather than inside the job
       * summary — a summary is structurally price-free, and this screen is
       * office-only. The requirement is word for word the same: every closed
       * row carries the price the job was issued at.
       */
      expect(row.pricingSnapshot, row.job.jobNumber).not.toBeNull();
    }
  });

  it('keeps its own checklist version when a new version is issued', async () => {
    const before = await loadJobView(harness.repos, 'EJE-1044');
    const originalVersion = before!.job.checklist?.templateVersion;
    const originalWording = before!.checklistTemplate?.sections[0]?.items[0]?.text;
    expect(originalVersion).toBe('1.0-DEMO');
    expect(originalWording).toBeDefined();

    const templates = await harness.repos.checklistTemplates.list();
    const current = templates.find(
      (template) => template.jobTypeCode === 'service' && template.status === 'current',
    );
    expect(current).toBeDefined();

    const masterContext = harness.as(master);
    const draft = await startNewVersion(masterContext, current!);
    const rewritten = {
      ...draft,
      sections: draft.sections.map((section, index) =>
        index === 0
          ? {
              ...section,
              items: section.items.map((item, itemIndex) =>
                itemIndex === 0 ? { ...item, text: 'COMPLETELY REWORDED ITEM' } : item,
              ),
            }
          : section,
      ),
    };
    await publishTemplate(masterContext, rewritten);

    const after = await loadJobView(harness.repos, 'EJE-1044');
    expect(after!.job.checklist?.templateVersion).toBe(originalVersion);
    expect(after!.checklistTemplate?.version).toBe(originalVersion);
    expect(after!.checklistTemplate?.sections[0]?.items[0]?.text).toBe(originalWording);
    expect(after!.checklistVersionMissing).toBe(false);
  });
});

describe('the final document on a closed job', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('is stored on every closed job, so it never has to be re-made', async () => {
    const page = await loadClosedJobs(harness.repos, master, filters());
    for (const row of page.rows) {
      expect(row.job.finalDocument, row.job.jobNumber).not.toBeNull();
    }
  });

  it('is named after the job, and says it is the final copy', async () => {
    const closed = await seededJob(harness, 'EJE-1044');
    expect(closed.finalDocument?.fileName).toBe('EJE-1044-Final-Job-Card.pdf');
  });

  it('names a parts collection as a collection note, not a job card', async () => {
    const closed = await seededJob(harness, 'EJE-1062');
    expect(closed.finalDocument?.fileName).toBe('EJE-1062-Final-Parts-Collection-Note.pdf');
  });

  it('records who issued it, when, and where it went', async () => {
    const closed = await seededJob(harness, 'EJE-1044');
    const document = closed.finalDocument!;
    expect(document.generatedBy).toBe('user-master-elmarie');
    expect(document.generatedAt).not.toBe('');
    expect(document.issuedTo).toContain('@');
    // The demo renders no file server-side, and says so rather than pretending.
    expect(document.simulated).toBe(true);
    expect(document.pageCount).toBeGreaterThan(0);
  });

  it('does not change when the job is read again', async () => {
    const first = await loadJobView(harness.repos, 'EJE-1044');
    const second = await loadJobView(harness.repos, 'EJE-1044');
    expect(second!.job.finalDocument).toEqual(first!.job.finalDocument);
  });

  it('is unaffected by a later rate change', async () => {
    const before = (await seededJob(harness, 'EJE-1044')).finalDocument;
    await harness.repos.settings.save({
      ...(await harness.repos.settings.get()),
      labourRates: { normal: 250000, overtime: 375000, double: 500000 },
    });
    expect((await seededJob(harness, 'EJE-1044')).finalDocument).toEqual(before);
  });
});

describe('history links', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('reaches the same closed job record from the customer, the site and the machine', async () => {
    const archived = await loadClosedJobs(harness.repos, master, filters({ term: 'EJE-1044' }));
    const fromArchive = archived.rows[0]?.job;
    expect(fromArchive).toBeDefined();

    // The three history lists a screen renders, each read the way its page
    // reads it.
    const byCustomer = await harness.repos.jobs.list({ customerId: fromArchive!.customerId });
    // The customer screen derives its per-site history from the same rows.
    const bySite = byCustomer.filter((job) => job.siteId === fromArchive!.siteId);
    const byMachine = await harness.repos.jobs.list({ machineId: fromArchive!.machineId! });

    for (const [label, rows] of [
      ['customer', byCustomer],
      ['site', bySite],
      ['machine', byMachine],
    ] as const) {
      const matches = rows.filter((job) => job.jobNumber === 'EJE-1044');
      // Exactly one: a closed job must not be duplicated by a second archive
      // record living alongside the original.
      expect(matches, label).toHaveLength(1);
      expect(matches[0]!.id, label).toBe(fromArchive!.id);
      /*
       * The archive row is a SUMMARY of the stored job, so narrowing the
       * stored job must reproduce it exactly. Comparing the two shapes
       * directly would only prove they have different numbers of keys.
       */
      expect(toJobSummary(matches[0]!), label).toEqual(fromArchive);
    }
  });

  it('holds one record per closed job across the whole archive', async () => {
    const page = await loadClosedJobs(harness.repos, master, filters());
    const numbers = page.rows.map((row) => row.job.jobNumber);
    expect(new Set(numbers).size).toBe(numbers.length);
    const ids = page.rows.map((row) => row.job.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
