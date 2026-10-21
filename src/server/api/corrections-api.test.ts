import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_USERS, signedInAs, startTestServer, type ApiTestClient } from '@/test/api-harness';

/**
 * CORRECTIONS AND UNSIGNED DELIVERY, THROUGH THE REAL ROUTES.
 * BD-02, BD-06, IMMUT-9, AUD-3, AUD-4.
 *
 * The application tests prove the rules. These prove the HTTP boundary, where
 * the actor comes from a session and every identifier comes from a browser:
 *
 *   - a Coordinator and a technician are refused by the SERVER, not by a
 *     screen that does not draw the button;
 *   - a correction id belonging to another job does not resolve under this
 *     job's URL;
 *   - the addendum comes back as bytes, to the people who may read the job
 *     card it corrects;
 *   - and a body that is the wrong shape is a 400 rather than a surprise.
 */
const CLOSED_SIGNED = 'EJE-1044';

const RAISE = {
  reason: 'The labour hours were captured against the wrong rate.',
  narrative: 'Three hours were charged after hours and should have been normal time.',
  areas: ['labour', 'charges'],
  acknowledgementRequired: false,
} as const;

describe('corrections through the API', () => {
  let master: ApiTestClient;
  let coordinator: ApiTestClient;
  let technician: ApiTestClient;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
    coordinator = await signedInAs(DEMO_USERS.coordinator);
    technician = await signedInAs(DEMO_USERS.technician);
  });

  const raise = (client: ApiTestClient, body: unknown = RAISE, job = CLOSED_SIGNED) =>
    client.post<{ id: string; sequence: number }>(`/api/jobs/${job}/raise_correction`, body);

  it('lets a Master raise one on a closed, issued job card', async () => {
    const raised = await raise(master);
    expect(raised.status, JSON.stringify(raised.error)).toBe(200);
    expect(raised.data.sequence).toBe(1);
  });

  it('REFUSES a Coordinator', async () => {
    const refused = await raise(coordinator);
    expect([403, 422]).toContain(refused.status);
  });

  it('REFUSES a technician', async () => {
    const refused = await raise(technician);
    expect([403, 404, 422]).toContain(refused.status);
  });

  it('REFUSES a body with no areas at all', async () => {
    // The schema refuses the SHAPE; the operation refuses the meaning. This is
    // the first of the two, and it must not reach the operation.
    const refused = await raise(master, { ...RAISE, areas: [] });
    expect(refused.status).toBe(400);
  });

  it('REFUSES a body missing the acknowledgement decision', async () => {
    const { acknowledgementRequired: _omitted, ...body } = RAISE;
    const refused = await raise(master, body);
    expect(refused.status).toBe(400);
  });

  it('puts the correction on the JOB VIEW, without its storage key', async () => {
    await raise(master);

    // The job route answers `{ view, users, activity, submissionCover }`.
    const response = await master.get<{
      view: { corrections: readonly { sequence: number; reason: string }[] };
    }>(`/api/jobs/${CLOSED_SIGNED}`);
    expect(response.data.view.corrections).toHaveLength(1);
    expect(response.data.view.corrections[0]?.reason).toBe(RAISE.reason);
    // The storage key never leaves the server.
    expect(response.data.view.corrections[0]).not.toHaveProperty('documentStorageKey');
  });

  it('serves the addendum’s bytes, and they are a PDF', async () => {
    const raised = await raise(master);

    const file = await master.post<{ fileName: string; base64: string; sequence: number }>(
      `/api/documents/${CLOSED_SIGNED}/corrections/${raised.data.id}`,
    );
    expect(file.status, JSON.stringify(file.error)).toBe(200);
    expect(file.data.fileName).toMatch(/correction-1\.pdf$/u);
    expect(file.data.sequence).toBe(1);
    expect(Buffer.from(file.data.base64, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
  });

  /**
   * THE CROSS-JOB CASE, which is the one a URL invites: a real correction id
   * under a different, equally real job's URL.
   */
  it('REFUSES a correction id under another job’s URL, with a 404', async () => {
    const raised = await raise(master);
    const file = await master.post(`/api/documents/EJE-1056/corrections/${raised.data.id}`);
    expect(file.status).toBe(404);
  });

  it('answers 404 for a correction id that is not a correction', async () => {
    const file = await master.post(
      `/api/documents/${CLOSED_SIGNED}/corrections/00000000-0000-4000-8000-00000000dead`,
    );
    expect(file.status).toBe(404);
  });

  it('REFUSES acknowledging a correction that belongs to another job', async () => {
    const raised = await raise(master);
    const refused = await master.post(`/api/jobs/EJE-1056/acknowledge_correction`, {
      correctionId: raised.data.id,
      acknowledgedBy: 'Pieter Nel',
      method: 'By telephone',
      note: '',
    });
    expect(refused.status).toBe(404);
  });

  it('lets a Coordinator record the acknowledgement, but not raise one', async () => {
    const raised = await raise(master, { ...RAISE, acknowledgementRequired: true });

    const acknowledged = await coordinator.post(
      `/api/jobs/${CLOSED_SIGNED}/acknowledge_correction`,
      {
        correctionId: raised.data.id,
        acknowledgedBy: 'Pieter Nel',
        method: 'By telephone',
        note: '',
      },
    );
    expect(acknowledged.status, JSON.stringify(acknowledged.error)).toBe(200);
  });
});
