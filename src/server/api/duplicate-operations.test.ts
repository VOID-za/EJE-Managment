import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEMO_USERS,
  signedInAs,
  startTestServer,
  type ApiResponse,
  type ApiTestClient,
} from '@/test/api-harness';

/**
 * ACCEPTANCE AND SUBMISSION HAPPEN ONCE. MASTER SCOPE IDEM-2, QA-2.
 *
 * The scope recorded IDEM-2 as "PARTIAL — mechanism present, untested", and the
 * CR-10 amendment narrowed that: replay under one idempotency key was tested,
 * and a duplicate SUBMISSION was not — "`performIssue`'s status guard refuses
 * it, and nothing asserts that". QA-2 asks for the duplicate submission to be
 * "tested, not merely refused by a status guard".
 *
 * That wording turned out to be exactly right, and not for the reason it looks
 * like. The status guard DOES refuse a duplicate — but it was reading the job
 * OBJECT its caller passed in, and two requests that arrive together each read
 * the job before either writes it. Both were told the job was at `review`. Both
 * issued it. Both emailed the customer. Measured before the fix, through these
 * very routes:
 *
 *     concurrent POST /accept  → 200, 200   (one job, accepted twice)
 *     concurrent POST /issue   → 200, 200   (TWO signed job cards emailed)
 *
 * An idempotency key would not have saved it: `command()` in
 * `src/api/endpoints.ts` mints a FRESH key per call, so two taps are two keys
 * and the replay table never sees them. Nor would disabling the button — these
 * requests need no button at all.
 *
 * WHAT MAKES IT ONCE, and where each part lives:
 *
 *   - the STALE caller is refused by the operation, which re-reads the job and
 *     holds itself to the stored status (`asStored` in `job-operations.ts`);
 *   - the CONCURRENT caller is refused by the write boundary — one writer at a
 *     time in the demonstration runtime, the row version on PostgreSQL;
 *   - the RETRY of one request is replayed by the idempotency key, unchanged.
 *
 * These drive the real routes, so every assertion below is one a `curl` could
 * make. The PostgreSQL half of the same ground is in
 * `duplicate-operations.db.test.ts`.
 */
interface JobBody {
  readonly id: string;
  readonly jobNumber: string;
  readonly status: string;
  readonly acceptedAt: string | null;
}

interface OutboxBody {
  readonly entries: readonly { readonly subject: string; readonly attachments: readonly string[] }[];
}

const VALID = {
  customerId: 'cust-abc',
  siteId: 'site-abc-jhb',
  contactId: 'contact-abc-jhb',
  machineId: 'machine-abc-lv40',
  jobType: 'breakdown',
  priority: 'urgent',
  scheduledDate: null,
  scheduledEndDate: null,
  orderNumber: 'PO-99500',
  referenceNumber: '',
  faultDescription: 'Coolant pump alarming on low flow.',
  primaryTechnicianId: null,
  courierCollection: false,
  deliveryNote: '',
} as const;

/** Every refusal below is one of these two, and never a 500. */
const refused = (response: ApiResponse<unknown>): string =>
  `${response.status} ${response.error?.violations?.[0]?.code ?? response.error?.code ?? ''}`.trim();

describe('acceptance and submission cannot happen twice', () => {
  let master: ApiTestClient;
  let siphoId: string;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
    const admin = await master.get<{ users: readonly { id: string; email: string }[] }>('/api/admin');
    siphoId = admin.data.users.find((user) => user.email === DEMO_USERS.technician)?.id ?? '';
    expect(siphoId).not.toBe('');
  });

  /** A job assigned to Sipho, and Sipho signed in. */
  const openJob = async (): Promise<{ tech: ApiTestClient; id: string; jobNumber: string }> => {
    const created = await master.post<JobBody>('/api/jobs', {
      ...VALID,
      primaryTechnicianId: siphoId,
    });
    expect(created.status).toBe(200);
    return {
      tech: await signedInAs(DEMO_USERS.technician),
      id: created.data.id,
      jobNumber: created.data.jobNumber,
    };
  };

  /**
   * A job carried to `review`, signed by the customer, ready to issue.
   *
   * The whole journey, through the routes, because the duplicate that matters
   * is a duplicate of the LAST step and nothing else reaches it.
   */
  const signedJob = async (): Promise<{ tech: ApiTestClient; id: string; jobNumber: string }> => {
    const { tech, id } = await openJob();
    expect((await tech.post(`/api/jobs/${id}/accept`)).status).toBe(200);
    await tech.post(`/api/jobs/${id}/add_labour`, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 3,
      description: 'Replaced the coolant pump.',
    });
    await tech.post(`/api/jobs/${id}/save_report`, {
      faultFindings: '',
      diagnosis: '',
      workPerformed: 'Replaced the coolant pump and cleared the alarm.',
      recommendations: '',
      generalNotes: '',
    });
    await tech.post(`/api/jobs/${id}/start_completion`);
    await tech.post(`/api/jobs/${id}/start_signature`);
    const signed = await tech.post<JobBody>(`/api/jobs/${id}/capture_signature`, {
      customerName: 'Pieter',
      customerSurname: 'Nel',
      strokeData: 'M0,0 L1,1',
    });
    expect(signed.status).toBe(200);
    expect(signed.data.status).toBe('review');
    return { tech, id, jobNumber: signed.data.jobNumber };
  };

  /** How many signed job cards the customer has actually been sent. */
  const customerCopies = async (jobNumber: string): Promise<number> => {
    const outbox = await master.get<OutboxBody>('/api/outbox');
    expect(outbox.status).toBe(200);
    return outbox.data.entries.filter((entry) => entry.subject.startsWith(jobNumber)).length;
  };

  /* -- acceptance ---------------------------------------------------------- */

  describe('acceptance', () => {
    it('two identical requests accept the job once', async () => {
      const { tech, id } = await openJob();

      const first = await tech.post<JobBody>(`/api/jobs/${id}/accept`);
      const second = await tech.post<JobBody>(`/api/jobs/${id}/accept`);

      expect(first.status).toBe(200);
      // `in_progress` has no edge back to itself. Not a 500, not a silent 200.
      expect(refused(second)).toBe('422 illegal_transition');
    });

    it('a burst of rapid repeats accepts the job once', async () => {
      const { tech, id } = await openJob();

      /*
       * SIX AT ONCE, which is what a tap-happy glove on a frozen screen looks
       * like. Before the write boundary was serialised every one of these
       * answered 200.
       */
      const responses = await Promise.all(
        Array.from({ length: 6 }, () => tech.post<JobBody>(`/api/jobs/${id}/accept`)),
      );

      expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
      for (const response of responses.filter((response) => response.status !== 200)) {
        expect(refused(response)).toBe('422 illegal_transition');
      }
    });

    it('two concurrent requests accept the job once', async () => {
      const { tech, id, jobNumber } = await openJob();

      const [a, b] = await Promise.all([
        tech.post<JobBody>(`/api/jobs/${id}/accept`),
        tech.post<JobBody>(`/api/jobs/${id}/accept`),
      ]);

      const ok = [a, b].filter((response) => response.status === 200);
      expect(ok).toHaveLength(1);
      expect(refused([a, b].find((response) => response.status !== 200)!)).toBe(
        '422 illegal_transition',
      );
      // And the job was accepted at one moment, not two.
      const after = await tech.get<{ view: { job: JobBody } }>(`/api/jobs/${jobNumber}`);
      expect(after.data.view.job.acceptedAt).toBe(ok[0]?.data.acceptedAt);
    });

    it('a retry of a request that appeared to time out is replayed, not repeated', async () => {
      const { tech, id } = await openJob();
      const key = 'accept-retry-after-timeout';

      /*
       * THE TABLET NEVER SAW THE ANSWER.
       *
       * The request reached the server and the reply did not come back, so the
       * client sends THE SAME request again — same key, same body. That is the
       * one case an idempotency key exists for, and the answer must be the
       * first answer rather than a refusal: the caller is entitled to learn
       * what happened.
       */
      const first = await tech.post<JobBody>(`/api/jobs/${id}/accept`, undefined, {
        idempotencyKey: key,
      });
      const retry = await tech.post<JobBody>(`/api/jobs/${id}/accept`, undefined, {
        idempotencyKey: key,
      });

      expect(first.status).toBe(200);
      expect(retry.status).toBe(200);
      expect(retry.headers.get('Idempotent-Replay')).toBe('true');
      expect(retry.data.acceptedAt).toBe(first.data.acceptedAt);
    });

    it('a stale screen that accepts an already-accepted job is refused', async () => {
      const { tech, id } = await openJob();
      await tech.post(`/api/jobs/${id}/accept`);

      /*
       * A SECOND TECHNICIAN'S TABLET, still showing the job in the open pool.
       * It is not a retry — a different person, a different key, the same
       * request — so nothing about idempotency applies and the workflow has to
       * refuse it on its own.
       */
      const riaan = await signedInAs(DEMO_USERS.otherTechnician);
      const stale = await riaan.post<JobBody>(`/api/jobs/${id}/accept`, undefined, {
        idempotencyKey: 'a-different-key-entirely',
      });

      expect(stale.status).not.toBe(200);
      expect(stale.status).toBeLessThan(500);
    });
  });

  /* -- submission ---------------------------------------------------------- */

  describe('submission', () => {
    it('two identical requests issue one job card and send one email', async () => {
      const { tech, id, jobNumber } = await signedJob();

      const first = await tech.post<JobBody>(`/api/jobs/${id}/issue`, {});
      const second = await tech.post<JobBody>(`/api/jobs/${id}/issue`, {});

      expect(first.status).toBe(200);
      expect(refused(second)).toBe('422 not_ready_to_issue');
      expect(await customerCopies(jobNumber)).toBe(1);
    });

    it('two concurrent requests issue one job card and send one email', async () => {
      const { tech, id, jobNumber } = await signedJob();

      /*
       * THE ONE THAT WAS BROKEN. Both of these answered 200 before IDEM-2, and
       * the customer received their signed job card twice.
       */
      const [a, b] = await Promise.all([
        tech.post<JobBody>(`/api/jobs/${id}/issue`, {}),
        tech.post<JobBody>(`/api/jobs/${id}/issue`, {}),
      ]);

      expect([a, b].filter((response) => response.status === 200)).toHaveLength(1);
      expect(refused([a, b].find((response) => response.status !== 200)!)).toBe(
        '422 not_ready_to_issue',
      );
      expect(await customerCopies(jobNumber)).toBe(1);
    });

    it('a burst of rapid repeats issues one job card and sends one email', async () => {
      const { tech, id, jobNumber } = await signedJob();

      const responses = await Promise.all(
        Array.from({ length: 5 }, () => tech.post<JobBody>(`/api/jobs/${id}/issue`, {})),
      );

      expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
      for (const response of responses.filter((response) => response.status !== 200)) {
        expect(refused(response)).toBe('422 not_ready_to_issue');
      }
      expect(await customerCopies(jobNumber)).toBe(1);
    });

    it('a retry of a submission that appeared to time out is replayed, not repeated', async () => {
      const { tech, id, jobNumber } = await signedJob();
      const key = 'issue-retry-after-timeout';

      const first = await tech.post<JobBody>(`/api/jobs/${id}/issue`, {}, { idempotencyKey: key });
      const retry = await tech.post<JobBody>(`/api/jobs/${id}/issue`, {}, { idempotencyKey: key });

      expect(first.status).toBe(200);
      expect(retry.status).toBe(200);
      expect(retry.headers.get('Idempotent-Replay')).toBe('true');
      // THE POINT OF THE WHOLE REQUIREMENT: one email, not two.
      expect(await customerCopies(jobNumber)).toBe(1);
    });

    it('a stale screen that submits an already-submitted job is refused, and sends nothing', async () => {
      const { tech, id, jobNumber } = await signedJob();
      expect((await tech.post(`/api/jobs/${id}/issue`, {})).status).toBe(200);

      /*
       * The tablet has been in a pocket since the submission. It still shows
       * the Signed step with its Submit button, and it has never heard that the
       * job card went out.
       */
      const stale = await tech.post<JobBody>(`/api/jobs/${id}/issue`, {}, {
        idempotencyKey: 'a-key-from-this-morning',
      });

      expect(refused(stale)).toBe('422 not_ready_to_issue');
      expect(await customerCopies(jobNumber)).toBe(1);
    });

    it('the second submission changes nothing about the job that was issued', async () => {
      const { tech, id, jobNumber } = await signedJob();
      const issued = await tech.post<JobBody>(`/api/jobs/${id}/issue`, {});
      const before = await tech.get<{ view: { job: Record<string, unknown> } }>(
        `/api/jobs/${jobNumber}`,
      );

      await tech.post(`/api/jobs/${id}/issue`, {});
      const after = await tech.get<{ view: { job: Record<string, unknown> } }>(
        `/api/jobs/${jobNumber}`,
      );

      expect(issued.status).toBe(200);
      /*
       * BYTE FOR BYTE. A refused duplicate that nudged the delivery record,
       * bumped the attempt count or re-stamped the document would be a second
       * submission wearing a refusal's clothes.
       */
      expect(after.data.view.job).toEqual(before.data.view.job);
      expect(await customerCopies(jobNumber)).toBe(1);
    });
  });
});
