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
import type { IsoDate, IsoDateTime, Job, User } from '@/domain';
import type { RepositoryBundle } from '@/data/repositories';
import { businessDateOf } from '@/lib/business-time';
import { confirmJobCardDelivery } from './job-operations';
import type { AppServices } from './context';

/**
 * A fresh demo backend for a test.
 *
 * The same repositories and simulated services the application runs against, so
 * a test exercises the real write path rather than a stub of it.
 */
export interface Harness {
  readonly repos: RepositoryBundle;
  readonly services: AppServices;
  readonly outbox: SimulatedOutbox;
  /** An operation context acting as the given user. */
  as(user: User): OperationContext;
}

export const seedUser = (id: string): User => {
  const user = seedUsers.find((candidate) => candidate.id === id);
  if (user === undefined) throw new Error(`${id} is not a seeded user`);
  return user;
};

/**
 * A VALID JPEG, for the tests that attach a photograph. PWA-3.
 *
 * Minimal but real: SOI, an APP0/JFIF header, a comment segment carrying
 * `label` so two fixtures differ byte for byte, and EOI. It has to be genuine
 * because `validatePhotoUpload` sniffs the first three bytes and the capture
 * path stores and serves what it finds — a fixture of arbitrary bytes would
 * test a path production refuses.
 */
export const jpegFixture = (label = 'fixture'): Uint8Array => {
  const text = new TextEncoder().encode(label);
  const commentLength = text.length + 2;
  return new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
    0x00, 0x01, 0x00, 0x00, // APP0/JFIF
    0xff, 0xfe, (commentLength >> 8) & 0xff, commentLength & 0xff, // COM
    ...text,
    0xff, 0xd9, // EOI
  ]);
};

/**
 * A date `days` from today, IN THE BUSINESS ZONE.
 *
 * The zone matters and used to be the runner's. Every rule that asks "is this
 * person away today?" or "is this job overdue?" asks it of
 * `businessDateOf(clock.now())` — South African time — so a test that built
 * "today" from the runner's own clock disagreed with the application for two
 * hours out of every twenty-four, on a machine running UTC. A suite that fails
 * between 22:00 and midnight and passes the rest of the day is worse than one
 * that fails always: it looks like a flake. QA-5, and the same defect
 * `signed-job-submission.db.test.ts` carried.
 */
export const dayOffset = (days: number): IsoDate => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return businessDateOf(date.toISOString()) ?? '1970-01-01';
};

/**
 * Confirms the provider delivered a customer's copy, then closes the job.
 *
 * Stands in for the delivery report Microsoft 365 sends in production. Tests
 * need it because issuing a job card no longer closes the job: an accepted send
 * is not a delivered mail, so the job waits until something confirms delivery.
 */
export const confirmDelivery = async (
  harness: Harness,
  context: OperationContext,
  job: Job,
): Promise<Job> => {
  const messageId = job.delivery?.messageId ?? '';
  if (messageId.length === 0) throw new Error(`${job.jobNumber} has no message to confirm`);
  harness.outbox.setDelivery(messageId, 'delivered');
  return confirmJobCardDelivery(context, job);
};

/**
 * Puts a job into the retired Master Review state, as a FIXTURE.
 *
 * Master Review is gone from the workflow: no transition leads into
 * `submitted`, so there is no operation that can produce this state and there
 * is deliberately no way for a new job to reach it. Jobs that entered it before
 * it was retired still exist, though, and have to stay readable and issuable —
 * so tests that cover that compatibility build the state directly, the way a
 * persisted snapshot from before the change would present it.
 *
 * Writing through the repository rather than through an operation is the point:
 * this is old data, not a path anybody can take.
 */
export const historicalMasterReview = async (
  repos: RepositoryBundle,
  job: Job,
  at: IsoDateTime,
): Promise<Job> =>
  repos.jobs.save({
    ...job,
    status: 'submitted',
    submittedAt: job.submittedAt ?? at,
    completedAt: job.completedAt ?? at,
  });

export const buildHarness = (): Harness => {
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

  return { repos, outbox, services, as: (user) => ({ repos, services, actor: user }) };
};
