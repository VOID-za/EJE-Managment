import { beforeEach, describe, expect, it } from 'vitest';
import { createJob, releaseDraft } from './job-creation';
import { WorkflowError } from './errors';
import { loadActiveJobList, loadJobList, loadJobView } from './job-view';
import { loadCalendar } from './calendar';
import type { OperationContext } from './context';
import { createDemoRepositories } from '@/data/demo/repositories';
import { DemoStore } from '@/data/demo/demo-store';
import { SimulatedEmailService } from '@/services/simulated/email';
import { SimulatedOutbox } from '@/services/simulated/outbox';
import { SimulatedPdfService } from '@/services/simulated/pdf';
import { inMemoryFileStore, DemoStorageService } from '@/services/simulated/storage';
import { SequentialIdGenerator, SystemClock } from '@/services/simulated/system';
import { SimulatedWhatsAppService } from '@/services/simulated/whatsapp';
import { seedUsers } from '@/data/seed';
import {
  asContactId,
  asCustomerId,
  asMachineId,
  asSiteId,
  type Job,
  type User,
} from '@/domain';
import type { RepositoryBundle } from '@/data/repositories';

/**
 * DRAFT JOBS, MASTER-ONLY. DRAFT-1.
 *
 * Creation always produced `open`, so there was no way to write a job card down
 * before it was a job — which is what an office does when a customer telephones
 * about work they have not yet confirmed.
 *
 * THE TWO RULES THIS IS BUILT ON, and both are asserted here rather than
 * described in a document:
 *
 *  1. A DRAFT MAY OMIT WHAT THE TECHNICIAN STILL HAS TO SUPPLY — the fault
 *     description and the machine — and nothing else. Who it is FOR is still
 *     required, because a draft addressed to nobody is not a draft of a job
 *     card.
 *  2. RELEASING RE-ASKS EVERY ONE OF THEM, against the job as it now stands.
 *     The validation is deferred, never weakened: the same function runs in
 *     both places, so there is one rule and not two copies of it.
 *
 * AND A DRAFT IS INVISIBLE TO EVERYBODY ELSE, including a Coordinator who may
 * otherwise read every job in the business, and including a technician named on
 * one as an intention.
 */
const master = seedUsers.find((user) => user.role === 'master')!;
const coordinator = seedUsers.find((user) => user.role === 'coordinator')!;
const technician = seedUsers.find((user) => user.id === 'user-tech-sipho')!;

interface Harness {
  readonly repos: RepositoryBundle;
  as(actor: User): OperationContext;
}

const build = (): Harness => {
  const store = new DemoStore();
  const repos = createDemoRepositories({ read: store.read, commit: store.commit });
  const clock = new SystemClock();
  const ids = new SequentialIdGenerator();
  const outbox = new SimulatedOutbox();
  const services = {
    clock,
    ids,
    email: new SimulatedEmailService(outbox, clock, ids),
    whatsapp: new SimulatedWhatsAppService(outbox, clock, ids),
    pdf: new SimulatedPdfService(clock),
    storage: new DemoStorageService(inMemoryFileStore()),
  };
  return { repos, as: (actor: User) => ({ repos, actor, services }) };
};

/** A real customer, site, contact and machine from the demonstration register. */
const target = async (harness: Harness) => {
  const customers = await harness.repos.customers.list();
  const customer = customers[0]!;
  const sites = await harness.repos.customers.listSites(customer.id);
  const site = sites[0]!;
  const contacts = await harness.repos.customers.listContacts(customer.id);
  const contact = contacts[0]!;
  const machines = await harness.repos.machines.list();
  const machine = machines.find((candidate) => candidate.customerId === customer.id)!;
  return {
    customerId: asCustomerId(customer.id),
    siteId: asSiteId(site.id),
    contactId: asContactId(contact.id),
    machineId: asMachineId(machine.id),
  };
};

const input = async (harness: Harness, over: Record<string, unknown> = {}) => ({
  ...(await target(harness)),
  jobType: 'breakdown' as const,
  priority: 'normal' as const,
  scheduledDate: null,
  scheduledEndDate: null,
  orderNumber: '',
  referenceNumber: '',
  faultDescription: 'Spindle will not start.',
  primaryTechnicianId: null,
  additionalTechnicianIds: [],
  courierCollection: false,
  deliveryNote: '',
  ...over,
});

describe('drafting a job', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = build();
  });

  it('is REFUSED to a Coordinator and to a technician', async () => {
    for (const actor of [coordinator, technician]) {
      await expect(
        createJob(harness.as(actor), await input(harness), { asDraft: true }),
        actor.role,
      ).rejects.toThrow(WorkflowError);
    }
  });

  it('produces a job at `draft`, not at `open`', async () => {
    const job = await createJob(harness.as(master), await input(harness), { asDraft: true });
    expect(job.status).toBe('draft');
  });

  it('still produces an OPEN job when nobody asked for a draft', async () => {
    // The default, so every existing client keeps working exactly as it did.
    const job = await createJob(harness.as(master), await input(harness));
    expect(job.status).toBe('open');
  });

  it('may be saved with NO fault description and NO machine', async () => {
    /*
     * The two facts the technician or the customer still has to supply. A
     * Master writing a job card down while the customer is still on the
     * telephone has neither.
     */
    const job = await createJob(
      harness.as(master),
      await input(harness, { faultDescription: '', machineId: null }),
      { asDraft: true },
    );

    expect(job.status).toBe('draft');
    expect(job.faultDescription).toBe('');
    expect(job.machineId).toBeNull();
  });

  it('still REFUSES a draft with no customer, site or contact', async () => {
    // What is NOT relaxed. A draft addressed to nobody is not a draft of a job
    // card, and the register is resolved exactly as it always was.
    await expect(
      createJob(
        harness.as(master),
        await input(harness, { siteId: asSiteId('site-that-does-not-exist') }),
        { asDraft: true },
      ),
    ).rejects.toThrow(WorkflowError);
  });

  it('takes a job number, because a draft is a job that was raised', async () => {
    const job = await createJob(harness.as(master), await input(harness), { asDraft: true });
    expect(job.jobNumber.length).toBeGreaterThan(0);
  });

  it('TELLS NOBODY, even when it names the technician the Master has in mind', async () => {
    /*
     * "You are on EJE-1103 tomorrow" about a job that may never be raised is
     * worse than hearing it a day later. The draft carries the intention; the
     * release sends the message.
     */
    const job = await createJob(
      harness.as(master),
      await input(harness, { primaryTechnicianId: technician.id }),
      { asDraft: true },
    );

    expect(job.primaryTechnicianId).toBe(technician.id);
    const events = await harness.repos.activity.list(job.id);
    expect(events.some((event) => event.type === 'job_assigned')).toBe(false);
    const notifications = await harness.repos.notifications.list(technician.id);
    expect(notifications.some((notice) => notice.jobId === job.id)).toBe(false);
  });

  it('says on the trail that it was DRAFTED and not raised', async () => {
    const job = await createJob(harness.as(master), await input(harness), { asDraft: true });
    const events = await harness.repos.activity.list(job.id);
    const created = events.find((event) => event.type === 'job_created');
    expect(created?.summary).toMatch(/[Dd]raft/u);
    expect(created?.detail).toMatch(/not yet open/u);
  });
});

describe('a draft is invisible to everybody but a Master', () => {
  let harness: Harness;
  let draft: Job;

  beforeEach(async () => {
    harness = build();
    draft = await createJob(
      harness.as(master),
      await input(harness, { primaryTechnicianId: technician.id }),
      { asDraft: true },
    );
  });

  it('is absent from a COORDINATOR’s job list, who sees every other job', async () => {
    /*
     * The one that matters most, because a Coordinator holds `jobs.viewAll` and
     * every list read short-circuits on it. A draft on the office screen would
     * be work that may never be raised, with nothing the Coordinator could do
     * about it — the requirement says Master-only and this is what that means.
     */
    const rows = await loadJobList(harness.repos, coordinator);
    expect(rows.some((row) => row.job.id === draft.id)).toBe(false);

    const active = await loadActiveJobList(harness.repos, coordinator);
    expect(active.some((row) => row.job.id === draft.id)).toBe(false);
  });

  it('IS in a Master’s list', async () => {
    const rows = await loadActiveJobList(harness.repos, master);
    expect(rows.some((row) => row.job.id === draft.id)).toBe(true);
  });

  it('is absent from the list of the TECHNICIAN named on it', async () => {
    const rows = await loadActiveJobList(harness.repos, technician);
    expect(rows.some((row) => row.job.id === draft.id)).toBe(false);
  });

  it('is not on the calendar, even for a Master', async () => {
    /*
     * A date on a draft is an intention. Drawing it as a bar would have a
     * planner counting a technician as busy on a day nobody has promised them
     * to anybody.
     */
    const dated = await createJob(
      harness.as(master),
      await input(harness, { scheduledDate: '2026-11-03' }),
      { asDraft: true },
    );
    const calendar = await loadCalendar(
      harness.repos,
      { from: '2026-11-01', to: '2026-11-30' },
      master,
    );
    expect(calendar.entries.some((entry) => entry.id === `job-${dated.id}`)).toBe(false);
  });
});

describe('releasing a draft', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = build();
  });

  const draftOf = async (over: Record<string, unknown> = {}): Promise<Job> =>
    createJob(harness.as(master), await input(harness, over), { asDraft: true });

  it('is REFUSED to a Coordinator', async () => {
    const draft = await draftOf();
    await expect(releaseDraft(harness.as(coordinator), draft)).rejects.toThrow(WorkflowError);
  });

  it('opens the job, and the technician on it is told', async () => {
    const draft = await draftOf({ primaryTechnicianId: technician.id });
    const released = await releaseDraft(harness.as(master), draft);

    expect(released.status).toBe('open');
    const events = await harness.repos.activity.list(released.id);
    expect(events.some((event) => event.type === 'job_assigned')).toBe(true);
    const notifications = await harness.repos.notifications.list(technician.id);
    expect(notifications.some((notice) => notice.jobId === released.id)).toBe(true);
  });

  it('KEEPS THE JOB NUMBER, so releasing does not move the sequence', async () => {
    const draft = await draftOf();
    const released = await releaseDraft(harness.as(master), draft);
    expect(released.jobNumber).toBe(draft.jobNumber);
  });

  it('RE-ASKS for the fault description that the draft was let off', async () => {
    /*
     * The assertion the whole design rests on. A draft may be saved without
     * one; it may not BECOME a job without one, and the refusal comes from the
     * same function that refuses it at creation.
     */
    const draft = await draftOf({ faultDescription: '' });
    await expect(releaseDraft(harness.as(master), draft)).rejects.toThrow(WorkflowError);
    // And it is still a draft afterwards — a refused release changes nothing.
    const view = await loadJobView(harness.repos, draft.jobNumber);
    expect(view?.job.status).toBe('draft');
  });

  it('RE-ASKS for the machine too', async () => {
    const draft = await draftOf({ machineId: null });
    await expect(releaseDraft(harness.as(master), draft)).rejects.toThrow(WorkflowError);
  });

  it('refuses to release something that is not a draft', async () => {
    const open = await createJob(harness.as(master), await input(harness));
    await expect(releaseDraft(harness.as(master), open)).rejects.toThrow(WorkflowError);
  });

  it('refuses a SECOND release of the same draft', async () => {
    // A stale screen pressing twice must be told, not answered with success.
    const draft = await draftOf();
    const released = await releaseDraft(harness.as(master), draft);
    await expect(releaseDraft(harness.as(master), released)).rejects.toThrow(WorkflowError);
  });

  it('becomes visible to the technician it was released to', async () => {
    const draft = await draftOf({ primaryTechnicianId: technician.id });
    const released = await releaseDraft(harness.as(master), draft);

    const rows = await loadActiveJobList(harness.repos, technician);
    expect(rows.some((row) => row.job.id === released.id)).toBe(true);
  });

  it('records the release on the trail', async () => {
    const draft = await draftOf();
    const released = await releaseDraft(harness.as(master), draft);
    const events = await harness.repos.activity.list(released.id);
    expect(events.some((event) => event.summary.includes('Draft released'))).toBe(true);
  });
});
