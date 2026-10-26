import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_USERS, signedInAs, startTestServer, type ApiTestClient } from '@/test/api-harness';

/**
 * SITE-1, SITE-2, SITE-3 and CONTACT-SITE-1 THROUGH THE REAL ROUTES.
 *
 * The operations are tested in `one-site.test.ts`; this proves the HTTP
 * surface carries them — in particular that a contact's changed site now
 * reaches the server. It used to be dropped twice over: the edit dialog never
 * sent it, and the strict update schema had no field to accept it.
 */
interface Record {
  readonly sites: readonly { id: string; latitude: number | null; longitude: number | null }[];
  readonly contacts: readonly { id: string; siteId: string | null }[];
  readonly machines: readonly { id: string; siteId: string }[];
}

const record = async (client: ApiTestClient, id: string) =>
  (await client.get<Record>(`/api/customers/${id}`)).data;

describe('the customer site rules over HTTP', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('a contact’s new site is saved, and read back on the customer', async () => {
    const office = await signedInAs(DEMO_USERS.coordinator);
    const response = await office.post('/api/contacts/contact-abc-pta/update', {
      siteId: 'site-abc-ger',
      firstName: 'Lindiwe',
      lastName: 'Dube',
      position: 'Maintenance Manager',
      email: 'lindiwe@abc-engineering-demo.co.za',
      phone: '+27 82 555 0300',
      isPrimary: false,
    });
    expect(response.status).toBe(200);
    const { contacts } = await record(office, 'cust-abc');
    expect(contacts.find((contact) => contact.id === 'contact-abc-pta')?.siteId).toBe('site-abc-ger');
  });

  it('an edit that leaves the site out keeps it, and another customer’s site is refused', async () => {
    const office = await signedInAs(DEMO_USERS.master);
    const fields = {
      firstName: 'Gerhard', lastName: 'Smit', position: 'Line Supervisor',
      email: 'gerhard.smit@midrandautomation-demo.co.za', phone: '+27 82 555 0733', isPrimary: true,
    };
    expect((await office.post('/api/contacts/contact-midrand-main/update', fields)).status).toBe(200);
    const kept = await record(office, 'cust-midrand');
    expect(kept.contacts.find((contact) => contact.id === 'contact-midrand-main')?.siteId).toBe('site-midrand-main');

    const refused = await office.post('/api/contacts/contact-midrand-main/update', {
      ...fields,
      siteId: 'site-kruger-main',
    });
    expect(refused.status).toBe(422);
    expect(refused.error?.violations.map((violation) => violation.code)).toEqual(['site_not_of_customer']);
  });

  it('a second site is refused; the location is pinned and read back', async () => {
    const office = await signedInAs(DEMO_USERS.master);
    const refused = await office.post('/api/customers/cust-kruger/add_site', {
      name: 'Second', addressLine1: '1 Road', addressLine2: '', city: 'Benoni',
      province: 'Gauteng', postalCode: '', accessNotes: '',
    });
    expect(refused.status).toBe(422);
    expect(refused.error?.violations.map((violation) => violation.code)).toEqual(['customer_has_site']);

    const site = (await record(office, 'cust-midrand')).sites[0]!;
    const pinned = await office.post(`/api/sites/${site.id}/update`, {
      name: 'Midrand Line 2', addressLine1: '5 Gemini Road', addressLine2: 'Halfway House',
      city: 'Midrand', province: 'Gauteng', postalCode: '1685', accessNotes: '',
      latitude: -25.997123, longitude: 28.1265,
    });
    expect(pinned.status).toBe(200);
    expect((await record(office, 'cust-midrand')).sites[0]).toMatchObject({ latitude: -25.997123, longitude: 28.1265 });
  });

  it('the office consolidates a legacy customer; a technician cannot', async () => {
    const technician = await signedInAs(DEMO_USERS.technician);
    expect(
      (await technician.post('/api/customers/cust-abc/consolidate_sites', { keepSiteId: 'site-abc-jhb' })).status,
    ).toBe(403);

    const office = await signedInAs(DEMO_USERS.master);
    const done = await office.post('/api/customers/cust-abc/consolidate_sites', { keepSiteId: 'site-abc-jhb' });
    expect(done.status).toBe(200);
    const after = await record(office, 'cust-abc');
    expect(after.sites.map((site) => site.id)).toEqual(['site-abc-jhb']);
    expect(after.machines.every((machine) => machine.siteId === 'site-abc-jhb')).toBe(true);
  });
});
