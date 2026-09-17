import {
  asContactId,
  asCustomerId,
  asSiteId,
  can,
  type Contact,
  type Customer,
  type CustomerId,
  type Site,
  type SiteId,
} from '@/domain';
import type { OperationContext } from './context';
import { audit } from './audit';
import { WorkflowError } from './errors';

/**
 * Customer register operations.
 *
 * The official customer record belongs to the office: only a Master may create
 * or change it. Technicians read it and raise change requests against it, which
 * is why the permission check sits here rather than being left to whichever
 * screen happens to call in.
 */
const assertManages = (context: OperationContext): void => {
  if (can(context.actor.role, 'customers.manage')) return;
  throw new WorkflowError('Only a Master can change official customer information.', [
    {
      code: 'not_permitted',
      message: 'Technicians can view customers and raise change requests, but not edit them.',
    },
  ]);
};

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
