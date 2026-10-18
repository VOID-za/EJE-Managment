import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_USERS, signedInAs, startTestServer, type ApiTestClient } from '@/test/api-harness';
import type { ChangeRequest } from '@/domain';

/**
 * REPORTS THAT THE REGISTER IS WRONG, THROUGH THE REAL ROUTES. CUST-CR.
 *
 * The operations have their own tests; these are about the HTTP boundary, where
 * the actor comes from a session and every identifier comes from a browser:
 *
 *   - a technician may RAISE one (the whole point — they cannot edit the
 *     record) and may not read anybody else's;
 *   - the office's list needs `customers.manage`, and the refusal is a 403
 *     rather than an empty list, because an empty list reads as "no problems";
 *   - resolving is office-only and happens once.
 */
describe('the change-request routes', () => {
  let technician: ApiTestClient;
  let master: ApiTestClient;
  let riaan: ApiTestClient;

  beforeEach(async () => {
    startTestServer();
    technician = await signedInAs(DEMO_USERS.technician);
    riaan = await signedInAs(DEMO_USERS.otherTechnician);
    master = await signedInAs(DEMO_USERS.master);
  });

  const raise = (client: ApiTestClient, body: Readonly<Record<string, unknown>>) =>
    client.post<ChangeRequest>('/api/change-requests', body);

  it('lets a technician report the customer record they cannot edit', async () => {
    const raised = await raise(technician, {
      subject: 'customer',
      customerId: 'cust-abc',
      details: 'The accounts email bounces.',
    });

    expect(raised.status).toBe(200);
    expect(raised.data.state).toBe('open');
    expect(raised.data.raisedAt.length).toBeGreaterThan(0);
  });

  it('REFUSES a technician the office’s list, rather than answering it empty', async () => {
    await raise(technician, {
      subject: 'customer',
      customerId: 'cust-abc',
      details: 'Something to find.',
    });

    const refused = await technician.get('/api/change-requests');
    /*
     * A 403 rather than `{ rows: [] }`. An empty list reads as "there are no
     * problems with the register", which is a different and false statement.
     */
    expect(refused.status).toBe(403);
  });

  it('gives a technician their OWN reports and nobody else’s', async () => {
    await raise(technician, {
      subject: 'customer',
      customerId: 'cust-abc',
      details: 'Reported by Sipho.',
    });
    await raise(riaan, {
      subject: 'customer',
      customerId: 'cust-abc',
      details: 'Reported by Riaan.',
    });

    const mine = await technician.get<{ rows: readonly ChangeRequest[] }>(
      '/api/change-requests?mine=1',
    );
    expect(mine.status).toBe(200);
    expect(mine.data.rows).toHaveLength(1);
    expect(mine.data.rows[0]?.details).toBe('Reported by Sipho.');
  });

  it('gives the office every report', async () => {
    await raise(technician, {
      subject: 'customer',
      customerId: 'cust-abc',
      details: 'One.',
    });
    await raise(riaan, { subject: 'customer', customerId: 'cust-abc', details: 'Two.' });

    const all = await master.get<{ rows: readonly ChangeRequest[] }>('/api/change-requests');
    expect(all.status).toBe(200);
    expect(all.data.rows).toHaveLength(2);
    // Oldest open first: the report that has waited longest is the one to read.
    expect(all.data.rows[0]?.details).toBe('One.');
  });

  it('REFUSES a report filed against another customer’s machine', async () => {
    // Whose machine is whose comes from the customer screen rather than from a
    // display name, which is a label and not an identity.
    const screen = await master.get<{ machines: readonly { id: string }[] }>(
      '/api/customers/cust-abc',
    );
    const theirs = new Set(screen.data.machines.map((machine) => machine.id));
    const machines = await master.get<readonly { id: string }[]>('/api/machines');
    const other = machines.data.find((machine) => !theirs.has(machine.id));
    expect(other, 'the demonstration data has only one customer with machines').toBeDefined();

    const wrong = await raise(technician, {
      subject: 'machine',
      customerId: 'cust-abc',
      machineId: other!.id,
      details: 'Wrong serial.',
    });
    expect(wrong.status).toBe(422);
    expect(wrong.error?.violations?.[0]?.code).toBe('machine_not_of_customer');
  });

  it('REFUSES a report with no words in it, at both layers', async () => {
    // Empty: the schema refuses it before the operation is reached, which is
    // where a length belongs — a 400, and nothing is written.
    const empty = await raise(technician, {
      subject: 'customer',
      customerId: 'cust-abc',
      details: '',
    });
    expect(empty.status).toBe(400);

    // Whitespace: the schema is satisfied and the OPERATION refuses it, which
    // is where "a report has to say something" belongs.
    const blank = await raise(technician, {
      subject: 'customer',
      customerId: 'cust-abc',
      details: '    ',
    });
    expect(blank.status).toBe(422);
    expect(blank.error?.violations?.[0]?.code).toBe('details_required');

    const mine = await technician.get<{ rows: readonly ChangeRequest[] }>(
      '/api/change-requests?mine=1',
    );
    expect(mine.data.rows).toEqual([]);
  });

  it('lets the office record what they did, once', async () => {
    const raised = await raise(technician, {
      subject: 'customer',
      customerId: 'cust-abc',
      details: 'VAT number has a transposed digit.',
    });
    const id = raised.data.id;

    const applied = await master.post<ChangeRequest>(`/api/change-requests/${id}/resolve`, {
      outcome: 'applied',
      note: 'Corrected on the customer tab.',
    });
    expect(applied.status).toBe(200);
    expect(applied.data.state).toBe('applied');

    const again = await master.post(`/api/change-requests/${id}/resolve`, {
      outcome: 'declined',
      note: 'Changed my mind.',
    });
    expect(again.status).toBe(422);
    expect(again.error?.violations?.[0]?.code).toBe('already_resolved');
  });

  it('REFUSES a technician resolving their own report', async () => {
    const raised = await raise(technician, {
      subject: 'customer',
      customerId: 'cust-abc',
      details: 'Mine to report, not mine to decide.',
    });

    const refused = await technician.post(`/api/change-requests/${raised.data.id}/resolve`, {
      outcome: 'applied',
      note: 'I did it myself.',
    });
    expect(refused.status).toBe(403);
  });

  it('REFUSES a decision with no note', async () => {
    const raised = await raise(technician, {
      subject: 'customer',
      customerId: 'cust-abc',
      details: 'Needs a decision with words.',
    });

    // Empty is refused by the schema; whitespace by the operation, which is
    // the one that knows a decision needs words.
    const empty = await master.post(`/api/change-requests/${raised.data.id}/resolve`, {
      outcome: 'declined',
      note: '',
    });
    expect(empty.status).toBe(400);

    const blank = await master.post(`/api/change-requests/${raised.data.id}/resolve`, {
      outcome: 'declined',
      note: '   ',
    });
    expect(blank.status).toBe(422);
    expect(blank.error?.violations?.[0]?.code).toBe('note_required');

    // Still open for somebody to deal with properly.
    const rows = await master.get<{ rows: readonly ChangeRequest[] }>(
      '/api/change-requests?state=open',
    );
    expect(rows.data.rows).toHaveLength(1);
  });

  /**
   * THE CUSTOMER SCREEN CARRIES THE OFFICE'S COPY AND NOT A TECHNICIAN'S.
   *
   * Composed on the server rather than filtered in the browser: that somebody
   * complained about a record is not a technician's to read, so the field is
   * empty for them in the response itself.
   */
  it('puts the reports on the office’s customer screen and not the technician’s', async () => {
    await raise(technician, {
      subject: 'customer',
      customerId: 'cust-abc',
      details: 'On the screen for the office.',
    });

    const office = await master.get<{ changeRequests: readonly ChangeRequest[] }>(
      '/api/customers/cust-abc',
    );
    expect(office.status).toBe(200);
    expect(office.data.changeRequests).toHaveLength(1);

    const field = await technician.get<{ changeRequests: readonly ChangeRequest[] }>(
      '/api/customers/cust-abc',
    );
    expect(field.status).toBe(200);
    expect(field.data.changeRequests).toEqual([]);
  });
});
