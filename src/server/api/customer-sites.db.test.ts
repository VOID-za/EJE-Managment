import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as schema from '@/db/schema';
import { machineTypeCodeFor } from '@/db/reference-data';
import { IDS, seedBaseline } from '@/data/postgres/test-fixtures';
import { openTestDatabase, testDatabaseUrl, truncateAll } from '@/data/postgres/test-database';
import { hashPassword } from '@/server/auth/passwords';
import { ApiTestClient, startPostgresTestServer } from '@/test/api-harness';

/**
 * SITE-1, SITE-2, SITE-3 AND CONTACT-SITE-1, ON REAL POSTGRESQL.
 *
 * `customer-sites.test.ts` proves the routes on the demonstration backend; this
 * proves the rows. A contact's site and a site's pinned location are read back
 * from the tables, and consolidating a legacy customer leaves the other site
 * ARCHIVED (not deleted), a `machine_movements` row for the machine that moved,
 * and the job done at the archived site still pointing at it.
 *
 * The legacy second site is inserted directly, as a pre-SITE-1 record would
 * exist — the application itself now refuses to create one.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

const PASSWORD = 'a-real-test-password';
const MASTER = 'elmarie@example-test.co.za';
const LEGACY_SITE = '00000000-0000-4000-8000-000000000031';
const LEGACY_MACHINE = '00000000-0000-4000-8000-000000000033';

const SITE_BODY = {
  name: 'Isando', addressLine1: '14 Anvil Road', addressLine2: '', city: 'Kempton Park',
  province: 'Gauteng', postalCode: '1600', accessNotes: '',
};
const CONTACT_BODY = {
  firstName: 'Pieter', lastName: 'Nel', position: 'Maintenance Supervisor',
  email: 'pieter@example-test.co.za', phone: '', isPrimary: true,
};

describeDb('customer sites on PostgreSQL', () => {
  let db: Database;

  const signIn = async (): Promise<ApiTestClient> => {
    const client = new ApiTestClient();
    const response = await client.signIn(MASTER, PASSWORD);
    if (response.status !== 200) throw new Error('sign-in failed');
    return client;
  };

  beforeAll(async () => {
    db = await openTestDatabase(url ?? '');
    startPostgresTestServer(url ?? '');
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedBaseline(db);
    await db.update(schema.users).set({ passwordHash: await hashPassword(PASSWORD) });
    startPostgresTestServer(url ?? '');
  });

  it('refuses a second site, and pins a location that reads back from the row', async () => {
    const master = await signIn();
    const refused = await master.post(`/api/customers/${IDS.otherCustomer}/add_site`, SITE_BODY);
    expect(refused.status).toBe(422);
    expect(refused.error?.violations.map((violation) => violation.code)).toEqual(['customer_has_site']);
    expect(await db.select().from(schema.sites).where(eq(schema.sites.customerId, IDS.otherCustomer)))
      .toHaveLength(1);

    const pinned = await master.post(`/api/sites/${IDS.site}/update`, {
      ...SITE_BODY, latitude: -26.1076, longitude: 28.2311,
    });
    expect(pinned.status).toBe(200);
    const [row] = await db.select().from(schema.sites).where(eq(schema.sites.id, IDS.site));
    expect([Number(row!.latitude), Number(row!.longitude)]).toEqual([-26.1076, 28.2311]);
  });

  it('a contact’s changed site is written to contacts.site_id; another customer’s is refused', async () => {
    const master = await signIn();
    const moved = await master.post(`/api/contacts/${IDS.contact}/update`, {
      ...CONTACT_BODY, siteId: IDS.site,
    });
    expect(moved.status).toBe(200);
    const [row] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, IDS.contact));
    expect(row!.siteId).toBe(IDS.site);

    const refused = await master.post(`/api/contacts/${IDS.contact}/update`, {
      ...CONTACT_BODY, siteId: IDS.otherSite,
    });
    expect(refused.status).toBe(422);
    const [after] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, IDS.contact));
    expect(after!.siteId).toBe(IDS.site);
  });

  it('consolidating a legacy customer archives, records the move, and leaves the job alone', async () => {
    await db.insert(schema.sites).values({ id: LEGACY_SITE, customerId: IDS.customer, name: 'Wadeville' });
    await db.insert(schema.machines).values({
      id: LEGACY_MACHINE,
      customerId: IDS.customer,
      siteId: LEGACY_SITE,
      manufacturer: 'Haas',
      model: 'ST-20',
      serialNumber: 'HA-ST20-55110',
      machineTypeCode: machineTypeCodeFor('CNC Lathe'),
      year: 2019,
      approval: 'approved',
    });
    const master = await signIn();
    const job = await master.post<{ id: string }>('/api/jobs', {
      customerId: IDS.customer,
      siteId: LEGACY_SITE,
      contactId: IDS.contact,
      machineId: LEGACY_MACHINE,
      jobType: 'breakdown',
      priority: 'normal',
      scheduledDate: null,
      scheduledEndDate: null,
      orderNumber: '',
      referenceNumber: '',
      faultDescription: 'Turret indexing fault.',
      primaryTechnicianId: IDS.technician,
      courierCollection: false,
      deliveryNote: '',
    });
    expect(job.status).toBe(200);

    const done = await master.post(`/api/customers/${IDS.customer}/consolidate_sites`, {
      keepSiteId: IDS.site,
    });
    expect(done.status).toBe(200);

    const [legacy] = await db.select().from(schema.sites).where(eq(schema.sites.id, LEGACY_SITE));
    expect(legacy, 'the legacy site must be kept, not deleted').toBeDefined();
    expect(legacy!.archivedAt).not.toBeNull();

    const [machine] = await db.select().from(schema.machines).where(eq(schema.machines.id, LEGACY_MACHINE));
    expect(machine!.siteId).toBe(IDS.site);
    const movements = await db
      .select()
      .from(schema.machineMovements)
      .where(eq(schema.machineMovements.machineId, LEGACY_MACHINE));
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ fromSiteId: LEGACY_SITE, toSiteId: IDS.site });

    const [jobRow] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, job.data.id));
    expect(jobRow!.siteId).toBe(LEGACY_SITE);
  });
});
