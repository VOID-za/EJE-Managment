import 'server-only';
import { z } from 'zod';
import {
  asContactId,
  asCustomerId,
  asMachineId,
  asSiteId,
  type Contact,
  type Customer,
  type Machine,
  type Site,
} from '@/domain';
import * as customers from '@/application/customer-operations';
import * as machines from '@/application/machine-operations';
import { notFound } from '../errors';
import { command, type CommandContext, type CommandRegistry } from './types';

/**
 * Customers, sites, contacts and machines.
 *
 * THE MERGE IS THE POINT OF THIS FILE. Several of these operations take a whole
 * record — `updateCustomer(context, customer)` — because in the demonstration
 * the screen had the record in hand. A request must not be able to hand the
 * server a record: it would let a client rewrite `createdAt`, `active`,
 * `approval`, or a machine's `approvedBy`, none of which are its business.
 *
 * So every update here LOADS THE STORED RECORD and overlays only the fields the
 * business actually lets a person edit. Anything else in the body is refused by
 * the schema, which is `.strict()` throughout.
 */
const text = (max: number) => z.string().max(max);
/** `YYYY-MM-DD`, as a calendar date and not a timestamp. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Expected a date as YYYY-MM-DD');
const id = z.string().min(1).max(100);

const address = z
  .object({
    line1: text(200),
    line2: text(200),
    city: text(120),
    province: text(120),
    postalCode: text(20),
  })
  .strict();

/*
 * The editable company fields.
 *
 * `email` and `officeAddress` are optional because the screens that edit a
 * customer do not all carry them; what is omitted comes from the STORED
 * record rather than being blanked. Nothing outside this list can be set —
 * `id`, `createdAt`, `notes` and `documents` are the server's, and a client
 * that sends one is refused rather than quietly obeyed.
 */
const customerFields = z
  .object({
    name: z.string().min(1).max(200),
    accountNumber: text(60),
    registrationNumber: text(60),
    vatNumber: text(60),
    phone: text(60),
    email: text(320).optional(),
    officeAddress: address.optional(),
    industry: text(120),
    paymentTerms: text(120),
    /** Withdrawing a customer from the register, which the edit dialog offers. */
    active: z.boolean().optional(),
  })
  .strict();

const siteFields = z
  .object({
    name: z.string().min(1).max(200),
    addressLine1: text(200),
    addressLine2: text(200),
    city: text(120),
    province: text(120),
    postalCode: text(20),
    accessNotes: text(2000),
  })
  .strict();

const contactFields = z
  .object({
    firstName: z.string().min(1).max(120),
    lastName: text(120),
    position: text(120),
    email: text(320),
    phone: text(60),
    isPrimary: z.boolean(),
  })
  .strict();

const machineFields = z
  .object({
    customerId: id,
    siteId: id,
    manufacturer: z.string().min(1).max(160),
    model: z.string().min(1).max(160),
    serialNumber: z.string().min(1).max(160),
    machineNumber: text(60),
    machineType: z.enum([
      'CNC Milling Machine',
      'CNC Lathe',
      'Machining Centre',
      'Surface Grinder',
      'Press Brake',
      'Other',
    ]),
    year: z.number().int().min(1900).max(2200),
    installationDate: text(10),
    controlSystem: text(160),
    notes: text(4000),
    /**
     * In service, or withdrawn from use.
     *
     * A property of the machine the office maintains, and distinct from
     * `approval` — which says whether the OFFICE has confirmed the record, and
     * is not editable from here at all.
     */
    active: z.boolean().optional(),
    /*
     * WHEN THE MACHINE MOVED, AND WHY. MACH-HIST.
     *
     * Both optional and both IGNORED unless the site or the customer actually
     * changed. `movedOn` defaults to the business day in the operation, which
     * is right for recording a move as it happens; the office states a date
     * when it is catching up on one it has just heard about.
     */
    movedOn: isoDate.optional(),
    moveNote: text(500).optional(),
  })
  .strict();

const loadCustomer = async (context: CommandContext, target: string): Promise<Customer> => {
  const found = await context.repos.customers.findById(asCustomerId(target));
  if (found === null) throw notFound('That customer does not exist.');
  return found;
};

const loadSite = async (context: CommandContext, siteId: string): Promise<Site> => {
  const found = await context.repos.customers.findSiteById(asSiteId(siteId));
  if (found === null) throw notFound('That site does not exist.');
  return found;
};

const loadContact = async (context: CommandContext, contactId: string): Promise<Contact> => {
  const found = await context.repos.customers.findContactById(asContactId(contactId));
  if (found === null) throw notFound('That contact does not exist.');
  return found;
};

const loadMachine = async (context: CommandContext, machineId: string): Promise<Machine> => {
  const found = await context.repos.machines.findById(asMachineId(machineId));
  if (found === null) throw notFound('That machine does not exist.');
  return found;
};

/** Actions on one customer. `target` is the customer id. */
export const CUSTOMER_COMMANDS: CommandRegistry = {
  update: command({
    schema: customerFields,
    async run(context, input, target) {
      const stored = await loadCustomer(context, target);
      return customers.updateCustomer(context.operation, {
        ...stored,
        ...input,
        email: input.email ?? stored.email,
        officeAddress: input.officeAddress ?? stored.officeAddress,
        active: input.active ?? stored.active,
      });
    },
  }),

  add_site: command({
    schema: siteFields,
    async run(context, input, target) {
      // Loaded to prove it exists and that this actor may reach it; the
      // operation takes the id.
      const stored = await loadCustomer(context, target);
      return customers.createSite(context.operation, stored.id, input);
    },
  }),

  /*
   * AN ACCOUNT NOTE. Customers §2.
   *
   * `customers.manage` is applied by the operation, as every other command here
   * leaves it: the office writes notes and a technician raises a change
   * request. The body is bounded by the schema AND trimmed and refused by the
   * operation, because a schema has nothing to say about a note of three
   * spaces.
   */
  add_note: command({
    schema: z.object({ body: z.string().min(1).max(customers.CUSTOMER_NOTE_LIMIT) }).strict(),
    async run(context, input, target) {
      const stored = await loadCustomer(context, target);
      return customers.addCustomerNote(context.operation, stored, input.body);
    },
  }),

  edit_note: command({
    schema: z
      .object({
        noteId: z.string().min(1).max(200),
        body: z.string().min(1).max(customers.CUSTOMER_NOTE_LIMIT),
      })
      .strict(),
    async run(context, input, target) {
      const stored = await loadCustomer(context, target);
      return customers.editCustomerNote(context.operation, stored, input.noteId, input.body);
    },
  }),

  /*
   * ONE OF A LEGACY CUSTOMER'S SITES BECOMES THE CUSTOMER'S SITE. SITE-2.
   * The office's deliberate choice; see `consolidateCustomerSites` for what
   * moves, what is archived and what is never touched.
   */
  consolidate_sites: command({
    schema: z.object({ keepSiteId: id }).strict(),
    async run(context, input, target) {
      const stored = await loadCustomer(context, target);
      return customers.consolidateCustomerSites(
        context.operation,
        stored.id,
        asSiteId(input.keepSiteId),
      );
    },
  }),

  add_contact: command({
    schema: contactFields.extend({ siteId: id.nullable() }),
    async run(context, input, target) {
      const stored = await loadCustomer(context, target);
      const site = input.siteId === null ? null : await loadSite(context, input.siteId);
      const { siteId: _ignored, ...fields } = input;
      return customers.createContact(context.operation, stored.id, site?.id ?? null, fields);
    },
  }),
};

/** Actions on one site. `target` is the site id. */
export const SITE_COMMANDS: CommandRegistry = {
  /*
   * The location is optional on the wire: omitted keeps what is pinned, null
   * clears it, numbers pin it. `updateSite` validates the pair (SITE-3).
   */
  update: command({
    schema: siteFields.extend({
      latitude: z.number().nullable().optional(),
      longitude: z.number().nullable().optional(),
    }),
    async run(context, input, target) {
      const stored = await loadSite(context, target);
      return customers.updateSite(context.operation, {
        ...stored,
        ...input,
        latitude: input.latitude === undefined ? stored.latitude : input.latitude,
        longitude: input.longitude === undefined ? stored.longitude : input.longitude,
      });
    },
  }),

  /**
   * Removal, which may archive instead.
   *
   * `removeSite` decides: a site a job has named is archived so those jobs
   * still resolve it, and one nothing refers to is deleted. The OUTCOME is
   * returned because the screen has to say which happened.
   */
  remove: command({
    schema: z.object({}).strict(),
    async run(context, _input: Record<string, never>, target) {
      const stored = await loadSite(context, target);
      return customers.removeSite(context.operation, stored);
    },
  }),
};

/** Actions on one contact. `target` is the contact id. */
export const CONTACT_COMMANDS: CommandRegistry = {
  /*
   * THE SITE WAS NOT PART OF THIS SCHEMA, and the edit dialog did not send it,
   * so changing a contact's site saved everything else and dropped the site
   * without a word. It is accepted now — omitted keeps it, null is head office
   * — and `updateContact` checks it belongs to the contact's own customer.
   */
  update: command({
    schema: contactFields.extend({ siteId: id.nullable().optional() }),
    async run(context, input, target) {
      const stored = await loadContact(context, target);
      const { siteId, ...fields } = input;
      return customers.updateContact(context.operation, {
        ...stored,
        ...fields,
        siteId: siteId === undefined ? stored.siteId : siteId === null ? null : asSiteId(siteId),
      });
    },
  }),

  remove: command({
    schema: z.object({}).strict(),
    async run(context, _input: Record<string, never>, target) {
      const stored = await loadContact(context, target);
      return customers.removeContact(context.operation, stored);
    },
  }),
};

/** Actions on one machine. `target` is the machine id. */
export const MACHINE_COMMANDS: CommandRegistry = {
  update: command({
    schema: machineFields,
    async run(context, input, target) {
      const stored = await loadMachine(context, target);
      /*
       * `approval`, `approvedBy`, `approvedAt`, `createdBy`, `createdAt` and
       * `archivedAt` are NOT in the schema and are taken from the stored
       * record. A client that could set `approval: 'approved'` could put an
       * unconfirmed machine on the official register without a Master.
       */
      const { movedOn, moveNote, ...fields } = input;
      return machines.updateMachine(
        context.operation,
        {
          ...stored,
          ...fields,
          active: input.active ?? stored.active,
          customerId: asCustomerId(input.customerId),
          siteId: asSiteId(input.siteId),
        },
        movedOn,
        moveNote,
      );
    },
  }),

  approve: command({
    schema: z.object({}).strict(),
    async run(context, _input: Record<string, never>, target) {
      const stored = await loadMachine(context, target);
      return machines.approveMachine(context.operation, stored);
    },
  }),

  remove: command({
    schema: z.object({}).strict(),
    async run(context, _input: Record<string, never>, target) {
      const stored = await loadMachine(context, target);
      return machines.removeMachine(context.operation, stored);
    },
  }),
};

export const createCustomerSchema = customerFields.extend({
  /** A customer with nowhere to send a technician is not useful, so this is required. */
  site: siteFields,
  contact: contactFields.nullable(),
});

/**
 * A new customer.
 *
 * `active` is not a field on a new record — a customer is raised active, and
 * withdrawing one is an edit — so it is dropped here rather than offered.
 */
export const runCreateCustomer = (
  context: CommandContext,
  input: z.infer<typeof createCustomerSchema>,
) => {
  const { active: _raisedActive, email, officeAddress, ...rest } = input;
  return customers.createCustomer(context.operation, {
    ...rest,
    email: email ?? '',
    officeAddress: officeAddress ?? {
      line1: '',
      line2: '',
      city: '',
      province: '',
      postalCode: '',
    },
  });
};

/**
 * A new machine. NO PHOTOGRAPHS IN THE JSON BODY. *Amended by MACH-PHOTO-1.*
 *
 * It used to accept `photos: [{ fileName, caption, sizeBytes }]` — metadata
 * the client made up, which `createMachine` turned into storage keys with
 * nothing behind them. The register then displayed photographs that did not
 * exist.
 *
 * A machine is now raised first and photographed afterwards, through
 * `POST /api/machines/:machineId/photos`, which carries real bytes. Two
 * requests, each doing one thing, rather than a multipart create carrying a
 * record and several megabytes of images.
 */
export const createMachineSchema = machineFields;

export const runCreateMachine = (
  context: CommandContext,
  input: z.infer<typeof createMachineSchema>,
) =>
  machines.createMachine(context.operation, {
    ...input,
    customerId: asCustomerId(input.customerId),
    siteId: asSiteId(input.siteId),
    photos: [],
  });
