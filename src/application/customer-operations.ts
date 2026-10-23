import {
  asContactId,
  asCustomerId,
  asSiteId,
  can,
  contactFullName,
  emptyAddress,
  machineDisplayName,
  type Contact,
  type Customer,
  type CustomerId,
  type CustomerNote,
  type PostalAddress,
  type Site,
  type SiteId,
} from '@/domain';
import type { OperationContext } from './context';
import { audit } from './audit';
import { WorkflowError } from './errors';
import type { RemovalResult } from './removal';

/**
 * Customer register operations.
 *
 * The official customer record belongs to THE OFFICE — a Master or a
 * Coordinator, both of whom hold `customers.manage`. Technicians read it and
 * raise change requests against it, which is why the permission check sits here
 * rather than being left to whichever screen happens to call in.
 *
 * THE REFUSAL USED TO SAY "ONLY A MASTER", AND THAT WAS NEVER WHAT IT CHECKED.
 * A Coordinator has held `customers.manage` since the roles were written, so
 * the sentence described a rule the code did not implement — and a Coordinator
 * reading it had every reason to believe the register was closed to them. The
 * check is unchanged; the wording now matches it.
 */
const assertManages = (context: OperationContext): void => {
  if (can(context.actor.role, 'customers.manage')) return;
  throw new WorkflowError('Only the office can change official customer information.', [
    {
      code: 'not_permitted',
      message: 'Technicians can view customers and raise change requests, but not edit them.',
    },
  ]);
};

const trimAddress = (address: PostalAddress): PostalAddress => ({
  line1: address.line1.trim(),
  line2: address.line2.trim(),
  city: address.city.trim(),
  province: address.province.trim(),
  postalCode: address.postalCode.trim(),
});

const required = (value: string, code: string, message: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new WorkflowError(message, [{ code, message }]);
  return trimmed;
};

export interface NewCustomerInput {
  readonly name: string;
  readonly accountNumber: string;
  readonly registrationNumber: string;
  readonly vatNumber: string;
  readonly phone: string;
  readonly email: string;
  readonly officeAddress?: PostalAddress;
  readonly industry: string;
  readonly paymentTerms: string;
  /** The first site. A customer with nowhere to send a technician is not useful. */
  readonly site: NewSiteInput;
  /** Optional first contact for that site. */
  readonly contact: NewContactInput | null;
}

export interface NewSiteInput {
  readonly name: string;
  readonly addressLine1: string;
  readonly addressLine2: string;
  readonly city: string;
  readonly province: string;
  readonly postalCode: string;
  readonly accessNotes: string;
}

export interface NewContactInput {
  readonly firstName: string;
  readonly lastName: string;
  readonly position: string;
  readonly email: string;
  readonly phone: string;
  readonly isPrimary: boolean;
}

export interface CreatedCustomer {
  readonly customer: Customer;
  readonly site: Site;
  readonly contact: Contact | null;
}

/** A customer name already on the register, or null. Case-insensitive. */
export const findCustomerNameClash = (
  customers: readonly Customer[],
  name: string,
  excludingId?: CustomerId,
): Customer | null => {
  const needle = name.trim().toLowerCase();
  return (
    customers.find(
      (customer) => customer.id !== excludingId && customer.name.trim().toLowerCase() === needle,
    ) ?? null
  );
};

export const createCustomer = async (
  context: OperationContext,
  input: NewCustomerInput,
): Promise<CreatedCustomer> => {
  assertManages(context);

  const trimmedName = required(input.name, 'name_required', 'A customer name is required.');

  const existing = await context.repos.customers.list();
  const clash = findCustomerNameClash(existing, trimmedName);
  if (clash !== null) {
    throw new WorkflowError(`${clash.name} is already on the customer register.`, [
      {
        code: 'duplicate_customer',
        message: `Account ${clash.accountNumber} already exists under this name.`,
      },
    ]);
  }

  const now = context.services.clock.now();
  const customer: Customer = {
    id: asCustomerId(context.services.ids.next('cust')),
    name: trimmedName,
    accountNumber: input.accountNumber.trim(),
    registrationNumber: input.registrationNumber.trim(),
    vatNumber: input.vatNumber.trim(),
    phone: input.phone.trim(),
    email: input.email.trim(),
    officeAddress: trimAddress(input.officeAddress ?? emptyAddress()),
    industry: input.industry.trim(),
    paymentTerms: input.paymentTerms.trim(),
    active: true,
    notes: [],
    documents: [],
    createdAt: now,
  };

  const saved = await context.repos.customers.save(customer);
  const site = await createSite(context, saved.id, input.site, { silent: true });
  const contact =
    input.contact === null
      ? null
      : await createContact(context, saved.id, site.id, input.contact, { silent: true });

  await audit(context, {
    jobId: null,
    type: 'customer_created',
    summary: `Customer added: ${saved.name}`,
    detail:
      `Account ${saved.accountNumber || '—'} created with site "${site.name}"` +
      (contact === null ? '.' : ` and contact ${contact.firstName} ${contact.lastName}.`),
  });

  return { customer: saved, site, contact };
};

export const updateCustomer = async (
  context: OperationContext,
  customer: Customer,
): Promise<Customer> => {
  assertManages(context);
  const saved = await context.repos.customers.save(customer);
  await audit(context, {
    jobId: null,
    type: 'customer_updated',
    summary: `Customer updated: ${saved.name}`,
    detail: `Official customer details amended by ${context.actor.firstName} ${context.actor.lastName}.`,
  });
  return saved;
};

/**
 * THE LONGEST USEFUL ACCOUNT NOTE.
 *
 * Long enough for the standing instruction a note exists to carry — who to ask
 * for at the gate, which purchase-order rules this account works to — and short
 * enough that a contract does not get pasted into one. A contract is a
 * DOCUMENT, and the panel beside this one takes those.
 */
export const CUSTOMER_NOTE_LIMIT = 2000;

/**
 * AN ACCOUNT NOTE, WRITTEN BY THE OFFICE. Customers §2.
 *
 * The notes were READ-ONLY EVERYWHERE, for every role, and had been since the
 * register was built: `Customer.notes` was rendered on the screen, persisted by
 * `replaceNotes`, seeded with demonstration data — and there was no operation,
 * no route and no control that could add one. A Coordinator asked to keep
 * account notes could not, and neither could a Master.
 *
 * WHO MAY: the office, `customers.manage`, the same rule as every other change
 * to the official record. A technician who finds a note wrong raises a change
 * request, exactly as they do for a serial number.
 *
 * WHAT IS RECORDED: the author and the moment, because a note is somebody's
 * statement about an account rather than a field on it. That is also why
 * `editCustomerNote` keeps both and records the correction separately — see
 * there.
 */
export const addCustomerNote = async (
  context: OperationContext,
  customer: Customer,
  body: string,
): Promise<Customer> => {
  assertManages(context);

  const text = body.trim();
  if (text.length === 0) {
    throw new WorkflowError('A note needs something in it.', [
      {
        code: 'note_body_required',
        message: 'Write the note before saving it. An empty note records nothing.',
      },
    ]);
  }
  if (text.length > CUSTOMER_NOTE_LIMIT) {
    throw new WorkflowError('That note is too long.', [
      {
        code: 'note_too_long',
        message: `A note is limited to ${CUSTOMER_NOTE_LIMIT} characters. Attach a document instead.`,
      },
    ]);
  }

  const note: CustomerNote = {
    id: context.services.ids.next('customer-note'),
    body: text,
    authorId: context.actor.id,
    createdAt: context.services.clock.now(),
    editedBy: null,
    editedAt: null,
  };

  const saved = await context.repos.customers.save({
    ...customer,
    notes: [...customer.notes, note],
  });

  await audit(context, {
    jobId: null,
    type: 'customer_updated',
    summary: `Account note added: ${saved.name}`,
    detail: `${context.actor.firstName} ${context.actor.lastName} added an account note.`,
    changes: [{ field: 'Account note', from: null, to: text }],
  });

  return saved;
};

/**
 * CORRECTING A NOTE, WITHOUT PRETENDING IT WAS ALWAYS THAT.
 *
 * The owner asked that the office be able to EDIT account notes, so this
 * replaces the body — and keeps the original author and the original moment,
 * because they are facts about who said something and when, and an edit does
 * not change either. Who corrected it and when is recorded alongside, so the
 * screen can say a note was edited rather than quietly showing new words under
 * somebody else's name.
 *
 * The before and after both go on the audit trail (AUDIT-2), which is the only
 * place the previous wording survives — the note itself holds one body, as a
 * note does.
 */
export const editCustomerNote = async (
  context: OperationContext,
  customer: Customer,
  noteId: string,
  body: string,
): Promise<Customer> => {
  assertManages(context);

  const existing = customer.notes.find((note) => note.id === noteId);
  if (existing === undefined) {
    throw new WorkflowError('That note is not on this customer.', [
      {
        code: 'note_not_found',
        message: 'The note may have been removed. Reload the customer and try again.',
      },
    ]);
  }

  const text = body.trim();
  if (text.length === 0) {
    throw new WorkflowError('A note needs something in it.', [
      {
        code: 'note_body_required',
        message:
          'A note cannot be emptied. Rewrite it, or add a new note saying the old one no longer applies.',
      },
    ]);
  }
  if (text.length > CUSTOMER_NOTE_LIMIT) {
    throw new WorkflowError('That note is too long.', [
      {
        code: 'note_too_long',
        message: `A note is limited to ${CUSTOMER_NOTE_LIMIT} characters. Attach a document instead.`,
      },
    ]);
  }

  // Nothing to record and nothing to save: an "edit" that changes no character
  // should not put a correction marker on somebody else's note.
  if (text === existing.body) return customer;

  const saved = await context.repos.customers.save({
    ...customer,
    notes: customer.notes.map((note) =>
      note.id === noteId
        ? {
            ...note,
            body: text,
            editedBy: context.actor.id,
            editedAt: context.services.clock.now(),
          }
        : note,
    ),
  });

  await audit(context, {
    jobId: null,
    type: 'customer_updated',
    summary: `Account note edited: ${saved.name}`,
    detail: `${context.actor.firstName} ${context.actor.lastName} corrected an account note.`,
    changes: [{ field: 'Account note', from: existing.body, to: text }],
  });

  return saved;
};

export const createSite = async (
  context: OperationContext,
  customerId: CustomerId,
  input: NewSiteInput,
  options: { readonly silent?: boolean } = {},
): Promise<Site> => {
  assertManages(context);

  const site: Site = {
    id: asSiteId(context.services.ids.next('site')),
    customerId,
    name: required(input.name, 'site_name_required', 'A site name is required.'),
    addressLine1: required(
      input.addressLine1,
      'site_address_required',
      'A street address is required so the technician can be sent there.',
    ),
    addressLine2: input.addressLine2.trim(),
    city: required(input.city, 'site_city_required', 'A city or town is required.'),
    province: input.province.trim(),
    postalCode: input.postalCode.trim(),
    accessNotes: input.accessNotes.trim(),
    // The demo has no map picker; the address is used for navigation instead.
    latitude: null,
    longitude: null,
    archivedAt: null,
  };

  const saved = await context.repos.customers.saveSite(site);
  if (options.silent !== true) {
    await audit(context, {
      jobId: null,
      type: 'site_created',
      summary: `Site added: ${saved.name}`,
      detail: `${saved.addressLine1}, ${saved.city}.`,
    });
  }
  return saved;
};

export const createContact = async (
  context: OperationContext,
  customerId: CustomerId,
  siteId: SiteId | null,
  input: NewContactInput,
  options: { readonly silent?: boolean } = {},
): Promise<Contact> => {
  assertManages(context);

  const contact: Contact = {
    id: asContactId(context.services.ids.next('contact')),
    customerId,
    siteId,
    firstName: required(input.firstName, 'contact_name_required', 'A contact name is required.'),
    lastName: required(input.lastName, 'contact_name_required', 'A contact surname is required.'),
    position: input.position.trim(),
    email: input.email.trim(),
    phone: input.phone.trim(),
    isPrimary: input.isPrimary,
    archivedAt: null,
  };

  const saved = await context.repos.customers.saveContact(contact);
  if (options.silent !== true) {
    await audit(context, {
      jobId: null,
      type: 'contact_created',
      summary: `Contact added: ${saved.firstName} ${saved.lastName}`,
      detail: `${saved.position || 'Contact'} · ${saved.phone || 'no phone recorded'}.`,
    });
  }
  return saved;
};

export const updateContact = async (
  context: OperationContext,
  contact: Contact,
): Promise<Contact> => {
  assertManages(context);
  const saved = await context.repos.customers.saveContact(contact);
  await audit(context, {
    jobId: null,
    type: 'contact_updated',
    summary: `Contact updated: ${saved.firstName} ${saved.lastName}`,
    detail: `${saved.position || 'Contact'} details amended.`,
  });
  return saved;
};

export const updateSite = async (context: OperationContext, site: Site): Promise<Site> => {
  assertManages(context);
  const saved = await context.repos.customers.saveSite(site);
  await audit(context, {
    jobId: null,
    type: 'site_updated',
    summary: `Site updated: ${saved.name}`,
    detail: `${saved.addressLine1}, ${saved.city}.`,
  });
  return saved;
};

/**
 * Removes a contact.
 *
 * Deleted outright when no job has ever named them; archived when one has, so
 * the job cards that record who signed for the work still resolve the person.
 * Which of the two happened is returned rather than assumed, because the office
 * needs to know whether the name will still appear in history.
 */
export const removeContact = async (
  context: OperationContext,
  contact: Contact,
): Promise<RemovalResult> => {
  assertManages(context);

  const jobs = await context.repos.jobs.list();
  const referencing = jobs.filter((job) => job.contactId === contact.id);
  const name = contactFullName(contact);

  if (referencing.length === 0) {
    await context.repos.customers.deleteContact(contact.id);
    await audit(context, {
      jobId: null,
      type: 'contact_deleted',
      summary: `Contact deleted: ${name}`,
      detail: `${contact.position || 'Contact'} removed. No job had ever named them.`,
    });
    return { outcome: 'deleted', message: `${name} has been deleted.` };
  }

  await context.repos.customers.saveContact({
    ...contact,
    archivedAt: context.services.clock.now(),
  });
  await audit(context, {
    jobId: null,
    type: 'contact_archived',
    summary: `Contact archived: ${name}`,
    detail: `Named on ${referencing.length} ${referencing.length === 1 ? 'job' : 'jobs'}, so the record is kept and withdrawn from the register rather than deleted.`,
  });
  return {
    outcome: 'archived',
    message: `${name} has been removed from the customer. ${referencing.length} ${
      referencing.length === 1 ? 'job names' : 'jobs name'
    } them, so the record is kept and those job cards still read correctly.`,
  };
};

/**
 * Removes a site.
 *
 * Refused while machines still stand at it: deleting the site would leave those
 * machines pointing at somewhere that no longer exists, and silently moving
 * them would be a decision only the office can make. Once it is empty, the site
 * goes the same way as a contact — deleted if no job was ever done there,
 * archived if one was. The site's own contacts go with it, each on its own
 * merits.
 */
export const removeSite = async (
  context: OperationContext,
  site: Site,
): Promise<RemovalResult> => {
  assertManages(context);

  const machines = await context.repos.machines.list();
  const atSite = machines.filter((machine) => machine.siteId === site.id);
  if (atSite.length > 0) {
    throw new WorkflowError(`${site.name} still has machines on it.`, [
      {
        code: 'site_has_machines',
        message: `${atSite.length} ${atSite.length === 1 ? 'machine is' : 'machines are'} recorded at this site, starting with the ${machineDisplayName(atSite[0]!)}. Move or remove ${atSite.length === 1 ? 'it' : 'them'} first.`,
      },
    ]);
  }

  const contacts = await context.repos.customers.listContacts(site.customerId);
  for (const contact of contacts.filter((candidate) => candidate.siteId === site.id)) {
    await removeContact(context, contact);
  }

  const jobs = await context.repos.jobs.list();
  const referencing = jobs.filter((job) => job.siteId === site.id);

  if (referencing.length === 0) {
    await context.repos.customers.deleteSite(site.id);
    await audit(context, {
      jobId: null,
      type: 'site_deleted',
      summary: `Site deleted: ${site.name}`,
      detail: `${site.addressLine1}, ${site.city}. No job had ever been carried out there.`,
    });
    return { outcome: 'deleted', message: `${site.name} has been deleted.` };
  }

  await context.repos.customers.saveSite({ ...site, archivedAt: context.services.clock.now() });
  await audit(context, {
    jobId: null,
    type: 'site_archived',
    summary: `Site archived: ${site.name}`,
    detail: `${referencing.length} ${referencing.length === 1 ? 'job was' : 'jobs were'} carried out there, so the site is kept and withdrawn from the register rather than deleted.`,
  });
  return {
    outcome: 'archived',
    message: `${site.name} has been removed from the customer. ${referencing.length} ${
      referencing.length === 1 ? 'job was' : 'jobs were'
    } carried out there, so the site is kept and that job history still reads correctly.`,
  };
};
