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
   * WHO IS ASKED FIRST, AT THE LAYER IT MATTERS.
   *
   * The thing being held here has never been who exactly may submit — it is
   * that `issue` refuses on PERMISSION before it refuses on the job's state.
   * Calling it used to be refused only by the status ("not ready to be
   * issued"), so on a job that HAD reached Review the wrong person would have
   * generated the final PDF and emailed the customer.
   *
   * WHO changed on 25 September 2026 (CR-07): the normal signed journey has no
   * office step, so the technician who did the work submits it and the office
   * does not. The three cases below are the same three questions with their
   * actors swapped, not new or weaker ones.
   */
  const issue = async (client: ApiTestClient) =>
    client.post('/api/jobs/EJE-1048/issue', {});

  it('refuses a Master, on permission rather than on state', async () => {
    const response = await issue(await signedInAs(DEMO_USERS.master));

    expect(response.status).toBe(403);
    expect(JSON.stringify(response.raw)).toMatch(/cannot be submitted by you/i);
    expect(JSON.stringify(response.raw)).not.toMatch(/not ready to be issued/i);
  });

  it('refuses a coordinator the same way', async () => {
    const response = await issue(await signedInAs(DEMO_USERS.coordinator));

    expect(response.status).toBe(403);
    expect(JSON.stringify(response.raw)).toMatch(/cannot be submitted by you/i);
  });

  /*
   * THE CR-08 TAKEOVER, AT THE SAME LAYER.
   *
   * It is the one route that lets the office submit a signed job card, so the
   * thing worth holding here is that it is not a second door into `issue`: it
   * refuses on its own grounds, and the fixture's technician is at work.
   */
  const takeOver = async (client: ApiTestClient) =>
    client.post('/api/jobs/EJE-1048/take_over_submission', {});

  it('refuses a takeover while the technician is available — Master', async () => {
    // 422, not 403: the Master MAY take over, just not today. The condition is
    // the register's, and it can change; being told "forbidden" would be wrong.
    const response = await takeOver(await signedInAs(DEMO_USERS.master));
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.raw)).toMatch(/cannot be taken over by you/i);
    // Refused on the TAKEOVER's own grounds — the fixture's job is not signed
    // — rather than by falling through to the ordinary submission's refusal.
    expect(JSON.stringify(response.raw)).toMatch(/takeover_not_available/);
    expect(JSON.stringify(response.raw)).not.toMatch(/cannot be submitted by you/i);
  });

  it('refuses a takeover while the technician is available — Coordinator', async () => {
    const response = await takeOver(await signedInAs(DEMO_USERS.coordinator));
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.raw)).toMatch(/cannot be taken over by you/i);
  });

  it('refuses a takeover to a technician outright — it is the office’s exception', async () => {
    // 403 here, and permanently: no calendar entry makes this theirs.
    const response = await takeOver(await signedInAs(DEMO_USERS.technician));
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.raw)).toMatch(/cannot be taken over by you/i);
  });

  it('gets the technician past the permission check, and on to the job’s state', async () => {
    // Not refused for WHO they are. EJE-1048 is not at Review in the fixture,
    // so state refuses it — which is the correct second question, and proves
    // the first one passed.
    const response = await issue(await signedInAs(DEMO_USERS.technician));

    expect(JSON.stringify(response.raw)).not.toMatch(/cannot be submitted by you/i);
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
