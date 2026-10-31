import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_USERS, signedInAs, startTestServer, type ApiTestClient } from '@/test/api-harness';
import { businessToday } from '@/lib/business-time';
import { previousMonth, monthOfDate } from '@/lib/payroll-files';

/**
 * MY MONTHLY FORMS MEANS MY OWN FORMS — OVER THE REAL ROUTES. TST-MMF-1 (the
 * tester, 31 October 2026).
 *
 * A Master and a Coordinator have exactly a technician's own-forms workflow —
 * their timesheet, their attendance, their month to submit — and the access
 * the office has to EJE Monthly Forms (reading everybody's month) gives them
 * no way to WRITE anybody else's. Each request below is what a manipulated
 * client would send: another person's id in the path or the body. Every one is
 * refused by the server; the same request for the person's own id succeeds.
 */
interface Person {
  readonly id: string;
  readonly firstName: string;
}

const today = businessToday();
const month = previousMonth(monthOfDate(today));
const line = { date: today, customerName: 'Kruger Mining', workshop: false, overtimeHours: 1, doubleHours: 0, calloutAmount: 0, internalKm: 0, customerKm: 0 };

const peopleOf = async (client: ApiTestClient): Promise<readonly Person[]> => {
  const answer = await client.get<readonly Person[]>('/api/timesheets');
  expect(answer.status).toBe(200);
  return answer.data;
};

const refused = (answer: { readonly status: number; readonly error: unknown }) => {
  expect(answer.status, JSON.stringify(answer.error)).toBeGreaterThanOrEqual(400);
  expect(answer.status).toBeLessThan(500);
};

describe('the office keeps its OWN forms, and only its own', () => {
  let master: ApiTestClient;
  let coordinator: ApiTestClient;
  let people: readonly Person[];
  let me: Person;
  let coordinatorPerson: Person;
  let technician: Person;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
    coordinator = await signedInAs(DEMO_USERS.coordinator);
    people = await peopleOf(master);
    me = people[0]!;
    coordinatorPerson = people.find((person) => person.firstName === 'Christene')!;
    technician = people.find((person) => person.firstName === 'Sipho')!;
  });

  it('opens on the Master’s own timesheet, which the Master can fill in and read back', async () => {
    expect(me.firstName).toBe('Elmarie');
    const saved = await master.post(`/api/timesheets/${me.id}/entries`, line);
    expect(saved.status, JSON.stringify(saved.error)).toBe(200);
    const sheet = await master.get<{ readonly editable: boolean; readonly days: readonly { readonly entries: readonly unknown[] }[] }>(
      `/api/timesheets/${me.id}?from=${today}&to=${today}`,
    );
    expect(sheet.status).toBe(200);
    expect(sheet.data.editable).toBe(true);
    expect(sheet.data.days[0]?.entries).toHaveLength(1);
    // And the Coordinator's list starts with the Coordinator.
    expect((await peopleOf(coordinator))[0]?.firstName).toBe('Christene');
  });

  it('refuses every write to a technician’s timesheet, with the technician’s id in the path', async () => {
    refused(await master.post(`/api/timesheets/${technician.id}/entries`, line));
    refused(await master.post(`/api/timesheets/${technician.id}/period/comment`, { from: `${month}-01`, to: `${month}-01`, comment: 'not mine' }));
    refused(await master.post(`/api/timesheets/${technician.id}/period/submit`, { from: `${month}-01`, to: `${month}-01` }));
    refused(await coordinator.post(`/api/timesheets/${technician.id}/entries`, line));
  });

  it('refuses one office user writing the other’s timesheet', async () => {
    refused(await coordinator.post(`/api/timesheets/${me.id}/entries`, line));
    refused(await master.post(`/api/timesheets/${coordinatorPerson.id}/entries`, line));
    const own = await master.post<{ readonly entry: { readonly id: string } }>(`/api/timesheets/${me.id}/entries`, line);
    expect(own.status).toBe(200);
    // Not by correcting it through their own sheet, and not by removing it.
    refused(await coordinator.post(`/api/timesheets/${coordinatorPerson.id}/entries`, { ...line, entryId: own.data.entry.id }));
    refused(await coordinator.post(`/api/timesheets/${me.id}/entries/${own.data.entry.id}/remove`, {}));
  });

  it('refuses submitting anybody else’s month, though the office can read it', async () => {
    refused(await master.post(`/api/payroll/${technician.id}/${month}/submit`, { confirmUnrecorded: true }));
    refused(await coordinator.post(`/api/payroll/${me.id}/${month}/submit`, { confirmUnrecorded: true }));

    const theirs = await master.get<{ readonly owner: boolean; readonly canSubmit: boolean }>(`/api/payroll/${technician.id}/${month}`);
    expect(theirs.status).toBe(200);
    expect(theirs.data.owner).toBe(false);
    expect(theirs.data.canSubmit).toBe(false);

    const mine = await master.get<{ readonly owner: boolean }>(`/api/payroll/${me.id}/${month}`);
    expect(mine.status).toBe(200);
    expect(mine.data.owner).toBe(true);
  });
});

describe('a technician’s own forms are theirs alone', () => {
  beforeEach(() => startTestServer());

  it('refuses another person’s attendance, timesheet and month, and accepts their own', async () => {
    const sipho = await signedInAs(DEMO_USERS.technician);
    const [self] = await peopleOf(sipho);
    const master = await signedInAs(DEMO_USERS.master);
    const others = (await peopleOf(master)).filter((person) => person.id !== self!.id);
    const riaan = others.find((person) => person.firstName === 'Riaan')!;

    refused(await sipho.post('/api/attendance', { userId: riaan.id, date: today, status: 'present', note: '' }));
    refused(await sipho.post(`/api/timesheets/${riaan.id}/entries`, line));
    refused(await sipho.post(`/api/payroll/${riaan.id}/${month}/submit`, { confirmUnrecorded: true }));
    refused(await sipho.get(`/api/payroll/${riaan.id}/${month}`));

    expect((await sipho.post('/api/attendance', { userId: self!.id, date: today, status: 'present', note: '' })).status).toBe(200);
    expect((await sipho.post(`/api/timesheets/${self!.id}/entries`, line)).status).toBe(200);
  });
});
