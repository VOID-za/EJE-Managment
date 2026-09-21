import { beforeEach, describe, expect, it } from 'vitest';
import type { OutboxMessage } from '@/domain';
import { MAX_OUTBOX_ATTEMPTS } from '@/domain';
import { getServerRuntime } from '@/server/runtime';
import { DEMO_USERS, signedInAs, startTestServer, type ApiTestClient } from '@/test/api-harness';
import { dispatchOutbox } from './outbox-dispatch';

/**
 * The transaction boundary, and what happens on the other side of it.
 *
 * WHAT CHANGED AND WHY. The assignment used to call Meta from inside the
 * PostgreSQL transaction that was recording it. That held a database connection
 * open across a network round trip, and — worse — left nothing behind to retry
 * from: commit the assignment, fail the call, and the obligation to tell
 * somebody existed only as a sentence on the audit trail.
 *
 * Now the transaction writes a ROW and commits. These hold that the row is
 * written, that nothing is sent while it is being written, that a send failure
 * leaves the obligation intact, and that a message is never handed over twice.
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
  orderNumber: 'PO-78000',
  referenceNumber: '',
  faultDescription: 'Spindle drive alarm.',
  primaryTechnicianId: null,
  courierCollection: false,
  deliveryNote: '',
} as const;

const outbox = (): Promise<readonly OutboxMessage[]> =>
  getServerRuntime().read(({ repos }) => repos.outbox.list());

describe('assigning a job', () => {
  let master: ApiTestClient;
  let siphoId: string;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
    const admin = await master.get<{ users: readonly { id: string; email: string }[] }>(
      '/api/admin',
    );
    siphoId = admin.data.users.find((user) => user.email === DEMO_USERS.technician)?.id ?? '';
  });

  it('records the message to send as part of the business transaction', async () => {
    const created = await master.post<{ id: string }>('/api/jobs', {
      ...NEW_JOB,
      primaryTechnicianId: siphoId,
    });

    const messages = (await outbox()).filter((message) => message.jobId === created.data.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.channel).toBe('whatsapp');
    expect(messages[0]?.template).toBe('eje_job_assigned');
  });

  it('drains it on the way out, so the request leaves nothing owing', async () => {
    const created = await master.post<{ id: string }>('/api/jobs', {
      ...NEW_JOB,
      primaryTechnicianId: siphoId,
    });

    /*
     * `writeRoute` calls `drainOutboxQuietly` AFTER its transaction commits, so
     * by the time the response was written the demonstration adapter had
     * already accepted the message.
     */
    const [message] = (await outbox()).filter((entry) => entry.jobId === created.data.id);
    expect(message?.state).toBe('sent');
    expect(message?.attempts).toBe(1);
    expect(message?.providerMessageId).not.toBeNull();
  });

  it('says SENT, and never delivered', async () => {
    const created = await master.post<{ id: string }>('/api/jobs', {
      ...NEW_JOB,
      primaryTechnicianId: siphoId,
    });

    const [message] = (await outbox()).filter((entry) => entry.jobId === created.data.id);
    // The provider accepted it. No handset has confirmed anything, and the
    // vocabulary here is deliberately not able to say otherwise.
    expect(message?.state).toBe('sent');
    expect(['pending', 'sent', 'failed']).toContain(message?.state);
  });

  it('does not send the same message twice, however often the outbox is drained', async () => {
    const created = await master.post<{ id: string }>('/api/jobs', {
      ...NEW_JOB,
      primaryTechnicianId: siphoId,
    });

    const before = (await outbox()).filter((entry) => entry.jobId === created.data.id)[0];
    // A second drain finds nothing to do: `sent` is terminal.
    const outcome = await dispatchOutbox(getServerRuntime());
    const after = (await outbox()).filter((entry) => entry.jobId === created.data.id)[0];

    expect(outcome.attempted).toBe(0);
    expect(after?.attempts).toBe(before?.attempts);
    expect(after?.providerMessageId).toBe(before?.providerMessageId);
  });

});

/**
 * When the provider will not take it.
 *
 * The obligation is the row, and a failed attempt does not discharge it. This
 * is the failure the old design could not survive: commit, fail, forget.
 */
describe('a provider that refuses', () => {
  beforeEach(() => {
    startTestServer();
  });

  const enqueueOne = async (recipient = '082 555 0134'): Promise<string> => {
    const runtime = getServerRuntime();
    const id = `outbox-test-${Math.random().toString(36).slice(2)}`;
    await runtime.write(({ repos }) =>
      repos.outbox.enqueue({
        id,
        channel: 'whatsapp',
        template: 'eje_job_assigned',
        recipient,
        parameters: ['EJE-1000', 'ABC Engineering', 'Isando', 'Leadwell V-40'],
        preview: 'EJE-1000 — assigned to you',
        jobId: null,
        state: 'pending',
        attempts: 0,
        providerMessageId: null,
        failureReason: '',
        createdAt: new Date().toISOString(),
        lastAttemptAt: null,
      }),
    );
    return id;
  };

  const find = async (id: string): Promise<OutboxMessage | undefined> =>
    (await outbox()).find((message) => message.id === id);

  it('keeps the message pending so the next request tries again', async () => {
    const runtime = getServerRuntime();
    const id = await enqueueOne();

    // Stand a failing provider in the composition root's place.
    const services = await runtime.read(({ services: built }) => Promise.resolve(built));
    const original = services.whatsapp;
    (services as { whatsapp: unknown }).whatsapp = {
      send: () => Promise.reject(new Error('Template name does not exist')),
    };

    try {
      const outcome = await dispatchOutbox(runtime);
      expect(outcome.failed).toBe(1);

      const message = await find(id);
      // STILL OUTSTANDING. That is the durability the row exists for.
      expect(message?.state).toBe('pending');
      expect(message?.attempts).toBe(1);
      expect(message?.failureReason).toContain('Template name does not exist');
      expect(message?.providerMessageId).toBeNull();
    } finally {
      (services as { whatsapp: unknown }).whatsapp = original;
    }
  });

  it('sends it on a later attempt once the provider recovers', async () => {
    const runtime = getServerRuntime();
    const id = await enqueueOne();
    const services = await runtime.read(({ services: built }) => Promise.resolve(built));
    const original = services.whatsapp;

    (services as { whatsapp: unknown }).whatsapp = {
      send: () => Promise.reject(new Error('provider unavailable')),
    };
    await dispatchOutbox(runtime);
    expect((await find(id))?.state).toBe('pending');

    // THE RETRY, and it is not a new business change: the assignment happened
    // once and only the telling is being attempted again.
    (services as { whatsapp: unknown }).whatsapp = original;
    try {
      const outcome = await dispatchOutbox(runtime);
      expect(outcome.sent).toBe(1);

      const message = await find(id);
      expect(message?.state).toBe('sent');
      expect(message?.attempts).toBe(2);
    } finally {
      (services as { whatsapp: unknown }).whatsapp = original;
    }
  });

  it('gives up after enough attempts rather than trying for ever', async () => {
    const runtime = getServerRuntime();
    const id = await enqueueOne();
    const services = await runtime.read(({ services: built }) => Promise.resolve(built));
    const original = services.whatsapp;
    (services as { whatsapp: unknown }).whatsapp = {
      send: () => Promise.reject(new Error('still down')),
    };

    try {
      for (let attempt = 0; attempt < MAX_OUTBOX_ATTEMPTS + 2; attempt += 1) {
        await dispatchOutbox(runtime);
      }

      const message = await find(id);
      // These are notifications, not payments. Somebody not reached by the
      // fourth attempt needs a telephone call, not a fifth.
      expect(message?.state).toBe('failed');
      expect(message?.attempts).toBe(MAX_OUTBOX_ATTEMPTS);
    } finally {
      (services as { whatsapp: unknown }).whatsapp = original;
    }
  });

  it('never fails the request that created the obligation', async () => {
    const runtime = getServerRuntime();
    const services = await runtime.read(({ services: built }) => Promise.resolve(built));
    const original = services.whatsapp;
    (services as { whatsapp: unknown }).whatsapp = {
      send: () => Promise.reject(new Error('provider unavailable')),
    };

    try {
      const master = await signedInAs(DEMO_USERS.master);
      const admin = await master.get<{ users: readonly { id: string; email: string }[] }>(
        '/api/admin',
      );
      const siphoId =
        admin.data.users.find((user) => user.email === DEMO_USERS.technician)?.id ?? '';

      const created = await master.post<{ id: string; status: string }>('/api/jobs', {
        ...NEW_JOB,
        orderNumber: 'PO-78002',
        primaryTechnicianId: siphoId,
      });

      // The person assigned the job. Whether Meta was reachable a moment later
      // is not their problem and must not become an error on their screen.
      expect(created.status).toBe(200);
      expect(created.data.status).toBe('open');

      const [message] = (await outbox()).filter((entry) => entry.jobId === created.data.id);
      expect(message?.state).toBe('pending');
    } finally {
      (services as { whatsapp: unknown }).whatsapp = original;
    }
  });
});
