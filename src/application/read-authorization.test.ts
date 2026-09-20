import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptJob,
  addLabour,
  recordSignatureRefusal,
  saveCompletionReport,
  startCompletion,
  startSignature,
} from './job-operations';
import { loadActivityFeed, loadJobActivity } from './activity-read';
import { loadClosedJobs } from './closed-jobs';
import { emptyClosedJobFilters } from './closed-jobs';
import { runSearch } from './search';
import { loadJobView } from './job-view';
import { buildHarness, seedUser, type Harness } from './test-harness';
import { currentRefusal, type Job } from '@/domain';

/**
 * Reads are authorised by the function that performs them.
 *
 * The audit that produced this file found the same shape of hole in four
 * places: the rule existed, the screen consulted it, and the READ did not. A
 * technician could therefore reach the data by typing a URL, and in Phase 2 —
 * where these functions become API handlers and the screen is not in the
 * request path at all — by calling the endpoint.
 *
 * The leak that mattered most was the customer's refusal reason. It was
 * correctly redacted off the job record and correctly hidden on the job screen,
 * and then written verbatim into an audit event, which nothing redacted and
 * which every signed-in user could read on `/activity` and on any job's
 * Activity tab. Two copies of one fact under two sets of rules, and the looser
 * one won.
 *
 * Every test below therefore uses a unique marker string and asserts on the
 * MARKER rather than on a shape, so nothing can pass by returning a differently
 * worded leak.
 */

const technicianA = seedUser('user-tech-sipho');
const technicianB = seedUser('user-tech-lerato');
const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');

/**
 * A marker that cannot occur anywhere else in the demo data.
 *
 * Searched for across whole payloads, so a leak through a field nobody thought
 * to check is still a failure.
 */
const SECRET = 'AUDIT-MARKER-7f3c the site manager walked off before signing';

const REFUSED_JOB = 'EJE-1048';

/** Drives EJE-1048 to a refusal, recorded by technician A on her own job. */
const refuseAsTechnicianA = async (harness: Harness): Promise<Job> => {
  const context = harness.as(technicianA);
  const opened = await harness.repos.jobs.findByJobNumber(REFUSED_JOB);
  let job = await acceptJob(context, opened!);
  job = await saveCompletionReport(context, job, {
    ...job.completionReport,
    workPerformed: 'Replaced the spindle drive cooling fan.',
  });
  job = await addLabour(context, job, {
    date: '2026-09-17',
    rateType: 'normal',
    hours: 2,
    description: 'Spindle drive repair',
  });
  job = await startCompletion(context, job);
  job = await startSignature(context, job);
  return recordSignatureRefusal(context, job, { reason: SECRET });
};

describe('a customer’s refusal reason, and who may read it', () => {
  let harness: Harness;
  let refused: Job;

  beforeEach(async () => {
    harness = buildHarness();
    refused = await refuseAsTechnicianA(harness);
    // The premise: it really was recorded, and really is on the job.
    expect(currentRefusal(refused)?.reason).toBe(SECRET);
  });

  it('is not written into the audit trail at all', async () => {
    // The raw repository, deliberately: whatever is stored is what every
    // present and future read path has to be trusted not to leak.
    const events = await harness.repos.activity.list();
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });

  it('does not reach another technician through the job’s Activity tab', async () => {
    const events = await loadJobActivity(harness.repos, technicianB, refused.id);
    expect(JSON.stringify(events)).not.toContain(SECRET);
    // Not merely stripped of the reason: the refusal events are not hers to read.
    expect(events.some((event) => event.type === 'customer_refused_to_sign')).toBe(false);
  });

  it('does not reach another technician through the company-wide feed', async () => {
    // Which she cannot open at all — the strongest form of the same answer.
    await expect(loadActivityFeed(harness.repos, technicianB)).rejects.toThrow(/office record/i);
  });

  it('does not reach another technician through the job record', async () => {
    const view = await loadJobView(harness.repos, REFUSED_JOB, technicianB);
    expect(view?.job.signatureRefusals).toEqual([]);
    expect(JSON.stringify(view?.job)).not.toContain(SECRET);
  });

  it('does not reach another technician through global search', async () => {
    const results = await runSearch(harness.repos, technicianB, REFUSED_JOB);
    expect(JSON.stringify(results)).not.toContain(SECRET);
  });

  it('is still readable by the technician who recorded it', async () => {
    const view = await loadJobView(harness.repos, REFUSED_JOB, technicianA);
    expect(view?.job.signatureRefusals).toHaveLength(1);
    expect(currentRefusal(view!.job)?.reason).toBe(SECRET);

    // And the fact of it is on her job's own timeline.
    const events = await loadJobActivity(harness.repos, technicianA, refused.id);
    expect(events.some((event) => event.type === 'customer_refused_to_sign')).toBe(true);
  });

  it('is readable by a Master, on the job and on the trail', async () => {
    const view = await loadJobView(harness.repos, REFUSED_JOB, master);
    expect(currentRefusal(view!.job)?.reason).toBe(SECRET);

    const feed = await loadActivityFeed(harness.repos, master);
    expect(feed.events.some((event) => event.type === 'customer_refused_to_sign')).toBe(true);

    const events = await loadJobActivity(harness.repos, master, refused.id);
    expect(events.some((event) => event.type === 'customer_refused_to_sign')).toBe(true);
  });

  it('is readable by a Coordinator, who is the office too', async () => {
    const view = await loadJobView(harness.repos, REFUSED_JOB, coordinator);
    expect(currentRefusal(view!.job)?.reason).toBe(SECRET);

    const feed = await loadActivityFeed(harness.repos, coordinator);
    expect(feed.events.some((event) => event.type === 'customer_refused_to_sign')).toBe(true);
  });

  it('reaches the office as a notification, which is how they are told', async () => {
    // The reason genuinely does travel — to the people entitled to it, through
    // the per-recipient notification store rather than the shared trail.
    const forMaster = await harness.repos.notifications.list(master.id);
    const forCoordinator = await harness.repos.notifications.list(coordinator.id);
    const forOtherTechnician = await harness.repos.notifications.list(technicianB.id);

    expect(JSON.stringify(forMaster)).toContain(SECRET);
    expect(JSON.stringify(forCoordinator)).toContain(SECRET);
    expect(JSON.stringify(forOtherTechnician)).not.toContain(SECRET);
  });
});

describe('the company-wide audit trail', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('refuses a technician, rather than returning a filtered page', async () => {
    await expect(loadActivityFeed(harness.repos, technicianA)).rejects.toThrow(/office record/i);
  });

  it('opens for a Master', async () => {
    const feed = await loadActivityFeed(harness.repos, master);
    expect(feed.events.length).toBeGreaterThan(0);
    expect(feed.users.length).toBeGreaterThan(0);
  });

  it('opens for a Coordinator, who runs the office', async () => {
    const feed = await loadActivityFeed(harness.repos, coordinator);
    expect(feed.events.length).toBeGreaterThan(0);
  });
});

describe('the closed-job archive', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('refuses a technician inside the read, not on the screen', async () => {
    await expect(
      loadClosedJobs(harness.repos, technicianA, emptyClosedJobFilters),
    ).rejects.toThrow(/office screen/i);
  });

  it('opens for the office', async () => {
    const forMaster = await loadClosedJobs(harness.repos, master, emptyClosedJobFilters);
    const forCoordinator = await loadClosedJobs(
      harness.repos,
      coordinator,
      emptyClosedJobFilters,
    );
    expect(forMaster.rows.length).toBeGreaterThan(0);
    expect(forCoordinator.rows.length).toBe(forMaster.rows.length);
  });
});

describe('global search, scoped by who is asking', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  /** Searches for a seeded colleague by name. */
  const findPeople = async (actor: Parameters<typeof runSearch>[1]) =>
    (await runSearch(harness.repos, actor, 'Riaan')).filter(
      (result) => result.category === 'technician',
    );

  it('does not hand a technician the staff register', async () => {
    expect(await findPeople(technicianA)).toHaveLength(0);

    // Not by email address either, which is the other way in.
    const byEmail = await runSearch(harness.repos, technicianA, 'riaan.vanwyk@eje-demo.co.za');
    expect(byEmail.filter((result) => result.category === 'technician')).toHaveLength(0);
  });

  it('hands it to the office, which administers people', async () => {
    expect((await findPeople(master)).length).toBeGreaterThan(0);
    expect((await findPeople(coordinator)).length).toBeGreaterThan(0);
  });

  it('does not hand a technician soft-deleted jobs', async () => {
    const deleted = await harness.repos.jobs.findByJobNumber('EJE-1048');
    await harness.repos.jobs.save({
      ...deleted!,
      deletedAt: '2026-09-18T09:00:00.000Z',
      deletedBy: master.id,
      deletionReason: 'Raised against the wrong machine.',
    });

    const forTechnician = await runSearch(harness.repos, technicianA, 'EJE-1048');
    expect(forTechnician.filter((result) => result.category === 'job')).toHaveLength(0);

    // The office still gets the answer to "where did EJE-1048 go?", labelled.
    const forMaster = await runSearch(harness.repos, master, 'EJE-1048');
    const jobs = forMaster.filter((result) => result.category === 'job');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.title).toContain('Deleted');
  });

  it('still finds live work for a technician, which is not what changed', async () => {
    const results = await runSearch(harness.repos, technicianA, 'EJE-1048');
    expect(results.some((result) => result.title.includes('EJE-1048'))).toBe(true);
  });
});
