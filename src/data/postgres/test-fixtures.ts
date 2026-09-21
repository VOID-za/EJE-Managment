import {
  asContactId,
  asCustomerId,
  asJobId,
  asMachineId,
  asSiteId,
  asUserId,
  type Job,
} from '@/domain';
import type { Database } from '@/db/client';
import { machineTypeCodeFor, syncReferenceData } from '@/db/reference-data';
import * as schema from '@/db/schema';

/**
 * The records every integration test needs before it can store anything.
 *
 * Shared because the alternative is each test file inventing its own people and
 * its own customer, which is how two tests end up disagreeing about what a
 * valid row looks like. Small on purpose: two technicians, one office, one
 * customer with one site, one contact and one machine — enough to exercise
 * every foreign key and nothing more.
 *
 * THIS IS TEST DATA. It is never imported by the application, it is not the
 * demonstration seed, and nothing here is a real person, a real customer or a
 * real price. The domains are `example-test.co.za`, which cannot receive mail.
 */

export const IDS = {
  master: '00000000-0000-4000-8000-000000000001',
  technician: '00000000-0000-4000-8000-000000000002',
  coordinator: '00000000-0000-4000-8000-000000000003',
  otherTechnician: '00000000-0000-4000-8000-000000000004',
  customer: '00000000-0000-4000-8000-000000000010',
  site: '00000000-0000-4000-8000-000000000011',
  contact: '00000000-0000-4000-8000-000000000012',
  machine: '00000000-0000-4000-8000-000000000013',
  /*
   * A SECOND customer, with its own site, contact and machine.
   *
   * Exists so a test can send a request in which every id is real and they do
   * NOT belong together — which is the only way to prove that the server checks
   * the relationships rather than merely that the records exist.
   */
  otherCustomer: '00000000-0000-4000-8000-000000000020',
  otherSite: '00000000-0000-4000-8000-000000000021',
  otherContact: '00000000-0000-4000-8000-000000000022',
  otherMachine: '00000000-0000-4000-8000-000000000023',
} as const;

/**
 * Reference rows, people, a customer, a site, a contact, a machine, settings.
 *
 * The reference data comes from `syncReferenceData`, which is what production
 * runs — so a test cannot pass against job-type rows that only exist in tests.
 */
export const seedBaseline = async (db: Database): Promise<void> => {
  await syncReferenceData(db);

  await db.insert(schema.users).values([
    {
      id: IDS.master,
      firstName: 'Elmarie',
      lastName: 'Coetzee',
      initials: 'EC',
      email: 'elmarie@example-test.co.za',
      role: 'master',
    },
    {
      id: IDS.technician,
      // A mobile number, because the assignment notification has somewhere to
      // go only if the technician can be reached — which is the case the
      // outbox exists for.
      mobile: '082 555 0134',
      firstName: 'Sipho',
      lastName: 'Mahlangu',
      initials: 'SM',
      email: 'sipho@example-test.co.za',
      role: 'technician',
    },
    {
      id: IDS.coordinator,
      firstName: 'Christene',
      lastName: 'Botha',
      initials: 'CB',
      email: 'christene@example-test.co.za',
      role: 'coordinator',
    },
    {
      id: IDS.otherTechnician,
      firstName: 'Lerato',
      lastName: 'Dlamini',
      initials: 'LD',
      email: 'lerato@example-test.co.za',
      role: 'technician',
    },
  ]);

  await db
    .insert(schema.customers)
    .values({ id: IDS.customer, name: 'ABC Engineering', accountNumber: 'ABC-001' });
  await db
    .insert(schema.sites)
    .values({ id: IDS.site, customerId: IDS.customer, name: 'Isando' });
  await db.insert(schema.contacts).values({
    id: IDS.contact,
    customerId: IDS.customer,
    firstName: 'Pieter',
    lastName: 'Nel',
    email: 'pieter@example-test.co.za',
  });
  await db.insert(schema.machines).values({
    id: IDS.machine,
    customerId: IDS.customer,
    siteId: IDS.site,
    manufacturer: 'Leadwell',
    model: 'V40',
    serialNumber: 'LW-V40-88213',
    machineTypeCode: machineTypeCodeFor('CNC Lathe'),
    year: 2016,
    approval: 'approved',
  });

  await db
    .insert(schema.customers)
    .values({ id: IDS.otherCustomer, name: 'Kruger Engineering', accountNumber: 'KRU-001' });
  await db
    .insert(schema.sites)
    .values({ id: IDS.otherSite, customerId: IDS.otherCustomer, name: 'Benoni' });
  await db.insert(schema.contacts).values({
    id: IDS.otherContact,
    customerId: IDS.otherCustomer,
    firstName: 'Anna',
    lastName: 'Kruger',
    email: 'anna@example-test.co.za',
  });
  await db.insert(schema.machines).values({
    id: IDS.otherMachine,
    customerId: IDS.otherCustomer,
    siteId: IDS.otherSite,
    manufacturer: 'Haas',
    model: 'VF-2',
    serialNumber: 'HA-VF2-11904',
    machineTypeCode: machineTypeCodeFor('CNC Milling Machine'),
    year: 2018,
    approval: 'approved',
  });

  /*
   * Rates, so a job can be priced.
   *
   * Representative figures for a test, not EJE's charge-out rates — those are
   * business data and are captured by the business, never invented here.
   */
  await db.insert(schema.systemSettings).values({
    id: 1,
    companyName: 'EJE Industrial Electronics',
    labourNormalCents: 95_000,
    labourOvertimeCents: 142_500,
    labourDoubleCents: 190_000,
    calloutRateCents: 85_000,
    kilometreRateCents: 1_850,
    vatPercentBasisPoints: 1_500,
  });
};

/** A minimal, valid job. Its number must already have been allocated. */
export const jobFixture = (jobNumber: string, over: Partial<Job> = {}): Job => ({
  id: asJobId(crypto.randomUUID()),
  jobNumber,
  customerId: asCustomerId(IDS.customer),
  siteId: asSiteId(IDS.site),
  contactId: asContactId(IDS.contact),
  machineId: asMachineId(IDS.machine),
  jobType: 'breakdown',
  priority: 'urgent',
  status: 'open',
  scheduledDate: null,
  scheduledEndDate: null,
  orderNumber: '',
  referenceNumber: '',
  faultDescription: 'Spindle drive alarm 750.',
  attachments: [],
  primaryTechnicianId: null,
  additionalTechnicianIds: [],
  labour: [],
  travel: [],
  parts: [],
  photos: [],
  videos: [],
  notes: [],
  completionReport: {
    faultFindings: '',
    diagnosis: '',
    workPerformed: '',
    recommendations: '',
    generalNotes: '',
  },
  checklist: null,
  signature: null,
  signatureRefusals: [],
  awaitingSparesReason: '',
  calloutApplied: false,
  courierCollection: false,
  waybillNumber: '',
  deliveryNote: '',
  pricingSnapshot: null,
  finalDocument: null,
  delivery: null,
  cancellation: null,
  createdAt: '2026-09-20T08:00:00.000Z',
  createdBy: asUserId(IDS.master),
  acceptedAt: null,
  completedAt: null,
  submittedAt: null,
  closedAt: null,
  ...over,
});
