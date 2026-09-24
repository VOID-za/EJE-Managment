import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_USERS, signedInAs, startTestServer, type ApiTestClient } from '@/test/api-harness';

/**
 * THE AUTHORIZATION BOUNDARIES THE MASTER SCOPE DRAWS, AT THE API.
 *
 * Server-side, over HTTP, per §17 — "Server-side authorization mandatory" —
 * because a hidden button is not a control. Each case here corresponds to a
 * finding in the repository-to-scope audit against `95e9848`, and each had no
 * test at all before, which is why each shipped.
 */
describe('the final official submission — §3.1, §7, §15', () => {
  beforeEach(() => {
    startTestServer();
  });

  /*
   * The audit's critical finding, at the layer it matters.
   *
   * A technician calling `issue` was refused by the job's STATUS — "not ready
   * to be issued" — never by permission, so on a job that HAD reached Review
   * they would have generated the final PDF and emailed the customer. The
   * capability is now asked first, so the refusal is about who is asking.
   */
  const issue = async (client: ApiTestClient) =>
    client.post('/api/jobs/EJE-1048/issue', {});

  it('refuses a technician, on permission rather than on state', async () => {
    const response = await issue(await signedInAs(DEMO_USERS.technician));

    expect(response.status).toBe(403);
    expect(JSON.stringify(response.raw)).toMatch(/cannot be issued by you/i);
    expect(JSON.stringify(response.raw)).not.toMatch(/not ready to be issued/i);
  });

  it('refuses a coordinator the same way', async () => {
    const response = await issue(await signedInAs(DEMO_USERS.coordinator));

    expect(response.status).toBe(403);
    expect(JSON.stringify(response.raw)).toMatch(/cannot be issued by you/i);
  });

  it('gets a Master past the permission check, and on to the job’s state', async () => {
    // The Master is not refused for WHO they are. EJE-1048 is not at Review in
    // the fixture, so state refuses it — which is the correct second question,
    // and proves the first one passed.
    const response = await issue(await signedInAs(DEMO_USERS.master));

    expect(JSON.stringify(response.raw)).not.toMatch(/cannot be issued by you/i);
  });
});

describe('customer correspondence — §17', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('refuses a technician the outbox', async () => {
    /*
     * Every row carries a customer's address and a preview of what EJE said to
     * them, on every job — so an authenticated-only outbox handed a technician
     * the correspondence on jobs DECISION 5 says they may not even see.
     */
    const response = await (await signedInAs(DEMO_USERS.technician)).get('/api/outbox');

    expect(response.status).toBe(403);
    expect(response.error?.code).toBe('forbidden');
  });

  it('serves the office', async () => {
    expect((await (await signedInAs(DEMO_USERS.master)).get('/api/outbox')).status).toBe(200);
    expect((await (await signedInAs(DEMO_USERS.coordinator)).get('/api/outbox')).status).toBe(200);
  });
});

describe('the calendar — §3.3, §16, §24-CAL', () => {
  beforeEach(() => {
    startTestServer();
  });

  const range = '/api/calendar?from=2026-01-01&to=2026-12-31';

  it('serves every role, technicians included', async () => {
    for (const email of [DEMO_USERS.master, DEMO_USERS.coordinator, DEMO_USERS.technician]) {
      const response = await (await signedInAs(email)).get(range);
      expect(response.status, email).toBe(200);
    }
  });

  it('still refuses a technician the leave register — §8', async () => {
    const technician = await signedInAs(DEMO_USERS.technician);
    const response = await technician.post('/api/availability', {
      userId: '00000000-0000-4000-8000-000000000000',
      type: 'annual_leave',
      startDate: '2026-12-01',
      endDate: '2026-12-02',
      allDay: true,
      startTime: null,
      endTime: null,
      description: 'Reading the calendar is not writing it',
    });

    // Refused for WHO, not for the made-up technician id.
    expect(JSON.stringify(response.raw)).toMatch(/only the office/i);
  });
});
