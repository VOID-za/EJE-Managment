import type { OperationContext } from './context';
import { createDemoRepositories } from '@/data/demo/repositories';
import { DemoStore } from '@/data/demo/demo-store';
import { SimulatedEmailService } from '@/services/simulated/email';
import { SimulatedOutbox } from '@/services/simulated/outbox';
import { SimulatedPdfService } from '@/services/simulated/pdf';
import { SimulatedStorageService } from '@/services/simulated/storage';
import { SequentialIdGenerator, SystemClock } from '@/services/simulated/system';
import { SimulatedWhatsAppService } from '@/services/simulated/whatsapp';
import { seedUsers } from '@/data/seed';
import type { User } from '@/domain';
import type { RepositoryBundle } from '@/data/repositories';

/**
 * A fresh demo backend for a test.
 *
 * The same repositories and simulated services the application runs against, so
 * a test exercises the real write path rather than a stub of it.
 */
export interface Harness {
  readonly repos: RepositoryBundle;
  readonly outbox: SimulatedOutbox;
  /** An operation context acting as the given user. */
  as(user: User): OperationContext;
}

export const seedUser = (id: string): User => {
  const user = seedUsers.find((candidate) => candidate.id === id);
  if (user === undefined) throw new Error(`${id} is not a seeded user`);
  return user;
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
    storage: new SimulatedStorageService(),
  };

  return { repos, outbox, as: (user) => ({ repos, services, actor: user }) };
};
