import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  asContactId,
  asCustomerId,
  asSiteId,
  type Contact,
  type ContactId,
  type Customer,
  type CustomerId,
  type Site,
  type SiteId,
} from '@/domain';
import type { CustomerRepository, RegisterFilter } from '@/data/repositories';
import type { DatabaseExecutor } from '@/db/client';
import * as schema from '@/db/schema';
import { VersionLedger, requireWritten } from './versions';

type CustomerRow = typeof schema.customers.$inferSelect;
type NoteRow = typeof schema.customerNotes.$inferSelect;
type SiteRow = typeof schema.sites.$inferSelect;
type ContactRow = typeof schema.contacts.$inferSelect;

/** `numeric` arrives as text so no precision is lost on the way; coordinates are numbers. */
const coordinate = (value: string | null): number | null =>
  value === null ? null : Number(value);

const toDomainSite = (row: SiteRow): Site => ({
  id: asSiteId(row.id),
  customerId: asCustomerId(row.customerId),
  name: row.name,
  addressLine1: row.addressLine1,
  addressLine2: row.addressLine2,
  city: row.city,
  province: row.province,
  postalCode: row.postalCode,
  accessNotes: row.accessNotes,
  latitude: coordinate(row.latitude),
  longitude: coordinate(row.longitude),
  archivedAt: row.archivedAt,
});

const toDomainContact = (row: ContactRow): Contact => ({
  id: asContactId(row.id),
  customerId: asCustomerId(row.customerId),
  siteId: row.siteId === null ? null : asSiteId(row.siteId),
  firstName: row.firstName,
  lastName: row.lastName,
  position: row.position,
  email: row.email,
  phone: row.phone,
  isPrimary: row.isPrimary,
  archivedAt: row.archivedAt,
});

/**
 * Customers, their sites and their contacts, in PostgreSQL.
 *
 * ARCHIVED RECORDS ARE NEVER GONE. `src/application/removal.ts` states the rule
 * — "Nothing that a job refers to is ever deleted" — and the schema enforces
 * the half of it that matters most: `sites.customer_id` and `contacts.*` are
 * `on delete restrict`, so a record a job names cannot be removed even by a
 * mistaken query. The application archives instead, and the lists here leave
 * archived records out by default so one cannot reappear in a picker because a
 * caller forgot a filter. `findSiteById` and `findContactById` always resolve
 * them, which is what keeps a historical job card readable.
 *
 * `deleteSite` and `deleteContact` are a hard DELETE, and correctly so: they
 * are only ever called for a record nothing refers to, which the application
 * layer establishes before calling. The foreign keys are the second line.
 *
 * `Customer.documents` is not persisted. Nothing in the application captures
 * one — the field is written as `[]` at every site — so there is nothing to
 * store and a table for it would be speculation. When customer documents become
 * a feature they get a table, the way machine photos just did.
 */
export class PostgresCustomerRepository implements CustomerRepository {
  private readonly customerVersions = new VersionLedger();
  private readonly siteVersions = new VersionLedger();
  private readonly contactVersions = new VersionLedger();

  constructor(private readonly db: DatabaseExecutor) {}

  async list(): Promise<readonly Customer[]> {
    const rows = await this.db
      .select()
      .from(schema.customers)
      .orderBy(asc(schema.customers.name));
    return this.assembleCustomers(rows);
  }

  async findById(id: CustomerId): Promise<Customer | null> {
    const rows = await this.db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.id, id))
      .limit(1);
    const assembled = await this.assembleCustomers(rows);
    return assembled[0] ?? null;
  }

  async listSites(customerId?: CustomerId, filter?: RegisterFilter): Promise<readonly Site[]> {
    const conditions = [];
    if (customerId !== undefined) conditions.push(eq(schema.sites.customerId, customerId));
    if (filter?.includeArchived !== true) conditions.push(isNull(schema.sites.archivedAt));

    const rows = await this.db
      .select()
      .from(schema.sites)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(asc(schema.sites.name));
    this.siteVersions.rememberAll(rows);
    return rows.map(toDomainSite);
  }

  async listContacts(
    customerId?: CustomerId,
    filter?: RegisterFilter,
  ): Promise<readonly Contact[]> {
    const conditions = [];
    if (customerId !== undefined) conditions.push(eq(schema.contacts.customerId, customerId));
    if (filter?.includeArchived !== true) conditions.push(isNull(schema.contacts.archivedAt));

    const rows = await this.db
      .select()
      .from(schema.contacts)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(asc(schema.contacts.firstName), asc(schema.contacts.lastName));
    this.contactVersions.rememberAll(rows);
    return rows.map(toDomainContact);
  }

  /** Resolution, not selection: an archived site still has to resolve. */
  async findSiteById(id: SiteId): Promise<Site | null> {
    const rows = await this.db.select().from(schema.sites).where(eq(schema.sites.id, id)).limit(1);
    this.siteVersions.rememberAll(rows);
    return rows[0] === undefined ? null : toDomainSite(rows[0]);
  }

  async findContactById(id: ContactId): Promise<Contact | null> {
    const rows = await this.db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.id, id))
      .limit(1);
    this.contactVersions.rememberAll(rows);
    return rows[0] === undefined ? null : toDomainContact(rows[0]);
  }

  async save(customer: Customer): Promise<Customer> {
    const values = {
      name: customer.name,
      accountNumber: customer.accountNumber,
      registrationNumber: customer.registrationNumber,
      vatNumber: customer.vatNumber,
      phone: customer.phone,
      // LEGACY, and written back exactly as it arrived. DECISION 4 sends the
      // job card to the named contact and this is never a recipient; it is kept
      // so an address captured before that rule existed is not destroyed.
      email: customer.email,
      officeLine1: customer.officeAddress.line1,
      officeLine2: customer.officeAddress.line2,
      officeCity: customer.officeAddress.city,
      officeProvince: customer.officeAddress.province,
      officePostalCode: customer.officeAddress.postalCode,
      industry: customer.industry,
      paymentTerms: customer.paymentTerms,
      active: customer.active,
    } as const;

    const existing = await this.db
      .select({ version: schema.customers.version })
      .from(schema.customers)
      .where(eq(schema.customers.id, customer.id))
      .limit(1);

    const current = existing[0];
    if (current === undefined) {
      const inserted = await this.db
        .insert(schema.customers)
        .values({ id: customer.id, ...values, createdAt: customer.createdAt })
        .returning();
      this.customerVersions.rememberAll(inserted);
    } else {
      const expected = this.customerVersions.expected(customer.id, current.version);
      const updated = await this.db
        .update(schema.customers)
        .set({ ...values, updatedAt: sql`now()`, version: expected + 1 })
        .where(
          and(eq(schema.customers.id, customer.id), eq(schema.customers.version, expected)),
        )
        .returning();
      const written = requireWritten(updated, 'Customer', customer.name, expected);
      this.customerVersions.remember(written.id, written.version);
    }

    await this.replaceNotes(customer);

    const saved = await this.findById(customer.id);
    if (saved === null) throw new Error(`${customer.name} vanished during save.`);
    return saved;
  }

  async saveSite(site: Site): Promise<Site> {
    const values = {
      customerId: site.customerId as string,
      name: site.name,
      addressLine1: site.addressLine1,
      addressLine2: site.addressLine2,
      city: site.city,
      province: site.province,
      postalCode: site.postalCode,
      accessNotes: site.accessNotes,
      latitude: site.latitude === null ? null : String(site.latitude),
      longitude: site.longitude === null ? null : String(site.longitude),
      archivedAt: site.archivedAt,
    } as const;

    const existing = await this.db
      .select({ version: schema.sites.version })
      .from(schema.sites)
      .where(eq(schema.sites.id, site.id))
      .limit(1);

    const current = existing[0];
    if (current === undefined) {
      const inserted = await this.db
        .insert(schema.sites)
        .values({ id: site.id, ...values })
        .returning();
      this.siteVersions.rememberAll(inserted);
      return toDomainSite(inserted[0]!);
    }

    const expected = this.siteVersions.expected(site.id, current.version);
    const updated = await this.db
      .update(schema.sites)
      .set({ ...values, updatedAt: sql`now()`, version: expected + 1 })
      .where(and(eq(schema.sites.id, site.id), eq(schema.sites.version, expected)))
      .returning();

    const written = requireWritten(updated, 'Site', site.name, expected);
    this.siteVersions.remember(written.id, written.version);
    return toDomainSite(written);
  }

  async saveContact(contact: Contact): Promise<Contact> {
    const values = {
      customerId: contact.customerId as string,
      siteId: contact.siteId,
      firstName: contact.firstName,
      lastName: contact.lastName,
      position: contact.position,
      email: contact.email,
      phone: contact.phone,
      isPrimary: contact.isPrimary,
      archivedAt: contact.archivedAt,
    } as const;

    const existing = await this.db
      .select({ version: schema.contacts.version })
      .from(schema.contacts)
      .where(eq(schema.contacts.id, contact.id))
      .limit(1);

    const current = existing[0];
    if (current === undefined) {
      const inserted = await this.db
        .insert(schema.contacts)
        .values({ id: contact.id, ...values })
        .returning();
      this.contactVersions.rememberAll(inserted);
      return toDomainContact(inserted[0]!);
    }

    const expected = this.contactVersions.expected(contact.id, current.version);
    const updated = await this.db
      .update(schema.contacts)
      .set({ ...values, updatedAt: sql`now()`, version: expected + 1 })
      .where(and(eq(schema.contacts.id, contact.id), eq(schema.contacts.version, expected)))
      .returning();

    const written = requireWritten(
      updated,
      'Contact',
      `${contact.firstName} ${contact.lastName}`,
      expected,
    );
    this.contactVersions.remember(written.id, written.version);
    return toDomainContact(written);
  }

  async deleteSite(id: SiteId): Promise<void> {
    await this.db.delete(schema.sites).where(eq(schema.sites.id, id));
    this.siteVersions.forget(id);
  }

  async deleteContact(id: ContactId): Promise<void> {
    await this.db.delete(schema.contacts).where(eq(schema.contacts.id, id));
    this.contactVersions.forget(id);
  }

  /* ---------------------------------------------------------------------- */

  private async replaceNotes(customer: Customer): Promise<void> {
    await this.db
      .delete(schema.customerNotes)
      .where(eq(schema.customerNotes.customerId, customer.id));
    if (customer.notes.length === 0) return;
    await this.db.insert(schema.customerNotes).values(
      customer.notes.map((note) => ({
        id: note.id,
        customerId: customer.id as string,
        body: note.body,
        authorId: note.authorId.length === 0 ? null : note.authorId,
        createdAt: note.createdAt,
      })),
    );
  }

  private async assembleCustomers(
    rows: readonly CustomerRow[],
  ): Promise<readonly Customer[]> {
    if (rows.length === 0) return [];
    this.customerVersions.rememberAll(rows);

    const notes = await this.db
      .select()
      .from(schema.customerNotes)
      .where(
        inArray(
          schema.customerNotes.customerId,
          rows.map((row) => row.id),
        ),
      )
      .orderBy(asc(schema.customerNotes.createdAt));

    const notesFor = (id: string): NoteRow[] =>
      notes.filter((note) => note.customerId === id);

    return rows.map((row) => ({
      id: asCustomerId(row.id),
      name: row.name,
      accountNumber: row.accountNumber,
      registrationNumber: row.registrationNumber,
      vatNumber: row.vatNumber,
      phone: row.phone,
      email: row.email,
      officeAddress: {
        line1: row.officeLine1,
        line2: row.officeLine2,
        city: row.officeCity,
        province: row.officeProvince,
        postalCode: row.officePostalCode,
      },
      industry: row.industry,
      paymentTerms: row.paymentTerms,
      active: row.active,
      notes: notesFor(row.id).map((note) => ({
        id: note.id,
        body: note.body,
        authorId: note.authorId ?? '',
        createdAt: note.createdAt,
      })),
      // See the class docblock: nothing captures these, so nothing stores them.
      documents: [],
      createdAt: row.createdAt,
    }));
  }
}
