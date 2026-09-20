import { beforeEach, describe, expect, it } from 'vitest';
import { loadJobActivity } from './activity-read';
import { loadJobList, loadJobView } from './job-view';
import { runSearch } from './search';
import { buildHarness, seedUser, type Harness } from './test-harness';

/**
 * DECISION 5, at the read boundary.
 *
 * The rule itself is tested in `src/domain/job/visibility.test.ts`. What these
 * hold is that the READS apply it — the list, the search, the job screen and a
 * job's own timeline — because that is where it can be got wrong. In the next
 * phase each of these functions is an API handler with no screen in the request
 * path at all, so a rule applied in a component is a rule that is not applied.
 *
 * Seeded facts these rely on:
 *   EJE-1048  open, assigned to Sipho        — his own work
 *   EJE-1067  in progress, Sipho             — his own work
 *   EJE-1056  closed, Sipho, machine-abc-lv40
 *   EJE-1061  in progress, Riaan             — somebody else's live job
 *   EJE-1059  open, nobody                   — the pool
 */
const sipho = seedUser('user-tech-sipho');
const lerato = seedUser('user-tech-lerato');
const coordinator = seedUser('user-coord-christene');
const master = seedUser('user-master-elmarie');

describe('the job list a technician is handed', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  const numbersFor = async (actor: typeof sipho): Promise<readonly string[]> =>
    (await loadJobList(harness.repos, actor)).map((row) => row.job.jobNumber);

  it('includes the work that is his', async () => {
    const numbers = await numbersFor(sipho);
    expect(numbers).toContain('EJE-1048');
    expect(numbers).toContain('EJE-1067');
  });

  it('includes the open pool, which is where a technician gets work', async () => {
    expect(await numbersFor(sipho)).toContain('EJE-1059');
  });

  it('leaves out another technician’s live job', async () => {
    expect(await numbersFor(sipho)).not.toContain('EJE-1061');
  });

  it('hands the office every job, which is unchanged', async () => {
    for (const actor of [master, coordinator]) {
      const numbers = await numbersFor(actor);
      expect(numbers).toContain('EJE-1061');
      expect(numbers).toContain('EJE-1048');
      // Including the cancelled work a technician is not shown.
      expect(numbers).toContain('EJE-1045');
    }
  });

  it('still keeps cancelled work off a technician’s tablet', async () => {
    expect(await numbersFor(sipho)).not.toContain('EJE-1045');
  });
});

describe('opening a job by its number', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('opens his own', async () => {
    const view = await loadJobView(harness.repos, 'EJE-1048', sipho);
    expect(view?.job.jobNumber).toBe('EJE-1048');
  });

  it('opens one from the pool, which he may accept', async () => {
    const view = await loadJobView(harness.repos, 'EJE-1059', sipho);
    expect(view?.job.jobNumber).toBe('EJE-1059');
  });

  it('answers a hand-typed URL for another technician’s job with nothing', async () => {
    // The same answer a job number that does not exist gives, which is the only
    // answer that does not confirm the job exists.
    expect(await loadJobView(harness.repos, 'EJE-1061', sipho)).toBeNull();
    expect(await loadJobView(harness.repos, 'EJE-9999', sipho)).toBeNull();
  });

  it('opens everything for the office', async () => {
    expect((await loadJobView(harness.repos, 'EJE-1061', coordinator))?.job.jobNumber).toBe(
      'EJE-1061',
    );
  });

  it('reads the whole record when no viewer is given, which is what operations need', async () => {
    // Rules have to be enforced against the truth, not against a redacted copy.
    const view = await loadJobView(harness.repos, 'EJE-1061');
    expect(view?.job.jobNumber).toBe('EJE-1061');
  });
});

describe('search, which is the same data reached a different way', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('does not find another technician’s live job by its number', async () => {
    const results = await runSearch(harness.repos, sipho, 'EJE-1061');
    expect(results.filter((result) => result.category === 'job')).toHaveLength(0);
  });

  it('finds it for the office', async () => {
    const results = await runSearch(harness.repos, coordinator, 'EJE-1061');
    expect(results.some((result) => result.title.includes('EJE-1061'))).toBe(true);
  });

  it('still finds his own work, and the pool', async () => {
    expect(
      (await runSearch(harness.repos, sipho, 'EJE-1048')).some((result) =>
        result.title.includes('EJE-1048'),
      ),
    ).toBe(true);
    expect(
      (await runSearch(harness.repos, sipho, 'EJE-1059')).some((result) =>
        result.title.includes('EJE-1059'),
      ),
    ).toBe(true);
  });

  it('does not leak a withheld job through a customer or a fault description', async () => {
    // Searching for words that occur on somebody else's job must not surface it
    // under a different match reason.
    const results = await runSearch(harness.repos, sipho, 'Tool changer jamming');
    expect(results.filter((result) => result.category === 'job')).toHaveLength(0);
  });
});

describe('a job’s own timeline', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('is empty for somebody who may not open the job', async () => {
    const withheld = await harness.repos.jobs.findByJobNumber('EJE-1061');
    expect(await loadJobActivity(harness.repos, sipho, withheld!.id)).toEqual([]);
  });

  it('is there for the technician whose job it is', async () => {
    const mine = await harness.repos.jobs.findByJobNumber('EJE-1048');
    const events = await loadJobActivity(harness.repos, sipho, mine!.id);
    expect(events.length).toBeGreaterThan(0);
  });

  it('is there for the office', async () => {
    const withheld = await harness.repos.jobs.findByJobNumber('EJE-1061');
    const events = await loadJobActivity(harness.repos, master, withheld!.id);
    expect(events.length).toBeGreaterThan(0);
  });

  it('withholds a deleted job’s trail from a technician, and keeps it for the office', async () => {
    const job = await harness.repos.jobs.findByJobNumber('EJE-1048');
    const id = job!.id;
    await harness.repos.jobs.delete(id);

    expect(await loadJobActivity(harness.repos, sipho, id)).toEqual([]);
    // DECISION 6: the trail survives the job, and the office is where it lives.
    expect((await loadJobActivity(harness.repos, master, id)).length).toBeGreaterThan(0);
  });
});

describe('a technician who is on somebody else’s job as an extra pair of hands', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('may read it, because they are on it', async () => {
    const job = await harness.repos.jobs.findByJobNumber('EJE-1061');
    await harness.repos.jobs.save({ ...job!, additionalTechnicianIds: [lerato.id] });

    const view = await loadJobView(harness.repos, 'EJE-1061', lerato);
    expect(view?.job.jobNumber).toBe('EJE-1061');

    const numbers = (await loadJobList(harness.repos, lerato)).map((row) => row.job.jobNumber);
    expect(numbers).toContain('EJE-1061');
  });
});
