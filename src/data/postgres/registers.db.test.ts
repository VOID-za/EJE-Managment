import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  asAttachmentId,
  asContactId,
  asCustomerId,
  asMachineId,
  asSiteId,
  asUserId,
  type Contact,
  type Customer,
  type Machine,
  type Site,
} from '@/domain';
import type { Database } from '@/db/client';
import * as schema from '@/db/schema';
import { PostgresCustomerRepository } from './customer-repository';
import { PostgresMachineRepository } from './machine-repository';
import { PostgresUserRepository } from './user-repository';
import { ConcurrencyError } from './transaction';
import { openTestDatabase, testDatabaseUrl, truncateAll } from './test-database';
import { IDS, seedBaseline } from './test-fixtures';

/**
 * The registers — customers, sites, contacts, machines, people — in PostgreSQL.
 *
 * The rule under test throughout is `src/application/removal.ts`: nothing a job
 * refers to is ever deleted. The demo could only choose not to delete; here the
 * foreign keys refuse, which is the difference between a convention and a
 * guarantee.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

describeDb('the PostgreSQL registers', () => {
  let db: Database;
  let customers: PostgresCustomerRepository;
  let machines: PostgresMachineRepository;
  let users: PostgresUserRepository;

  beforeAll(async () => {
    db = await openTestDatabase(url ?? '');
  });

  afterAll(async () => {
    await db.execute(sql`select 1`);
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedBaseline(db);
    customers = new PostgresCustomerRepository(db);
    machines = new PostgresMachineRepository(db);
    users = new PostgresUserRepository(db);
  });

  const newCustomer = (over: Partial<Customer> = {}): Customer => ({
    id: asCustomerId(crypto.randomUUID()),
    name: 'Strucmac Engineering',
    accountNumber: `STR-${Math.random().toString(36).slice(2, 8)}`,
    registrationNumber: '2011/123456/07',
    vatNumber: '4560112233',
    phone: '011 555 0100',
    email: '',
    officeAddress: {
      line1: '12 Isando Road',
      line2: '',
      city: 'Kempton Park',
      province: 'Gauteng',
      postalCode: '1600',
    },
    industry: 'Structural steel',
    paymentTerms: '30 days',
    active: true,
    notes: [],
    documents: [],
    createdAt: '2026-01-05T08:00:00.000Z',
    ...over,
  });

  const newSite = (customerId: string, over: Partial<Site> = {}): Site => ({
    id: asSiteId(crypto.randomUUID()),
    customerId: asCustomerId(customerId),
    name: 'Wadeville',
    addressLine1: '5 Fabriek Street',
    addressLine2: '',
    city: 'Germiston',
    province: 'Gauteng',
    postalCode: '1428',
    accessNotes: 'Report to the gatehouse.',
    latitude: -26.243_45,
    longitude: 28.168_21,
    archivedAt: null,
    ...over,
  });

  const newContact = (customerId: string, over: Partial<Contact> = {}): Contact => ({
    id: asContactId(crypto.randomUUID()),
    customerId: asCustomerId(customerId),
    siteId: null,
    firstName: 'Johan',
    lastName: 'Venter',
    position: 'Maintenance Manager',
    email: 'johan@example-test.co.za',
    phone: '082 555 0100',
    isPrimary: false,
    archivedAt: null,
    ...over,
  });

  describe('customers, their sites and their contacts', () => {
    it('round trips a customer with its notes', async () => {
      const customer = newCustomer({
        notes: [
          {
            id: crypto.randomUUID(),
            body: 'Pays on presentation. Always asks for the technician by name.',
            authorId: IDS.master,
            createdAt: '2026-01-06T09:00:00.000Z',
          },
        ],
      });

      const saved = await customers.save(customer);
      expect(saved.name).toBe('Strucmac Engineering');
      expect(saved.notes).toHaveLength(1);

      const read = await customers.findById(customer.id);
      expect(read?.officeAddress.city).toBe('Kempton Park');
      expect(read?.notes[0]?.body).toContain('presentation');
    });

    it('keeps a site’s coordinates exactly, so the navigation link is the site', async () => {
      const customer = await customers.save(newCustomer());
      const site = await customers.saveSite(newSite(customer.id));

      const read = await customers.findSiteById(site.id);
      expect(read?.latitude).toBe(-26.243_45);
      expect(read?.longitude).toBe(28.168_21);
    });

    it('leaves archived records out of the lists and still resolves them', async () => {
      const customer = await customers.save(newCustomer());
      const site = await customers.saveSite(newSite(customer.id));
      const contact = await customers.saveContact(newContact(customer.id));

      await customers.saveSite({ ...site, archivedAt: '2026-02-01T08:00:00.000Z' });
      await customers.saveContact({ ...contact, archivedAt: '2026-02-01T08:00:00.000Z' });

      expect(await customers.listSites(customer.id)).toHaveLength(0);
      expect(await customers.listContacts(customer.id)).toHaveLength(0);

      // Which is the point: a closed job card that named them still renders.
      expect(await customers.findSiteById(site.id)).not.toBeNull();
      expect(await customers.findContactById(contact.id)).not.toBeNull();

      const withArchived = await customers.listSites(customer.id, { includeArchived: true });
      expect(withArchived).toHaveLength(1);
    });

    it('deletes a contact nothing refers to', async () => {
      const customer = await customers.save(newCustomer());
      const contact = await customers.saveContact(newContact(customer.id));

      await customers.deleteContact(contact.id);
      expect(await customers.findContactById(contact.id)).toBeNull();
    });

    it('refuses to delete a site a job was carried out at', async () => {
      // The baseline site is named by a job, so the database itself refuses.
      await db.execute(sql`
        insert into jobs (id, job_number, job_number_seq, customer_id, site_id, contact_id,
                          job_type_code, priority, status, created_by)
        values (gen_random_uuid(), 'EJE-9001', 9001, ${IDS.customer}, ${IDS.site}, ${IDS.contact},
                'breakdown', 'urgent', 'open', ${IDS.master})
      `);

      await expect(customers.deleteSite(asSiteId(IDS.site))).rejects.toThrow();
      expect(await customers.findSiteById(asSiteId(IDS.site))).not.toBeNull();
    });

    it('allows one primary contact per customer, and says so when a second is added', async () => {
      const customer = await customers.save(newCustomer());
      await customers.saveContact(newContact(customer.id, { isPrimary: true }));

      await expect(
        customers.saveContact(
          newContact(customer.id, { firstName: 'Ansie', isPrimary: true }),
        ),
      ).rejects.toThrow();
    });

    it('refuses the second of two concurrent writers', async () => {
      const customer = await customers.save(newCustomer());

      // Two units of work, which is what two requests are.
      const first = new PostgresCustomerRepository(db);
      const second = new PostgresCustomerRepository(db);
      const readByFirst = await first.findById(customer.id);
      const readBySecond = await second.findById(customer.id);

      await first.save({ ...readByFirst!, phone: '011 555 0199' });
      await expect(
        second.save({ ...readBySecond!, phone: '011 555 0123' }),
      ).rejects.toBeInstanceOf(ConcurrencyError);

      const read = await customers.findById(customer.id);
      expect(read?.phone).toBe('011 555 0199');
    });
  });

  describe('the machine register', () => {
    const newMachine = (over: Partial<Machine> = {}): Machine => ({
      id: asMachineId(crypto.randomUUID()),
      customerId: asCustomerId(IDS.customer),
      siteId: asSiteId(IDS.site),
      manufacturer: 'Haas',
      model: 'ST-20',
      serialNumber: `HAAS-${Math.random().toString(36).slice(2, 8)}`,
      machineNumber: 'STM2',
      machineType: 'CNC Lathe',
      year: 2019,
      installationDate: '2019-04-11',
      controlSystem: 'Haas NGC',
      notes: '',
      photos: [],
      active: true,
      approval: 'pending_approval',
      createdBy: asUserId(IDS.technician),
      approvedBy: null,
      approvedAt: null,
      createdAt: '2026-03-01T07:30:00.000Z',
      archivedAt: null,
      ...over,
    });

    it('round trips a machine, its type and its photographs', async () => {
      const machine = newMachine({
        photos: [
          {
            id: asAttachmentId(crypto.randomUUID()),
            kind: 'photo',
            fileName: 'haas-st20-rating-plate.jpg',
            caption: 'Rating plate',
            storageKey: 'machines/haas-st20-rating-plate.jpg',
            uploadedAt: '2026-03-01T07:35:00.000Z',
            uploadedBy: asUserId(IDS.technician),
            sizeBytes: 1_840_000,
          },
        ],
      });

      const saved = await machines.save(machine);
      // The label survives the round trip through the slug the column holds.
      expect(saved.machineType).toBe('CNC Lathe');
      expect(saved.machineNumber).toBe('STM2');
      expect(saved.photos).toHaveLength(1);
      expect(saved.photos[0]?.caption).toBe('Rating plate');
      expect(saved.installationDate).toBe('2019-04-11');
    });

    it('keeps a technician’s unconfirmed machine usable until a Master approves it', async () => {
      const machine = await machines.save(newMachine());
      expect(machine.approval).toBe('pending_approval');
      expect((await machines.list()).some((row) => row.id === machine.id)).toBe(true);

      const approved = await machines.save({
        ...machine,
        approval: 'approved',
        approvedBy: asUserId(IDS.master),
        approvedAt: '2026-03-02T09:00:00.000Z',
      });
      expect(approved.approval).toBe('approved');
      expect(approved.approvedBy).toBe(IDS.master);
    });

    it('refuses the same serial number twice at one customer', async () => {
      const machine = await machines.save(newMachine({ serialNumber: 'DUP-0001' }));
      await expect(machines.save(newMachine({ serialNumber: 'DUP-0001' }))).rejects.toThrow();
      expect(machine.serialNumber).toBe('DUP-0001');
    });

    it('archives out of the register and still resolves for a historical job', async () => {
      const machine = await machines.save(newMachine());
      await machines.save({ ...machine, archivedAt: '2026-04-01T08:00:00.000Z' });

      expect((await machines.list()).some((row) => row.id === machine.id)).toBe(false);
      expect(await machines.findById(machine.id)).not.toBeNull();
      expect(
        (await machines.list({ includeArchived: true })).some((row) => row.id === machine.id),
      ).toBe(true);
    });
  });

  describe('people', () => {
    it('disables an account rather than removing it', async () => {
      const list = await users.list();
      const technician = list.find((user) => user.id === IDS.technician);
      expect(technician?.active).toBe(true);

      await users.save({ ...technician!, active: false });

      const after = await users.findById(asUserId(IDS.technician));
      expect(after).not.toBeNull();
      expect(after?.active).toBe(false);

      const rows = await db
        .select({ disabledAt: schema.users.disabledAt })
        .from(schema.users)
        .where(eq(schema.users.id, IDS.technician));
      expect(rows[0]?.disabledAt).not.toBeNull();
    });

    it('never reads or writes a credential column in this phase', async () => {
      const technician = await users.findById(asUserId(IDS.technician));
      await users.save({ ...technician!, jobTitle: 'Senior Field Technician' });

      const rows = await db
        .select({
          passwordHash: schema.users.passwordHash,
          passwordSetAt: schema.users.passwordSetAt,
          lastLoginAt: schema.users.lastLoginAt,
        })
        .from(schema.users)
        .where(eq(schema.users.id, IDS.technician));

      expect(rows[0]?.passwordHash).toBeNull();
      expect(rows[0]?.passwordSetAt).toBeNull();
      expect(rows[0]?.lastLoginAt).toBeNull();
    });

    it('compares email addresses without regard to case', async () => {
      const technician = await users.findById(asUserId(IDS.technician));
      await expect(
        users.save({
          ...technician!,
          id: asUserId(crypto.randomUUID()),
          email: 'SIPHO@EXAMPLE-TEST.CO.ZA',
        }),
      ).rejects.toThrow();
    });
  });
});
