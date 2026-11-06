import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDatabase, type Database } from '@/db/client';
import { testDatabaseUrl } from '@/data/postgres/test-database';
import { IDS, jobFixture, seedBaseline } from '@/data/postgres/test-fixtures';
import { PostgresDocumentRepository } from '@/data/postgres/document-repository';
import { PostgresJobRepository } from '@/data/postgres/job-repository';
import { asDocumentId, asUserId, type DocumentTextIndex, type TechnicalDocument } from '@/domain';
import { ROLLBACK_0047, ROLLBACK_0048, ROLLBACK_0049, ROLLBACK_0050, ROLLBACK_0051, ROLLBACK_0052, ROLLBACK_0054, ROLLBACK_DOCUMENTS, ROLLBACK_INTEGRATIONS, ROLLBACK_TIMESHEET } from './rollback-fixture';
import { asAttachmentId, asLineItemId } from '@/domain';
import { PostgresStandbyRepository } from '@/data/postgres/standby-repository';
import { PostgresCustomerRepository } from '@/data/postgres/customer-repository';
import { STANDBY_POSITIONS, type StandbyWeek } from '@/domain';
import { PostgresAttendanceRepository } from '@/data/postgres/attendance-repository';
import { PostgresDeliveryNoteRepository } from '@/data/postgres/delivery-note-repository';
import { asCustomerId, asJobId, type TimesheetEntry } from '@/domain';
import { PostgresPayrollRepository } from '@/data/postgres/payroll-repository';
import { PostgresSettingsRepository } from '@/data/postgres/settings-repository';
import { PostgresUserRepository } from '@/data/postgres/user-repository';

/**
 * ROLLBACK COMPATIBILITY, PHASE 1 OF 2: THIS RELEASE PREPARES THE DATABASE.
 *
 * Run only by `scripts/release/rollback-compat.sh` (RELEASE_ROLLBACK_PHASE=
 * prepare), never by `npm run db:test` — it leaves the database in place for
 * phase 2, which is the LIVE release's own code reading and writing it.
 *
 * It migrates a disposable test database to `0030` through the real migrator,
 * exactly as the release will, and writes a library document in every indexing
 * state this release can produce — including the one only it can produce:
 * `partially_indexed` with the page coverage UNKNOWN (0 of M). That row is the
 * whole question: if the release is rolled back after `0030` has run, the old
 * code meets it.
 */
const url = testDatabaseUrl();
const requested = process.env.RELEASE_ROLLBACK_PHASE === 'prepare';
/*
 * ASKED FOR AND UNABLE TO RUN IS A FAILURE, NOT A SKIP. A skipped test exits 0,
 * so a CI step that ran nothing would look exactly like one that proved
 * rollback compatibility. rollback-compat.sh also refuses any run that reports
 * a skipped or zero passed test.
 */
if (requested && url === null) {
  throw new Error('RELEASE_ROLLBACK_PHASE=prepare needs TEST_DATABASE_URL naming a disposable test database.');
}
const enabled = requested;
const describePhase = enabled ? describe : describe.skip;

const technicalDocument = (id: string, name: string): TechnicalDocument => ({
  id: asDocumentId(id),
  name,
  description: 'Written by the rollback-compatibility preparation.',
  documentType: 'service_manual',
  manufacturer: 'Leadwell',
  machineModel: 'V40',
  version: '1.0',
  status: 'current',
  fileName: `${id}.pdf`,
  fileSizeBytes: 1024,
  checksumSha256: null,
  pageCount: 10,
  storageKey: `uploads/${id}`,
  provenance: 'genuine',
  uploadedAt: '2026-10-01T08:00:00.000Z',
  uploadedBy: asUserId(IDS.master),
  tags: [],
});

const index = (documentId: string, over: Partial<DocumentTextIndex>): DocumentTextIndex => ({
  documentId: asDocumentId(documentId),
  state: 'indexed',
  source: 'text_layer',
  extractedAt: '2026-10-25T08:00:00.000Z',
  characters: 0,
  pages: 10,
  pagesIndexed: 10,
  truncated: false,
  unreadableStreams: 0,
  failureReason: '',
  ...over,
});

const pageRows = (documentId: string, numbers: readonly number[]) =>
  numbers.map((pageNumber) => {
    const content = `Page ${pageNumber}: check the spindle drive parameter before restart.`;
    return {
      documentId: asDocumentId(documentId),
      pageNumber,
      source: 'text_layer' as const,
      characters: content.length,
      content,
    };
  });

describePhase('rollback compatibility — phase 1: this release migrates to 0030 and writes every state', () => {
  let db: Database;

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
  });

  it('migrates a disposable database to 0030 through the real migrator', async () => {
    db = createDatabase({ connectionString: url ?? '', maxConnections: 2 });
    await db.execute(sql`drop schema if exists public cascade`);
    await db.execute(sql`drop schema if exists drizzle cascade`);
    await db.execute(sql`create schema public`);
    await migrate(db, { migrationsFolder: join(process.cwd(), 'src/db/migrations') });
    const rows = await db.execute<{ n: string }>(sql`select count(*)::text as n from drizzle.__drizzle_migrations`);
    // Every migration this checkout ships — 0030, and 0031 onwards when present.
    const shipped = (
      JSON.parse(readFileSync(join(process.cwd(), 'src/db/migrations/meta/_journal.json'), 'utf8')) as {
        entries: readonly unknown[];
      }
    ).entries.length;
    expect(Number(rows[0]?.n)).toBe(shipped);
  }, 120_000);

  it('writes a library document in every indexing state, "coverage unknown" included', async () => {
    await seedBaseline(db);
    const repository = new PostgresDocumentRepository(db);
    const { indexed, partial, needsOcr, failed, coverageUnknown } = ROLLBACK_DOCUMENTS;
    for (const [name, id] of Object.entries(ROLLBACK_DOCUMENTS)) {
      await repository.save(technicalDocument(id, `Rollback ${name}`));
    }

    const full = pageRows(indexed, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    await repository.saveTextIndex(
      index(indexed, { characters: full.reduce((sum, page) => sum + page.characters, 0) }),
      full.map((page) => page.content).join('\n\n'),
      full,
    );
    const seven = pageRows(partial, [1, 2, 3, 5, 6, 8, 9]);
    await repository.saveTextIndex(
      index(partial, {
        state: 'partially_indexed',
        pagesIndexed: 7,
        characters: seven.reduce((sum, page) => sum + page.characters, 0),
        failureReason: 'No text could be read from pages 4, 7, 10.',
      }),
      seven.map((page) => page.content).join('\n\n'),
      seven,
    );
    await repository.saveTextIndex(
      index(needsOcr, { state: 'needs_ocr', source: null, pagesIndexed: 0, failureReason: 'A scan.' }),
      '',
    );
    await repository.saveTextIndex(
      index(failed, { state: 'failed', source: null, pagesIndexed: 0, failureReason: 'Damaged.' }),
      '',
    );
    // ONLY THIS RELEASE CAN WRITE THIS ROW (migration 0030): the built-in reader,
    // cut at its summary budget, with no page rows and coverage unknown.
    const summary = 'Coolant pressure alarm 2071 means the filter is blocked. The rest was cut.';
    const saved = await repository.saveTextIndex(
      index(coverageUnknown, {
        state: 'partially_indexed',
        pages: 214,
        pagesIndexed: 0,
        characters: summary.length,
        truncated: true,
        failureReason: 'This server has no pdftotext; the rest is not searchable.',
      }),
      summary,
    );
    expect(saved.pagesIndexed).toBe(0);
    expect(saved.state).toBe('partially_indexed');
  });

  /*
   * 0031: `jobs.date_received`. A Test & Repair job carrying a date received
   * is the one job shape only this release writes; phase 2 has the live code
   * read it and write a job of its own beside it.
   */
  it('writes a Test & Repair job carrying a date received (0031) and FOUR parts booked in (0041)', async () => {
    const jobs = new PostgresJobRepository(db);
    // A number from the sequence, as every saved job has: the repository keeps
    // the sequence value beside it, so an invented number cannot be stored.
    // Phase 2 finds this job as the only Test & Repair on the database.
    const allocated = await jobs.allocateJobNumber();
    const saved = await jobs.save(
      jobFixture(allocated.jobNumber, {
        jobType: 'test_and_repair',
        dateReceived: '2026-10-20',
        // TR-PARTS-1 (0041): the first part in the old columns, three more in more_repair_items.
        repairItem: { partNumber: 'BRG-001', description: 'Bearing', quantity: 2 },
        moreRepairItems: [
          { partNumber: 'SK-010', description: 'Seal kit', quantity: 1 },
          { partNumber: 'SNS-004', description: 'Sensor', quantity: 3 },
          { partNumber: 'CPL-002', description: 'Coupling', quantity: 1 },
        ],
      }),
    );
    expect(saved.dateReceived).toBe('2026-10-20');
    expect(saved.moreRepairItems).toHaveLength(3);
    expect((await jobs.list()).filter((job) => job.jobType === 'test_and_repair')).toHaveLength(1);
  });

  /*
   * 0037–0039: an absence reason, a Workshop line with a call-out amount and
   * kilometres, a period SENT to the office, an ACCEPTED correction of it, and
   * an issued Delivery Note. Phase 2 has the live code (ef0f695) meet them.
   */
  it('writes the timesheet, attendance and delivery-note rows only this release can (0037–0039)', async () => {
    const attendance = new PostgresAttendanceRepository(db);
    const T = ROLLBACK_TIMESHEET;
    const tech = asUserId(IDS.technician);
    await attendance.saveRecord({
      id: crypto.randomUUID(), userId: tech, date: T.absentDay, status: 'absent', absenceReason: 'sick_leave',
      note: '', recordedBy: asUserId(IDS.master), recordedAt: '2026-10-20T08:00:00.000Z',
    });
    const entry = (id: string, over: Partial<TimesheetEntry>): TimesheetEntry => ({
      id, userId: tech, date: '2026-10-21', customerId: null, customerName: '', workshop: false,
      normalHours: 0, overtimeHours: 2, doubleHours: 0, callouts: 0, calloutAmount: 0, calloutShared: false,
      internalKm: 0, customerKm: 0, updatedBy: tech, updatedAt: '2026-10-21T17:00:00.000Z', ...over,
    });
    const workshop = await attendance.saveEntry(entry(T.workshopLine, { workshop: true, internalKm: 12.5 }));
    const customer = await attendance.saveEntry(entry(T.customerLine, {
      date: '2026-10-22', customerId: asCustomerId(IDS.customer), customerName: 'Test customer',
      calloutAmount: 50000, calloutShared: true, customerKm: 40,
    }));
    const snapshot = { technicianName: 'Sipho', from: '2026-10-19', to: '2026-10-25', comment: 'Sent.', entries: [workshop, customer] };
    const sent = await attendance.submitPeriod({
      id: T.period, userId: tech, from: '2026-10-19', to: '2026-10-25', comment: 'Sent.', updatedBy: tech,
      updatedAt: '2026-10-26T08:00:00.000Z', submittedAt: '2026-10-26T08:00:00.000Z', submittedBy: tech, snapshot,
    });
    expect(sent?.submittedAt).not.toBeNull();
    const asked = await attendance.createCorrection({
      id: T.correction, periodId: T.period, userId: tech, sequence: 1, reason: 'OT was 3',
      before: snapshot, after: { ...snapshot, entries: [{ ...workshop, overtimeHours: 3 }, customer] },
      requestedBy: tech, requestedAt: '2026-10-27T08:00:00.000Z', status: 'pending', decidedBy: null, decidedAt: null, decisionNote: '',
    });
    expect(asked?.status).toBe('pending');
    const accepted = await attendance.decideCorrection({
      id: T.correction, status: 'accepted', decidedBy: asUserId(IDS.master), decidedAt: '2026-10-27T09:00:00.000Z', decisionNote: '',
    });
    expect(accepted?.status).toBe('accepted');

    const job = (await new PostgresJobRepository(db).list()).find((candidate) => candidate.jobType === 'test_and_repair');
    const note = await new PostgresDeliveryNoteRepository(db).record({
      id: T.deliveryNote, jobId: asJobId(job!.id), fileName: 'delivery-note.pdf', storageKey: 'documents/rollback-delivery-note.pdf',
      pageCount: 1, sizeBytes: 100, checksumSha256: null, generatedAt: '2026-10-27T10:00:00.000Z', generatedBy: tech,
      jobCardDocumentKey: 'documents/rollback-job-card.pdf', signedByName: 'Johan Courier', signedAt: '2026-10-27T10:00:00.000Z',
      signatureSha256: 'a'.repeat(64),
    });
    expect(note.jobId).toBe(job!.id);
  });

  /*
   * 0040: a technician's name on documents, the Finance recipient, a sent
   * September period with its monthly submission, and a SENT Finance package.
   * Phase 2 has the live code (1a34d1c) meet them.
   */
  it('writes the integration rows only this release can (0042)', async () => {
    const I = ROLLBACK_INTEGRATIONS;
    const job = (await new PostgresJobRepository(db).list()).find((candidate) => candidate.jobType === 'test_and_repair')!;
    await db.execute(sql`
      update sites set latitude = -26.2745, longitude = 28.198, location_status = 'resolved', location_source = 'geocoded',
        geocode_query = '3 Wadeville Boulevard, Germiston, South Africa', geocoded_address = '3 Wadeville Blvd, Germiston (rollback fixture)',
        geocode_provider = 'google', geocode_precision = 'ROOFTOP', geocoded_at = now(), suggested_latitude = -26.27, suggested_longitude = 28.19
       where id = ${IDS.site}`);
    await db.execute(sql`insert into email_templates (id, event, job_type, name, active, is_default, current_version, system_key)
      values (${I.template}, 'signed_job_card', 'test_and_repair', 'Rollback template', true, true, 1, 'signed_job_card:test_and_repair')`);
    await db.execute(sql`insert into email_template_versions (id, template_id, version, subject, body)
      values (${I.templateVersion}, ${I.template}, 1, '{{job_number}} — {{document_title}} — Test & Repair', 'Good day {{customer_name}}')`);
    await db.execute(sql`insert into email_messages (id, idempotency_key, event, job_id, template_id, template_version_id, template_name, template_version,
        sender, recipient, subject, body, state, attempts, sent_at, provider_request_id, created_at, updated_at)
      values (${I.email}, 'signed_job_card:rollback', 'signed_job_card', ${job.id}, ${I.template}, ${I.templateVersion}, 'Rollback template', 1,
        'sales@ejeie.co.za', 'customer@example.test', 'EJE-ROLLBACK — Signed Job Card — Test & Repair', 'Good day', 'sent', 1, now(), 'graph-request:rollback', now(), now())`);
    await db.execute(sql`insert into outbox_messages (id, channel, template, recipient, parameters, preview, job_id, state, attempts, provider_message_id,
        created_at, purpose, delivery_status, delivered_at)
      values (${I.outbox}, 'whatsapp', 'eje_job_assigned', '27820000000', '[]'::jsonb, '', ${job.id}, 'sent', 1, 'wamid.rollback', now(), 'assignment', 'delivered', now())`);
    // The guard holds: a sent email cannot be changed.
    await expect(db.execute(sql`update email_messages set subject = 'changed' where id = ${I.email}`)).rejects.toThrow();
  });

  it('writes the monthly payroll rows only this release can (0040)', async () => {
    const T = ROLLBACK_TIMESHEET;
    const tech = asUserId(IDS.technician);
    const users = new PostgresUserRepository(db);
    const stored = await users.findById(tech);
    await users.save({ ...stored!, documentName: 'SM' });
    const settings = new PostgresSettingsRepository(db);
    await settings.save({ ...(await settings.get()), financeEmail: 'payroll@finance.example.test' });

    const attendance = new PostgresAttendanceRepository(db);
    const snapshot = { technicianName: 'Sipho', from: '2026-09-01', to: '2026-09-30', comment: '', entries: [] };
    const sent = await attendance.submitPeriod({
      id: T.monthPeriod, userId: tech, from: '2026-09-01', to: '2026-09-30', comment: '', updatedBy: tech,
      updatedAt: '2026-10-01T08:00:00.000Z', submittedAt: '2026-10-01T08:00:00.000Z', submittedBy: tech, snapshot,
    });
    expect(sent?.submittedAt).not.toBeNull();
    const payroll = new PostgresPayrollRepository(db);
    const submission = await payroll.createSubmission({
      id: T.submission, userId: tech, month: '2026-09', timesheetPeriodId: T.monthPeriod,
      attendance: { technicianName: 'Sipho', month: '2026-09', days: [] },
      submittedAt: '2026-10-01T08:00:00.000Z', submittedBy: tech,
    });
    expect(submission?.month).toBe('2026-09');
    const attachment = (kind: 'timesheet' | 'attendance', fileName: string) => ({
      technicianId: tech, technicianName: 'Sipho', kind, fileName, storageKey: `finance-packages/${T.financePackage}/${fileName}`,
      sha256: 'b'.repeat(64), sizeBytes: 1000, pageCount: 1, versionLabel: 'Original submission', correctedResend: false,
    });
    const prepared = await payroll.createPackage({
      id: T.financePackage, month: '2026-09', status: 'prepared', recipient: 'payroll@finance.example.test',
      attachments: [attachment('timesheet', 'SM TIMESHEET SEP.pdf'), attachment('attendance', 'SM ATTEN SEPTEMBER.pdf')],
      totalBytes: 2000, preparedBy: asUserId(IDS.coordinator), preparedAt: '2026-10-02T08:00:00.000Z',
      sentBy: null, sendStartedAt: null, sentAt: null, providerMessageId: null, providerState: null, failureReason: '', failureKind: null, attempts: 0,
    });
    expect(prepared?.status).toBe('prepared');
    await payroll.transitionPackage(T.financePackage, ['prepared'], 'sending', { sentBy: asUserId(IDS.coordinator), sendStartedAt: '2026-10-02T08:01:00.000Z', attempts: 1 });
    const done = await payroll.transitionPackage(T.financePackage, ['sending'], 'sent', {
      sentAt: '2026-10-02T08:01:05.000Z', providerMessageId: 'rollback-probe', providerState: 'pending_delivery',
    });
    expect(done?.status).toBe('sent');
  });

  /*
   * 0043 (TS-ROLE-1, 1 November 2026): the rows only this release can write —
   * a Coordinator's month submitted as attendance ONLY (no timesheet period),
   * and a Finance package carrying that one PDF.
   */
  it('writes a Coordinator’s attendance-only month and a one-file package (0043)', async () => {
    const coordinator = asUserId(IDS.coordinator);
    const payroll = new PostgresPayrollRepository(db);
    const submission = await payroll.createSubmission({
      id: '00000000-0000-4000-8000-0000000004f1', userId: coordinator, month: '2026-09', timesheetPeriodId: null,
      attendance: { technicianName: 'Christene', month: '2026-09', days: [] },
      submittedAt: '2026-10-01T09:00:00.000Z', submittedBy: coordinator,
    });
    expect(submission?.timesheetPeriodId).toBeNull();
    const prepared = await payroll.createPackage({
      id: '00000000-0000-4000-8000-0000000004f2', month: '2026-08', status: 'prepared', recipient: 'payroll@finance.example.test',
      attachments: [{
        technicianId: coordinator, technicianName: 'Christene', kind: 'attendance', fileName: 'CB ATTEN AUGUST.pdf',
        storageKey: 'finance-packages/00000000-0000-4000-8000-0000000004f2/01-attendance.pdf',
        sha256: 'c'.repeat(64), sizeBytes: 900, pageCount: 1, versionLabel: 'As submitted', correctedResend: false,
      }],
      totalBytes: 900, preparedBy: asUserId(IDS.master), preparedAt: '2026-10-02T09:00:00.000Z',
      sentBy: null, sendStartedAt: null, sentAt: null, providerMessageId: null, providerState: null, failureReason: '', failureKind: null, attempts: 0,
    });
    expect(prepared?.attachments).toHaveLength(1);
  });

  /*
   * 0047, which the live release (b3a9014) has never heard of: an Apprentice,
   * a customer on Custom Rates, a document chosen for the customer email, a
   * QUEUED email carrying it, an approved day swap and its notification. The
   * probe records what the old code makes of each — read, ignored or hidden.
   */
  it('writes the rows only this release can (0047): apprentice, Custom Rates, email documents, day swaps', async () => {
    const B = ROLLBACK_0047;
    const at = '2027-02-20T08:00:00.000Z';
    await db.execute(sql`insert into users (id, first_name, last_name, initials, email, role)
      values (${B.apprentice}, 'Ayanda', 'Apprentice', 'AA', 'ayanda@example-test.co.za', 'apprentice')`);

    const customers = new PostgresCustomerRepository(db);
    const customer = (await customers.findById(asCustomerId(IDS.customer)))!;
    await customers.save({ ...customer, rateMode: 'custom' });
    await customers.saveCustomRates({
      customerId: asCustomerId(IDS.customer),
      labourRates: { normal: 100000, overtime: 150000, double: 200000 },
      calloutRate: 80000, testBenchFee: 40000, kilometreRate: 2000, vatPercentage: 15,
      updatedBy: IDS.master, updatedAt: at,
    });

    const job = (await new PostgresJobRepository(db).list()).find((candidate) => candidate.jobType === 'test_and_repair')!;
    await db.execute(sql`insert into job_media (id, job_id, kind, file_name, storage_key, content_type, size_bytes, uploaded_at, uploaded_by, email_to_customer)
      values (${B.document}, ${job.id}, 'document', 'Customer order.pdf', 'uploads/rollback-order', 'application/pdf', 1200, ${at}, ${IDS.master}, true)`);
    await db.execute(sql`insert into email_messages (id, idempotency_key, event, job_id, recipient, subject, body, state, created_at, updated_at, attachment_storage_key, attachment_file_name, extra_attachments)
      values (${B.queuedEmail}, 'signed_job_card:rollback-0047', 'signed_job_card', ${job.id}, 'customer@example.test', 'EJE-ROLLBACK — Signed Job Card', 'Good day', 'queued', now(), now(), 'documents/rollback-0047.pdf', 'EJE-ROLLBACK.pdf',
        ${JSON.stringify([{ storageKey: 'uploads/rollback-order', fileName: 'Customer order.pdf', sha256: null }])}::jsonb)`);

    const standby = new PostgresStandbyRepository(db);
    for (const userId of [IDS.technician, IDS.otherTechnician]) {
      await standby.saveEligibility({ userId: asUserId(userId), main: true, helper: false, apprentice: false, updatedBy: asUserId(IDS.master), updatedAt: at });
    }
    await standby.saveEligibility({ userId: asUserId(B.apprentice), main: false, helper: false, apprentice: true, updatedBy: asUserId(IDS.master), updatedAt: at });
    const week = (weekStart: string, main: string): StandbyWeek => ({
      id: crypto.randomUUID(), weekStart, status: 'draft', publishedBy: null, publishedAt: null, createdBy: asUserId(IDS.master), createdAt: at,
      assignments: STANDBY_POSITIONS.map((position) => {
        const holder = position === 'main' ? main : position === 'apprentice_1' ? B.apprentice : null;
        return { position, userId: holder === null ? null : asUserId(holder), assignedBy: holder === null ? null : asUserId(IDS.master), assignedAt: holder === null ? null : at };
      }),
    });
    await standby.createWeeks([week(B.weekA, IDS.technician), week(B.weekB, IDS.otherTechnician)]);
    await standby.publishWeeks([B.weekA, B.weekB], asUserId(IDS.master), at);
    // The two stages, then the Office's approval writing exactly the two Saturdays.
    const pairs = JSON.stringify([{ requesterDate: B.saturdayA, requesterPosition: 'main', recipientDate: B.saturdayB, recipientPosition: 'main' }]);
    await db.execute(sql`insert into standby_day_swaps (id, kind, requester_id, recipient_id, pairs, reason, requested_at)
      values (${B.daySwap}, 'main', ${IDS.technician}, ${IDS.otherTechnician}, ${pairs}::jsonb, 'Wedding', ${at})`);
    await db.execute(sql`update standby_day_swaps set status = 'awaiting_office', recipient_decided_at = ${at} where id = ${B.daySwap}`);
    await db.execute(sql`insert into standby_day_overrides (id, date, position, user_id, swap_id) values
      (${B.overrideA}, ${B.saturdayA}, 'main', ${IDS.otherTechnician}, ${B.daySwap}),
      (${B.overrideB}, ${B.saturdayB}, 'main', ${IDS.technician}, ${B.daySwap})`);
    await db.execute(sql`update standby_day_swaps set status = 'approved', office_decided_by = ${IDS.coordinator}, office_decided_at = ${at} where id = ${B.daySwap}`);
    await db.execute(sql`insert into notifications (id, recipient_id, type, title, body, link, channels)
      values (${B.notification}, ${IDS.technician}, 'standby_day_swap_decided', 'Standby day swap approved', 'Saturday 6 March is now Riaan''s.', '/standby', '{in_app}')`);

    const [counts] = await db.execute<{ rates: string; overrides: string }>(sql`select
      (select count(*) from customer_rates)::text as rates, (select count(*) from standby_day_overrides)::text as overrides`);
    expect(counts).toEqual({ rates: '1', overrides: '2' });
  });

  /*
   * 0048, which the live release (9569c85) has never heard of: a Delivery Note
   * still being completed (its part line carries a comment), an overlapping
   * timesheet submission that superseded an earlier one, and a Senior Tech in
   * a main standby place.
   */
  it('writes the rows only this release can (0048): a Delivery Note, a superseded timesheet, a Senior Tech on standby', async () => {
    const B = ROLLBACK_0048;
    const at = '2027-02-21T08:00:00.000Z';
    const jobs = new PostgresJobRepository(db);
    const allocated = await jobs.allocateJobNumber();
    await jobs.save(
      jobFixture(allocated.jobNumber, {
        id: asJobId(B.deliveryNoteJob),
        jobType: 'delivery_note',
        status: 'completion',
        primaryTechnicianId: null,
        deliveryDate: '2027-02-21',
        parts: [{ id: asLineItemId(B.partLine), partNumber: 'LU-200', description: 'Loan servo drive', quantity: 1, unitPrice: 0, comment: 'Loan unit', capturedAt: at, capturedBy: asUserId(IDS.coordinator) }],
      }),
    );
    const attendance = new PostgresAttendanceRepository(db);
    const tech = asUserId(IDS.technician);
    const period = (id: string, from: string, to: string) => ({
      id, userId: tech, from, to, comment: '', updatedBy: tech, updatedAt: at, submittedAt: at, submittedBy: tech,
      snapshot: { technicianName: 'Sipho Mahlangu', from, to, comment: '', entries: [] },
    });
    await attendance.submitPeriod(period(B.earlyPeriod, '2027-01-01', '2027-01-31'));
    // The later submission covers every day of the earlier one (TS-PAPER-7: only then is it replaced).
    await attendance.supersedeOverlappingPeriods({ userId: tech, from: '2027-01-01', to: '2027-02-14', exceptId: null, at, by: tech });
    await attendance.submitPeriod(period(B.latePeriod, '2027-01-01', '2027-02-14'));
    const standby = new PostgresStandbyRepository(db);
    await standby.saveEligibility({ userId: asUserId(IDS.master), main: true, helper: true, apprentice: false, updatedBy: asUserId(IDS.coordinator), updatedAt: at });
    await standby.createWeeks([{
      id: crypto.randomUUID(), weekStart: B.standbyWeek, status: 'draft', publishedBy: null, publishedAt: null, createdBy: asUserId(IDS.master), createdAt: at,
      assignments: STANDBY_POSITIONS.map((position) => ({
        position,
        userId: position === 'main' ? asUserId(IDS.master) : null,
        assignedBy: position === 'main' ? asUserId(IDS.master) : null,
        assignedAt: position === 'main' ? at : null,
      })),
    }]);
    const [state] = await db.execute<{ comment: string; superseded: string }>(sql`select
      (select comment from job_parts where id = ${B.partLine}) as comment,
      (select count(*) from timesheet_periods where superseded_at is not null)::text as superseded`);
    expect(state).toEqual({ comment: 'Loan unit', superseded: '1' });
  });

  /*
   * 0049, which the live release (6ec5655) has never heard of: a Delivery Note
   * raised WITHOUT a site, and a Test & Repair job carrying the office's
   * internal delivery-note reference photo.
   */
  it('writes the rows only this release can (0049): a site-less Delivery Note, a delivery-note reference photo', async () => {
    const B = ROLLBACK_0049;
    const at = '2027-02-22T08:00:00.000Z';
    const jobs = new PostgresJobRepository(db);
    await jobs.save(jobFixture((await jobs.allocateJobNumber()).jobNumber, {
      id: asJobId(B.siteLessNote), jobType: 'delivery_note', status: 'completion', primaryTechnicianId: null, siteId: null, deliveryDate: '2027-02-22',
    }));
    // On phase 1's one Test & Repair job (the probe counts exactly one).
    const repair = (await jobs.list()).find((candidate) => candidate.jobType === 'test_and_repair')!;
    await jobs.save({
      ...repair,
      photos: [{
        id: asAttachmentId(B.referencePhoto), kind: 'photo', visibility: 'internal', purpose: 'delivery_note_reference', fileName: 'delivery-note.jpg',
        caption: 'Delivery note (reference)', storageKey: 'uploads/rollback-dn', uploadedAt: at, uploadedBy: asUserId(IDS.coordinator), sizeBytes: 10, checksumSha256: null, provenance: 'genuine',
      }],
    });
    const [state] = await db.execute<{ site: string | null; purpose: string }>(sql`select
      (select site_id::text from jobs where id = ${B.siteLessNote}) as site,
      (select purpose from job_media where id = ${B.referencePhoto}) as purpose`);
    expect(state).toEqual({ site: null, purpose: 'delivery_note_reference' });
  });

  /*
   * 0050, which the live release (89668e8) has never heard of: a submitted
   * timesheet longer than 92 days, the open sheet's comment, and a
   * technician's month submitted as attendance only (TS-PAPER).
   */
  it('writes the rows only this release can (0050): a 152-day submission, a working comment, an attendance-only month', async () => {
    const B = ROLLBACK_0050;
    const tech = asUserId(IDS.technician);
    const attendance = new PostgresAttendanceRepository(db);
    const at = '2027-09-01T08:00:00.000Z';
    const sent = await attendance.submitPeriod({
      id: B.longPeriod, userId: tech, from: B.longFrom, to: B.longTo, comment: 'Long period', updatedBy: tech, updatedAt: at,
      submittedAt: at, submittedBy: tech, snapshot: { technicianName: 'Sipho', from: B.longFrom, to: B.longTo, comment: 'Long period', entries: [] },
    });
    expect(sent?.submittedAt).not.toBeNull();
    await attendance.saveWorkingComment({ userId: tech, comment: 'Still filling it in', updatedBy: tech, updatedAt: at });
    const payroll = new PostgresPayrollRepository(db);
    const month = await payroll.createSubmission({
      id: B.attendanceOnlyMonth, userId: tech, month: B.month, timesheetPeriodId: null,
      attendance: { technicianName: 'Sipho', month: B.month, days: [] },
      submittedAt: at, submittedBy: tech,
    });
    expect(month?.timesheetPeriodId).toBeNull();
  });

  it('writes the rows only this release can (0051): a Lathe checklist chosen, a Fail before its note, readings in a row’s blanks', async () => {
    const B = ROLLBACK_0051;
    const tech = asUserId(IDS.technician);
    const jobs = new PostgresJobRepository(db);
    const answer = (itemId: string, over: { choice: 'pass' | 'fail'; fieldValues?: Record<string, string> }) => ({
      itemId, choice: over.choice, yesNo: null, measurement: null, text: '', notes: '',
      fieldValues: over.fieldValues ?? {}, photos: [], answeredAt: '2027-10-01T08:00:00.000Z', answeredBy: tech,
    });
    const job = async (id: string, jobType: 'service' | 'installation', checklist: string, kind: string, responses: ReturnType<typeof answer>[]) => {
      const allocated = await jobs.allocateJobNumber();
      await jobs.save(jobFixture(allocated.jobNumber, {
        id: asJobId(id), jobType, status: 'in_progress', primaryTechnicianId: tech,
        checklist: { templateId: checklist as never, templateVersion: '1.0', checklistKind: kind, responses, completedAt: null, completedBy: null },
      }));
    };
    await job(B.latheJob, 'service', B.latheChecklist, 'service_lathe', [answer(B.handwrittenRow, { choice: 'fail' })]);
    await job(B.installationJob, 'installation', B.installationChecklist, 'installation', [
      answer(B.voltageRow, { choice: 'pass', fieldValues: { r: '401', s: '399', t: '400' } }),
    ]);
    const [stored] = await db.execute<{ kind: string }>(sql`select checklist_kind as kind from checklist_instances where job_id = ${B.latheJob}`);
    expect(stored?.kind).toBe('service_lathe');
  });

  it('writes the rows only this release can (0052): a period submission replaced by one with the same dates, a PDF name, a draft line', async () => {
    const B = ROLLBACK_0052;
    const tech = asUserId(IDS.technician);
    const attendance = new PostgresAttendanceRepository(db);
    const payroll = new PostgresPayrollRepository(db);
    const at = '2028-01-26T08:00:00.000Z';
    const period = (id: string) => ({
      id, userId: tech, from: B.from, to: B.to, comment: '', updatedBy: tech, updatedAt: at, submittedAt: at, submittedBy: tech,
      snapshot: { technicianName: 'Sipho', from: B.from, to: B.to, comment: '', entries: [] },
    });
    const submission = (id: string, periodId: string) => ({
      id, userId: tech, from: B.from, to: B.to, financeMonth: '2028-01', timesheetRequired: true, timesheetPeriodId: periodId,
      attendance: { technicianName: 'Sipho', from: B.from, to: B.to, days: [] },
      fileNames: { timesheet: 'Sipho TS.pdf', attendance: 'Sipho Att.pdf' }, documents: [],
      submittedAt: at, submittedBy: tech, supersededAt: null, supersededBy: null, supersededBySubmission: null,
    });
    await attendance.submitPeriod(period(B.replacedPeriod));
    await payroll.createPayrollSubmission(submission(B.replacedSubmission, B.replacedPeriod));
    // The complete replacement, same dates, in ONE transaction as the application writes it (the
    // "replaced by" link is checked at commit): the first kept beside it, one CURRENT row per dates.
    await db.transaction(async (tx) => {
      const txAttendance = new PostgresAttendanceRepository(tx);
      const txPayroll = new PostgresPayrollRepository(tx);
      await txAttendance.supersedeOverlappingPeriods({ userId: tech, from: B.from, to: B.to, exceptId: null, at, by: tech });
      expect(await txAttendance.submitPeriod(period(B.currentPeriod))).not.toBeNull();
      await txPayroll.replacePayrollSubmissions({ userId: tech, ids: [B.replacedSubmission], at, by: tech, bySubmission: B.currentSubmission });
      expect(await txPayroll.createPayrollSubmission(submission(B.currentSubmission, B.currentPeriod))).not.toBeNull();
    });
    await payroll.saveDocumentName({ userId: tech, kind: 'timesheet', fileName: 'Sipho Ünïcode.pdf', updatedBy: tech, updatedAt: at });
    await attendance.saveLineDraft({
      id: B.draftLine, userId: tech, date: '2028-02-03', updatedBy: tech, updatedAt: at,
      typed: { pick: '', customerName: '', overtime: 'abc', double: '0', callout: '0', internalKm: '0', customerKm: '0' },
    });
    const periods = await db.execute<{ n: string }>(sql`select count(*)::text as n from timesheet_periods where period_from = ${B.from} and period_to = ${B.to}`);
    expect(periods[0]?.n).toBe('2');
  });

  it('writes the rows only this release can (0054): a completed form awaiting submission, and one submitted with its attendance', async () => {
    const B = ROLLBACK_0054;
    const tech = asUserId(IDS.technician);
    const payroll = new PostgresPayrollRepository(db);
    const at = '2028-04-26T08:00:00.000Z';
    const document = (kind: 'timesheet' | 'attendance') => ({ kind, fileName: `Sipho ${kind}.pdf`, storageKey: `payroll-completions/probe/${kind}.pdf`, sha256: 'b'.repeat(64), sizeBytes: 10, pageCount: 1 });
    expect(
      await payroll.createFormCompletion({
        id: B.awaiting, userId: tech, kind: 'timesheet', from: B.from, to: B.to, fileName: 'Sipho timesheet.pdf',
        timesheet: { comment: 'Completed for the probe.', entries: [] }, attendance: null, document: document('timesheet'),
        completedAt: at, completedBy: tech, submissionId: null,
      }),
    ).not.toBeNull();
    await payroll.createPayrollSubmission({
      id: B.submission, userId: tech, from: '2028-05-01', to: '2028-05-25', financeMonth: '2028-05', timesheetRequired: false, timesheetPeriodId: null,
      attendance: { technicianName: 'Sipho', from: '2028-05-01', to: '2028-05-25', days: [] },
      fileNames: { timesheet: '', attendance: 'Sipho attendance.pdf' }, documents: [],
      submittedAt: at, submittedBy: tech, supersededAt: null, supersededBy: null, supersededBySubmission: null,
    });
    expect(
      await payroll.createFormCompletion({
        id: B.submittedForm, userId: tech, kind: 'attendance', from: '2028-05-01', to: '2028-05-25', fileName: 'Sipho attendance.pdf',
        timesheet: null, attendance: [], document: document('attendance'), completedAt: at, completedBy: tech, submissionId: null,
      }),
    ).not.toBeNull();
    expect(await payroll.markFormsSubmitted([B.submittedForm], B.submission)).toBe(1);
    const forms = await db.execute<{ n: string }>(sql`select count(*)::text as n from payroll_form_completions`);
    expect(forms[0]?.n).toBe('2');
  });
});
