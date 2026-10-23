import { beforeEach, describe, expect, it } from 'vitest';
import { loadJobView } from './job-view';
import { updateMachine } from './machine-operations';
import { applyDiscount } from './job-operations';
import { WorkflowError } from './errors';
import type { OperationContext } from './context';
import { createDemoRepositories } from '@/data/demo/repositories';
import { DemoStore } from '@/data/demo/demo-store';
import { SimulatedEmailService } from '@/services/simulated/email';
import { SimulatedOutbox } from '@/services/simulated/outbox';
import { SimulatedPdfService } from '@/services/simulated/pdf';
import { builtinPdfText } from '@/services/pdf-text';
import { inMemoryFileStore, DemoStorageService } from '@/services/simulated/storage';
import { SequentialIdGenerator, SystemClock } from '@/services/simulated/system';
import { SimulatedWhatsAppService } from '@/services/simulated/whatsapp';
import { seedUsers } from '@/data/seed';
import { can, type User } from '@/domain';
import type { RepositoryBundle } from '@/data/repositories';

/**
 * BD-19 AND BD-20, BOTH ANSWERED BY THE OWNER ON 23 OCTOBER 2026.
 *
 * BD-19 — WHAT SHAPE IS A DISCOUNT? A fixed amount, before VAT, MASTER ONLY —
 * which is exactly the shape that was built and recommended, so no code
 * changed. **The owner declined the Coordinator ceiling**, which was the one
 * alternative that would have needed a figure. These cases pin the answered
 * rule, including the absence of that authority, so a later "small
 * convenience" cannot grant it quietly.
 *
 * BD-20 — DOES A JOB SCREEN SHOW WHERE THE MACHINE STOOD AT THE TIME? Yes on a
 * CLOSED job; the current register on one in progress. And where the history
 * cannot answer, it says UNKNOWN rather than presenting today's register as
 * historical fact — which is the case that needed the owner's instruction,
 * because movement history starts empty and only records moves made from now
 * on.
 */
const master = seedUsers.find((user) => user.role === 'master')!;
const coordinator = seedUsers.find((user) => user.role === 'coordinator')!;
const technician = seedUsers.find((user) => user.role === 'technician')!;

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
    pdfText: builtinPdfText(),
    storage: new DemoStorageService(inMemoryFileStore()),
  };
  return { repos, as: (actor: User) => ({ repos, actor, services }) };
};

/** A closed job out of the demonstration data, with its machine. */
const closedJobView = async (harness: Harness) => {
  const closed = await harness.repos.jobs.listSummaries({ statuses: ['closed'] });
  for (const summary of closed) {
    const view = await loadJobView(harness.repos, summary.jobNumber);
    if (view?.machine !== null && view?.job.completedAt !== null) return view!;
  }
  throw new Error('the demonstration data has no closed job with a machine');
};

describe('BD-19: the discount rule, as answered', () => {
  it('is a MASTER’s alone — no Coordinator authority was granted', () => {
    expect(can(master.role, 'jobs.applyDiscount')).toBe(true);
    // The owner declined the Coordinator ceiling. This is the assertion that
    // makes granting it a deliberate act rather than a quiet convenience.
    expect(can(coordinator.role, 'jobs.applyDiscount')).toBe(false);
    expect(can(technician.role, 'jobs.applyDiscount')).toBe(false);
  });

  it('refuses a Coordinator at the operation, not merely in the screen', async () => {
    const harness = build();
    const job = (await loadJobView(harness.repos, 'EJE-1061'))!.job;

    const error = await applyDiscount(harness.as(coordinator), job, {
      amount: 5_000,
      reason: 'Goodwill',
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(WorkflowError);
    expect((error as WorkflowError).violations.map((v) => v.code)).toContain('not_permitted');
  });
});

describe('BD-20: a job in progress shows the register, not history', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = build();
  });

  it('resolves NOTHING historical for a job still being worked', async () => {
    const view = await loadJobView(harness.repos, 'EJE-1061');
    expect(view!.job.status).not.toBe('closed');
    // Null means "the screen shows the register", which is the owner's answer
    // for the in-progress case — and it also means no extra read.
    expect(view!.machineLocationAtWork).toBeNull();
  });
});

describe('BD-20: a closed job and a machine with no recorded moves', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = build();
  });

  it('says the location is NOT KNOWN rather than echoing today’s register', async () => {
    const view = await closedJobView(harness);
    const at = view.machineLocationAtWork;

    expect(at).not.toBeNull();
    expect(at!.known).toBe(false);
    if (at!.known) return;
    expect(at!.reason).toMatch(/not known/iu);
    // And it says where the register's answer comes from, so nobody reads the
    // card above it as history.
    expect(at!.reason).toMatch(/today/iu);
  });
});

describe('BD-20: a closed job and a machine that HAS moved', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = build();
  });

  it('names the site the machine stood at WHEN THE WORK WAS DONE', async () => {
    const view = await closedJobView(harness);
    const completedOn = view.job.completedAt!.slice(0, 10);
    const machine = view.machine!;
    const originalSiteId = machine.siteId;

    /*
     * A move recorded as having taken effect BEFORE the work, from the site the
     * machine is on today — so the historical answer is that same site, and
     * then a second move afterwards takes it somewhere else. That is the shape
     * that distinguishes "where it was" from "where it is".
     */
    const sites = await harness.repos.customers.listSites(machine.customerId);
    const elsewhere = sites.find((candidate) => candidate.id !== originalSiteId);
    expect(elsewhere).toBeDefined();

    await harness.repos.machines.saveMovement({
      id: 'mvmt-before-the-work',
      machineId: machine.id,
      fromSiteId: null,
      fromCustomerId: null,
      toSiteId: originalSiteId,
      toCustomerId: machine.customerId,
      effectiveOn: '2020-01-01',
      note: 'Installed.',
      recordedBy: master.id,
      recordedAt: '2020-01-01T08:00:00.000Z',
    });

    const before = (await loadJobView(harness.repos, view.job.jobNumber))!.machineLocationAtWork;
    expect(before!.known).toBe(true);
    if (!before!.known) return;
    expect(before!.siteId).toBe(originalSiteId);
    expect(before!.asAt).toBe(completedOn);
    expect(before!.movedSince).toBe(false);

    // Now move it, after the work. The historical answer must not change.
    await updateMachine(
      harness.as(master),
      { ...machine, siteId: elsewhere!.id },
      '2026-12-01',
      'Moved to the other works.',
    );

    const after = (await loadJobView(harness.repos, view.job.jobNumber))!.machineLocationAtWork;
    expect(after!.known).toBe(true);
    if (!after!.known) return;
    // STILL the site it was at when the work happened.
    expect(after!.siteId).toBe(originalSiteId);
    // And the screen can say it has moved on.
    expect(after!.movedSince).toBe(true);
  });

  it('reports a move that took effect AFTER the work as not knowable', async () => {
    const view = await closedJobView(harness);
    const machine = view.machine!;
    const sites = await harness.repos.customers.listSites(machine.customerId);
    const elsewhere = sites.find((candidate) => candidate.id !== machine.siteId);

    // The only recorded move is later than the job, so the history genuinely
    // cannot say where the machine was at the time.
    await harness.repos.machines.saveMovement({
      id: 'mvmt-after-the-work',
      machineId: machine.id,
      fromSiteId: machine.siteId,
      fromCustomerId: machine.customerId,
      toSiteId: elsewhere!.id,
      toCustomerId: machine.customerId,
      effectiveOn: '2026-12-01',
      note: 'Moved later.',
      recordedBy: master.id,
      recordedAt: '2026-12-01T08:00:00.000Z',
    });

    const at = (await loadJobView(harness.repos, view.job.jobNumber))!.machineLocationAtWork;
    expect(at!.known).toBe(false);
    if (at!.known) return;
    expect(at!.reason).toMatch(/after this job/iu);
  });
});
