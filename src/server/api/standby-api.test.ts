import { beforeEach, describe, expect, it } from 'vitest';
import { standbyWeeksOfYear } from '@/domain';
import { businessToday } from '@/lib/business-time';
import { ApiTestClient, DEMO_USERS, signedInAs, startTestServer } from '@/test/api-harness';

/**
 * THE STANDBY CALENDAR THROUGH THE REAL ROUTES (STANDBY-3, STANDBY-11). A screen
 * can hide a button; these are the answers a client gets without the screen.
 * Plans NEXT year, so every week is in the future whatever today is.
 */
const YEAR = Number(businessToday().slice(0, 4)) + 1;
const WEEKS = standbyWeeksOfYear(YEAR);
const RANGE = `from=${YEAR}-01-01&to=${YEAR}-12-31`;

interface Calendar {
  readonly weeks: readonly { weekStart: string; status: string; places: readonly { position: string; userId: string | null }[] }[];
  readonly people: readonly { id: string; name: string }[];
}

const idOf = async (client: ApiTestClient): Promise<string> =>
  (await client.get<{ user: { id: string } }>('/api/auth/me')).data.user.id;

describe('the standby calendar over HTTP', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('refuses anybody not signed in', async () => {
    const anonymous = new ApiTestClient();
    expect((await anonymous.get(`/api/standby?${RANGE}`)).status).toBe(401);
    expect((await anonymous.get('/api/standby/requests')).status).toBe(401);
  });

  it('refuses a technician every administrative route, whatever the screen shows', async () => {
    const technician = await signedInAs(DEMO_USERS.technician);
    const me = await idOf(technician);
    expect((await technician.post('/api/standby/eligibility', { userId: me, main: true, helper: true, apprentice: false })).status).toBe(403);
    expect((await technician.post('/api/standby/generate', { year: YEAR })).status).toBe(403);
    expect((await technician.post('/api/standby/publish', { year: YEAR, acknowledgeIncomplete: true })).status).toBe(403);
    expect(
      (await technician.post('/api/standby/assign', { weekStart: WEEKS[0], position: 'main', userId: me, expectedUserId: null, reason: '' })).status,
    ).toBe(403);
    expect((await technician.post('/api/standby/requests/anything/decide', { decision: 'approve' })).status).toBe(403);
  });

  it('runs the whole swap workflow, and refuses what the workflow does not allow', async () => {
    const coordinator = await signedInAs(DEMO_USERS.coordinator);
    const master = await signedInAs(DEMO_USERS.master);
    const sipho = await signedInAs(DEMO_USERS.technician);
    const riaan = await signedInAs(DEMO_USERS.otherTechnician);
    const siphoId = await idOf(sipho);
    const riaanId = await idOf(riaan);

    for (const userId of [siphoId, riaanId]) {
      const set = await coordinator.post('/api/standby/eligibility', { userId, main: true, helper: false, apprentice: false });
      expect(set.status, JSON.stringify(set.error)).toBe(200);
    }
    const generated = await coordinator.post<{ result: { created: string[] } }>('/api/standby/generate', {
      year: YEAR,
      rotation: { main: [siphoId, riaanId] },
    });
    expect(generated.status, JSON.stringify(generated.error)).toBe(200);
    expect(generated.data.result.created).toHaveLength(WEEKS.length);

    // Drafts are the office's: a technician sees none of them.
    expect((await sipho.get<Calendar>(`/api/standby?${RANGE}`)).data.weeks).toEqual([]);
    expect((await coordinator.post('/api/standby/publish', { year: YEAR, acknowledgeIncomplete: false })).status).toBe(422);
    expect((await coordinator.post('/api/standby/publish', { year: YEAR, acknowledgeIncomplete: true })).status).toBe(200);
    const published = (await sipho.get<Calendar>(`/api/standby?${RANGE}`)).data;
    expect(published.weeks).toHaveLength(WEEKS.length);
    const [weekA, weekB] = [WEEKS[0]!, WEEKS[1]!];
    expect(published.weeks[0]!.places.find((place) => place.position === 'main')!.userId).toBe(siphoId);

    const body = { kind: 'main', weekStart: weekA, counterpartId: riaanId, counterpartWeekStart: weekB, reason: 'Family' };
    // The requester is the session's user: a body naming one is refused outright.
    expect((await riaan.post('/api/standby/requests', { ...body, requesterId: siphoId })).status).toBe(400);
    // Riaan offering Sipho's week.
    expect((await riaan.post('/api/standby/requests', { ...body, counterpartId: siphoId })).status).toBe(403);

    const asked = await sipho.post<{ request: { id: string; status: string } }>('/api/standby/requests', body);
    expect(asked.status, JSON.stringify(asked.error)).toBe(200);
    expect(asked.data.request.status).toBe('pending');
    expect((await sipho.post('/api/standby/requests', body)).status).toBe(422);
    const id = asked.data.request.id;

    // Neither side of the swap may decide it.
    expect((await riaan.post(`/api/standby/requests/${id}/decide`, { decision: 'approve' })).status).toBe(403);
    expect((await sipho.post(`/api/standby/requests/${id}/decide`, { decision: 'approve' })).status).toBe(403);
    // Nor withdraw it, except the requester.
    expect((await riaan.post(`/api/standby/requests/${id}/cancel`, {})).status).toBe(403);

    const approved = await coordinator.post<{ request: { status: string } }>(`/api/standby/requests/${id}/decide`, { decision: 'approve', note: 'OK' });
    expect(approved.status, JSON.stringify(approved.error)).toBe(200);
    expect(approved.data.request.status).toBe('approved');
    expect((await master.post(`/api/standby/requests/${id}/decide`, { decision: 'approve' })).status).toBe(422);

    const after = (await riaan.get<Calendar>(`/api/standby?${RANGE}`)).data;
    expect(after.weeks[0]!.places.find((place) => place.position === 'main')!.userId).toBe(riaanId);
    expect(after.weeks[1]!.places.find((place) => place.position === 'main')!.userId).toBe(siphoId);

    expect((await master.get<readonly unknown[]>('/api/standby/requests?status=approved')).data).toHaveLength(1);
    expect((await sipho.get<readonly unknown[]>('/api/standby/requests')).data).toHaveLength(1);
    const notes = (await riaan.get<{ notifications: readonly { type: string }[] }>('/api/notifications')).data.notifications;
    expect(notes.filter((note) => note.type === 'standby_swap_decided')).toHaveLength(1);
  });
});
