import { beforeEach, describe, expect, it } from 'vitest';
import {
  CUSTOMER_NOTE_LIMIT,
  addCustomerNote,
  createCustomer,
  editCustomerNote,
  updateCustomer,
} from './customer-operations';
import { attachCustomerDocument, listCustomerDocuments } from './customer-documents';
import { WorkflowError } from './errors';
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
import { can, type Customer, type User } from '@/domain';
import type { RepositoryBundle } from '@/data/repositories';

/**
 * WHAT A COORDINATOR MAY DO ON THE CUSTOMERS SCREEN. Customers §2.
 *
 * The owner's feedback was that creating a customer was a problem and that the
 * Notes & Documents area could not be used. Reading the code found three
 * separate things, and only one of them was a permission:
 *
 *  1. CREATING AND EDITING A CUSTOMER ALREADY WORKED. A Coordinator has held
 *     `customers.manage` since the roles were written. What was wrong was the
 *     REFUSAL MESSAGE — "Only a Master can change official customer
 *     information" — which described a rule the code did not implement, and
 *     which a Coordinator reading it would reasonably believe.
 *  2. ACCOUNT NOTES COULD NOT BE WRITTEN BY ANYBODY. There was no operation,
 *     no route and no control. The screen rendered the notes and the
 *     repository persisted them, so it looked finished.
 *  3. THE DOCUMENTS CARD ON THAT TAB WAS A FAKE. It said "No documents
 *     uploaded … storage is simulated in this demonstration", hard-coded,
 *     while the real panel sat on the Overview tab holding real files.
 *
 * These cases pin down what a Coordinator can now actually do, and what a
 * technician still cannot.
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
    storage: new DemoStorageService(inMemoryFileStore()),
  };
  return { repos, as: (actor: User) => ({ repos, actor, services }) };
};

const anyCustomer = async (harness: Harness): Promise<Customer> => {
  const customers = await harness.repos.customers.list();
  return customers[0]!;
};

const newCustomerInput = {
  name: 'Rand Tooling & Hydraulics',
  accountNumber: 'RTH-0001',
  registrationNumber: '2019/554321/07',
  vatNumber: '4550119988',
  phone: '011 555 0100',
  email: 'accounts@randtooling.co.za',
  industry: 'Hydraulics',
  paymentTerms: '30 days',
  site: {
    name: 'Alberton Works',
    addressLine1: '12 Voortrekker Road',
    addressLine2: '',
    city: 'Alberton',
    province: 'Gauteng',
    postalCode: '1449',
    accessNotes: '',
  },
  contact: {
    firstName: 'Nomsa',
    lastName: 'Dlamini',
    position: 'Buyer',
    phone: '082 555 0101',
    email: 'nomsa@randtooling.co.za',
    isPrimary: true,
  },
};

describe('the register is the OFFICE’s, not only a Master’s', () => {
  it('gives a Coordinator customers.manage, which is what every operation checks', () => {
    expect(can(coordinator.role, 'customers.manage')).toBe(true);
    expect(can(master.role, 'customers.manage')).toBe(true);
    expect(can(technician.role, 'customers.manage')).toBe(false);
  });

  it('refuses a technician in words that no longer name the wrong role', async () => {
    const harness = build();
    const customer = await anyCustomer(harness);
    const error = await updateCustomer(harness.as(technician), customer).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(WorkflowError);
    // The old sentence said "Only a Master", which was never what was checked.
    expect((error as WorkflowError).message).not.toMatch(/only a master/iu);
    expect((error as WorkflowError).message).toMatch(/office/iu);
  });
});

describe('a Coordinator creates a customer', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = build();
  });

  it('creates the customer, its first site and its first contact', async () => {
    const created = await createCustomer(harness.as(coordinator), newCustomerInput);

    expect(created.customer.name).toBe('Rand Tooling & Hydraulics');
    expect(created.site.name).toBe('Alberton Works');
    expect(created.contact?.firstName).toBe('Nomsa');

    const stored = await harness.repos.customers.findById(created.customer.id);
    expect(stored).not.toBeNull();
  });

  it('is refused to a technician', async () => {
    await expect(createCustomer(harness.as(technician), newCustomerInput)).rejects.toThrow(
      WorkflowError,
    );
  });
});

describe('a Coordinator writes an account note', () => {
  let harness: Harness;
  let customer: Customer;
  beforeEach(async () => {
    harness = build();
    customer = await anyCustomer(harness);
  });

  it('adds one, attributed to them and timed', async () => {
    const before = customer.notes.length;
    const saved = await addCustomerNote(
      harness.as(coordinator),
      customer,
      '  Gate code changed to 4417. Ask for Pieter at reception.  ',
    );

    expect(saved.notes).toHaveLength(before + 1);
    const added = saved.notes.at(-1)!;
    // Trimmed by the operation: a schema has nothing to say about whitespace.
    expect(added.body).toBe('Gate code changed to 4417. Ask for Pieter at reception.');
    expect(added.authorId).toBe(coordinator.id);
    expect(added.createdAt.length).toBeGreaterThan(0);
    expect(added.editedBy).toBeNull();
    expect(added.editedAt).toBeNull();
  });

  it('PERSISTS it, so it survives a reload rather than living in the screen', async () => {
    const saved = await addCustomerNote(harness.as(coordinator), customer, 'Invoices go to AP.');
    const reloaded = await harness.repos.customers.findById(saved.id);
    expect(reloaded!.notes.map((note) => note.body)).toContain('Invoices go to AP.');
  });

  it('records it on the audit trail, with the text as the new value', async () => {
    await addCustomerNote(harness.as(coordinator), customer, 'No deliveries on Fridays.');
    const events = await harness.repos.activity.list();
    const event = events.find((candidate) => candidate.summary.includes('Account note added'));
    expect(event).toBeDefined();
    expect(event!.changes.some((change) => change.to === 'No deliveries on Fridays.')).toBe(true);
  });

  it('refuses a note that is only whitespace', async () => {
    await expect(addCustomerNote(harness.as(coordinator), customer, '   \t  ')).rejects.toThrow(
      WorkflowError,
    );
  });

  it('refuses a note longer than the limit', async () => {
    await expect(
      addCustomerNote(harness.as(coordinator), customer, 'x'.repeat(CUSTOMER_NOTE_LIMIT + 1)),
    ).rejects.toThrow(WorkflowError);
  });

  it('is refused to a technician, who raises a change request instead', async () => {
    await expect(
      addCustomerNote(harness.as(technician), customer, 'The serial number is wrong.'),
    ).rejects.toThrow(WorkflowError);
  });
});

describe('a Coordinator edits an account note', () => {
  let harness: Harness;
  let customer: Customer;
  beforeEach(async () => {
    harness = build();
    customer = await anyCustomer(harness);
  });

  it('replaces the body and KEEPS the original author and date', async () => {
    const withNote = await addCustomerNote(
      harness.as(master),
      customer,
      'Gate code is 1234.',
    );
    const note = withNote.notes.at(-1)!;

    const edited = await editCustomerNote(
      harness.as(coordinator),
      withNote,
      note.id,
      'Gate code is 4417.',
    );
    const after = edited.notes.find((candidate) => candidate.id === note.id)!;

    expect(after.body).toBe('Gate code is 4417.');
    // An edit does not change who said it, or when they said it.
    expect(after.authorId).toBe(master.id);
    expect(after.createdAt).toBe(note.createdAt);
    // It does record who corrected it, so the screen can say so.
    expect(after.editedBy).toBe(coordinator.id);
    expect(after.editedAt).not.toBeNull();
  });

  it('keeps the PREVIOUS wording on the audit trail, which is the only place it survives', async () => {
    const withNote = await addCustomerNote(harness.as(coordinator), customer, 'Old wording.');
    const note = withNote.notes.at(-1)!;
    await editCustomerNote(harness.as(coordinator), withNote, note.id, 'New wording.');

    const events = await harness.repos.activity.list();
    const event = events.find((candidate) => candidate.summary.includes('Account note edited'));
    expect(event).toBeDefined();
    expect(
      event!.changes.some((change) => change.from === 'Old wording.' && change.to === 'New wording.'),
    ).toBe(true);
  });

  it('does NOT mark a note edited when the text has not changed', async () => {
    const withNote = await addCustomerNote(harness.as(coordinator), customer, 'Unchanged.');
    const note = withNote.notes.at(-1)!;
    const same = await editCustomerNote(harness.as(coordinator), withNote, note.id, 'Unchanged.');
    expect(same.notes.find((candidate) => candidate.id === note.id)!.editedBy).toBeNull();
  });

  it('refuses to empty a note', async () => {
    const withNote = await addCustomerNote(harness.as(coordinator), customer, 'Still applies.');
    const note = withNote.notes.at(-1)!;
    await expect(
      editCustomerNote(harness.as(coordinator), withNote, note.id, '    '),
    ).rejects.toThrow(WorkflowError);
  });

  it('refuses a note id that is not on this customer', async () => {
    await expect(
      editCustomerNote(harness.as(coordinator), customer, 'cnote-not-here', 'Anything.'),
    ).rejects.toThrow(WorkflowError);
  });

  it('is refused to a technician', async () => {
    const withNote = await addCustomerNote(harness.as(coordinator), customer, 'Office wrote this.');
    const note = withNote.notes.at(-1)!;
    await expect(
      editCustomerNote(harness.as(technician), withNote, note.id, 'Technician rewrote it.'),
    ).rejects.toThrow(WorkflowError);
  });
});

describe('a Coordinator files a customer document', () => {
  let harness: Harness;
  let customer: Customer;
  beforeEach(async () => {
    harness = build();
    customer = await anyCustomer(harness);
  });

  const pdf = {
    fileName: 'rate-agreement-2026.pdf',
    contentType: 'application/pdf',
    bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25]),
    caption: 'Signed rate agreement',
  };

  it('attaches it and reads it back', async () => {
    const saved = await attachCustomerDocument(harness.as(coordinator), customer.id, pdf);
    expect(saved.fileName).toBe('rate-agreement-2026.pdf');

    const listed = await listCustomerDocuments(harness.as(coordinator), customer.id);
    expect(listed.map((document) => document.id)).toContain(saved.id);
  });

  it('is refused to a technician — both the attach and the list', async () => {
    await expect(attachCustomerDocument(harness.as(technician), customer.id, pdf)).rejects.toThrow(
      WorkflowError,
    );
    await expect(listCustomerDocuments(harness.as(technician), customer.id)).rejects.toThrow(
      WorkflowError,
    );
  });
});
