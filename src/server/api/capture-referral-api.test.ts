import { beforeEach, describe, expect, it } from 'vitest';
import { ApiTestClient, DEMO_USERS, signedInAs, startTestServer } from '@/test/api-harness';

/**
 * WORK A TABLET COULD NOT GET ONTO A JOB, AND WHAT THE OFFICE DOES ABOUT IT.
 * BD-15, answering OFF-QUEUE-DEC-1.
 *
 * `queued-capture-api.test.ts` proves the server REFUSES a late capture when
 * the job has moved on. This file proves what happens next, which until BD-15
 * was nothing: the capture is retained, referred to the office with the
 * server's own refusal on it, and resolved by a person — either applied to the
 * job through the ordinary operation, or closed with a recorded reason.
 *
 * THE FOUR PROPERTIES THAT MATTER, each of which has a test below that fails
 * if it is broken:
 *
 *   1. REFERRING CHANGES NOTHING. The hours are not on the job because the job
 *      refused them, and referring them does not sneak them on.
 *   2. APPLYING GOES THROUGH THE DOMAIN. The referral is applied by running the
 *      real command with the real guards under the office's own authority. A
 *      job that still refuses the work leaves the referral OPEN — the refusal
 *      is not laundered into a resolution.
 *   3. ONLY THE OFFICE RESOLVES, and only once. The capability is the narrow
 *      `captures.resolveReferral`, not `admin.access`, and a second decision
 *      on the same referral is refused rather than overwriting the first.
 *   4. A TECHNICIAN SEES THEIR OWN AND NOBODY ELSE'S. That is how they learn
 *      what became of their work, and it is the whole of their access.
 */
const NEW_JOB = {
  customerId: 'cust-abc',
  siteId: 'site-abc-jhb',
  contactId: 'contact-abc-jhb',
  machineId: 'machine-abc-lv40',
  jobType: 'breakdown',
  priority: 'urgent',
  scheduledDate: null,
  scheduledEndDate: null,
  orderNumber: 'PO-99002',
  referenceNumber: '',
  faultDescription: 'Drive tripping under load.',
  primaryTechnicianId: null,
  courierCollection: false,
  deliveryNote: '',
} as const;

const LABOUR = {
  date: '2026-10-17',
  rateType: 'normal',
  hours: 3,
  description: 'Stripped and refitted the drive',
} as const;

interface JobBody {
  readonly id: string;
  readonly jobNumber: string;
  readonly status: string;
  readonly labour: readonly { readonly id: string; readonly hours: number }[];
}

interface Referral {
  readonly id: string;
  readonly jobId: string;
  readonly technicianId: string;
  readonly action: string;
  readonly state: string;
  readonly refusalCode: string;
  readonly refusalMessage: string;
  readonly idempotencyKey: string;
  readonly referredAt: string;
  readonly resolution: string | null;
  readonly resolutionNote: string;
  readonly resolvedBy: string | null;
}

interface ReferralRows {
  readonly rows: readonly {
    readonly referral: Referral;
    readonly jobNumber: string;
    readonly technicianName: string;
  }[];
}

const userId = async (client: ApiTestClient, email: string): Promise<string> =>
  (
    await client.get<{ users: readonly { id: string; email: string }[] }>('/api/admin')
  ).data.users.find((user) => user.email === email)?.id ?? '';

describe('referring a refused capture to the office', () => {
  let master: ApiTestClient;
  let coordinator: ApiTestClient;
  let sipho: ApiTestClient;
  let riaan: ApiTestClient;
  let job: JobBody;
  let siphoId: string;
  let riaanId: string;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
    coordinator = await signedInAs(DEMO_USERS.coordinator);
    siphoId = await userId(master, DEMO_USERS.technician);
    riaanId = await userId(master, DEMO_USERS.otherTechnician);
    job = (await master.post<JobBody>('/api/jobs', { ...NEW_JOB, primaryTechnicianId: siphoId }))
      .data;
    sipho = await signedInAs(DEMO_USERS.technician);
    riaan = await signedInAs(DEMO_USERS.otherTechnician);
    expect((await sipho.post(`/api/jobs/${job.id}/accept`)).status).toBe(200);
  });

  /** The job is taken off Sipho, so his held capture is refused on arrival. */
  const takeTheJobAway = async (): Promise<void> => {
    expect(
      (await master.post(`/api/jobs/${job.id}/assign_primary`, { technicianId: riaanId })).status,
    ).toBe(200);
  };

  const sendLate = (key: string) =>
    sipho.post(`/api/jobs/${job.id}/add_labour`, LABOUR, { idempotencyKey: key });

  const refer = (
    client: ApiTestClient,
    key: string,
    overrides: Readonly<Record<string, unknown>> = {},
  ) =>
    client.post<{ referral: Referral }>('/api/captures/referrals', {
      jobId: job.id,
      action: 'add_labour',
      payload: LABOUR,
      summary: '3 h normal — Stripped and refitted the drive',
      capturedAt: '2026-10-17T09:14:00.000Z',
      idempotencyKey: key,
      refusalCode: 'not_on_job',
      refusalMessage: 'You can only capture work on a job you are working on.',
      ...overrides,
    });

  const resolve = (client: ApiTestClient, id: string, body: Readonly<Record<string, unknown>>) =>
    client.post<{ referral: Referral }>(`/api/captures/referrals/${id}/resolve`, body);

  const labourOnJob = async (): Promise<number> =>
    (
      await master.get<{ view: { job: JobBody } }>(`/api/jobs/${job.jobNumber}`)
    ).data.view.job.labour.length;

  /* -- the tablet hands it over -------------------------------------------- */

  it('retains the capture with the server’s own refusal on it, and changes nothing', async () => {
    await takeTheJobAway();
    const refused = await sendLate('capture-taken-away');
    expect(refused.status).toBe(422);

    const referred = await refer(sipho, 'capture-taken-away');

    expect(referred.status).toBe(200);
    expect(referred.data.referral.state).toBe('open');
    expect(referred.data.referral.technicianId).toBe(siphoId);
    // The refusal is the SERVER's words, kept verbatim for the office to read.
    expect(referred.data.referral.refusalCode).toBe('not_on_job');
    expect(referred.data.referral.refusalMessage).toMatch(/only capture work on a job/iu);
    // Property 1: referring is not a way onto the job.
    expect(await labourOnJob()).toBe(0);
  });

  it('puts ONE referral on the office’s screen when a tablet refers twice', async () => {
    await takeTheJobAway();
    const first = await refer(sipho, 'capture-referred-twice');
    const again = await refer(sipho, 'capture-referred-twice');

    expect(again.status).toBe(200);
    // Idempotent on the CAPTURE, not on the request: same key, same referral.
    expect(again.data.referral.id).toBe(first.data.referral.id);
    expect(again.data.referral.referredAt).toBe(first.data.referral.referredAt);

    const office = await master.get<ReferralRows>('/api/captures/referrals');
    expect(office.data.rows.filter((row) => row.referral.id === first.data.referral.id)).toHaveLength(1);
  });

  it('keeps each capture separate, because each carries its own key', async () => {
    await takeTheJobAway();
    await refer(sipho, 'capture-one');
    await refer(sipho, 'capture-two', { summary: '48 km — Site visit' });

    const office = await master.get<ReferralRows>('/api/captures/referrals');
    const keys = office.data.rows.map((row) => row.referral.idempotencyKey);
    expect(keys).toContain('capture-one');
    expect(keys).toContain('capture-two');
  });

  it('refuses a referral for an action a tablet is never allowed to hold', async () => {
    await takeTheJobAway();
    const forbidden = await refer(sipho, 'capture-signature', { action: 'capture_signature' });

    // Not an endpoint for getting an arbitrary command in front of an
    // "apply" button: the action must be one the offline contract allows.
    expect(forbidden.status).toBe(400);
  });

  it('refuses a referral against a job that is none of this technician’s business', async () => {
    const other = (
      await master.post<JobBody>('/api/jobs', {
        ...NEW_JOB,
        orderNumber: 'PO-99003',
        primaryTechnicianId: riaanId,
      })
    ).data;

    const sneaked = await sipho.post('/api/captures/referrals', {
      jobId: other.id,
      action: 'add_labour',
      payload: LABOUR,
      summary: 'Hours on somebody else’s job',
      capturedAt: '2026-10-17T09:14:00.000Z',
      idempotencyKey: 'capture-on-another-job',
      refusalCode: 'not_on_job',
      refusalMessage: 'Refused.',
    });

    expect(sneaked.status).toBe(404);
  });

  /* -- who may see it ------------------------------------------------------ */

  it('shows a technician their OWN referrals and nobody else’s', async () => {
    await takeTheJobAway();
    const mine = await refer(sipho, 'capture-mine');

    const own = await sipho.get<ReferralRows>('/api/captures/referrals?mine=1');
    expect(own.data.rows.map((row) => row.referral.id)).toContain(mine.data.referral.id);

    const stranger = await riaan.get<ReferralRows>('/api/captures/referrals?mine=1');
    expect(stranger.data.rows.map((row) => row.referral.id)).not.toContain(mine.data.referral.id);
  });

  it('refuses a technician the office’s list of everybody’s referrals', async () => {
    await takeTheJobAway();
    await refer(sipho, 'capture-office-list');

    const peek = await sipho.get<ReferralRows>('/api/captures/referrals');
    expect(peek.status).toBe(403);
  });

  it('lets a Coordinator see them, because that is the office', async () => {
    await takeTheJobAway();
    const referral = await refer(sipho, 'capture-for-coordinator');

    const list = await coordinator.get<ReferralRows>('/api/captures/referrals');
    expect(list.status).toBe(200);
    const row = list.data.rows.find((entry) => entry.referral.id === referral.data.referral.id);
    expect(row?.jobNumber).toBe(job.jobNumber);
    // Named, so the office knows whose hours they are deciding about.
    expect(row?.technicianName.length).toBeGreaterThan(0);
  });

  /* -- applying it --------------------------------------------------------- */

  it('applies a referred capture to the job through the ordinary operation', async () => {
    await takeTheJobAway();
    const referral = await refer(sipho, 'capture-to-apply');

    const applied = await resolve(master, referral.data.referral.id, { resolution: 'applied' });

    expect(applied.status).toBe(200);
    expect(applied.data.referral.state).toBe('resolved');
    expect(applied.data.referral.resolution).toBe('applied');
    // The hours are on the job, and there is exactly one line of them.
    const view = await master.get<{ view: { job: JobBody } }>(`/api/jobs/${job.jobNumber}`);
    expect(view.data.view.job.labour).toHaveLength(1);
    expect(view.data.view.job.labour[0]?.hours).toBe(3);
  });

  it('records who decided, when, and what happened, against the job', async () => {
    await takeTheJobAway();
    const referral = await refer(sipho, 'capture-audited');
    await resolve(master, referral.data.referral.id, { resolution: 'applied' });

    const view = await master.get<{
      activity: readonly { type: string; summary: string; detail: string }[];
    }>(`/api/jobs/${job.jobNumber}`);
    const types = view.data.activity.map((entry) => entry.type);

    expect(types, JSON.stringify(types)).toContain('capture_referred');
    expect(types, JSON.stringify(types)).toContain('capture_referral_resolved');
    const decided = view.data.activity.find((entry) => entry.type === 'capture_referral_resolved');
    expect(decided?.detail).toMatch(/Elmarie/iu);
  });

  it('leaves the referral OPEN when the job still refuses the work', async () => {
    /*
     * Property 2, and the one that would be easiest to get wrong. A signed job
     * card is final, so applying a referred capture to it must fail — and the
     * referral must still be open afterwards, because nothing happened.
     * Recording it as resolved would be a lie told to the technician whose
     * hours they are.
     */
    const referral = await refer(sipho, 'capture-onto-signed-job');
    expect(await signJob(sipho, job.id)).toBe(true);

    const applied = await resolve(master, referral.data.referral.id, { resolution: 'applied' });

    expect(applied.status).toBe(422);
    expect(JSON.stringify(applied.raw)).toMatch(/final|signed/iu);

    const still = await master.get<ReferralRows>('/api/captures/referrals?state=open');
    expect(still.data.rows.map((row) => row.referral.id)).toContain(referral.data.referral.id);
  });

  it('refuses to apply a capture whose details the job would not accept', async () => {
    await takeTheJobAway();
    const referral = await refer(sipho, 'capture-with-bad-hours', {
      payload: { ...LABOUR, hours: 99 },
    });

    const applied = await resolve(master, referral.data.referral.id, { resolution: 'applied' });

    expect(applied.status).toBe(400);
    expect(await labourOnJob()).toBe(0);
    // Still open, so the office can record no action with a reason instead.
    const open = await master.get<ReferralRows>('/api/captures/referrals?state=open');
    expect(open.data.rows.map((row) => row.referral.id)).toContain(referral.data.referral.id);
  });

  /* -- closing it with no action ------------------------------------------- */

  it('refuses “no action” without a reason, and accepts it with one', async () => {
    await takeTheJobAway();
    const referral = await refer(sipho, 'capture-no-action');

    const bare = await resolve(master, referral.data.referral.id, { resolution: 'no_action' });
    expect(bare.status).toBe(422);
    expect(JSON.stringify(bare.raw)).toMatch(/note_required/u);

    const reasoned = await resolve(master, referral.data.referral.id, {
      resolution: 'no_action',
      note: 'Already captured on JC-2026-0007 by Riaan.',
    });
    expect(reasoned.status).toBe(200);
    expect(reasoned.data.referral.resolution).toBe('no_action');
    expect(reasoned.data.referral.resolutionNote).toMatch(/JC-2026-0007/u);
    // No action means exactly that: nothing reached the job.
    expect(await labourOnJob()).toBe(0);
  });

  it('refuses a SECOND decision on the same referral rather than overwriting the first', async () => {
    await takeTheJobAway();
    const referral = await refer(sipho, 'capture-decided-twice');
    expect(
      (
        await resolve(master, referral.data.referral.id, {
          resolution: 'no_action',
          note: 'Captured on the other job.',
        })
      ).status,
    ).toBe(200);

    const second = await resolve(coordinator, referral.data.referral.id, { resolution: 'applied' });

    expect(second.status).toBe(422);
    expect(JSON.stringify(second.raw)).toMatch(/referral_resolved/u);
    // And the losing decision did not apply the hours on its way out.
    expect(await labourOnJob()).toBe(0);
  });

  it('refuses a technician resolving their own referral', async () => {
    await takeTheJobAway();
    const referral = await refer(sipho, 'capture-self-resolved');

    const self = await resolve(sipho, referral.data.referral.id, { resolution: 'applied' });

    expect(self.status).toBe(403);
    expect(await labourOnJob()).toBe(0);
  });

  it('refuses another technician resolving somebody else’s referral', async () => {
    await takeTheJobAway();
    const referral = await refer(sipho, 'capture-resolved-by-stranger');

    // Not even visible to them, so the answer is the one a missing record gives.
    const theirs = await resolve(riaan, referral.data.referral.id, { resolution: 'applied' });
    expect(theirs.status).toBe(404);
  });

  it('answers 404 for a referral that does not exist', async () => {
    const nothing = await resolve(master, 'ref-does-not-exist', { resolution: 'applied' });
    expect(nothing.status).toBe(404);
  });

  it('refuses a referral sent with no session at all', async () => {
    const stranger = await new ApiTestClient().post('/api/captures/referrals', {
      jobId: job.id,
      action: 'add_labour',
      payload: LABOUR,
      summary: 'Hours from nowhere',
      capturedAt: '2026-10-17T09:14:00.000Z',
      idempotencyKey: 'capture-with-no-session',
      refusalCode: 'unauthenticated',
      refusalMessage: 'Sign in again.',
    });
    expect(stranger.status).toBe(401);
  });
});

/**
 * Drives the job all the way to a customer signature, through the real routes.
 *
 * A helper rather than a fixture because the point of the test it serves is
 * that the REAL workflow refuses a referred capture once the card is final —
 * so the job has to get signed the way a job gets signed.
 */
const signJob = async (tech: ApiTestClient, jobId: string): Promise<boolean> => {
  await tech.post(`/api/jobs/${jobId}/add_labour`, {
    date: '2026-10-17',
    rateType: 'normal',
    hours: 1,
    description: 'Fault found',
  });
  await tech.post(`/api/jobs/${jobId}/save_report`, {
    faultFindings: 'Drive fan seized.',
    diagnosis: 'Overload trip from a high cabinet temperature.',
    workPerformed: 'Replaced the drive cooling fan and cleaned the filters.',
    recommendations: '',
    generalNotes: '',
  });
  await tech.post(`/api/jobs/${jobId}/start_completion`);
  await tech.post(`/api/jobs/${jobId}/start_signature`);
  const signed = await tech.post(`/api/jobs/${jobId}/capture_signature`, {
    customerName: 'Thandi',
    customerSurname: 'Nkosi',
    strokeData: 'M0,0 L10,10',
  });
  return signed.status === 200;
};
