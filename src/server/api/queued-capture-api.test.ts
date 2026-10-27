import { beforeEach, describe, expect, it } from 'vitest';
import { ApiTestClient, DEMO_USERS, signedInAs, startTestServer } from '@/test/api-harness';

/**
 * WHAT THE SERVER DOES WITH WORK A TABLET HELD. OFF-6, OFF-7, OFF-9.
 * CR-09 Phase 4, step one.
 *
 * The offline queue is deliberately thin: it stores a request and sends it
 * later, with the key it was captured under. Everything that keeps that safe
 * is on the SERVER, and this file is where those properties are proved —
 * because the queue is only as honest as the refusals it gets back.
 *
 * Each test is one thing that can change while a tablet is out of signal:
 * nothing (the happy path), the answer getting lost, the customer signing, the
 * office closing or cancelling the job, the job being reassigned, the session
 * being revoked, and the details being wrong. The queue's job is to ask; the
 * server's job is to be the authority; neither may guess.
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
  orderNumber: 'PO-99001',
  referenceNumber: '',
  faultDescription: 'Spindle drive tripping on overload.',
  primaryTechnicianId: null,
  courierCollection: false,
  deliveryNote: '',
} as const;

const LABOUR = { date: '2026-10-17', rateType: 'normal', hours: 2.5, description: 'Replaced the drive fan' } as const;

interface JobBody {
  readonly id: string;
  readonly jobNumber: string;
  readonly status: string;
  readonly labour: readonly { readonly id: string; readonly hours: number }[];
  readonly notes: readonly { readonly body: string }[];
}

const userId = async (client: ApiTestClient, email: string): Promise<string> =>
  (
    await client.get<{ users: readonly { id: string; email: string }[] }>('/api/admin')
  ).data.users.find((user) => user.email === email)?.id ?? '';

describe('sending work a tablet captured while it was offline', () => {
  let master: ApiTestClient;
  let sipho: ApiTestClient;
  let job: JobBody;
  let siphoId: string;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
    siphoId = await userId(master, DEMO_USERS.technician);
    job = (
      await master.post<JobBody>('/api/jobs', { ...NEW_JOB, primaryTechnicianId: siphoId })
    ).data;
    sipho = await signedInAs(DEMO_USERS.technician);
    expect((await sipho.post(`/api/jobs/${job.id}/accept`)).status).toBe(200);
  });

  const send = (client: ApiTestClient, body: unknown, key: string, action = 'add_labour') =>
    client.post<JobBody>(`/api/jobs/${job.id}/${action}`, body, { idempotencyKey: key });

  it('applies a capture that arrives late, exactly as if it had been online', async () => {
    const sent = await send(sipho, LABOUR, 'capture-1');

    expect(sent.status).toBe(200);
    expect(sent.data.labour).toHaveLength(1);
    expect(sent.data.labour[0]?.hours).toBe(2.5);
  });

  it('applies a capture held from the offline page, which names the job by its NUMBER (OFF-2)', async () => {
    // The tablet's copy keeps no internal id; the job number is the target.
    const sent = await sipho.post<JobBody>(`/api/jobs/${job.jobNumber}/add_labour`, LABOUR, {
      idempotencyKey: 'offline-page-capture-1',
    });
    expect(sent.status).toBe(200);
    expect(sent.data.id).toBe(job.id);
    expect(sent.data.labour).toHaveLength(1);

    const replay = await sipho.post<JobBody>(`/api/jobs/${job.jobNumber}/add_labour`, LABOUR, {
      idempotencyKey: 'offline-page-capture-1',
    });
    expect(replay.headers.get('Idempotent-Replay')).toBe('true');
    expect(replay.data.labour).toHaveLength(1);
  });

  /* -- the answer that never came back ------------------------------------- */

  it('does NOT double the hours when the same capture is sent twice', async () => {
    /*
     * THE CASE THE QUEUE EXISTS TO SURVIVE. The bytes reached the server, it
     * committed, and the reply was lost on the way back to a tablet at the
     * edge of coverage. The queue still holds the row, so the flush sends it
     * again — under the SAME key, because the key belongs to the capture and
     * not to the attempt.
     */
    const first = await send(sipho, LABOUR, 'capture-held-on-tablet');
    const replay = await send(sipho, LABOUR, 'capture-held-on-tablet');

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.headers.get('Idempotent-Replay')).toBe('true');
    // One line, and the SAME line — not two lines of 2.5 hours each.
    expect(replay.data.labour).toHaveLength(1);
    expect(replay.data.labour[0]?.id).toBe(first.data.labour[0]?.id);

    const view = await sipho.get<{ view: { job: JobBody } }>(`/api/jobs/${job.jobNumber}`);
    expect(view.data.view.job.labour).toHaveLength(1);
  });

  it('refuses a key reused for DIFFERENT details rather than answering about the wrong one', async () => {
    await send(sipho, LABOUR, 'one-key-one-capture');
    const other = await send(sipho, { ...LABOUR, hours: 7 }, 'one-key-one-capture');

    expect(other.status).toBe(409);
    expect(other.error?.violations?.map((violation) => violation.code)).toContain(
      'idempotency_key_reused',
    );
  });

  it('keeps two separate captures separate, because each has its own key', async () => {
    await send(sipho, LABOUR, 'capture-a');
    const second = await send(sipho, { ...LABOUR, hours: 1, description: 'Refitted the guard' }, 'capture-b');

    expect(second.data.labour).toHaveLength(2);
  });

  /* -- what changed while the tablet was away ------------------------------ */

  it('refuses a capture against a job the customer has SIGNED, and says so', async () => {
    /*
     * The one refusal that can never be resolved by retrying: a signed job
     * card is final (CR-01, IMMUT-1…7). The queue classifies this as a
     * conflict and keeps the capture for a person to deal with.
     */
    const signed = await signJob(sipho, master, job);
    expect(signed).toBe(true);

    const late = await send(sipho, LABOUR, 'capture-after-signature');
    expect(late.status).toBe(422);
    expect(JSON.stringify(late.raw)).toMatch(/final|signed/iu);
  });

  it('refuses a capture against a job TRANSFERRED to somebody else', async () => {
    /*
     * The realistic version of "the job was taken away". Cancellation is NOT
     * among these cases on purpose: the domain only allows a job that is still
     * Open AND unassigned to be cancelled, so an in-progress job a technician
     * is holding work for cannot be cancelled underneath them at all
     * (`isEndableJob`). A transfer can, and this is it.
     */
    const riaanId = await userId(master, DEMO_USERS.otherTechnician);
    const moved = await master.post(`/api/jobs/${job.id}/transfer_to_technician`, {
      technicianId: riaanId,
      reason: 'requires_another_technician',
      description: 'Needs the drive specialist.',
    });
    expect(moved.status).toBe(200);

    const late = await send(sipho, LABOUR, 'capture-after-transfer');
    expect(late.status).not.toBe(200);
    expect(late.status).toBeLessThan(500);

    // The hours are not on the job, and the refusal is the server's.
    const view = await master.get<{ view: { job: JobBody } }>(`/api/jobs/${job.jobNumber}`);
    expect(view.data.view.job.labour).toHaveLength(0);
  });

  it('refuses a capture from a technician the job was taken OFF', async () => {
    // Reassignment while the tablet was out of signal. `assertCanCapture` is
    // what refuses it — the queue never has to know the rule.
    const riaanId = await userId(master, DEMO_USERS.otherTechnician);
    expect(
      (await master.post(`/api/jobs/${job.id}/assign_primary`, { technicianId: riaanId })).status,
    ).toBe(200);

    const late = await send(sipho, LABOUR, 'capture-after-reassignment');
    expect(late.status).not.toBe(200);
    expect(late.status).toBeLessThan(500);
    // And the work is NOT on the job.
    const view = await master.get<{ view: { job: JobBody } }>(`/api/jobs/${job.jobNumber}`);
    expect(view.data.view.job.labour).toHaveLength(0);
  });

  it('refuses a capture sent with no session at all', async () => {
    const stranger = await new ApiTestClient().post(`/api/jobs/${job.id}/add_labour`, LABOUR, {
      idempotencyKey: 'capture-with-no-session',
    });
    expect(stranger.status).toBe(401);
  });

  it('refuses a capture whose details are not valid, without a partial write', async () => {
    const bad = await send(sipho, { ...LABOUR, hours: 99 }, 'capture-with-bad-hours');
    expect(bad.status).toBe(400);

    const view = await sipho.get<{ view: { job: JobBody } }>(`/api/jobs/${job.jobNumber}`);
    expect(view.data.view.job.labour).toHaveLength(0);
  });

  /* -- the other three offline captures ------------------------------------ */

  it('applies a held note, a held travel line and a held part the same way', async () => {
    expect((await send(sipho, { kilometres: 48, date: '2026-10-17', description: 'Site visit' }, 'travel-1', 'add_travel')).status).toBe(200);
    expect(
      (await send(sipho, { partNumber: 'FAN-220', description: 'Drive fan', quantity: 1, unitPrice: 48_500 }, 'part-1', 'add_part')).status,
    ).toBe(200);
    const withNote = await send(sipho, { body: 'Customer asked for the old fan back.', internal: false }, 'note-1', 'add_note');

    expect(withNote.status).toBe(200);
    expect(withNote.data.notes.map((note) => note.body)).toContain(
      'Customer asked for the old fan back.',
    );
  });

  it('replays each of them idempotently, not just labour', async () => {
    const key = 'note-held-on-tablet';
    const body = { body: 'Access was locked out until 10am.', internal: true };
    const first = await send(sipho, body, key, 'add_note');
    const replay = await send(sipho, body, key, 'add_note');

    expect(replay.headers.get('Idempotent-Replay')).toBe('true');
    expect(replay.data.notes).toHaveLength(first.data.notes.length);
  });
});

/**
 * Drives a job all the way to a customer signature, through the real routes.
 *
 * Written as a helper rather than a fixture because the point of the test it
 * serves is that the REAL workflow refuses a late capture — so the job has to
 * get signed the way a job gets signed.
 */
const signJob = async (
  tech: ApiTestClient,
  _master: ApiTestClient,
  job: JobBody,
): Promise<boolean> => {
  await tech.post(`/api/jobs/${job.id}/add_labour`, {
    date: '2026-10-17',
    rateType: 'normal',
    hours: 1,
    description: 'Fault found',
  });
  await tech.post(`/api/jobs/${job.id}/save_report`, {
    faultFindings: 'Drive fan seized.',
    diagnosis: 'Overload trip from high cabinet temperature.',
    workPerformed: 'Replaced the drive cooling fan and cleaned the filters.',
    recommendations: '',
    generalNotes: '',
  });
  await tech.post(`/api/jobs/${job.id}/start_completion`);
  await tech.post(`/api/jobs/${job.id}/start_signature`);
  const signed = await tech.post(`/api/jobs/${job.id}/capture_signature`, {
    customerName: 'Thandi',
    customerSurname: 'Nkosi',
    strokeData: 'M0,0 L10,10',
  });
  return signed.status === 200;
};
