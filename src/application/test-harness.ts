import type { OperationContext } from './context';
import { createDemoRepositories } from '@/data/demo/repositories';
import { DemoStore } from '@/data/demo/demo-store';
import { SimulatedEmailService } from '@/services/simulated/email';
import { SimulatedOutbox } from '@/services/simulated/outbox';
import { SimulatedPdfService } from '@/services/simulated/pdf';
import { inMemoryFileStore, SimulatedStorageService } from '@/services/simulated/storage';
import { SequentialIdGenerator, SystemClock } from '@/services/simulated/system';
import { SimulatedWhatsAppService } from '@/services/simulated/whatsapp';
import { seedUsers } from '@/data/seed';
import type { IsoDate, Job, User } from '@/domain';
import type { RepositoryBundle } from '@/data/repositories';
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

/** A date `days` from today, as the seed's own offsets produce. */
export const dayOffset = (days: number): IsoDate => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}-${`${date.getDate()}`.padStart(2, '0')}`;
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
    storage: new SimulatedStorageService(inMemoryFileStore()),
  };

  return { repos, outbox, services, as: (user) => ({ repos, services, actor: user }) };
};
