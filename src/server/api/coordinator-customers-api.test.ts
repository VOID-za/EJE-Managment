import { beforeEach, describe, expect, it } from 'vitest';
import type { Customer } from '@/domain';
import { DEMO_USERS, signedInAs, startTestServer, type ApiTestClient } from '@/test/api-harness';

/**
 * THE COORDINATOR'S CUSTOMER SCREEN, OVER THE REAL ROUTES. Customers §2.
 *
 * The application tests prove the rules. What is left to the HTTP layer is the
 * part the owner's feedback was actually about: whether a Coordinator signed in
 * as themselves can do these things through the API the screen calls. A control
 * that is rendered and a request that is refused look the same to the person
 * using it, so both halves are asserted here.
 *
 * A refusal of AUTHORITY is a 403 and a refusal of the OPERATION is a 422,
 * which is the house convention and is what a screen's wording depends on.
 */
interface CustomerPayload {
  readonly customer: Customer;
}

const customerScreen = async (client: ApiTestClient, customerId: string): Promise<Customer> =>
  (await client.get<CustomerPayload>(`/api/customers/${customerId}`)).data.customer;

const firstCustomerId = async (client: ApiTestClient): Promise<string> => {
  const response = await client.get<readonly { readonly id: string }[]>('/api/customers');
  return response.data[0]!.id;
};

describe('a Coordinator on the customers screen', () => {
  let coordinator: ApiTestClient;
  let technician: ApiTestClient;
  let customerId: string;

  beforeEach(async () => {
    startTestServer();
    coordinator = await signedInAs(DEMO_USERS.coordinator);
    technician = await signedInAs(DEMO_USERS.technician);
    customerId = await firstCustomerId(coordinator);
  });

  it('CREATES a customer', async () => {
    const response = await coordinator.post('/api/customers', {
      name: 'Vaal Precision Engineering',
      accountNumber: 'VPE-0007',
      registrationNumber: '2021/111222/07',
      vatNumber: '4330229911',
      phone: '016 555 0199',
      email: 'admin@vaalprecision.co.za',
      industry: 'Precision machining',
      paymentTerms: '30 days',
      site: {
        name: 'Vereeniging Works',
        addressLine1: '8 Houtkop Road',
        addressLine2: '',
        city: 'Vereeniging',
        province: 'Gauteng',
        postalCode: '1930',
        accessNotes: '',
      },
      contact: {
        firstName: 'Jaco',
        lastName: 'Steyn',
        position: 'Workshop manager',
        email: 'jaco@vaalprecision.co.za',
        phone: '083 555 0199',
        isPrimary: true,
      },
    });

    expect(response.status, JSON.stringify(response.error)).toBe(200);
  });

  it('VIEWS an existing customer', async () => {
    const customer = await customerScreen(coordinator, customerId);
    expect(customer.id).toBe(customerId);
    expect(customer.name.length).toBeGreaterThan(0);
  });

  it('ADDS an account note, and the customer comes back carrying it', async () => {
    const response = await coordinator.post(`/api/customers/${customerId}/add_note`, {
      body: 'Deliveries to the rear gate only.',
    });
    expect(response.status, JSON.stringify(response.error)).toBe(200);

    const after = await customerScreen(coordinator, customerId);
    expect(after.notes.map((note) => note.body)).toContain('Deliveries to the rear gate only.');
  });

  it('EDITS an account note, and the screen can tell it was edited', async () => {
    await coordinator.post(`/api/customers/${customerId}/add_note`, { body: 'First wording.' });
    const withNote = await customerScreen(coordinator, customerId);
    const note = withNote.notes.find((candidate) => candidate.body === 'First wording.')!;

    const response = await coordinator.post(`/api/customers/${customerId}/edit_note`, {
      noteId: note.id,
      body: 'Corrected wording.',
    });
    expect(response.status, JSON.stringify(response.error)).toBe(200);

    const after = await customerScreen(coordinator, customerId);
    const edited = after.notes.find((candidate) => candidate.id === note.id)!;
    expect(edited.body).toBe('Corrected wording.');
    expect(edited.editedAt).not.toBeNull();
    // The author and the moment are unchanged: an edit does not rewrite who
    // said it or when.
    expect(edited.authorId).toBe(note.authorId);
    expect(edited.createdAt).toBe(note.createdAt);
  });

  it('ADDS a customer document, and lists it back', async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25]);
    const response = await coordinator.upload(`/api/customers/${customerId}/documents`, {
      name: 'rate-agreement.pdf',
      type: 'application/pdf',
      bytes: pdf,
      fields: { caption: 'Signed rate agreement' },
    });
    expect(response.status, JSON.stringify(response.error)).toBe(200);

    const listed = await coordinator.get<{
      readonly documents: readonly { readonly fileName: string }[];
    }>(`/api/customers/${customerId}/documents`);
    expect(listed.data.documents.map((document) => document.fileName)).toContain(
      'rate-agreement.pdf',
    );
  });

  it('refuses a blank note by SCHEMA, with a 400', async () => {
    const response = await coordinator.post(`/api/customers/${customerId}/add_note`, { body: '' });
    expect(response.status).toBe(400);
  });

  it('refuses a WHITESPACE-ONLY note by OPERATION, with a 422', async () => {
    // The schema sees three characters and is satisfied; the rule is the
    // operation's, which is why the status differs from the case above.
    const response = await coordinator.post(`/api/customers/${customerId}/add_note`, {
      body: '   ',
    });
    expect(response.status).toBe(422);
  });

  it('refuses a technician’s note with a 403, not a quietly ignored write', async () => {
    const response = await technician.post(`/api/customers/${customerId}/add_note`, {
      body: 'Technicians cannot write these.',
    });
    expect(response.status).toBe(403);

    const after = await customerScreen(coordinator, customerId);
    expect(after.notes.map((note) => note.body)).not.toContain(
      'Technicians cannot write these.',
    );
  });

  it('sends a technician the customer documents, and no storage key. CUST-DOC-2', async () => {
    /*
     * This answered 403 until the owner decided a technician may view and
     * download a customer's filed paperwork. What is still withheld from every
     * role is the STORAGE KEY: the download route resolves one after deciding
     * who is asking, and a key is not a way in.
     */
    const response = await technician.get<{
      readonly documents: readonly Record<string, unknown>[];
    }>(`/api/customers/${customerId}/documents`);
    expect(response.status, JSON.stringify(response.error)).toBe(200);
    for (const document of response.data.documents) {
      expect(document).not.toHaveProperty('storageKey');
    }
  });
});
