import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as schema from '@/db/schema';
import type { Job } from '@/domain';
import { IDS, seedBaseline } from '@/data/postgres/test-fixtures';
import { openTestDatabase, testDatabaseUrl, truncateAll } from '@/data/postgres/test-database';
import { businessToday } from '@/lib/business-time';
import { hashPassword } from '@/server/auth/passwords';
import { ApiTestClient, startPostgresTestServer } from '@/test/api-harness';

/**
 * A SIGNED JOB CARD REACHES THE CUSTOMER. MASTER SCOPE AUD-10, QA-1.
 *
 * THE DEFECT THIS EXISTS FOR. `JobRepository.save` replaced a job's children by
 * deleting them and re-inserting, and `0007_signed_job_immutability.sql` refuses
 * DELETE on `job_labour`, `job_travel`, `job_parts`, `job_notes` and `job_media`
 * once a signature exists. Both are right on their own. Together they meant that
 * issuing a signed job card — which saves the job to record the document and the
 * delivery — ran `DELETE FROM job_labour` on a signed job, raised
 * `restrict_violation`, rolled the transaction back and answered
 * `POST /api/jobs/:id/issue` with **500**. A genuinely signed PostgreSQL job
 * could not be submitted at all, so the customer never got their job card.
 *
 * It hid because nothing had ever saved a signed job against real PostgreSQL —
 * AUD-6, exactly as written.
 *
 * WHAT WAS NOT DONE ABOUT IT: the trigger was not weakened, dropped or worked
 * around, and no signed row was made deletable. The repository stopped asking
 * for the rewrite, because on a signed job there is nothing legitimate to write.
 * The last case below proves the trigger is still there and still bites.
 *
 * Each of the four child kinds gets its own case on purpose. One test with all
 * four would pass the moment the first was fixed and say nothing about the rest.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

const PASSWORD = 'a-real-test-password';
const MASTER = 'elmarie@example-test.co.za';
const TECHNICIAN = 'sipho@example-test.co.za';
/*
 * A PHOTOGRAPH, because the new-job attachment route takes photographs and
 * videos since Create New Job §3C. Nothing in this file is about file types:
 * what is being proved is the row, the bytes on disk and who may read them.
 */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

/** The database's own words, which the driver keeps on the cause. */
const reason = (error: unknown): string => {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    parts.push(current.message);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(' | ');
};

interface Evidence {
  readonly labour?: boolean;
  readonly travel?: boolean;
  readonly parts?: boolean;
  readonly notes?: boolean;
  readonly media?: boolean;
}

describeDb('a signed job card can be submitted on PostgreSQL', () => {
  let db: Database;
  let storageRoot: string;

  const signIn = async (email: string): Promise<ApiTestClient> => {
    const client = new ApiTestClient();
    const response = await client.signIn(email, PASSWORD);
    if (response.status !== 200) throw new Error(`sign-in failed for ${email}`);
    return client;
  };

  /**
   * A job carried to `review` and signed, carrying exactly the evidence asked
   * for — so a failure names which child table is responsible.
   */
  const signedJob = async (
    evidence: Evidence,
  ): Promise<{ tech: ApiTestClient; master: ApiTestClient; id: string; jobNumber: string }> => {
    const master = await signIn(MASTER);
    const created = await master.post<Job>('/api/jobs', {
      customerId: IDS.customer,
      siteId: IDS.site,
      contactId: IDS.contact,
      machineId: IDS.machine,
      jobType: 'breakdown',
      priority: 'urgent',
      scheduledDate: null,
      scheduledEndDate: null,
      orderNumber: 'PO-81000',
      referenceNumber: '',
      faultDescription: 'Spindle drive alarm 750.',
      primaryTechnicianId: IDS.technician,
      courierCollection: false,
      deliveryNote: '',
    });
    expect(created.status).toBe(200);
    const id = created.data.id;

    const tech = await signIn(TECHNICIAN);
    expect((await tech.post(`/api/jobs/${id}/accept`)).status).toBe(200);

    if (evidence.labour === true) {
      expect(
        (
          await tech.post(`/api/jobs/${id}/add_labour`, {
            date: '2026-09-17',
            rateType: 'normal',
            hours: 3,
            description: 'Replaced the coolant pump.',
          })
        ).status,
      ).toBe(200);
    }
    if (evidence.travel === true) {
      expect(
        (
          await tech.post(`/api/jobs/${id}/add_travel`, {
            date: '2026-09-17',
            kilometres: 84,
            description: 'Benoni and back.',
          })
        ).status,
      ).toBe(200);
    }
    if (evidence.parts === true) {
      expect(
        (
          await tech.post(`/api/jobs/${id}/add_part`, {
            partNumber: 'PMP-4410',
            description: 'Coolant pump',
            quantity: 1,
            unitPrice: 185000,
          })
        ).status,
      ).toBe(200);
    }
    if (evidence.notes === true) {
      expect(
        (
          await tech.post(`/api/jobs/${id}/add_note`, {
            body: 'Customer asked about a service contract.',
            internal: true,
          })
        ).status,
      ).toBe(200);
    }
    if (evidence.media === true) {
      const uploaded = await tech.upload(`/api/jobs/${id}/attachments`, {
        name: 'nameplate.png',
        type: 'image/png',
        bytes: PNG,
      });
      expect(uploaded.status).toBe(200);
    }

    await tech.post(`/api/jobs/${id}/save_report`, {
      faultFindings: '',
      diagnosis: '',
      workPerformed: 'Replaced the coolant pump and cleared the alarm.',
      recommendations: '',
      generalNotes: '',
    });
    await tech.post(`/api/jobs/${id}/start_completion`);
    await tech.post(`/api/jobs/${id}/start_signature`);
    const signed = await tech.post<Job>(`/api/jobs/${id}/capture_signature`, {
      customerName: 'Pieter',
      customerSurname: 'Nel',
      strokeData: 'M0,0 L1,1',
    });
    expect(signed.status).toBe(200);
    expect(signed.data.status).toBe('review');

    // The signature is really in the table — the triggers key off this row, so
    // a test that skipped it would prove nothing at all.
    const signatures = await db
      .select()
      .from(schema.jobSignatures)
      .where(eq(schema.jobSignatures.jobId, id));
    expect(signatures).toHaveLength(1);

    return { tech, master, id, jobNumber: signed.data.jobNumber };
  };

  /** `issue` answers a SubmitResult — the job, the document and the delivery. */
  const issue = (tech: ApiTestClient, id: string) =>
    tech.post<{ job: Job; documentFileName: string; delivery: { state: string } }>(
      `/api/jobs/${id}/issue`,
      {},
    );

  beforeAll(async () => {
    db = await openTestDatabase(url ?? '');
    storageRoot = await mkdtemp(join(tmpdir(), 'eje-signed-'));
    process.env.EJE_STORAGE_DIR = storageRoot;
    startPostgresTestServer(url ?? '');
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await rm(storageRoot, { recursive: true, force: true });
    delete process.env.EJE_STORAGE_DIR;
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedBaseline(db);
    await db.update(schema.users).set({ passwordHash: await hashPassword(PASSWORD) });
    process.env.EJE_STORAGE_DIR = storageRoot;
    startPostgresTestServer(url ?? '');
  });

  /* -- 1. the unsigned aggregate is still freely editable ------------------ */

  it('still saves an unsigned job whose children change', async () => {
    const master = await signIn(MASTER);
    const created = await master.post<Job>('/api/jobs', {
      customerId: IDS.customer,
      siteId: IDS.site,
      contactId: IDS.contact,
      machineId: IDS.machine,
      jobType: 'breakdown',
      priority: 'urgent',
      scheduledDate: null,
      scheduledEndDate: null,
      orderNumber: 'PO-81000',
      referenceNumber: '',
      faultDescription: 'Spindle drive alarm 750.',
      primaryTechnicianId: IDS.technician,
      courierCollection: false,
      deliveryNote: '',
    });
    const id = created.data.id;
    const tech = await signIn(TECHNICIAN);
    await tech.post(`/api/jobs/${id}/accept`);

    const added = await tech.post<Job>(`/api/jobs/${id}/add_labour`, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 3,
      description: 'First attempt.',
    });
    expect(added.status).toBe(200);
    const lineId = added.data.labour[0]?.id ?? '';

    // Edited and then removed: both go through the wholesale replace, which is
    // the path a signature closes and nothing else may.
    const edited = await tech.post<Job>(`/api/jobs/${id}/update_labour`, {
      lineId,
      date: '2026-09-17',
      rateType: 'overtime',
      hours: 5,
      description: 'Corrected.',
    });
    expect(edited.status).toBe(200);
    expect(edited.data.labour[0]?.hours).toBe(5);
    expect(edited.data.labour[0]?.rateType).toBe('overtime');

    const removed = await tech.post<Job>(`/api/jobs/${id}/remove_line`, { lineId, kind: 'labour' });
    expect(removed.status).toBe(200);
    expect(removed.data.labour).toHaveLength(0);
    expect(await db.select().from(schema.jobLabour).where(eq(schema.jobLabour.jobId, id))).toHaveLength(0);
  });

  /* -- 2-6. a signed job survives submission, one child kind at a time ----- */

  it('issues a signed job carrying LABOUR', async () => {
    const { tech, id } = await signedJob({ labour: true });
    const issued = await issue(tech, id);

    expect(issued.status).toBe(200);
    expect(issued.data.job.status).toBe('office_handling');
    /*
     * FAILED, AND THAT IS THE RIGHT ANSWER HERE. CR-09 Phase 1.
     *
     * This deployment has no Graph configuration, so the email adapter is
     * `UnconfiguredEmailService` and it REFUSES rather than pretending. The
     * submission still completes — the document is rendered, stored and
     * recorded — and the delivery record carries the refusal so the office can
     * re-send once the deployment is configured. `delivered` is the one state
     * no adapter may reach on its own, and nothing here reaches it.
     */
    expect(['failed', 'pending_delivery']).toContain(issued.data.delivery.state);
    expect(issued.data.delivery.state).not.toBe('delivered');
    expect(await db.select().from(schema.jobLabour).where(eq(schema.jobLabour.jobId, id))).toHaveLength(1);
  });

  /**
   * THE ROW DESCRIBES THE FILE. BACKUP-1.
   *
   * The defect: this insert wrote neither `size_bytes` nor `checksum_sha256`
   * and hard-coded `renderer_version` to 0, so every `final_documents` row in
   * production read `size_bytes = 0` with no checksum — while the schema's own
   * comment claimed the checksum was verified on every read. Nothing could
   * tell a stored job card from a missing one, or an intact one from a
   * truncated one, and the backup's restore test had nothing to check against.
   */
  it('records the SIZE and CHECKSUM of the document it issued, matching the file on disk', async () => {
    const { tech, id } = await signedJob({ labour: true });
    expect((await issue(tech, id)).status).toBe(200);

    const rows = await db
      .select()
      .from(schema.finalDocuments)
      .where(eq(schema.finalDocuments.jobId, id));
    const row = rows[0];
    expect(row, 'the issue wrote no final_documents row at all').toBeDefined();

    // Not merely non-zero: the same length and hash as the bytes on the disk.
    const onDisk = await readFile(join(storageRoot, `${row?.storageKey ?? ''}.bin`));
    expect(row?.sizeBytes).toBe(onDisk.byteLength);
    expect(row?.sizeBytes ?? 0).toBeGreaterThan(0);
    expect(row?.checksumSha256).toBe(createHash('sha256').update(onDisk).digest('hex'));
    // And the renderer that really produced them, not a hard-coded zero.
    expect(row?.rendererVersion ?? 0).toBeGreaterThan(0);
  });

  it('issues a signed job carrying TRAVEL', async () => {
    const { tech, id } = await signedJob({ labour: true, travel: true });
    const issued = await issue(tech, id);

    expect(issued.status).toBe(200);
    expect(await db.select().from(schema.jobTravel).where(eq(schema.jobTravel.jobId, id))).toHaveLength(1);
  });

  it('issues a signed job carrying PARTS', async () => {
    const { tech, id } = await signedJob({ labour: true, parts: true });
    const issued = await issue(tech, id);

    expect(issued.status).toBe(200);
    expect(await db.select().from(schema.jobParts).where(eq(schema.jobParts.jobId, id))).toHaveLength(1);
  });

  it('issues a signed job carrying NOTES', async () => {
    const { tech, id } = await signedJob({ labour: true, notes: true });
    const issued = await issue(tech, id);

    expect(issued.status).toBe(200);
    expect(await db.select().from(schema.jobNotes).where(eq(schema.jobNotes.jobId, id))).toHaveLength(1);
  });

  it('issues a signed job carrying MEDIA', async () => {
    const { tech, id } = await signedJob({ labour: true, media: true });
    const issued = await issue(tech, id);

    expect(issued.status).toBe(200);
    expect(await db.select().from(schema.jobMedia).where(eq(schema.jobMedia.jobId, id))).toHaveLength(1);
  });

  it('issues a signed job carrying all four at once, and writes the audit rows', async () => {
    const { tech, id } = await signedJob({
      labour: true,
      travel: true,
      parts: true,
      notes: true,
      media: true,
    });
    const issued = await issue(tech, id);

    expect(issued.status).toBe(200);

    /*
     * QA-1: the audit rows the submission writes, not merely its HTTP status.
     * A 200 with no trail would be a submission nobody can account for.
     */
    const events = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.jobId, id));
    const types = events.map((event) => event.type);
    expect(types).toContain('pdf_generated');
    expect(types).toContain('job_submitted');
    expect(types).toContain('delivery_state_changed');
  });

  /* -- 7. the signed children are untouched -------------------------------- */

  it('leaves every signed child row exactly as it was before submission', async () => {
    const { tech, id } = await signedJob({
      labour: true,
      travel: true,
      parts: true,
      notes: true,
      media: true,
    });

    const snapshot = async () => ({
      labour: await db.select().from(schema.jobLabour).where(eq(schema.jobLabour.jobId, id)),
      travel: await db.select().from(schema.jobTravel).where(eq(schema.jobTravel.jobId, id)),
      parts: await db.select().from(schema.jobParts).where(eq(schema.jobParts.jobId, id)),
      notes: await db.select().from(schema.jobNotes).where(eq(schema.jobNotes.jobId, id)),
      media: await db.select().from(schema.jobMedia).where(eq(schema.jobMedia.jobId, id)),
    });

    const before = await snapshot();
    expect((await issue(tech, id)).status).toBe(200);
    const after = await snapshot();

    /*
     * THE ROWS THEMSELVES, not a count of them. Identity included: a row that
     * was deleted and re-inserted with the same contents would carry a new
     * primary key, and this is what would catch it.
     */
    expect(after).toEqual(before);
  });

  /* -- 8. the trigger is still there, and still bites ---------------------- */

  it('still refuses an actual forbidden change to a signed job', async () => {
    const { tech, id } = await signedJob({ labour: true, parts: true, notes: true });
    expect((await issue(tech, id)).status).toBe(200);

    /*
     * STRAIGHT AT THE TABLES, DELIBERATELY. This is the mistaken migration or
     * the well-meant support query that `0007` exists for — it goes nowhere
     * near the repository, so nothing the repository was taught can be what
     * refuses it. Every one of these is a statement the trigger must stop.
     */
    const forbidden: readonly (readonly [string, () => Promise<unknown>])[] = [
      ['delete labour', () => db.delete(schema.jobLabour).where(eq(schema.jobLabour.jobId, id))],
      [
        'update labour',
        () => db.update(schema.jobLabour).set({ hours: '99' }).where(eq(schema.jobLabour.jobId, id)),
      ],
      ['delete parts', () => db.delete(schema.jobParts).where(eq(schema.jobParts.jobId, id))],
      [
        'update notes',
        () =>
          db.update(schema.jobNotes).set({ body: 'rewritten' }).where(eq(schema.jobNotes.jobId, id)),
      ],
      ['delete notes', () => db.delete(schema.jobNotes).where(eq(schema.jobNotes.jobId, id))],
    ];

    for (const [name, attempt] of forbidden) {
      const refusal = await attempt().then(
        () => null,
        (error: unknown) => error,
      );
      expect(refusal, `${name} was NOT refused`).not.toBeNull();
      // The driver wraps the server's message, so the trigger's own words are
      // on the cause. Asserting the wrapper would pass for any failure at all.
      expect(reason(refusal)).toMatch(/signed by the customer/u);
    }

    // And the job card text on the job row is still frozen too.
    const textRefusal = await db
      .update(schema.jobs)
      .set({ reportWorkPerformed: 'rewritten' })
      .where(eq(schema.jobs.id, id))
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(textRefusal).not.toBeNull();
    expect(reason(textRefusal)).toMatch(/the job card text and charges are final/u);
  });

  /* -- 9. IDEM-2 still holds on the path it could not previously reach ----- */

  it('still issues once when two submissions arrive together', async () => {
    const { tech, id } = await signedJob({ labour: true, parts: true });

    const [a, b] = await Promise.all([issue(tech, id), issue(tech, id)]);

    expect([a, b].filter((response) => response.status === 200)).toHaveLength(1);
    const loser = [a, b].find((response) => response.status !== 200);
    expect([409, 422]).toContain(loser?.status);

    // One submission, one document, one delivery record.
    const events = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.jobId, id));
    expect(events.filter((event) => event.type === 'job_submitted')).toHaveLength(1);
    expect(
      await db.select().from(schema.finalDocuments).where(eq(schema.finalDocuments.jobId, id)),
    ).toHaveLength(1);
  });

  it('refuses a second submission that arrives after the first has committed', async () => {
    const { tech, id } = await signedJob({ labour: true });
    expect((await issue(tech, id)).status).toBe(200);

    const again = await issue(tech, id);
    expect(again.status).toBe(422);
    expect(again.error?.violations?.[0]?.code).toBe('not_ready_to_issue');
    expect(
      await db.select().from(schema.finalDocuments).where(eq(schema.finalDocuments.jobId, id)),
    ).toHaveLength(1);
  });

  /* -- QA-1: delivery, and the audit rows it writes ------------------------ */

  // Issue #73: the submission hands the job to the office, a delivery report
  // closes nothing, and the office finishes it — all against PostgreSQL.
  it('goes to the office on submission, is not closed by delivery, and is invoiced by the office', async () => {
    const { tech, master, id, jobNumber } = await signedJob({ labour: true });
    const issued = await issue(tech, id);
    expect(issued.status).toBe(200);
    expect(issued.data.job.status).toBe('office_handling');

    /*
     * THE SUBMISSION DID NOT CLOSE IT. SUBMIT-5.
     *
     * A provider taking the message is not a customer receiving it, so the job
     * waits. Only the confirmation closes it — which is another save of a
     * SIGNED job, and therefore another journey down the path AUD-10 broke.
     */
    const rows = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
    expect(rows[0]?.status).toBe('office_handling');
    expect(rows[0]?.closedAt).toBeNull();

    const confirmed = await master.post(`/api/jobs/${id}/confirm_delivery`, {});
    expect(confirmed.status).toBe(200);

    /*
     * STILL OPEN, AND THAT IS CORRECT HERE. SUBMIT-5, DELIV-3.
     *
     * `confirm_delivery` asks the ADAPTER what became of the message; it does
     * not take the asking as an answer. This deployment has no email
     * configured, so there is no delivery report to be had and the job keeps
     * the state it had. A job that closed on this call would mean the system
     * had closed a job on a delivery nothing confirmed, which is the single
     * thing the whole delivery handshake exists to prevent.
     */
    const closed = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
    expect(closed[0]?.status).toBe('office_handling');
    expect(closed[0]?.closedAt).toBeNull();

    // The office lifecycle, through the routes, on the real schema.
    expect((await master.post(`/api/jobs/${id}/handle_office`, {})).status).toBe(200);
    const blank = await master.post(`/api/jobs/${id}/record_invoice`, { invoiceNumber: '' });
    expect(blank.status).toBe(422);
    const po = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
    expect(po[0]?.status).toBe('awaiting_po');
    expect(po[0]?.officeHandledAt).not.toBeNull();
    expect(po[0]?.invoiceNumber).toBeNull();
    expect(
      (await master.post(`/api/jobs/${id}/record_invoice`, { invoiceNumber: 'INV-PG-73' })).status,
    ).toBe(200);
    const invoiced = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
    expect(invoiced[0]?.status).toBe('invoiced');
    expect(invoiced[0]?.invoiceNumber).toBe('INV-PG-73');
    expect(invoiced[0]?.closedAt).toBeNull();

    // The labour the customer signed for is still exactly one row, untouched.
    expect(
      await db.select().from(schema.jobLabour).where(eq(schema.jobLabour.jobId, id)),
    ).toHaveLength(1);

    const events = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.jobId, id));
    expect(events.map((event) => event.type)).toContain('delivery_state_changed');
    expect(jobNumber).toMatch(/^EJE-/u);
  });

  /**
   * THE DELIVERY RECORD SURVIVES THE REQUEST THAT MADE IT. MANDATE-3.
   *
   * `delivery_attempts` was read by the mapper and written by nothing, so on
   * PostgreSQL what the provider said lived only in the object one request was
   * holding — and the office's next look at the job said it had not been sent.
   * This asserts the row, through the real route, and then asserts the job the
   * API serves afterwards agrees with it.
   */
  it('writes what the provider said, and still says it on the next request', async () => {
    const { tech, master, id, jobNumber } = await signedJob({ labour: true });
    expect((await issue(tech, id)).status).toBe(200);

    const attempts = await db
      .select()
      .from(schema.deliveryAttempts)
      .where(eq(schema.deliveryAttempts.jobId, id));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.attemptNumber).toBe(1);
    expect(attempts[0]?.channel).toBe('email');
    // Email is deliberately unconfigured in this deployment, so the attempt
    // failed — and the REASON is what the office acts on, so it is kept.
    expect(attempts[0]?.state).toBe('failed');
    expect(attempts[0]?.failureReason).toMatch(/not configured/u);
    expect(attempts[0]?.finalDocumentId).not.toBeNull();
    /*
     * AND WHICH KIND it was. MANDATE-3. "Not configured" is a different
     * instruction from "the provider refused": nothing was sent, nobody is at
     * fault on the customer's side, and what has to change is this deployment.
     * The office reads that off the job rather than out of a sentence.
     */
    expect(attempts[0]?.failureKind).toBe('not_configured');

    const reread = await master.get<{ view: { job: { delivery: Record<string, unknown> } } }>(
      `/api/jobs/${jobNumber}`,
    );
    expect(reread.status).toBe(200);
    const served = reread.data.view.job.delivery;
    expect(served.state).toBe('failed');
    expect(served.attempts).toBe(1);
    expect(String(served.failureReason)).toMatch(/not configured/u);
    // The classification reaches the screen, which is where it is acted on.
    expect(served.failureKind).toBe('not_configured');
  });

  it('keeps every attempt, so three tries can be told from one', async () => {
    const { tech, master, id, jobNumber } = await signedJob({ labour: true });
    expect((await issue(tech, id)).status).toBe(200);
    expect((await master.post(`/api/jobs/${id}/retry_delivery`, {})).status).toBe(200);

    const attempts = await db
      .select()
      .from(schema.deliveryAttempts)
      .where(eq(schema.deliveryAttempts.jobId, id));
    expect(attempts.map((row) => row.attemptNumber).sort()).toEqual([1, 2]);

    const reread = await master.get<{ view: { job: { delivery: { attempts: number } } } }>(
      `/api/jobs/${jobNumber}`,
    );
    expect(reread.data.view.job.delivery.attempts).toBe(2);
  });

  /**
   * TWO RE-SENDS AT ONCE DO NOT SEND TWO COPIES. MANDATE-3.
   *
   * The customer must never receive two copies of one signed job card — neither
   * they nor EJE could then say which is the record. Two requests arriving
   * together are refused one layer down, where the repository holds each writer
   * to the version it read; the second loses and never reaches the provider.
   * This asserts the OUTCOME rather than the mechanism: one success, one
   * refusal, and exactly two attempts on the job (the issue and one re-send).
   */
  it('does not send two copies when two re-sends arrive together', async () => {
    const { tech, master, id } = await signedJob({ labour: true });
    expect((await issue(tech, id)).status).toBe(200);

    const retry = () => master.post(`/api/jobs/${id}/retry_delivery`, {});
    const [a, b] = await Promise.all([retry(), retry()]);

    expect([a, b].filter((response) => response.status === 200)).toHaveLength(1);
    const attempts = await db
      .select()
      .from(schema.deliveryAttempts)
      .where(eq(schema.deliveryAttempts.jobId, id));
    expect(attempts.map((row) => row.attemptNumber).sort()).toEqual([1, 2]);

    // And the job is still awaiting delivery: nothing closed it on a send that
    // nothing confirmed.
    const rows = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
    expect(rows[0]?.status).toBe('office_handling');
  });

  it('re-sends the STORED document rather than rendering a new one', async () => {
    const { tech, master, id } = await signedJob({ labour: true, parts: true });
    expect((await issue(tech, id)).status).toBe(200);

    const before = await db
      .select()
      .from(schema.finalDocuments)
      .where(eq(schema.finalDocuments.jobId, id));
    expect(before).toHaveLength(1);

    /*
     * SUBMIT-12. The email is unconfigured on this deployment, so the first
     * send failed and the office re-sends — which saves the signed job again.
     * The customer must never receive two DIFFERENT job cards for one job, so
     * what goes out is the document already stored, not a fresh render.
     */
    const retried = await master.post(`/api/jobs/${id}/retry_delivery`, {});
    expect(retried.status).toBe(200);

    const after = await db
      .select()
      .from(schema.finalDocuments)
      .where(eq(schema.finalDocuments.jobId, id));
    expect(after).toHaveLength(1);
    expect(after[0]).toEqual(before[0]);
  });

  /* -- QA-1: the office takes a submission over ---------------------------- */

  it('lets the office take over the submission of a signed job', async () => {
    const { master, id } = await signedJob({ labour: true, travel: true, notes: true });

    /*
     * CR-08. The technician who signed the job is away for the whole day, so
     * the office may submit for them. A PART-day absence deliberately does not
     * open this door, which is why `allDay` is true here.
     */
    /*
     * THE BUSINESS DATE, NOT THE UTC ONE. QA-5's shape, found by this test
     * failing at 00:37 South African time: `submissionCover` asks whether the
     * technician is away on `businessDateOf(now)`, and between 22:00 and
     * midnight UTC that is TOMORROW in Johannesburg — so an absence recorded
     * for the UTC date did not cover the business day, the job stayed covered,
     * and the takeover was correctly refused. The test was wrong, not the rule.
     */
    const today = businessToday();
    const absence = await master.post('/api/availability', {
      userId: IDS.technician,
      type: 'sick_leave',
      startDate: today,
      endDate: today,
      allDay: true,
      startTime: null,
      endTime: null,
      description: 'Off sick for the day.',
    });
    expect(absence.status).toBe(200);

    const takenOver = await master.post<{ job: Job }>(`/api/jobs/${id}/take_over_submission`, {});
    expect(takenOver.status).toBe(200);
    expect(takenOver.data.job.status).toBe('office_handling');

    /*
     * The same issue path the technician would have run, so the job card is
     * the same document — and the trail says the office did it, which the
     * ordinary `job_submitted` event cannot say on its own.
     */
    const events = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.jobId, id));
    const types = events.map((event) => event.type);
    expect(types).toContain('submission_taken_over');
    expect(types).toContain('job_submitted');

    expect(
      await db.select().from(schema.finalDocuments).where(eq(schema.finalDocuments.jobId, id)),
    ).toHaveLength(1);
    // And not one row of signed evidence moved on the way through.
    expect(
      await db.select().from(schema.jobLabour).where(eq(schema.jobLabour.jobId, id)),
    ).toHaveLength(1);
    expect(
      await db.select().from(schema.jobTravel).where(eq(schema.jobTravel.jobId, id)),
    ).toHaveLength(1);
    expect(
      await db.select().from(schema.jobNotes).where(eq(schema.jobNotes.jobId, id)),
    ).toHaveLength(1);
  });

  /* -- 10. the stored document is the signed one, and stays that way ------- */

  it('keeps the stored final document, and does not regenerate it', async () => {
    const { tech, master, id, jobNumber } = await signedJob({ labour: true, parts: true });
    const issued = await issue(tech, id);
    expect(issued.status).toBe(200);

    const documents = await db
      .select()
      .from(schema.finalDocuments)
      .where(eq(schema.finalDocuments.jobId, id));
    expect(documents).toHaveLength(1);
    const original = documents[0];

    /*
     * A RATE CHANGE AFTERWARDS MUST NOT REACH IT. The document was rendered
     * from the pricing snapshot the signature froze, and re-reading the job,
     * confirming the delivery and closing it all save the job again — none of
     * which may re-render or re-stamp what the customer already has.
     */
    const stored = (await db.select().from(schema.systemSettings))[0];
    expect(stored).toBeDefined();
    const rates = await master.send('PATCH', '/api/settings', {
      body: {
        companyName: stored!.companyName,
        companyRegistration: stored!.companyRegistration,
        companyVatNumber: stored!.companyVatNumber,
        companyPhone: stored!.companyPhone,
        companyEmail: stored!.companyEmail,
        companyAddress: stored!.companyAddress,
        labourRates: { normal: 99_900, overtime: 99_900, double: 99_900 },
        calloutRate: 99_900,
        kilometreRate: 9_990,
        vatPercentage: 15,
        jobNumberPrefix: stored!.jobNumberPrefix,
        quietHoursStart: stored!.quietHoursStart,
        quietHoursEnd: stored!.quietHoursEnd,
      },
    });
    expect(rates.status).toBe(200);

    // Reading and confirming the delivery both save the job again.
    expect((await master.get(`/api/jobs/${jobNumber}`)).status).toBe(200);
    await master.post(`/api/jobs/${id}/confirm_delivery`, {});

    const after = await db
      .select()
      .from(schema.finalDocuments)
      .where(eq(schema.finalDocuments.jobId, id));
    expect(after).toHaveLength(1);
    expect(after[0]).toEqual(original);

    // And the pricing snapshot the customer signed against is still the one.
    const snapshots = await db
      .select()
      .from(schema.pricingSnapshots)
      .where(eq(schema.pricingSnapshots.jobId, id));
    expect(snapshots).toHaveLength(1);
  });
});
