import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_USERS, signedInAs, type ApiTestClient } from '@/test/api-harness';
import { startTestServer } from '@/test/api-harness';

/**
 * Who may read the customer register, and who may change it.
 *
 * THE RULE, which the system has always stated rather than one invented here:
 * `customers.view` reads, `customers.manage` changes. A technician holds the
 * first and not the second — `customer-operations.ts` refuses their edit with
 * "Technicians can view customers and raise change requests, but not edit
 * them", and the sidebar has always offered this screen on `customers.view`.
 *
 * It regressed when the screens moved behind the HTTP API: the read models were
 * given `customers.manage`, so the navigation offered a technician a screen the
 * server then refused. These tests hold both halves of the rule at once, so
 * neither half can be tightened or loosened without the other being noticed.
 *
 * DECISION 5 still applies to what hangs off the record. Reading a customer is
 * not reading their jobs: the job list on this screen is filtered per viewer
 * and priced per viewer, exactly as the Jobs screen is.
 *
 * Seeded facts these rely on (see `technician-visibility.test.ts`):
 *   EJE-1056  closed, Sipho, machine-abc-lv40, cust-abc     — his own work
 *   EJE-1044  closed, Riaan, machine-abc-lv40, cust-abc     — machine history
 *   EJE-1048  open,   Sipho, machine-abc-lv40, cust-abc     — his own work
 *   EJE-1061  in progress, Riaan, cust-kruger               — another's live job
 */
interface CustomerRow {
  readonly id: string;
  readonly name: string;
  readonly openJobs: number;
}

interface JobRow {
  readonly job: {
    readonly jobNumber: string;
    readonly status: string;
    readonly pricingSnapshot: unknown;
    readonly parts: readonly { readonly unitPrice: number }[];
  };
}

interface CustomerRecord {
  readonly customer: {
    readonly id: string;
    readonly name: string;
    /** The commercial fields EJE confirmed a technician may read. */
    readonly paymentTerms: string;
    readonly vatNumber: string;
    readonly registrationNumber: string;
  };
  readonly sites: readonly unknown[];
  readonly machines: readonly unknown[];
  readonly jobRows: readonly JobRow[];
}

const record = async (client: ApiTestClient, customerId: string) =>
  client.get<CustomerRecord>(`/api/customers/${customerId}`);

const numbersIn = (data: CustomerRecord): readonly string[] =>
  data.jobRows.map((row) => row.job.jobNumber);

describe('reading the customer register', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('serves a technician the register, because reading it is theirs', async () => {
    const technician = await signedInAs(DEMO_USERS.technician);
    const response = await technician.get<readonly CustomerRow[]>('/api/customers');

    expect(response.status).toBe(200);
    expect(response.data.length).toBeGreaterThan(0);
  });

  it('serves a technician one customer record, with its sites and machines', async () => {
    const technician = await signedInAs(DEMO_USERS.technician);
    const response = await record(technician, 'cust-abc');

    expect(response.status).toBe(200);
    // The point of a technician reading this at all: where to go and what
    // stands there.
    expect(response.data.sites.length).toBeGreaterThan(0);
    expect(response.data.machines.length).toBeGreaterThan(0);
  });

  it('serves the office the same screens, unchanged', async () => {
    for (const email of [DEMO_USERS.master, DEMO_USERS.coordinator]) {
      const client = await signedInAs(email);
      expect((await client.get('/api/customers')).status).toBe(200);
      expect((await record(client, 'cust-abc')).status).toBe(200);
    }
  });

  /**
   * A CONFIRMED BUSINESS RULE, not an oversight.
   *
   * EJE were asked directly whether a technician should see a customer's
   * commercial and account information, and said yes: payment terms, the VAT
   * number and the registration number are all readable. This test exists so
   * that decision cannot be mistaken for an unresolved question and quietly
   * reversed by somebody "tightening" the read later — reversing it means
   * deleting this test, which is a conversation rather than a tidy-up.
   */
  it('serves a technician the commercial fields, which EJE confirmed they may read', async () => {
    const technician = await signedInAs(DEMO_USERS.technician);
    const { customer } = (await record(technician, 'cust-abc')).data;

    expect(customer.paymentTerms).toBe('30 days from statement');
    expect(customer.vatNumber).toBe('4220156783');
    expect(customer.registrationNumber).toBe('1998/004521/07');
  });

  it('serves them to the office identically, so there is one customer record', async () => {
    // Not a redacted copy for one role and a full copy for another: the same
    // record, so nothing downstream has to know which version it was handed.
    const technician = await signedInAs(DEMO_USERS.technician);
    const master = await signedInAs(DEMO_USERS.master);

    expect((await record(technician, 'cust-abc')).data.customer).toEqual(
      (await record(master, 'cust-abc')).data.customer,
    );
  });

  it('still answers 404 for a customer that does not exist', async () => {
    const technician = await signedInAs(DEMO_USERS.technician);
    expect((await record(technician, 'cust-nobody')).status).toBe(404);
  });
});

describe('changing the customer register', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('refuses a technician the creation of a customer', async () => {
    const technician = await signedInAs(DEMO_USERS.technician);
    const response = await technician.post('/api/customers', {
      name: 'Nuwe Nywerhede',
      accountNumber: 'NN-001',
      registrationNumber: '2020/123456/07',
      vatNumber: '4001234567',
      phone: '011 555 0000',
      email: 'accounts@nuwe-demo.co.za',
      industry: 'Engineering',
      paymentTerms: '30 days',
      site: {
        name: 'Head office',
        addressLine1: '1 Nuwe Road',
        addressLine2: '',
        city: 'Benoni',
        province: 'Gauteng',
        postalCode: '1501',
        accessNotes: '',
      },
      contact: null,
    });

    expect(response.status).toBe(403);
    expect(response.error?.code).toBe('forbidden');
  });

  it('refuses a technician the editing of a customer', async () => {
    const technician = await signedInAs(DEMO_USERS.technician);
    // A COMPLETE, well-formed edit: validation passes and the refusal is the
    // authorization rule doing its job, not a malformed body being rejected.
    const response = await technician.post('/api/customers/cust-abc/update', {
      name: 'Renamed by a technician',
      accountNumber: 'ABC-001',
      registrationNumber: '1998/012345/07',
      vatNumber: '4123456789',
      phone: '011 555 0100',
      industry: 'Precision engineering',
      paymentTerms: '30 days',
    });

    expect(response.status).toBe(403);
    expect(response.error?.code).toBe('forbidden');
  });

  it('refuses a technician the addition of a site', async () => {
    const technician = await signedInAs(DEMO_USERS.technician);
    const response = await technician.post('/api/customers/cust-abc/add_site', {
      name: 'A site they invented',
      addressLine1: '2 Nowhere Street',
      addressLine2: '',
      city: 'Benoni',
      province: 'Gauteng',
      postalCode: '1501',
      accessNotes: '',
    });

    expect(response.status).toBe(403);
  });

  /**
   * NOT everything on a customer's screen is the office's.
   *
   * A technician who finds a machine on site that is not on the register adds
   * it, and `approvalForNewMachine` lands it as `pending_approval` for a Master
   * to confirm. It is the one write on this screen that is theirs, and it is
   * easy to lose by gating the whole screen on `machines.manage`.
   */
  it('still lets a technician add a machine, for a Master to confirm', async () => {
    const technician = await signedInAs(DEMO_USERS.technician);
    const response = await technician.post<{ readonly approval: string }>('/api/machines', {
      customerId: 'cust-abc',
      siteId: 'site-abc-jhb',
      manufacturer: 'Mazak',
      model: 'QT-300',
      serialNumber: 'MZ-QT300-55501',
      machineNumber: '',
      machineType: 'CNC Lathe',
      year: 2016,
      installationDate: '',
      controlSystem: '',
      notes: 'Found on site, not on the register.',
    });

    expect(response.status).toBe(200);
    expect(response.data.approval).toBe('pending_approval');
  });

  it('leaves the register untouched after every refusal', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const before = await record(master, 'cust-abc');

    const technician = await signedInAs(DEMO_USERS.technician);
    await technician.post('/api/customers/cust-abc/update', {
      name: 'Renamed',
      accountNumber: 'ABC-001',
      registrationNumber: '1998/012345/07',
      vatNumber: '4123456789',
      phone: '011 555 0100',
      industry: 'Precision engineering',
      paymentTerms: '30 days',
    });
    await technician.post('/api/customers/cust-abc/add_site', {
      name: 'Invented',
      addressLine1: '2 Nowhere Street',
      addressLine2: '',
      city: 'Benoni',
      province: 'Gauteng',
      postalCode: '1501',
      accessNotes: '',
    });

    const after = await record(master, 'cust-abc');
    expect(after.data.customer.name).toBe(before.data.customer.name);
    expect(after.data.sites.length).toBe(before.data.sites.length);
  });
});

/**
 * The record is readable; the work on it is still DECISION 5.
 *
 * This is the half that a capability check alone would have got wrong. Opening
 * the screen to technicians without filtering what hangs off it would have
 * handed every technician every job in the business, one customer at a time,
 * with the prices on them.
 */
describe('the jobs on a customer a technician may read', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('shows the technician their own work on that customer', async () => {
    const technician = await signedInAs(DEMO_USERS.technician);
    const numbers = numbersIn((await record(technician, 'cust-abc')).data);

    expect(numbers).toContain('EJE-1048');
    expect(numbers).toContain('EJE-1056');
  });

  it('leaves out another technician’s live job', async () => {
    const technician = await signedInAs(DEMO_USERS.technician);
    const numbers = numbersIn((await record(technician, 'cust-kruger')).data);

    expect(numbers).not.toContain('EJE-1061');
  });

  it('hands the office that same job, which is unchanged', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const numbers = numbersIn((await record(master, 'cust-kruger')).data);

    expect(numbers).toContain('EJE-1061');
  });

  it('keeps the history of a machine they have worked, with no prices on it', async () => {
    const technician = await signedInAs(DEMO_USERS.technician);
    const rows = (await record(technician, 'cust-abc')).data.jobRows;

    // Riaan's closed service on the machine Sipho has worked: useful history,
    // and none of EJE's business what it was charged at.
    const history = rows.find((row) => row.job.jobNumber === 'EJE-1044');
    expect(history).toBeDefined();
    expect(history?.job.pricingSnapshot).toBeNull();
    expect(history?.job.parts.every((part) => part.unitPrice === 0)).toBe(true);
  });

  it('keeps the prices on the technician’s own closed job', async () => {
    const technician = await signedInAs(DEMO_USERS.technician);
    const rows = (await record(technician, 'cust-abc')).data.jobRows;

    // Suppression is per visibility, not per role: his own work still prices.
    const own = rows.find((row) => row.job.jobNumber === 'EJE-1056');
    expect(own?.job.pricingSnapshot).not.toBeNull();
  });

  it('serves the office the prices on both, which is unchanged', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const rows = (await record(master, 'cust-abc')).data.jobRows;

    for (const number of ['EJE-1044', 'EJE-1056']) {
      expect(rows.find((row) => row.job.jobNumber === number)?.job.pricingSnapshot).not.toBeNull();
    }
  });

  it('counts only the open jobs the viewer may actually open', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const technician = await signedInAs(DEMO_USERS.technician);

    const forMaster = (await master.get<readonly CustomerRow[]>('/api/customers')).data;
    const forTechnician = (await technician.get<readonly CustomerRow[]>('/api/customers')).data;

    const kruger = (rows: readonly CustomerRow[]) =>
      rows.find((row) => row.id === 'cust-kruger')?.openJobs ?? -1;

    // EJE-1061 is live and Riaan's, so it is in the office's count and not in
    // Sipho's. A count he cannot account for is itself a disclosure.
    expect(kruger(forMaster)).toBeGreaterThan(kruger(forTechnician));
  });
});

/**
 * One machine, reached from the customer record.
 *
 * Not gated on `machines.manage` — the machine REGISTER is an office screen but
 * one machine's history is what DECISION 5 exists to give a technician. It was
 * serving that history unfiltered and fully priced.
 */
describe('a machine a technician opens', () => {
  beforeEach(() => {
    startTestServer();
  });

  const machine = async (client: ApiTestClient) =>
    client.get<{ readonly jobRows: readonly JobRow[] }>('/api/machines/machine-abc-lv40');

  it('shows its finished history with the prices removed', async () => {
    const technician = await signedInAs(DEMO_USERS.technician);
    const response = await machine(technician);

    expect(response.status).toBe(200);
    const history = response.data.jobRows.find((row) => row.job.jobNumber === 'EJE-1044');
    expect(history).toBeDefined();
    expect(history?.job.pricingSnapshot).toBeNull();
  });

  it('shows the office the same machine in full, which is unchanged', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const response = await machine(master);

    const history = response.data.jobRows.find((row) => row.job.jobNumber === 'EJE-1044');
    expect(history?.job.pricingSnapshot).not.toBeNull();
  });

  it('does not hand a technician a live job on a machine through its history', async () => {
    const technician = await signedInAs(DEMO_USERS.otherTechnician);
    // Riaan has worked machine-abc-lv40 (EJE-1044), so he reaches its history.
    // EJE-1048 is Sipho's live job on that same machine, and is not history.
    const numbers = (await machine(technician)).data.jobRows.map((row) => row.job.jobNumber);

    expect(numbers).toContain('EJE-1056');
    expect(numbers).not.toContain('EJE-1048');
  });
});
