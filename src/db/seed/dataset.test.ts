import { describe, expect, it } from 'vitest';
import { canSeeJob, technicianHistoryFrom, type Job } from '@/domain';
import { seedChecklistTemplates } from './checklists';
import { seedActivity } from './audit';
import { HIGHEST_JOB_SEQUENCE, seedJobs, seedParticipation, seedTransfers } from './jobs';
import { seedPeople, TECH1, TECH2, TECH3 } from './people';
import { seedContacts, seedCustomers, seedMachines, seedSites } from './register';
import {
  seedAvailability,
  seedConversations,
  seedDocuments,
  seedMessages,
  seedNotifications,
} from './collaboration';

/**
 * The seed, checked without a database.
 *
 * A broken reference here becomes a foreign key violation halfway through a
 * seed run, with some of the dataset already written — so it is worth catching
 * in the suite that runs everywhere.
 */
const ids = <T extends { readonly id: string }>(records: readonly T[]): readonly string[] =>
  records.map((record) => record.id);

const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;

describe('the development seed dataset', () => {
  it('gives every record its own identifier', () => {
    expect(unique(ids(seedPeople.map(({ user }) => user)))).toBe(true);
    expect(unique(ids(seedCustomers))).toBe(true);
    expect(unique(ids(seedSites))).toBe(true);
    expect(unique(ids(seedContacts))).toBe(true);
    expect(unique(ids(seedMachines))).toBe(true);
    expect(unique(ids(seedJobs))).toBe(true);
    expect(unique(ids(seedDocuments))).toBe(true);
    expect(unique(ids(seedAvailability))).toBe(true);
    expect(unique(ids(seedMessages))).toBe(true);
    expect(unique(ids(seedNotifications))).toBe(true);
    expect(unique(ids(seedActivity))).toBe(true);
  });

  it('numbers every job once, below the sequence it then advances past', () => {
    const numbers = seedJobs.map((job) => job.jobNumber);
    expect(unique(numbers)).toBe(true);
    for (const number of numbers) {
      expect(number).toMatch(/^EJE-\d{4}$/u);
      expect(Number(number.slice(4))).toBeLessThanOrEqual(HIGHEST_JOB_SEQUENCE);
    }
  });

  it('points every job at a customer, site, contact and machine that exist', () => {
    const customers = new Set(ids(seedCustomers));
    const sites = new Set(ids(seedSites));
    const contacts = new Set(ids(seedContacts));
    const machines = new Set(ids(seedMachines));

    for (const job of seedJobs) {
      expect(customers.has(job.customerId), `${job.jobNumber} customer`).toBe(true);
      expect(sites.has(job.siteId), `${job.jobNumber} site`).toBe(true);
      expect(contacts.has(job.contactId), `${job.jobNumber} contact`).toBe(true);
      if (job.machineId !== null) {
        expect(machines.has(job.machineId), `${job.jobNumber} machine`).toBe(true);
      }
    }
  });

  it('keeps every site, contact and machine with the customer it belongs to', () => {
    const customerOf = new Map(seedSites.map((site) => [site.id as string, site.customerId]));
    for (const machine of seedMachines) {
      expect(customerOf.get(machine.siteId), machine.serialNumber).toBe(machine.customerId);
    }
    for (const contact of seedContacts) {
      if (contact.siteId === null) continue;
      expect(customerOf.get(contact.siteId)).toBe(contact.customerId);
    }
    for (const job of seedJobs) {
      expect(customerOf.get(job.siteId), `${job.jobNumber} site/customer`).toBe(job.customerId);
    }
  });

  it('names every user a job, message or notification refers to', () => {
    const people = new Set(seedPeople.map(({ user }) => user.id as string));
    for (const job of seedJobs) {
      if (job.primaryTechnicianId !== null) expect(people.has(job.primaryTechnicianId)).toBe(true);
      for (const id of job.additionalTechnicianIds) expect(people.has(id)).toBe(true);
      for (const line of job.labour) expect(people.has(line.technicianId)).toBe(true);
    }
    for (const message of seedMessages) expect(people.has(message.senderId)).toBe(true);
    for (const entry of seedNotifications) expect(people.has(entry.recipientId)).toBe(true);
    for (const record of seedAvailability) expect(people.has(record.userId)).toBe(true);
  });

  it('puts every message in a conversation its sender is in', () => {
    const threads = new Map(seedConversations.map((entry) => [entry.id, entry]));
    for (const message of seedMessages) {
      const thread = threads.get(message.conversationId);
      expect(thread, message.id).toBeDefined();
      expect(thread?.participantIds).toContain(message.senderId);
    }
  });

  it('answers a completed checklist against questions the template actually has', () => {
    const questions = new Set(
      seedChecklistTemplates.flatMap((template) =>
        template.sections.flatMap((section) => section.items.map((item) => item.id)),
      ),
    );
    for (const job of seedJobs) {
      for (const response of job.checklist?.responses ?? []) {
        expect(questions.has(response.itemId), `${job.jobNumber} ${response.itemId}`).toBe(true);
      }
    }
  });

  it('covers every job type and every stage a reviewer needs to see', () => {
    const types = new Set(seedJobs.map((job) => job.jobType));
    expect([...types].sort()).toEqual([
      'breakdown',
      'installation',
      'parts',
      'service',
      'test_and_repair',
    ]);

    const statuses = new Set(seedJobs.map((job) => job.status));
    for (const status of ['open', 'in_progress', 'awaiting_spares', 'completion', 'customer_signature', 'closed']) {
      expect(statuses.has(status as Job['status']), status).toBe(true);
    }

    // The pool a technician takes work from.
    expect(
      seedJobs.some((job) => job.status === 'open' && job.primaryTechnicianId === null),
    ).toBe(true);
    // Work in both collection shapes.
    expect(seedJobs.some((job) => job.jobType === 'parts' && job.courierCollection)).toBe(true);
    expect(seedJobs.some((job) => job.jobType === 'parts' && !job.courierCollection)).toBe(true);
    expect(
      seedJobs.some((job) => job.jobType === 'test_and_repair' && job.waybillNumber.length > 0),
    ).toBe(true);
    // A multi-day schedule, for the calendar.
    expect(seedJobs.some((job) => job.scheduledEndDate !== null)).toBe(true);
  });

  it('carries an order number where the business expects one, and not where it does not', () => {
    const withNumber = (type: Job['jobType']): boolean =>
      seedJobs.some((job) => job.jobType === type && job.orderNumber.length > 0);
    const without = (type: Job['jobType']): boolean =>
      seedJobs.some((job) => job.jobType === type && job.orderNumber.length === 0);

    for (const type of ['parts', 'installation', 'service'] as const) {
      expect(withNumber(type), type).toBe(true);
    }
    for (const type of ['breakdown', 'test_and_repair'] as const) {
      expect(withNumber(type), `${type} with`).toBe(true);
      expect(without(type), `${type} without`).toBe(true);
    }
  });

  it('freezes a closed job at rates below the current ones', () => {
    const closed = seedJobs.filter((job) => job.status === 'closed');
    expect(closed.length).toBeGreaterThan(0);
    for (const job of closed) {
      expect(job.pricingSnapshot, job.jobNumber).not.toBeNull();
      expect(job.signature, job.jobNumber).not.toBeNull();
      expect(job.finalDocument, job.jobNumber).not.toBeNull();
      // Lower than `seedSettings.labourRates.normal`, deliberately.
      expect(job.pricingSnapshot?.labourRates.normal).toBeLessThan(95_000);
    }
  });

  it('demonstrates a refusal that is outstanding and one that was resolved', () => {
    const outstanding = seedJobs.filter((job) =>
      job.signatureRefusals.some((refusal) => refusal.resolvedAt === null),
    );
    const resolved = seedJobs.filter((job) =>
      job.signatureRefusals.some((refusal) => refusal.resolvedAt !== null),
    );

    expect(outstanding.length).toBeGreaterThan(0);
    expect(resolved.length).toBeGreaterThan(0);
    // The resolved one was signed afterwards, and KEPT its refusal.
    for (const job of resolved) {
      expect(job.signature, job.jobNumber).not.toBeNull();
      expect(job.signatureRefusals.length).toBeGreaterThan(0);
    }
  });

  it('records the participation the transferred job needs to stay visible', () => {
    const transferred = seedJobs.find((job) => job.jobNumber === 'EJE-2023');
    expect(transferred).toBeDefined();
    expect(transferred?.primaryTechnicianId).toBe(TECH2);
    expect(seedTransfers.some((entry) => entry.fromUserId === TECH1)).toBe(true);

    const history = seedParticipation.find((entry) => entry.userId === TECH1);
    expect(history, 'the closed participation row a live transfer would open').toBeDefined();

    // With that row, the rule lets Mike keep his own work and keeps Peter out.
    const mike = technicianHistoryFrom([
      { id: transferred?.id ?? ('' as Job['id']), machineId: transferred?.machineId ?? null },
    ]);
    expect(
      canSeeJob({ id: TECH1, role: 'technician' }, transferred as Job, mike),
    ).toBe(true);
    expect(
      canSeeJob(
        { id: TECH3, role: 'technician' },
        transferred as Job,
        technicianHistoryFrom([]),
      ),
    ).toBe(false);
  });

  it('marks every customer as demonstration data', () => {
    for (const customer of seedCustomers) {
      expect(customer.name, customer.accountNumber).toContain('(DEMO)');
    }
  });

  it('uses no address that could reach a real person', () => {
    for (const { user } of seedPeople) expect(user.email).toMatch(/@eje-demo\.local$/u);
    for (const contact of seedContacts) {
      if (contact.email.length === 0) continue;
      expect(contact.email).toMatch(/-demo\.local$/u);
    }
    for (const customer of seedCustomers) expect(customer.email).toMatch(/-demo\.local$/u);
  });

  it('leaves one contact incomplete, because a real register has those', () => {
    expect(seedContacts.some((contact) => contact.email.length === 0)).toBe(true);
  });
});
