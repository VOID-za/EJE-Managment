import { beforeEach, describe, expect, it } from 'vitest';
import { type ApiTestClient, DEMO_USERS, signedInAs, startTestServer } from '@/test/api-harness';
import type { JobView } from '@/application/job-view';
import { documentIdentityFor } from '@/lib/job-card/document-identity';

/**
 * BD-23 OVER HTTP — the path a tablet's queue actually takes. Approved by the
 * owner on 27 October 2026.
 *
 * The identity is computed here exactly as the browser computes it: from the
 * job view the technician's GET returned, as JSON. So these tests also prove
 * that what crosses the wire is enough to reproduce the server's identity —
 * the property every offline signature depends on.
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

interface JobBody {
  readonly id: string;
  readonly jobNumber: string;
  readonly status: string;
  readonly signature: { readonly customerName: string } | null;
  readonly signatureRefusals: readonly unknown[];
}

interface Outcome {
  readonly outcome: 'accepted' | 'referred';
  readonly job?: JobBody;
  readonly reason?: string;
  readonly referral?: { readonly id: string; readonly state: string; readonly action: string };
}

const userId = async (client: ApiTestClient, email: string): Promise<string> =>
  (
    await client.get<{ users: readonly { id: string; email: string }[] }>('/api/admin')
  ).data.users.find((user) => user.email === email)?.id ?? '';

describe('a signature held on the tablet, sent when the signal returns', () => {
  let master: ApiTestClient;
  let sipho: ApiTestClient;
  let job: JobBody;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
    const siphoId = await userId(master, DEMO_USERS.technician);
    job = (await master.post<JobBody>('/api/jobs', { ...NEW_JOB, primaryTechnicianId: siphoId })).data;
    sipho = await signedInAs(DEMO_USERS.technician);
    const step = async (action: string, body?: unknown) =>
      expect((await sipho.post(`/api/jobs/${job.id}/${action}`, body)).status, action).toBe(200);
    await step('accept');
    await step('add_labour', { date: '2026-10-17', rateType: 'normal', hours: 2, description: 'Drive fan' });
    await step('save_report', {
      faultFindings: '',
      diagnosis: '',
      workPerformed: 'Replaced the drive fan.',
      recommendations: '',
      generalNotes: '',
    });
    await step('start_completion');
    await step('start_signature');
  });

  /** What the tablet computes from the view the server gave the technician. */
  const shownIdentity = async (): Promise<string> => {
    const { view } = (await sipho.get<{ view: JobView }>(`/api/jobs/${job.jobNumber}`)).data;
    return documentIdentityFor({
      job: view.job,
      customer: view.customer,
      site: view.site,
      contact: view.contact,
      machine: view.machine,
      settings: view.settings,
      checklistTemplate: view.checklistTemplate,
      users: view.users,
    });
  };

  const signature = (documentIdentity: string) => ({
    captureId: '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b',
    documentIdentity,
    pdfSha256: null,
    capturedAt: '2026-10-27T09:15:00.000+02:00',
    customerName: 'Thandi',
    customerSurname: 'Mokoena',
    strokeData: 'M10 10 L40 40',
  });

  const send = (body: unknown, key: string, action = 'capture_signature_offline') =>
    sipho.post<Outcome>(`/api/jobs/${job.id}/${action}`, body, { idempotencyKey: key });

  it('accepts it when the document the customer saw is the one the server holds', async () => {
    const sent = await send(signature(await shownIdentity()), 'held-signature-1');

    expect(sent.status).toBe(200);
    expect(sent.data.outcome).toBe('accepted');
    expect(sent.data.job?.status).toBe('review');
    expect(sent.data.job?.signature?.customerName).toBe('Thandi');
  });

  it('answers a replay under the same key from the first request — one signature, not two attempts', async () => {
    const body = signature(await shownIdentity());
    await send(body, 'held-signature-2');
    const replay = await send(body, 'held-signature-2');

    expect(replay.status).toBe(200);
    expect(replay.headers.get('Idempotent-Replay')).toBe('true');
    expect(replay.data.outcome).toBe('accepted');
  });

  it('refers it, changing nothing, when the office altered the job card after it was shown', async () => {
    const identity = await shownIdentity();
    // Something printed on the card changes while the tablet is out of signal:
    // the office applies the call-out fee, which adds a charge line.
    const edit = await master.post(`/api/jobs/${job.id}/set_callout`, { applied: true });
    expect(edit.status, JSON.stringify(edit.error)).toBe(200);

    const sent = await send(signature(identity), 'held-signature-3');

    expect(sent.status).toBe(200);
    expect(sent.data.outcome).toBe('referred');
    expect(sent.data.reason).toBe('document_changed');
    expect(sent.data.referral?.state).toBe('open');

    const after = (await sipho.get<{ view: JobView }>(`/api/jobs/${job.jobNumber}`)).data.view.job;
    expect(after.signature).toBeNull();
    expect(after.status).toBe('customer_signature');

    // On the office's queue, and the office may NOT apply it.
    const id = sent.data.referral?.id ?? '';
    const applied = await master.post(`/api/captures/referrals/${id}/resolve`, { resolution: 'applied' });
    expect(applied.status).toBe(400);
    expect(applied.error?.violations?.map((violation) => violation.code)).toContain('action_not_applicable');

    const closed = await master.post<{ referral: { state: string } }>(`/api/captures/referrals/${id}/resolve`, {
      resolution: 'no_action',
      note: 'Customer re-signed the corrected job card on site.',
    });
    expect(closed.status).toBe(200);
    expect(closed.data.referral.state).toBe('resolved');
    // Closing the referral signs nothing.
    const still = (await sipho.get<{ view: JobView }>(`/api/jobs/${job.jobNumber}`)).data.view.job;
    expect(still.signature).toBeNull();
  });

  it('accepts a held refusal against the same document', async () => {
    const identity = await shownIdentity();
    const sent = await send(
      {
        captureId: '2a3b4c5d-6e7f-4801-9a2b-3c4d5e6f7a8b',
        documentIdentity: identity,
        pdfSha256: null,
        capturedAt: '2026-10-27T09:20:00.000+02:00',
        reason: 'Will not sign until the invoice is checked.',
      },
      'held-refusal-1',
      'record_refusal_offline',
    );
    expect(sent.status).toBe(200);
    expect(sent.data.outcome).toBe('accepted');
    expect(sent.data.job?.signatureRefusals).toHaveLength(1);
  });

  it('refuses a capture with no document identity at all — it cannot be verified', async () => {
    const { documentIdentity: _omit, ...withoutIdentity } = signature('x');
    const sent = await send(withoutIdentity, 'held-signature-4');
    expect(sent.status).toBe(400);
    const after = (await sipho.get<{ view: JobView }>(`/api/jobs/${job.jobNumber}`)).data.view.job;
    expect(after.signature).toBeNull();
  });

  it('refuses the office presenting a signature it did not take on a tablet', async () => {
    const sent = await master.post(`/api/jobs/${job.id}/capture_signature_offline`, signature(await shownIdentity()), {
      idempotencyKey: 'office-try',
    });
    expect(sent.status).toBeGreaterThanOrEqual(400);
    const after = (await sipho.get<{ view: JobView }>(`/api/jobs/${job.jobNumber}`)).data.view.job;
    expect(after.signature).toBeNull();
  });
});
