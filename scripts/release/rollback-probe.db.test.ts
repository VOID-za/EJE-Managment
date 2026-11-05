import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { createDatabase, type Database } from '@/db/client';
import { testDatabaseUrl } from '@/data/postgres/test-database';
import { IDS, jobFixture } from '@/data/postgres/test-fixtures';
import { PostgresDocumentRepository } from '@/data/postgres/document-repository';
import { PostgresJobRepository } from '@/data/postgres/job-repository';
import { describeSearchability } from '@/application/library-ocr';
import { checkMigrations } from '@/ops/preflight-rules';
import { asDocumentId, asUserId, type DocumentId, type TechnicalDocument } from '@/domain';
import { PostgresAttendanceRepository } from '@/data/postgres/attendance-repository';
import { PostgresUserRepository } from '@/data/postgres/user-repository';
import { PostgresSettingsRepository } from '@/data/postgres/settings-repository';
import { PostgresCustomerRepository } from '@/data/postgres/customer-repository';
import { PostgresOutboxRepository } from '@/data/postgres/outbox-repository';
import { PostgresPayrollRepository } from '@/data/postgres/payroll-repository';
import { asSiteId } from '@/domain';
// Each of these exists in f693747 (checked against that commit).
import { loadJobView } from '@/application/job-view';
import { readRepositories } from '@/data/backend';
import { documentPhotos } from '@/lib/job-card/model';
import { PostgresStandbyRepository } from '@/data/postgres/standby-repository';
import { PostgresNotificationRepository } from '@/data/postgres/notification-repository';
import { PostgresCustomerEmailRepository } from '@/data/postgres/integration-repositories';
import { asCustomerId, asJobId, can, getJobTypeDefinition, notificationCategory, roleLabel, type JobTypeCode, type UserRole } from '@/domain';

/**
 * ROLLBACK COMPATIBILITY, PHASE 2 OF 2: THE LIVE RELEASE'S OWN CODE.
 *
 * THIS FILE RUNS INSIDE A CHECKOUT OF THE LIVE RELEASE (ad0f3c8, v1.4.0), copied there
 * by `scripts/release/rollback-compat.sh`, so every `@/…` import below is the
 * LIVE code — the repository, the searchability wording and the preflight rule
 * as they are on the server today. It must therefore import only what exists
 * in ad0f3c8, and it does: each of these was checked against that commit.
 *
 * The database was migrated to the newest migration THIS release ships (0049)
 * and populated by it (phase 1). The question is the one a rollback asks: after
 * the migrations have run, does the old code still read and write — the
 * library, jobs, attendance, timesheets, corrections, monthly submissions and
 * Finance packages (0037–0040) and the extra parts booked in on a Test & Repair
 * job (0041), which it knows — beside the email templates, the customer email
 * outbox, WhatsApp delivery statuses and automatic site pins (0042) that it
 * knows — beside a Coordinator's month submitted WITHOUT a timesheet and a
 * one-file Finance package (0043), which it knows — beside the test bench
 * quantity on jobs (0044) and the standby calendar (0045), which it knows —
 * beside the PO number, the Awaiting Invoice No status, the replaceable
 * submissions and the activity retention guard (0046), which it knows — beside
 * the apprentice role, customers' rate option and Custom Rates, a document
 * chosen for the customer email, an email's extra attachments and the standby
 * day swaps (0047), and the Delivery Note, superseded timesheet submissions
 * and a Senior Tech on standby (0048), which it knows — beside a Delivery Note
 * with no site and the Test & Repair delivery-note photo (0049), which it has
 * never heard of?
 *
 * Skipped unless RELEASE_ROLLBACK_PHASE=probe, so it never runs by accident.
 */
const url = testDatabaseUrl();
const requested = process.env.RELEASE_ROLLBACK_PHASE === 'probe';
/*
 * ASKED FOR AND UNABLE TO RUN IS A FAILURE, NOT A SKIP. A skipped test exits 0,
 * so a CI step that ran nothing would look exactly like one that proved
 * rollback compatibility. rollback-compat.sh also refuses any run that reports
 * a skipped or zero passed test.
 */
if (requested && url === null) {
  throw new Error('RELEASE_ROLLBACK_PHASE=probe needs TEST_DATABASE_URL naming a disposable test database.');
}
const enabled = requested;
const describePhase = enabled ? describe : describe.skip;

// A copy of `src/ops/release/rollback-fixture.ts`, which the live release does
// not have; `rollback-fixture.test.ts` asserts the two are identical.
const DOCUMENTS = {
  indexed: '00000000-0000-4000-8000-0000000004a1',
  partial: '00000000-0000-4000-8000-0000000004a2',
  needsOcr: '00000000-0000-4000-8000-0000000004a3',
  failed: '00000000-0000-4000-8000-0000000004a4',
  coverageUnknown: '00000000-0000-4000-8000-0000000004a5',
} as const;
const WRITTEN_BY_OLD_CODE = '00000000-0000-4000-8000-0000000004b1';

// A copy of ROLLBACK_TIMESHEET in `src/ops/release/rollback-fixture.ts`.
const TIMESHEET = {
  absentDay: '2026-10-20',
  workshopLine: '00000000-0000-4000-8000-0000000005a1',
  customerLine: '00000000-0000-4000-8000-0000000005a2',
  period: '00000000-0000-4000-8000-0000000005b1',
  correction: '00000000-0000-4000-8000-0000000005c1',
  deliveryNote: '00000000-0000-4000-8000-0000000005d1',
  // 0040 (written for the 1a34d1c probe): a September period, its monthly submission, a Finance package.
  monthPeriod: '00000000-0000-4000-8000-0000000005e1',
  submission: '00000000-0000-4000-8000-0000000005e2',
  financePackage: '00000000-0000-4000-8000-0000000005e3',
} as const;

// A copy of ROLLBACK_INTEGRATIONS in `src/ops/release/rollback-fixture.ts`.
const INTEGRATIONS = {
  template: '00000000-0000-4000-8000-0000000006a1',
  templateVersion: '00000000-0000-4000-8000-0000000006a2',
  email: '00000000-0000-4000-8000-0000000006b1',
  outbox: '00000000-0000-4000-8000-0000000006c1',
} as const;

// A copy of ROLLBACK_0052 in `src/ops/release/rollback-fixture.ts`.
const BATCH_0052 = {
  replacedSubmission: '00000000-0000-4000-8000-000000000ca1',
  currentSubmission: '00000000-0000-4000-8000-000000000ca2',
  replacedPeriod: '00000000-0000-4000-8000-000000000cb1',
  currentPeriod: '00000000-0000-4000-8000-000000000cb2',
  draftLine: '00000000-0000-4000-8000-000000000cc1',
  from: '2028-01-01',
  to: '2028-01-25',
} as const;

// A copy of ROLLBACK_0051 in `src/ops/release/rollback-fixture.ts`.
const BATCH_0051 = {
  latheJob: '00000000-0000-4000-8000-000000000ba1',
  installationJob: '00000000-0000-4000-8000-000000000ba2',
  latheChecklist: 'a664c9a7-e7c9-527b-b920-d02c6bd7313f',
  installationChecklist: '69479130-a5bf-5041-a6ef-eb91dddab44b',
  handwrittenRow: '49ce73ee-0a1f-5e6f-b583-b8caccd634f3',
  voltageRow: 'f59a9e7a-1331-51c0-81b1-07019a1a8dc4',
} as const;

// A copy of ROLLBACK_0050 in `src/ops/release/rollback-fixture.ts`.
const BATCH_0050 = {
  longPeriod: '00000000-0000-4000-8000-000000000aa1',
  longFrom: '2027-04-01',
  longTo: '2027-08-31',
  attendanceOnlyMonth: '00000000-0000-4000-8000-000000000ab1',
  month: '2027-03',
} as const;

// A copy of ROLLBACK_0049 in `src/ops/release/rollback-fixture.ts`.
const BATCH_0049 = {
  siteLessNote: '00000000-0000-4000-8000-0000000009a1',
  referencePhoto: '00000000-0000-4000-8000-0000000009b2',
} as const;

// A copy of ROLLBACK_0048 in `src/ops/release/rollback-fixture.ts`.
const BATCH_0048 = {
  deliveryNoteJob: '00000000-0000-4000-8000-0000000008a1',
  partLine: '00000000-0000-4000-8000-0000000008a2',
  earlyPeriod: '00000000-0000-4000-8000-0000000008b1',
  latePeriod: '00000000-0000-4000-8000-0000000008b2',
  standbyWeek: '2027-04-05',
} as const;

// A copy of ROLLBACK_0047 in `src/ops/release/rollback-fixture.ts`.
const BATCH_0047 = {
  apprentice: '00000000-0000-4000-8000-0000000007a1',
  document: '00000000-0000-4000-8000-0000000007b1',
  queuedEmail: '00000000-0000-4000-8000-0000000007c1',
  daySwap: '00000000-0000-4000-8000-0000000007d1',
  overrideA: '00000000-0000-4000-8000-0000000007d2',
  overrideB: '00000000-0000-4000-8000-0000000007d3',
  notification: '00000000-0000-4000-8000-0000000007e1',
  weekA: '2027-03-01',
  weekB: '2027-03-08',
  saturdayA: '2027-03-06',
  saturdayB: '2027-03-13',
} as const;

const id = (value: string): DocumentId => asDocumentId(value);

describePhase('rollback compatibility — phase 2: the live release (42e71fc) against a database at 0042', () => {
  let db: Database;
  let repository: PostgresDocumentRepository;

  beforeAll(() => {
    db = createDatabase({ connectionString: url ?? '', maxConnections: 2 });
    repository = new PostgresDocumentRepository(db);
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });

  it("the live release's preflight does not refuse the database this release migrated", async () => {
    const journal = JSON.parse(
      readFileSync(join(process.cwd(), 'src/db/migrations/meta/_journal.json'), 'utf8'),
    ) as { entries: { tag: string }[] };
    const shipped = journal.entries.map((entry) => entry.tag);
    // ad0f3c8 (v1.4.0) shipped up to 0051; this release adds 0052.
    expect(shipped).toHaveLength(52);
    expect(shipped.at(-1)).toBe('0051_source_checklists');
    expect(shipped).not.toContain('0052_payroll_submissions');

    const rows = await db.execute<{ n: string }>(sql`select count(*)::text as n from drizzle.__drizzle_migrations`);
    const applied = Number(rows[0]?.n);
    // 0052 applied beyond what the live release ships.
    expect(applied).toBe(53);

    const checks = checkMigrations(shipped, { applied, schemaPresent: true });
    expect(checks.every((check) => check.verdict !== 'fail')).toBe(true);
  });

  it('reads every indexing state the new release wrote', async () => {
    const all = await repository.listTextIndexes(Object.values(DOCUMENTS).map(id));
    expect(all).toHaveLength(5);
    expect((await repository.findTextIndex(id(DOCUMENTS.indexed)))?.state).toBe('indexed');
    expect((await repository.findTextIndex(id(DOCUMENTS.partial)))?.pagesIndexed).toBe(7);
    expect((await repository.findTextIndex(id(DOCUMENTS.needsOcr)))?.state).toBe('needs_ocr');
    expect((await repository.findTextIndex(id(DOCUMENTS.failed)))?.state).toBe('failed');
  });

  it('reads the "coverage unknown" row without error, and still calls it searchable', async () => {
    const unknown = await repository.findTextIndex(id(DOCUMENTS.coverageUnknown));
    expect(unknown?.state).toBe('partially_indexed');
    expect(unknown?.pagesIndexed).toBe(0);
    /*
     * The live wording for 0 of M is "Searchable — 0 of 214 pages": a
     * cosmetic understatement for as long as a rolled-back release runs, and
     * recorded as such in docs/deploy-next-release.md. What matters is that it
     * does not throw and does not call the document unsearchable.
     */
    const said = describeSearchability(unknown, null);
    expect(said.searchable).toBe(true);
  });

  it('still SEARCHES the library, the "coverage unknown" document included', async () => {
    const candidates = Object.values(DOCUMENTS).map(id);
    expect(await repository.searchTextIds(['coolant', '2071'], candidates, 10)).toEqual([
      id(DOCUMENTS.coverageUnknown),
    ]);
    const spindle = await repository.searchTextIds(['spindle'], candidates, 10);
    expect([...spindle].sort()).toEqual([id(DOCUMENTS.indexed), id(DOCUMENTS.partial)].sort());
    const pages = await repository.findPageMatches(id(DOCUMENTS.partial), ['spindle'], 10);
    expect(pages.map((page) => page.pageNumber).sort((a, b) => a - b)).toEqual([1, 2, 3, 5, 6, 8, 9]);
  });

  it('still WRITES: a new document indexed by the live code is accepted under the 0030 rule', async () => {
    const document: TechnicalDocument = {
      id: id(WRITTEN_BY_OLD_CODE),
      name: 'Indexed by the live release after a rollback',
      description: '',
      documentType: 'service_manual',
      manufacturer: 'Leadwell',
      machineModel: 'V40',
      version: '1.0',
      status: 'current',
      fileName: 'rolled-back.pdf',
      fileSizeBytes: 1024,
      checksumSha256: null,
      pageCount: 4,
      storageKey: `uploads/${WRITTEN_BY_OLD_CODE}`,
      provenance: 'genuine',
      uploadedAt: '2026-10-25T09:00:00.000Z',
      uploadedBy: asUserId(IDS.master),
      tags: [],
    };
    await repository.save(document);
    const content = 'Three pages of text and one diagram.';
    const saved = await repository.saveTextIndex(
      {
        documentId: id(WRITTEN_BY_OLD_CODE),
        state: 'partially_indexed',
        source: 'text_layer',
        extractedAt: '2026-10-25T09:00:00.000Z',
        characters: content.length,
        pages: 4,
        pagesIndexed: 3,
        truncated: false,
        unreadableStreams: 0,
        failureReason: 'No text could be read from page 3.',
      },
      content,
      [1, 2, 4].map((pageNumber) => ({
        documentId: id(WRITTEN_BY_OLD_CODE),
        pageNumber,
        source: 'text_layer' as const,
        characters: content.length,
        content,
      })),
    );
    expect(saved.pagesIndexed).toBe(3);

    // And re-indexing the new release's "coverage unknown" row as the live code
    // would (a whole reading) is accepted too.
    const reindexed = await repository.saveTextIndex(
      {
        documentId: id(DOCUMENTS.coverageUnknown),
        state: 'indexed',
        source: 'text_layer',
        extractedAt: '2026-10-25T09:05:00.000Z',
        characters: content.length,
        pages: 214,
        pagesIndexed: 214,
        truncated: false,
        unreadableStreams: 0,
        failureReason: '',
      },
      content,
    );
    expect(reindexed.state).toBe('indexed');
  });

  /*
   * 0031 ADDED `jobs.date_received`. The live release knows nothing of the
   * column: it must still read a job this release wrote WITH one, and still
   * write a job of its own — leaving the column NULL, which is "not recorded".
   */
  /*
   * 0042. The live release has never heard of a site's automatic pin, the
   * email templates, the customer email outbox or a WhatsApp delivery status.
   * After a rollback it must still read and save the site — its own save
   * leaving the pin's record alone — read the WhatsApp outbox, and leave the
   * email history exactly as it was.
   */
  it('still reads and saves SITES, reads the WhatsApp outbox, and leaves the email history alone, at 0042', async () => {
    const customers = new PostgresCustomerRepository(db);
    const site = await customers.findSiteById(asSiteId(IDS.site));
    expect(site?.latitude).toBe(-26.2745);
    await customers.saveSite({ ...site!, accessNotes: 'Saved by the live release' });
    const [pin] = await db.execute<{ status: string; formatted: string; notes: string }>(
      sql`select location_status as status, geocoded_address as formatted, access_notes as notes from sites where id = ${IDS.site}`,
    );
    expect(pin).toEqual({ status: 'resolved', formatted: '3 Wadeville Blvd, Germiston (rollback fixture)', notes: 'Saved by the live release' });

    const outbox = await new PostgresOutboxRepository(db).list(10);
    expect(outbox.find((message) => message.id === INTEGRATIONS.outbox)?.state).toBe('sent');

    const [email] = await db.execute<{ state: string; subject: string }>(
      sql`select state, subject from email_messages where id = ${INTEGRATIONS.email}`,
    );
    expect(email).toEqual({ state: 'sent', subject: 'EJE-ROLLBACK — Signed Job Card — Test & Repair' });
  });

  it('still reads and writes JOBS on a database with 0031 and 0041 applied', async () => {
    const jobs = new PostgresJobRepository(db);
    // Phase 1's job: the only Test & Repair, written WITH a date received.
    const written = (await jobs.list()).filter((job) => job.jobType === 'test_and_repair');
    expect(written).toHaveLength(1);
    const found = await jobs.findByJobNumber(written[0]!.jobNumber);
    expect(found?.jobType).toBe('test_and_repair');

    /*
     * 0041: the job carries FOUR parts booked in. The live code reads the first
     * exactly as it always did — it is in the three columns it knows — and
     * saving the job through the live code leaves the other three untouched,
     * so they are all still there when this release returns.
     */
    expect(found?.repairItem).toEqual({ partNumber: 'BRG-001', description: 'Bearing', quantity: 2 });
    await jobs.save({ ...found!, referenceNumber: 'REF-ROLLED-BACK' });
    const [parts] = await db.execute<{ more: unknown; reference: string }>(
      sql`select more_repair_items as more, reference_number as reference from jobs where job_number = ${written[0]!.jobNumber}`,
    );
    expect(parts?.reference).toBe('REF-ROLLED-BACK');
    expect(parts?.more).toEqual([
      { partNumber: 'SK-010', description: 'Seal kit', quantity: 1 },
      { partNumber: 'SNS-004', description: 'Sensor', quantity: 3 },
      { partNumber: 'CPL-002', description: 'Coupling', quantity: 1 },
    ]);

    // And one of its own, numbered from the sequence as the live code numbers jobs.
    const allocated = await jobs.allocateJobNumber();
    await jobs.save(jobFixture(allocated.jobNumber));
    expect((await jobs.findByJobNumber(allocated.jobNumber))?.jobNumber).toBe(allocated.jobNumber);
    const [row] = await db.execute<{ date_received: string | null }>(
      sql`select date_received from jobs where job_number = ${allocated.jobNumber}`,
    );
    expect(row?.date_received ?? null).toBeNull();
  });

  /*
   * 0037–0039. The live release has never heard of absence reasons, Workshop,
   * call-out amounts, kilometres, sent periods, corrections or Delivery Notes.
   * After a rollback it must still read the register and the timesheet lines,
   * and still write its own — the new columns take their defaults, and the
   * new tables are left alone.
   */
  it('still reads and writes ATTENDANCE and TIMESHEET LINES on a database at 0040', async () => {
    const attendance = new PostgresAttendanceRepository(db);
    const tech = asUserId(IDS.technician);
    const records = await attendance.listRecords(TIMESHEET.absentDay, TIMESHEET.absentDay, tech);
    expect(records.map((record) => record.status)).toEqual(['absent']);
    // An absent day of its own, with no reason (the old screen asks for none): accepted.
    // Written in 1a34d1c's OWN shapes (the live release knows absence reasons,
    // Workshop and kilometres; it does not know the monthly lock of 0040, so a
    // day inside a submitted month is writable under it — recorded in
    // docs/deploy-next-release.md as a rollback limit).
    const own = await attendance.saveRecord({
      id: crypto.randomUUID(), userId: tech, date: '2026-10-23', status: 'absent', absenceReason: 'leave', note: 'rolled back',
      recordedBy: asUserId(IDS.master), recordedAt: '2026-10-23T08:00:00.000Z',
    });
    expect(own.status).toBe('absent');

    const lines = await attendance.listEntries(tech, '2026-10-19', '2026-10-25');
    expect(lines.map((line) => line.id).sort()).toEqual([TIMESHEET.workshopLine, TIMESHEET.customerLine].sort());
    // A line of its own, as its screen writes one.
    const written = await attendance.saveEntry({
      id: crypto.randomUUID(), userId: tech, date: '2026-10-28', customerId: null, customerName: 'Written after a rollback',
      workshop: false, normalHours: 0, overtimeHours: 1, doubleHours: 0, callouts: 0, calloutAmount: 0, calloutShared: false,
      internalKm: 0, customerKm: 12.5, updatedBy: tech, updatedAt: '2026-10-28T17:00:00.000Z',
    });
    expect(written.customerKm).toBe(12.5);
    const [stored] = await db.execute<{ workshop: boolean; callout_amount_cents: number; customer_km: string }>(
      sql`select workshop, callout_amount_cents, customer_km from timesheet_entries where id = ${written.id}`,
    );
    expect(stored).toMatchObject({ workshop: false, callout_amount_cents: 0 });
    expect(Number(stored?.customer_km)).toBe(12.5);

    // What the live release cannot see stays exactly as written.
    const [sent] = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from timesheet_periods where id = ${TIMESHEET.period} and submitted_at is not null`,
    );
    expect(sent?.n).toBe('1');
    const [correction] = await db.execute<{ status: string }>(
      sql`select status from timesheet_corrections where id = ${TIMESHEET.correction}`,
    );
    expect(correction?.status).toBe('accepted');
    const [note] = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from delivery_note_documents where id = ${TIMESHEET.deliveryNote}`,
    );
    expect(note?.n).toBe('1');
  });

  /*
   * 0040. The live release has never heard of monthly submissions, Finance
   * packages, a technician's name on documents or the Finance recipient. After
   * a rollback it must still read and save users and the settings (leaving the
   * new columns as they are), and read its own corrections; the new tables
   * stay exactly as written.
   */
  it('still reads and saves USERS, SETTINGS and CORRECTIONS on a database at 0040', async () => {
    const users = new PostgresUserRepository(db);
    const tech = await users.findById(asUserId(IDS.technician));
    expect(tech?.firstName).toBeTruthy();
    await users.save({ ...tech!, jobTitle: 'Field Technician (rolled back)' });
    const [kept] = await db.execute<{ document_name: string | null }>(sql`select document_name from users where id = ${IDS.technician}`);
    expect(kept?.document_name).toBe('SM');

    const settings = new PostgresSettingsRepository(db);
    const current = await settings.get();
    await settings.save({ ...current, companyPhone: '+27 11 000 0000' });
    const [finance] = await db.execute<{ finance_email: string }>(sql`select finance_email from system_settings`);
    expect(finance?.finance_email).toBe('payroll@finance.example.test');

    const corrections = await new PostgresAttendanceRepository(db).listCorrections(TIMESHEET.period);
    expect(corrections.map((correction) => correction.status)).toEqual(['accepted']);

    const [submission] = await db.execute<{ n: string }>(sql`select count(*)::text as n from monthly_submissions where id = ${TIMESHEET.submission}`);
    expect(submission?.n).toBe('1');
    const [financePackage] = await db.execute<{ status: string }>(sql`select status from finance_packages where id = ${TIMESHEET.financePackage}`);
    expect(financePackage?.status).toBe('sent');
  });

  /*
   * 0043. The live release reads a month that has NO timesheet period (a
   * Coordinator's) and a package with ONE attachment, through its own payroll
   * repository, without error — and still writes a submission of its own kind.
   */
  it('still reads monthly submissions and packages after 0043 — a Coordinator’s attendance-only month included', async () => {
    const payroll = new PostgresPayrollRepository(db);
    const september = await payroll.listSubmissions('2026-09');
    expect(september).toHaveLength(2);
    expect(september.find((submission) => submission.userId === IDS.coordinator)?.timesheetPeriodId).toBeNull();
    expect(september.find((submission) => submission.userId === IDS.technician)?.timesheetPeriodId).toBe(TIMESHEET.monthPeriod);
    const august = await payroll.listPackages('2026-08');
    expect(august.map((financePackage) => financePackage.attachments.length)).toEqual([1]);
  });

  /*
   * 0047, WHICH THIS CODE KNOWS (9569c85 is the release that added it): the
   * apprentice, Custom Rates, the chosen document, the email's extra
   * attachment, the day swap and its notification read as what they are.
   */
  it('reads the 0047 rows as what they are', async () => {
    const B = BATCH_0047;
    const apprentice = (await new PostgresUserRepository(db).list()).find((user) => user.id === B.apprentice);
    const role = apprentice!.role as UserRole;
    expect(can(role, 'jobs.captureWork')).toBe(true);
    expect(roleLabel(role)).toBe('Apprentice');
    const customer = await new PostgresCustomerRepository(db).findById(asCustomerId(IDS.customer));
    expect((customer as { rateMode?: string } | null)?.rateMode).toBe('custom');
    const email = await new PostgresCustomerEmailRepository(db).findById(B.queuedEmail);
    expect(email?.extraAttachments?.map((extra) => extra.fileName)).toEqual(['Customer order.pdf']);
    const inbox = await new PostgresNotificationRepository(db).list(asUserId(IDS.technician));
    expect(notificationCategory(inbox.find((notification) => notification.id === B.notification)!.type)).toBe('standby');
    expect((await new PostgresStandbyRepository(db).findWeek(B.weekA))?.status).toBe('published');
  });

  /*
   * 0048, WHICH THIS CODE KNOWS (6ec5655 added it): the Delivery Note with its
   * part comment, the superseded submission hidden, the Senior Tech on standby.
   */
  it('reads the 0048 rows as what they are', async () => {
    const B = BATCH_0048;
    const jobs = new PostgresJobRepository(db);
    const note = await jobs.findById(asJobId(B.deliveryNoteJob));
    expect(note?.jobType).toBe('delivery_note');
    expect(getJobTypeDefinition('delivery_note' as JobTypeCode)?.label).toBe('Delivery Note');
    expect(note?.parts.map((part) => (part as { comment?: string }).comment)).toEqual(['Loan unit']);
    const sent = await new PostgresAttendanceRepository(db).listSubmittedPeriods(asUserId(IDS.technician), '2027-01-01', '2027-02-28');
    expect(sent.map((period) => period.id)).toEqual([B.latePeriod]);
    expect((await new PostgresStandbyRepository(db).findWeek(B.standbyWeek))?.assignments.find((place) => place.position === 'main')?.userId).toBe(IDS.master);
  });

  /*
   * 0049, WHICH THIS CODE KNOWS (9fa858f added it): the site-less Delivery
   * Note opens, and the reference photo stays internal and off the job card.
   */
  it('reads the 0049 rows as what they are: the site-less Delivery Note opens; the reference photo stays internal and off the job card', async () => {
    const B = BATCH_0049;
    const jobs = new PostgresJobRepository(db);
    const note = await jobs.findById(asJobId(B.siteLessNote));
    expect(note?.jobType).toBe('delivery_note');
    expect(note?.siteId ?? null).toBeNull();
    expect((await loadJobView(readRepositories(db), note!.jobNumber))?.job.id).toBe(B.siteLessNote);
    // The reference photo: read as an ordinary INTERNAL photo — so never on this code's job card either.
    const repair = (await jobs.list()).find((candidate) => candidate.jobType === 'test_and_repair')!;
    const photo = repair.photos.find((item) => item.id === B.referencePhoto);
    expect(photo?.visibility).toBe('internal');
    expect(documentPhotos(repair).some((item) => item.id === B.referencePhoto)).toBe(false);
    // Saved by this code, the photo keeps its purpose; made customer-facing by it, the database refuses.
    await jobs.save(repair);
    const [kept] = await db.execute<{ purpose: string }>(sql`select purpose from job_media where id = ${B.referencePhoto}`);
    expect(kept?.purpose).toBe('delivery_note_reference');
    await expect(db.execute(sql`update job_media set visibility = 'customer_facing' where id = ${B.referencePhoto}`)).rejects.toThrow();
  });

  /*
   * 0050, WHICH THIS CODE HAS NEVER HEARD OF (TS-PAPER): a submitted period
   * longer than its own 92-day rule, a technician's attendance-only month, and
   * the working-comment table it does not know. It reads them all; nothing of
   * its own writes is refused.
   */
  it('meets the 0050 rows: the long submission and the attendance-only month read; the working comment is simply unseen', async () => {
    const B = BATCH_0050;
    const attendance = new PostgresAttendanceRepository(db);
    const sent = await attendance.listSubmittedPeriods(asUserId(IDS.technician), B.longFrom, B.longTo);
    expect(sent.map((period) => [period.id, period.from, period.to])).toEqual([[B.longPeriod, B.longFrom, B.longTo]]);
    const march = await new PostgresPayrollRepository(db).listSubmissions(B.month);
    expect(march.map((submission) => [submission.id, submission.timesheetPeriodId])).toEqual([[B.attendanceOnlyMonth, null]]);
    // Its own writes still work beside them: a timesheet line on a day of the long period.
    const saved = await attendance.saveEntry({
      id: '00000000-0000-4000-8000-000000000ac1', userId: asUserId(IDS.technician), date: '2027-05-03', customerId: null, customerName: 'Rollback probe', workshop: false,
      normalHours: 0, overtimeHours: 1, doubleHours: 0, callouts: 0, calloutAmount: 0, calloutShared: false, internalKm: 0, customerKm: 0,
      updatedBy: asUserId(IDS.technician), updatedAt: '2027-09-02T08:00:00.000Z',
    });
    expect(saved.overtimeHours).toBe(1);
  });

  /*
   * 0051, WHICH THIS CODE HAS NEVER HEARD OF (CHK-SRC): the source checklists,
   * the chosen kind, typed blanks, a Fail tapped before its note, the
   * demonstration wording archived. It reads every job as it is, issues one of
   * the current checklists for each type, starts one without sending a kind
   * (the trigger fills it), and saves a Fail with no note on the tap — which
   * 0051 now allows; the database still refuses to COMPLETE it.
   */
  it('meets the 0051 rows: reads the chosen checklists, starts one, saves a Fail on the tap, refuses completion without its note', async () => {
    const B = BATCH_0051;
    const jobs = new PostgresJobRepository(db);
    const lathe = await jobs.findById(asJobId(B.latheJob));
    expect(lathe?.checklist?.templateId).toBe(B.latheChecklist);
    expect(lathe?.checklist?.responses.find((r) => r.itemId === B.handwrittenRow)?.choice).toBe('fail');
    const installation = await jobs.findById(asJobId(B.installationJob));
    expect(installation?.checklist?.responses.find((r) => r.itemId === B.voltageRow)?.choice).toBe('pass');
    expect((await loadJobView(readRepositories(db), lathe!.jobNumber))?.checklistTemplate?.id).toBe(B.latheChecklist);

    // What this code issues to a new job: a current source checklist, never the archived demonstration wording.
    // `listCurrentForJobType` is the live release's (ad0f3c8) method; this file runs inside the live checkout.
    const templates = readRepositories(db).checklistTemplates as unknown as {
      listCurrentForJobType(code: string): Promise<readonly { id: string; version: string }[]>;
    };
    const forInstallation = (await templates.listCurrentForJobType('installation'))[0];
    expect(forInstallation?.id).toBe(B.installationChecklist);
    const forService = await templates.listCurrentForJobType('service');
    expect(forService.map((template) => template.version)).toEqual(['1.0', '1.0']);

    // Its own writes: a checklist started on a new job (no kind sent — the trigger fills it in)…
    const allocated = await jobs.allocateJobNumber();
    const fresh = jobFixture(allocated.jobNumber, {
      jobType: 'installation', status: 'in_progress', primaryTechnicianId: asUserId(IDS.technician),
      checklist: { templateId: forInstallation!.id as never, templateVersion: '1.0', responses: [], completedAt: null, completedBy: null },
    });
    await jobs.save(fresh);
    const [started] = await db.execute<{ kind: string }>(sql`select checklist_kind as kind from checklist_instances where job_id = ${fresh.id}`);
    expect(started?.kind).toBe('installation');

    // …a Fail tapped before its note is saved, and completing over it is refused.
    const failed = {
      ...lathe!,
      checklist: { ...lathe!.checklist!, completedAt: '2027-10-02T08:00:00.000Z', completedBy: asUserId(IDS.technician) },
    };
    await expect(jobs.save(failed)).rejects.toThrow();
    expect((await jobs.findById(asJobId(B.latheJob)))?.checklist?.completedAt).toBeNull();
  });

  /*
   * 0052, WHICH THIS CODE HAS NEVER HEARD OF (PAYROLL-ONE-1): payroll
   * submissions for a period, two timesheet periods with the same dates (one
   * replaced), a stored PDF name, a draft line. It reads its timesheets, the
   * current one included, and its own line writes still work. ITS OWN "Submit
   * timesheet" names the old full unique key in ON CONFLICT, which 0052
   * replaced by one for current rows: refused, writing nothing — the one
   * limitation recorded in docs/deploy-next-release.md.
   */
  it('meets the 0052 rows: reads both periods with the same dates, still writes lines; its old Submit is refused and writes nothing', async () => {
    const B = BATCH_0052;
    const attendance = new PostgresAttendanceRepository(db);
    const tech = asUserId(IDS.technician);
    const current = await attendance.listSubmittedPeriods(tech, B.from, B.to);
    expect(current.map((period) => period.id)).toEqual([B.currentPeriod]);
    const all = (await attendance.listSubmissions(tech)).filter((period) => period.from === B.from && period.to === B.to);
    expect(all.map((period) => period.id).sort()).toEqual([B.replacedPeriod, B.currentPeriod].sort());
    expect(await attendance.findPeriod(tech, B.from, B.to)).not.toBeNull();
    const saved = await attendance.saveEntry({
      id: '00000000-0000-4000-8000-000000000cd1', userId: tech, date: '2028-02-04', customerId: null, customerName: 'Rollback probe 0052', workshop: false,
      normalHours: 0, overtimeHours: 1, doubleHours: 0, callouts: 0, calloutAmount: 0, calloutShared: false, internalKm: 0, customerKm: 0,
      updatedBy: tech, updatedAt: '2028-02-04T08:00:00.000Z',
    });
    expect(saved.overtimeHours).toBe(1);
    const before = await db.execute<{ n: string }>(sql`select count(*)::text as n from timesheet_periods`);
    await expect(attendance.submitPeriod({
      id: '00000000-0000-4000-8000-000000000ce1', userId: tech, from: '2028-03-01', to: '2028-03-25', comment: '',
      updatedBy: tech, updatedAt: '2028-03-26T08:00:00.000Z', submittedAt: '2028-03-26T08:00:00.000Z', submittedBy: tech,
      snapshot: { technicianName: 'Sipho', from: '2028-03-01', to: '2028-03-25', comment: '', entries: [] },
    })).rejects.toThrow();
    const after = await db.execute<{ n: string }>(sql`select count(*)::text as n from timesheet_periods`);
    expect(after[0]?.n).toBe(before[0]?.n);
  });
});
