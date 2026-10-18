import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_USERS, signedInAs, startTestServer, type ApiTestClient } from '@/test/api-harness';

/**
 * A CHECKLIST ANSWER HELD WITH NO SIGNAL. OFF-CHK-1, OFF-9, BD-15.
 *
 * THE RULE THAT MADE IT POSSIBLE TO ALLOW THIS AT ALL. A checklist answer is
 * the one offline capture that is not a new row: it REPLACES the previous
 * answer. Labour captured in a basement can only ever add a line, so there is
 * nothing to get wrong; an answer sent four hours late could erase what
 * somebody else answered in the meantime, and CR-02 forbids exactly that.
 *
 * So a held answer says what it was answering:
 *
 *   - the checklist INSTANCE — `templateId` and `templateVersion`. An answer is
 *     never moved onto a different version of the document (CHK-VER-1),
 *     because the wording the technician answered is the wording the customer's
 *     job card reports.
 *   - the answer it replaces — `expectedAnsweredAt`, the stamp the tablet last
 *     saw, or null for an item nobody had answered.
 *
 * Both are optional, because an ONLINE screen has nothing to expect: it writes
 * one field at a time as the technician taps, with no interval for anybody to
 * write in. Every test below is one of those two guards, the online path that
 * must keep working without them, or what the office can do about a capture
 * they refused.
 */
const NEW_JOB = {
  customerId: 'cust-abc',
  siteId: 'site-abc-jhb',
  contactId: 'contact-abc-jhb',
  machineId: 'machine-abc-lv40',
  jobType: 'installation',
  priority: 'normal',
  scheduledDate: null,
  scheduledEndDate: null,
  orderNumber: 'PO-77601',
  referenceNumber: '',
  faultDescription: 'New machine installation and commissioning.',
  primaryTechnicianId: null,
  courierCollection: false,
  deliveryNote: '',
} as const;

/** Two items from the seeded installation template. */
const ITEM = 'inst-1';
const OTHER_ITEM = 'inst-3';

interface Response {
  readonly itemId: string;
  readonly choice: string | null;
  readonly notes: string;
  readonly answeredAt: string | null;
  readonly answeredBy: string | null;
}

interface JobBody {
  readonly id: string;
  readonly jobNumber: string;
  readonly checklist: {
    readonly templateId: string;
    readonly templateVersion: string;
    readonly completedAt: string | null;
    readonly responses: readonly Response[];
  } | null;
}

interface Referral {
  readonly id: string;
  readonly state: string;
  readonly action: string;
}

const userId = async (client: ApiTestClient, email: string): Promise<string> =>
  (
    await client.get<{ users: readonly { id: string; email: string }[] }>('/api/admin')
  ).data.users.find((user) => user.email === email)?.id ?? '';

describe('a checklist answer a tablet held offline', () => {
  let master: ApiTestClient;
  let sipho: ApiTestClient;
  let job: JobBody;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
    const siphoId = await userId(master, DEMO_USERS.technician);
    job = (await master.post<JobBody>('/api/jobs', { ...NEW_JOB, primaryTechnicianId: siphoId }))
      .data;
    sipho = await signedInAs(DEMO_USERS.technician);
    expect((await sipho.post(`/api/jobs/${job.id}/accept`)).status).toBe(200);
    job = (await sipho.post<JobBody>(`/api/jobs/${job.id}/start_checklist`)).data;
    expect(job.checklist).not.toBeNull();
  });

  const instance = () => ({
    templateId: job.checklist?.templateId ?? '',
    templateVersion: job.checklist?.templateVersion ?? '1.0-DEMO',
  });

  const answer = (
    client: ApiTestClient,
    body: Readonly<Record<string, unknown>>,
    key?: string,
  ) =>
    client.post<JobBody>(
      `/api/jobs/${job.id}/answer_checklist`,
      body,
      key === undefined ? undefined : { idempotencyKey: key },
    );

  /**
   * A write through the CAPTURE transport, as the queue sends it.
   *
   * `X-EJE-Capture` is what `sendCaptured` adds and nothing else does. It is
   * what tells the server this answer may have been written hours ago — the
   * idempotency key cannot, because every command in this application mints
   * one of those.
   */
  const captured = (
    client: ApiTestClient,
    body: Readonly<Record<string, unknown>>,
    key: string,
  ) =>
    client.post<JobBody>(`/api/jobs/${job.id}/answer_checklist`, body, {
      idempotencyKey: key,
      headers: { 'x-eje-capture': 'held' },
    });

  const responseFor = async (itemId: string): Promise<Response | undefined> =>
    (
      await master.get<{ view: { job: JobBody } }>(`/api/jobs/${job.jobNumber}`)
    ).data.view.job.checklist?.responses.find((entry) => entry.itemId === itemId);

  /**
   * That the item is still UNANSWERED.
   *
   * Not "has no response row": starting a checklist writes an empty response
   * for every question in the template, so the row exists from the start and
   * `answeredAt` is what says whether anybody has answered it.
   */
  const expectUnanswered = async (itemId: string): Promise<void> => {
    const stored = await responseFor(itemId);
    expect(stored?.answeredAt ?? null).toBeNull();
    expect(stored?.choice ?? null).toBeNull();
    expect(stored?.notes ?? '').toBe('');
  };

  /* -- the held answer arriving late --------------------------------------- */

  it('applies a held answer that is still answering what it thought it was', async () => {
    const held = await answer(sipho, {
      itemId: ITEM,
      choice: 'pass',
      notes: '',
      ...instance(),
      // Nobody had answered it when the tablet went out of signal.
      expectedAnsweredAt: null,
    });

    expect(held.status).toBe(200);
    const stored = await responseFor(ITEM);
    expect(stored?.choice).toBe('pass');
    expect(stored?.answeredAt).not.toBeNull();
  });

  it('refuses a held answer that would overwrite one given since', async () => {
    /*
     * THE CASE THE EXPECTATION EXISTS FOR. The tablet captured `fail` at 10:40
     * believing the item unanswered. By the time it reconnects, the office has
     * answered it `pass`. Before this guard, the tablet's answer replaced
     * theirs and nobody was told.
     */
    expect((await answer(master, { itemId: ITEM, choice: 'pass' })).status).toBe(200);
    const theirs = await responseFor(ITEM);

    const late = await answer(sipho, {
      itemId: ITEM,
      choice: 'fail',
      notes: 'Levelling feet not grouted.',
      ...instance(),
      expectedAnsweredAt: null,
    });

    expect(late.status).toBe(422);
    expect(JSON.stringify(late.raw)).toMatch(/checklist_answer_changed/u);

    // Their answer stands, untouched, stamp and all.
    const after = await responseFor(ITEM);
    expect(after?.choice).toBe('pass');
    expect(after?.answeredAt).toBe(theirs?.answeredAt);
    expect(after?.notes).toBe('');
  });

  it('refuses a held answer whose expectation names an answer that is gone', async () => {
    // The mirror of the above: the tablet believed it was replacing an answer
    // from 10:40, and the item has never been answered on the server.
    const late = await answer(sipho, {
      itemId: OTHER_ITEM,
      choice: 'pass',
      ...instance(),
      expectedAnsweredAt: '2026-10-17T10:40:00.000Z',
    });

    expect(late.status).toBe(422);
    expect(JSON.stringify(late.raw)).toMatch(/checklist_answer_changed/u);
    await expectUnanswered(OTHER_ITEM);
  });

  it('refuses a held answer given against another version of the checklist', async () => {
    /*
     * CHK-VER-1. The wording the technician answered is the wording the
     * customer's document reports, so an answer cannot be carried across to a
     * different version of the document — not by a tablet, and not by the
     * office (see the resolve route).
     */
    const late = await answer(sipho, {
      itemId: ITEM,
      choice: 'pass',
      templateId: job.checklist?.templateId ?? '',
      templateVersion: '99.0-NOT-THIS-ONE',
      expectedAnsweredAt: null,
    });

    expect(late.status).toBe(422);
    expect(JSON.stringify(late.raw)).toMatch(/checklist_version_changed/u);
    await expectUnanswered(ITEM);
  });

  it('refuses a held answer against a template the job does not carry at all', async () => {
    const late = await answer(sipho, {
      itemId: ITEM,
      choice: 'pass',
      templateId: 'template-that-is-not-on-this-job',
      templateVersion: job.checklist?.templateVersion ?? '1.0-DEMO',
      expectedAnsweredAt: null,
    });

    expect(late.status).toBe(422);
    expect(JSON.stringify(late.raw)).toMatch(/checklist_version_changed/u);
  });

  /* -- the online path, which sends no expectation ------------------------- */

  it('still answers from the screen with no expectation at all', async () => {
    // Field by field, as the runner writes it: a tap, then the note on blur.
    expect((await answer(sipho, { itemId: ITEM, choice: 'fail' })).status).toBe(200);
    expect(
      (await answer(sipho, { itemId: ITEM, notes: 'Anchor bolts undersized.' })).status,
    ).toBe(200);

    const stored = await responseFor(ITEM);
    expect(stored?.choice).toBe('fail');
    expect(stored?.notes).toBe('Anchor bolts undersized.');
  });

  it('replays a held answer idempotently, under the capture’s own key', async () => {
    const body = {
      itemId: ITEM,
      choice: 'pass',
      ...instance(),
      expectedAnsweredAt: null,
    };
    const first = await answer(sipho, body, 'checklist-held-on-tablet');
    const replay = await answer(sipho, body, 'checklist-held-on-tablet');

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.headers.get('Idempotent-Replay')).toBe('true');
    // And NOT a second refusal: the replay is answered from the first request,
    // which is what makes a flush that lost its answer safe.
    const stored = await responseFor(ITEM);
    expect(stored?.choice).toBe('pass');
  });

  /* -- what the office can do about one that was refused ------------------- */

  /* -- the ways the conflict rule could be got round ---------------------- */

  /**
   * THE BYPASS BY OMISSION. OFF-CHK-1, CR-02.
   *
   * The expectation is optional because an online screen has nothing to
   * expect — and optional meant a replay could simply leave it out and be
   * applied as though it were a tap made this second, silently replacing
   * whatever the office answered while the tablet was away. Nobody has to
   * tamper with anything: an older build, a hand-made request or a queue row
   * written before the fields existed does it by accident.
   *
   * An `Idempotency-Key` is minted once per CAPTURE and sent only by the
   * queue, so a request carrying one is work that was HELD. Such a request now
   * has to say what it was answering.
   */
  it('REFUSES a capture that does not say what it was answering', async () => {
    expect((await answer(master, { itemId: ITEM, choice: 'pass' })).status).toBe(200);
    const theirs = await responseFor(ITEM);

    const bare = await captured(
      sipho,
      { itemId: ITEM, choice: 'fail', notes: 'Captured out of signal.' },
      'capture-with-no-expectation',
    );

    expect(bare.status).toBe(422);
    expect(bare.error?.violations?.[0]?.code).toBe('checklist_expectation_required');
    // And the office's answer stands, untouched.
    const after = await responseFor(ITEM);
    expect(after?.choice).toBe('pass');
    expect(after?.answeredAt).toBe(theirs?.answeredAt);
  });

  it('REFUSES half an expectation when it arrived as a capture', async () => {
    expect((await answer(master, { itemId: ITEM, choice: 'pass' })).status).toBe(200);

    const half = await captured(
      sipho,
      { itemId: ITEM, choice: 'fail', notes: 'x', ...instance() },
      'capture-missing-the-stamp',
    );
    expect(half.status).toBe(422);
    expect(half.error?.violations?.[0]?.code).toBe('checklist_expectation_required');
    expect((await responseFor(ITEM))?.choice).toBe('pass');
  });

  /**
   * AND A NEW KEY IS NOT A NEW CHANCE.
   *
   * A tablet (or anybody) re-sending the same stale capture under a freshly
   * minted key gets the same refusal — the conflict is decided by what the JOB
   * says, not by whether this particular request has been seen before.
   */
  it('REFUSES the same stale capture again under a different key', async () => {
    const held = { itemId: ITEM, choice: 'fail' as const, notes: 'Bolts loose.', ...instance(), expectedAnsweredAt: null };
    expect((await answer(master, { itemId: ITEM, choice: 'pass' })).status).toBe(200);
    const theirs = await responseFor(ITEM);

    const first = await answer(sipho, held, 'capture-key-one');
    const second = await answer(sipho, held, 'capture-key-two');
    const third = await answer(sipho, held, 'capture-key-three');

    for (const [label, response] of [
      ['first', first],
      ['under a new key', second],
      ['under another new key', third],
    ] as const) {
      expect(response.status, label).toBe(422);
      expect(response.error?.violations?.[0]?.code, label).toBe('checklist_answer_changed');
    }

    const after = await responseFor(ITEM);
    expect(after?.choice).toBe('pass');
    expect(after?.answeredAt).toBe(theirs?.answeredAt);
  });

  /**
   * An online tap is UNCHANGED, which is the other half of the rule: the
   * runner writes one field at a time as the technician taps, and there is no
   * interval in which anybody could be overwritten.
   */
  it('still lets a SCREEN answer field by field, which is how the runner writes', async () => {
    /*
     * The established rule for an online answer, and the reason the capture
     * marker exists rather than the idempotency key: every command in this
     * application mints a key, so keying the rule on one refused every
     * ordinary tap — which a browser test caught.
     */
    expect((await answer(sipho, { itemId: ITEM, choice: 'fail' })).status).toBe(200);
    expect((await answer(sipho, { itemId: ITEM, notes: 'Bearing noisy.' })).status).toBe(200);
    const stored = await responseFor(ITEM);
    expect(stored?.choice).toBe('fail');
    expect(stored?.notes).toBe('Bearing noisy.');
  });

  /*
   * AND HALF AN EXPECTATION FROM A SCREEN IS DELIBERATELY ALLOWED. The office's
   * resolution of a referred capture is exactly that shape: it keeps the
   * version check and replaces the answer on purpose (BD-15). Dropping the
   * stamp gains nobody anything, because a screen may answer with no
   * expectation at all — which is weaker still.
   */
  it('allows the version check WITHOUT the stamp from a screen, which is the office path', async () => {
    expect((await answer(master, { itemId: ITEM, choice: 'pass' })).status).toBe(200);
    const replaced = await answer(master, { itemId: ITEM, choice: 'fail', notes: 'x', ...instance() });
    expect(replaced.status).toBe(200);
    expect((await responseFor(ITEM))?.choice).toBe('fail');
  });

  it('lets the office apply a refused answer, replacing the one on the job', async () => {
    /*
     * BD-15 with OFF-CHK-1. The expectation exists to stop a DEVICE
     * overwriting silently. The office applying it is the opposite of silent:
     * they are looking at the technician's answer and at the server's own
     * refusal, and their decision is audited — so the apply drops that one
     * field and nothing else.
     */
    expect((await answer(master, { itemId: ITEM, choice: 'pass' })).status).toBe(200);

    const refused = await answer(sipho, {
      itemId: ITEM,
      choice: 'fail',
      notes: 'Levelling feet not grouted.',
      ...instance(),
      expectedAnsweredAt: null,
    });
    expect(refused.status).toBe(422);

    const referred = await sipho.post<{ referral: Referral }>('/api/captures/referrals', {
      jobId: job.id,
      action: 'answer_checklist',
      payload: {
        itemId: ITEM,
        choice: 'fail',
        notes: 'Levelling feet not grouted.',
        ...instance(),
        expectedAnsweredAt: null,
      },
      summary: 'Machine level within tolerance — FAIL',
      capturedAt: '2026-10-17T10:40:00.000Z',
      idempotencyKey: 'checklist-refused-capture',
      refusalCode: 'checklist_answer_changed',
      refusalMessage: 'Somebody answered this item while this tablet was away.',
    });
    expect(referred.status).toBe(200);
    expect(referred.data.referral.action).toBe('answer_checklist');

    const applied = await master.post(
      `/api/captures/referrals/${referred.data.referral.id}/resolve`,
      { resolution: 'applied', note: 'Spoke to Sipho — his reading is the right one.' },
    );
    expect(applied.status).toBe(200);

    const stored = await responseFor(ITEM);
    expect(stored?.choice).toBe('fail');
    expect(stored?.notes).toBe('Levelling feet not grouted.');
  });

  it('refuses even the office moving an answer onto another checklist version', async () => {
    // The version guard is NOT dropped by a resolution. Nothing makes moving an
    // answer onto a different document acceptable.
    const referred = await sipho.post<{ referral: Referral }>('/api/captures/referrals', {
      jobId: job.id,
      action: 'answer_checklist',
      payload: {
        itemId: ITEM,
        choice: 'pass',
        templateId: job.checklist?.templateId ?? '',
        templateVersion: '99.0-NOT-THIS-ONE',
        expectedAnsweredAt: null,
      },
      summary: 'An answer from another version of the checklist',
      capturedAt: '2026-10-17T10:40:00.000Z',
      idempotencyKey: 'checklist-from-another-version',
      refusalCode: 'checklist_version_changed',
      refusalMessage: 'The job now carries a different checklist.',
    });

    const applied = await master.post(
      `/api/captures/referrals/${referred.data.referral.id}/resolve`,
      { resolution: 'applied' },
    );

    expect(applied.status).toBe(422);
    expect(JSON.stringify(applied.raw)).toMatch(/checklist_version_changed/u);
    await expectUnanswered(ITEM);
  });

  /* -- what is still online-only ------------------------------------------ */

  it('still refuses to complete the checklist with items outstanding', async () => {
    // Completing is evaluated against the TEMPLATE, which is why it stays
    // online-only in the offline contract: there is nothing here to hold.
    const early = await sipho.post(`/api/jobs/${job.id}/complete_checklist`);
    expect(early.status).toBe(422);
  });

  it('refuses a held answer on a job the technician no longer has', async () => {
    const riaanId = await userId(master, DEMO_USERS.otherTechnician);
    expect(
      (await master.post(`/api/jobs/${job.id}/assign_primary`, { technicianId: riaanId })).status,
    ).toBe(200);

    const late = await answer(sipho, {
      itemId: ITEM,
      choice: 'pass',
      ...instance(),
      expectedAnsweredAt: null,
    });

    // `assertCanCapture`, exactly as it refuses late labour. The expectation
    // never gets a chance to matter, and must not be a way around it.
    expect(late.status).not.toBe(200);
    await expectUnanswered(ITEM);
  });
});
