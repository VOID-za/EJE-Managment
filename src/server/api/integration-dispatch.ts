import 'server-only';
import { asUserId, type User } from '@/domain';
import type { OperationContext } from '@/application/context';
import {
  attemptCustomerEmail,
  expireStuckCustomerEmails,
  recordCustomerEmailOutcome,
} from '@/application/customer-email';
import {
  answerFor,
  applySiteGeocode,
  claimDueSites,
  maintainSiteProviderContent,
  prepareSiteGeocode,
} from '@/application/site-geocoding';
import { siteLocationOf } from '@/domain';
import type { ServerRuntime, UnitOfWork } from '@/server/runtime';

/**
 * THE INTEGRATIONS' BACKGROUND WORK: customer emails and site pins. INT-EMAIL-3,
 * INT-MAP-1.
 *
 * The same rule as the WhatsApp outbox (`outbox-dispatch.ts`): nothing is
 * handed to a provider from inside a transaction. Each item is CLAIMED in one
 * transaction (a locking update on PostgreSQL, so two requests or two
 * processes never take the same email), ATTEMPTED with no transaction open,
 * and RECORDED in another. A process that dies between claim and record leaves
 * an email in `sending`; ten minutes later it is marked uncertain — never
 * re-sent by itself — and the office decides.
 *
 * Run after every API mutation (the handler's drain) and every minute by the
 * worker started in `instrumentation.ts`, which is also what resumes the
 * queue after a restart.
 */

const EMAIL_BATCH = 5;

/**
 * The actor background work is recorded under. A FIXED, RESERVED id, as the
 * OCR worker's: the audit trail's actor needs no user row, and a nil-shaped
 * UUID is recognisably not a person.
 */
export const integrationWorkerActor = (now: string): User => ({
  id: asUserId('00000000-0000-4000-8000-0000000000e1'),
  firstName: 'EJE',
  lastName: 'system',
  initials: 'SYS',
  email: 'system@localhost',
  mobile: '',
  role: 'master',
  jobTitle: 'Background worker',
  active: true,
  createdAt: now as User['createdAt'],
});

const asSystem = (unit: UnitOfWork): OperationContext => ({
  repos: unit.repos,
  services: unit.services,
  actor: integrationWorkerActor(unit.services.clock.now()),
  // Already in the dispatcher: nothing below dispatches again inline.
  deferDelivery: true,
});

export interface DispatchCounts {
  readonly attempted: number;
  readonly sent: number;
  readonly failed: number;
}

export const dispatchCustomerEmails = async (runtime: ServerRuntime): Promise<DispatchCounts> => {
  await runtime.write((unit) => expireStuckCustomerEmails(asSystem(unit)));
  const claimed = await runtime.write((unit) => unit.repos.customerEmails.claimDue(unit.services.clock.now(), EMAIL_BATCH));
  let sent = 0;
  for (const email of claimed) {
    const outcome = await runtime.read((unit) => attemptCustomerEmail(unit.services, email));
    const recorded = await runtime.write((unit) => recordCustomerEmailOutcome(asSystem(unit), email, outcome));
    if (recorded.state === 'sent') sent += 1;
  }
  return { attempted: claimed.length, sent, failed: claimed.length - sent };
};

export const dispatchSiteGeocodes = async (runtime: ServerRuntime): Promise<number> => {
  // Rule 5 first: what is 30 days old is deleted, configured or not.
  await runtime.write((unit) => maintainSiteProviderContent(asSystem(unit)));
  const claimed = await runtime.write((unit) => claimDueSites(asSystem(unit)));
  for (const site of claimed) {
    const query = siteLocationOf(site).query;
    const plan = await runtime.write((unit) => prepareSiteGeocode(asSystem(unit), site));
    const answer =
      plan.kind === 'answered' ? plan.answer : await runtime.read((unit) => answerFor(unit.services, plan.query, plan.placeId));
    await runtime.write((unit) =>
      applySiteGeocode(asSystem(unit), site.id, query, answer, plan.kind === 'answered' && plan.fromCache, plan.refresh),
    );
  }
  return claimed.length;
};

/** The handler's drain. Never throws: a provider problem is recorded, not raised. */
export const drainIntegrationsQuietly = async (runtime: ServerRuntime): Promise<void> => {
  try {
    await dispatchCustomerEmails(runtime);
  } catch (cause) {
    console.error('[email] customer email dispatch failed', cause instanceof Error ? cause.message : cause);
  }
  try {
    await dispatchSiteGeocodes(runtime);
  } catch (cause) {
    console.error('[maps] site pin dispatch failed', cause instanceof Error ? cause.message : cause);
  }
};
