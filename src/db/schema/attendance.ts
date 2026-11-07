import { sql } from 'drizzle-orm';
import { boolean, check, date, index, integer, jsonb, numeric, pgTable, primaryKey, text, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { createdAt, instant, primaryId, rowVersion, updatedAt } from './columns';
import { users } from './identity';
import { customers } from './customers';

/**
 * THE ATTENDANCE REGISTER. ATTEND-1, migration 0033.
 *
 * ONE ROW PER PERSON PER DAY — `attendance_user_date_key` — so a second record
 * for the same day cannot exist however many writers race. A correction
 * UPDATES the row; its earlier value is on the audit trail.
 *
 * Separate from `availability` (planned leave) and from every job table, on
 * purpose: what was arranged, what happened and what was worked on are three
 * different records, and none of them writes another.
 */
export const attendance = pgTable(
  'attendance',
  {
    id: primaryId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    workDate: date('work_date').notNull(),
    status: text('status').notNull(),
    /** ATT-01, migration 0037. Null on a present day and on an absent day from before it. */
    absenceReason: text('absence_reason'),
    note: text('note').notNull().default(''),
    recordedBy: uuid('recorded_by')
      .notNull()
      .references(() => users.id),
    recordedAt: instant('recorded_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: rowVersion(),
  },
  (table) => [
    uniqueIndex('attendance_user_date_key').on(table.userId, table.workDate),
    index('attendance_date_idx').on(table.workDate),
    check('attendance_status_known', sql`${table.status} in ('present', 'absent')`),
    check('attendance_note_bounded', sql`char_length(${table.note}) <= 500`),
    check(
      'attendance_absence_reason_known',
      sql`${table.absenceReason} is null or (${table.status} = 'absent' and ${table.absenceReason} in ('leave', 'sick_leave', 'family_responsibility', 'iod'))`,
    ),
  ],
);

/**
 * A TECHNICIAN'S DAILY TIMESHEET COMMENT. TIMESHEET-1, migration 0033.
 *
 * The one part of a timesheet the system did not already hold: hours are the
 * labour lines on each job and the call-out is on the job, so neither is
 * copied here. One comment per person per day; a cleared comment is deleted,
 * and the clearing is audited.
 */
export const timesheetComments = pgTable(
  'timesheet_comments',
  {
    id: primaryId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    workDate: date('work_date').notNull(),
    comment: text('comment').notNull(),
    updatedBy: uuid('updated_by')
      .notNull()
      .references(() => users.id),
    commentedAt: instant('commented_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: rowVersion(),
  },
  (table) => [
    uniqueIndex('timesheet_comments_user_date_key').on(table.userId, table.workDate),
    check(
      'timesheet_comments_not_blank',
      sql`${table.comment} ~ '[^[:space:]]' and char_length(${table.comment}) <= 1000`,
    ),
  ],
);

/**
 * A technician's own timesheet lines. TIMESHEET-2 (27 October 2026): manual.
 *
 * Every value is what the technician typed; nothing here is derived from job
 * labour, call-out flags or assignments. Several lines may share a day (two
 * customers); a day with none is unrecorded. Hours in hundredths, 0 to 24.
 */
export const timesheetEntries = pgTable(
  'timesheet_entries',
  {
    id: primaryId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    workDate: date('work_date').notNull(),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'restrict' }),
    customerName: text('customer_name').notNull().default(''),
    normalHours: numeric('normal_hours', { precision: 5, scale: 2 }).notNull().default('0'),
    overtimeHours: numeric('overtime_hours', { precision: 5, scale: 2 }).notNull().default('0'),
    doubleHours: numeric('double_hours', { precision: 5, scale: 2 }).notNull().default('0'),
    callouts: integer('callouts').notNull().default(0),
    // Migration 0037: the reviewer's fields (TS-06, TS-08, TS-09).
    workshop: boolean('workshop').notNull().default(false),
    calloutAmountCents: integer('callout_amount_cents').notNull().default(0),
    calloutShared: boolean('callout_shared').notNull().default(false),
    internalKm: numeric('internal_km', { precision: 7, scale: 1 }).notNull().default('0'),
    customerKm: numeric('customer_km', { precision: 7, scale: 1 }).notNull().default('0'),
    updatedBy: uuid('updated_by')
      .notNull()
      .references(() => users.id),
    recordedAt: instant('recorded_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: rowVersion(),
  },
  (table) => [
    index('timesheet_entries_user_date_idx').on(table.userId, table.workDate),
    check(
      'timesheet_entries_hours_bounded',
      sql`${table.normalHours} between 0 and 24 and ${table.overtimeHours} between 0 and 24 and ${table.doubleHours} between 0 and 24`,
    ),
    check('timesheet_entries_callouts_bounded', sql`${table.callouts} between 0 and 10`),
    check('timesheet_entries_customer_bounded', sql`char_length(${table.customerName}) <= 200`),
    check(
      'timesheet_entries_reviewer_bounded',
      sql`${table.calloutAmountCents} between 0 and 100000000 and ${table.internalKm} between 0 and 10000 and ${table.customerKm} between 0 and 10000 and not (${table.workshop} and ${table.customerId} is not null)`,
    ),
  ],
);

/**
 * ONE TECHNICIAN'S TIMESHEET FOR ONE MONTH. TS-02, TS-03, TS-10; migration 0037.
 *
 * The one comment for the whole timesheet, and its submission to the office.
 * Once `submitted_at` is set the row is write-once — the application refuses
 * every change and the trigger `timesheet_months_write_once` refuses it again —
 * and `snapshot` is exactly what was sent.
 */
export const timesheetMonths = pgTable(
  'timesheet_months',
  {
    id: primaryId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    month: text('month').notNull(),
    comment: text('comment').notNull().default(''),
    updatedBy: uuid('updated_by')
      .notNull()
      .references(() => users.id),
    commentedAt: instant('commented_at').notNull(),
    submittedAt: instant('submitted_at'),
    submittedBy: uuid('submitted_by').references(() => users.id),
    snapshot: jsonb('snapshot'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: rowVersion(),
  },
  (table) => [
    uniqueIndex('timesheet_months_user_month_key').on(table.userId, table.month),
    check('timesheet_months_month_format', sql`${table.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check('timesheet_months_comment_bounded', sql`char_length(${table.comment}) <= 2000`),
    check(
      'timesheet_months_submission_whole',
      sql`(${table.submittedAt} is null and ${table.submittedBy} is null and ${table.snapshot} is null) or (${table.submittedAt} is not null and ${table.submittedBy} is not null and ${table.snapshot} is not null)`,
    ),
  ],
);

/**
 * A TECHNICIAN'S TIMESHEET FOR A CHOSEN PERIOD. TS-02, TS-03, TS-10; migration
 * 0038 (the owner's decision that the period is From/To, not a month).
 *
 * `timesheet_months` above is kept only because 0037 created it; 0038 copied
 * any rows it held into this table and nothing writes it any more.
 *
 * The trigger `timesheet_periods_guard` makes a sent period write-once and
 * refuses two sent periods of one technician that overlap.
 */
export const timesheetPeriods = pgTable(
  'timesheet_periods',
  {
    id: primaryId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    periodFrom: date('period_from').notNull(),
    periodTo: date('period_to').notNull(),
    comment: text('comment').notNull().default(''),
    updatedBy: uuid('updated_by')
      .notNull()
      .references(() => users.id),
    commentedAt: instant('commented_at').notNull(),
    submittedAt: instant('submitted_at'),
    submittedBy: uuid('submitted_by').references(() => users.id),
    snapshot: jsonb('snapshot'),
    // TS-OVERLAP-1 (0048): a later, overlapping submission replaced this one.
    supersededAt: instant('superseded_at'),
    supersededBy: uuid('superseded_by').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: rowVersion(),
  },
  (table) => [
    // REPEAT-DATES-1 (0056): one UNSENT row per person and dates; any number of SENT ones may share dates.
    uniqueIndex('timesheet_periods_user_range_unsent_key')
      .on(table.userId, table.periodFrom, table.periodTo)
      .where(sql`${table.supersededAt} is null and ${table.submittedAt} is null`),
    index('timesheet_periods_user_idx').on(table.userId, table.periodFrom),
    // TS-PAPER (0050): any length — a pay period ends on the real payday, however far away.
    check('timesheet_periods_range_ordered', sql`${table.periodFrom} <= ${table.periodTo}`),
    check('timesheet_periods_comment_bounded', sql`char_length(${table.comment}) <= 2000`),
    check(
      'timesheet_periods_submission_whole',
      sql`(${table.submittedAt} is null and ${table.submittedBy} is null and ${table.snapshot} is null) or (${table.submittedAt} is not null and ${table.submittedBy} is not null and ${table.snapshot} is not null)`,
    ),
  ],
);

/**
 * THE CORRECTION OF A SENT TIMESHEET. TS-16, migration 0039.
 *
 * Linked to the ONE sent period it corrects, which it never changes. Holds the
 * complete version it corrects and the complete corrected version; decided
 * once by the office. One pending per period; write-once after the decision;
 * never deleted — the trigger `timesheet_corrections_guard` enforces it.
 */
/**
 * THE OPEN SHEET'S COMMENT. TS-PAPER, migration 0050 (4 November 2026).
 *
 * One row per person: the comment on the timesheet they are filling in now,
 * whatever dates it will be submitted for. Submitting copies it into the
 * snapshot and clears it for the next sheet.
 */
export const timesheetWorkingComments = pgTable(
  'timesheet_working_comments',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'restrict' }),
    comment: text('comment').notNull().default(''),
    updatedBy: uuid('updated_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: rowVersion(),
  },
  (table) => [check('timesheet_working_comments_bounded', sql`char_length(${table.comment}) <= 2000`)],
);

export const timesheetCorrections = pgTable(
  'timesheet_corrections',
  {
    id: primaryId(),
    periodId: uuid('period_id')
      .notNull()
      .references(() => timesheetPeriods.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    sequence: integer('sequence').notNull(),
    reason: text('reason').notNull(),
    beforeSnapshot: jsonb('before_snapshot').notNull(),
    afterSnapshot: jsonb('after_snapshot').notNull(),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    requestedAt: instant('requested_at').notNull(),
    status: text('status').notNull().default('pending'),
    decidedBy: uuid('decided_by').references(() => users.id),
    decidedAt: instant('decided_at'),
    decisionNote: text('decision_note').notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: rowVersion(),
  },
  (table) => [
    uniqueIndex('timesheet_corrections_period_sequence_key').on(table.periodId, table.sequence),
    uniqueIndex('timesheet_corrections_one_pending_key').on(table.periodId).where(sql`${table.status} = 'pending'`),
    index('timesheet_corrections_user_idx').on(table.userId),
    index('timesheet_corrections_status_idx').on(table.status),
    check('timesheet_corrections_sequence_positive', sql`${table.sequence} >= 1`),
    check('timesheet_corrections_status_known', sql`${table.status} in ('pending', 'accepted', 'rejected')`),
    check('timesheet_corrections_reason_given', sql`char_length(btrim(${table.reason})) between 1 and 2000`),
    check('timesheet_corrections_note_bounded', sql`char_length(${table.decisionNote}) <= 2000`),
    check(
      'timesheet_corrections_decision_whole',
      sql`(${table.status} = 'pending' and ${table.decidedBy} is null and ${table.decidedAt} is null) or (${table.status} <> 'pending' and ${table.decidedBy} is not null and ${table.decidedAt} is not null)`,
    ),
    check('timesheet_corrections_decided_by_another', sql`${table.decidedBy} is null or ${table.decidedBy} <> ${table.requestedBy}`),
    check(
      'timesheet_corrections_rejection_explained',
      sql`${table.status} <> 'rejected' or char_length(btrim(${table.decisionNote})) > 0`,
    ),
  ],
);

/**
 * A TECHNICIAN'S MONTH SENT TO THE OFFICE. PAY-02, migration 0040. The sent
 * timesheet period covering exactly the month, and the month's attendance
 * frozen as it stood. One per technician per month; write-once. A Coordinator's
 * month carries no timesheet (migration 0043).
 */
export const monthlySubmissions = pgTable(
  'monthly_submissions',
  {
    id: primaryId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    month: text('month').notNull(),
    // Null: attendance only — a Coordinator's month (TS-ROLE-1, migration 0043).
    timesheetPeriodId: uuid('timesheet_period_id')
      .references(() => timesheetPeriods.id, { onDelete: 'restrict' }),
    attendanceSnapshot: jsonb('attendance_snapshot').notNull(),
    submittedAt: instant('submitted_at').notNull(),
    submittedBy: uuid('submitted_by')
      .notNull()
      .references(() => users.id),
    // PAYROLL-ONE-1 (0052): replaced, once, by a payroll submission covering all of the month.
    supersededAt: instant('superseded_at'),
    supersededBy: uuid('superseded_by').references(() => users.id),
    supersededBySubmission: uuid('superseded_by_submission').references((): AnyPgColumn => payrollSubmissions.id),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('monthly_submissions_user_month_key').on(table.userId, table.month),
    uniqueIndex('monthly_submissions_period_key').on(table.timesheetPeriodId),
    check('monthly_submissions_month_format', sql`${table.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
  ],
);

/**
 * ONE MONTH'S PAYROLL PACKAGE FOR FINANCE. PAY-05…PAY-08, migration 0040.
 * The manifest names every attachment, stored write-once; sent at most once.
 * The trigger `finance_packages_guard` keeps the manifest and recipient fixed
 * and allows only prepared/failed → sending → sent/failed, or → discarded.
 */
export const financePackages = pgTable(
  'finance_packages',
  {
    id: primaryId(),
    month: text('month').notNull(),
    status: text('status').notNull().default('prepared'),
    recipient: text('recipient').notNull(),
    manifest: jsonb('manifest').notNull(),
    attachmentCount: integer('attachment_count').notNull(),
    totalBytes: integer('total_bytes').notNull(),
    preparedBy: uuid('prepared_by')
      .notNull()
      .references(() => users.id),
    preparedAt: instant('prepared_at').notNull(),
    sentBy: uuid('sent_by').references(() => users.id),
    sendStartedAt: instant('send_started_at'),
    sentAt: instant('sent_at'),
    providerMessageId: text('provider_message_id'),
    providerState: text('provider_state'),
    failureReason: text('failure_reason').notNull().default(''),
    failureKind: text('failure_kind'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: rowVersion(),
  },
  (table) => [
    uniqueIndex('finance_packages_one_open_per_month')
      .on(table.month)
      .where(sql`${table.status} in ('prepared', 'sending', 'failed')`),
    index('finance_packages_month_idx').on(table.month),
    check('finance_packages_month_format', sql`${table.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check('finance_packages_status_known', sql`${table.status} in ('prepared', 'sending', 'sent', 'failed', 'discarded')`),
    check('finance_packages_has_attachments', sql`${table.attachmentCount} >= 1 and ${table.totalBytes} > 0`),
    check(
      'finance_packages_sent_whole',
      sql`(${table.status} = 'sent') = (${table.sentAt} is not null and ${table.sentBy} is not null and ${table.providerMessageId} is not null)`,
    ),
  ],
);

/**
 * A PERSON'S PAYROLL FORMS, SUBMITTED TOGETHER FOR A FROM–TO PERIOD.
 * PAYROLL-ONE-1, migration 0052 (the owner, 5 November 2026).
 *
 * The timesheet (the sent period it names, for exactly these dates) and the
 * attendance frozen as it stood, with the file names they went under and the
 * PDFs stored at that moment. The Finance month is the month of To. Write-once
 * (`payroll_submissions_guard`): only marked replaced, once, by a later
 * submission covering all of it; one current submission per person for any day.
 */
export const payrollSubmissions = pgTable(
  'payroll_submissions',
  {
    id: primaryId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    periodFrom: date('period_from').notNull(),
    periodTo: date('period_to').notNull(),
    financeMonth: text('finance_month').notNull(),
    timesheetRequired: boolean('timesheet_required').notNull(),
    timesheetPeriodId: uuid('timesheet_period_id').references(() => timesheetPeriods.id, { onDelete: 'restrict' }),
    attendanceSnapshot: jsonb('attendance_snapshot').notNull(),
    timesheetFileName: text('timesheet_file_name').notNull(),
    attendanceFileName: text('attendance_file_name').notNull(),
    documents: jsonb('documents').notNull(),
    submittedAt: instant('submitted_at').notNull(),
    submittedBy: uuid('submitted_by')
      .notNull()
      .references(() => users.id),
    supersededAt: instant('superseded_at'),
    supersededBy: uuid('superseded_by').references(() => users.id),
    supersededBySubmission: uuid('superseded_by_submission').references((): AnyPgColumn => payrollSubmissions.id),
    createdAt: createdAt(),
  },
  (table) => [
    index('payroll_submissions_user_idx').on(table.userId, table.periodFrom),
    index('payroll_submissions_finance_month_idx').on(table.financeMonth),
    uniqueIndex('payroll_submissions_timesheet_key').on(table.timesheetPeriodId),
    // REPEAT-DATES-1 (0056): several submissions may share — or have exactly — the same dates.
    index('payroll_submissions_user_range_idx').on(table.userId, table.periodFrom, table.periodTo),
    check('payroll_submissions_range_ordered', sql`${table.periodFrom} <= ${table.periodTo}`),
    check('payroll_submissions_range_bounded', sql`${table.periodTo} - ${table.periodFrom} < 366`),
    check('payroll_submissions_finance_month_of_to', sql`${table.financeMonth} = to_char(${table.periodTo}, 'YYYY-MM')`),
    check('payroll_submissions_timesheet_whole', sql`${table.timesheetRequired} = (${table.timesheetPeriodId} is not null)`),
    check(
      'payroll_submissions_file_names_bounded',
      sql`char_length(${table.attendanceFileName}) between 5 and 120 and (char_length(${table.timesheetFileName}) between 5 and 120 or (not ${table.timesheetRequired} and ${table.timesheetFileName} = ''))`,
    ),
    check(
      'payroll_submissions_superseded_whole',
      sql`(${table.supersededAt} is null and ${table.supersededBy} is null and ${table.supersededBySubmission} is null) or (${table.supersededAt} is not null and ${table.supersededBy} is not null and ${table.supersededBySubmission} is not null)`,
    ),
  ],
);

/**
 * THE NAME A PERSON GAVE A WORKING PDF. PAYROLL-ONE-1, migration 0052.
 * One per person per document (timesheet, attendance); metadata only — the
 * stored files' keys are always the server's. Cleared when the forms are
 * submitted: the submission keeps the names it went with. The full rules are
 * `pdfFileNameProblem` (src/lib/pdf-file-name.ts); the check is the backstop.
 */
export const payrollDocumentNames = pgTable(
  'payroll_document_names',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    fileName: text('file_name').notNull(),
    updatedBy: uuid('updated_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: rowVersion(),
  },
  (table) => [
    primaryKey({ name: 'payroll_document_names_pk', columns: [table.userId, table.kind] }),
    check('payroll_document_names_kind_known', sql`${table.kind} in ('timesheet', 'attendance')`),
  ],
);

/**
 * A TIMESHEET LINE TYPED BUT NOT COMPLETE YET. PAYROLL-ONE-1, migration 0052.
 * Exactly what was typed, kept on the server so it survives a reload, another
 * device or signing out; shown with what it still needs, and blocking the
 * submission until it is completed or removed. Its id is the line's: once it
 * is complete it is written as that timesheet entry and the draft goes.
 */
export const timesheetLineDrafts = pgTable(
  'timesheet_line_drafts',
  {
    id: primaryId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    workDate: date('work_date'),
    typed: jsonb('typed').notNull(),
    updatedBy: uuid('updated_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: rowVersion(),
  },
  (table) => [
    index('timesheet_line_drafts_user_idx').on(table.userId, table.workDate),
    check('timesheet_line_drafts_typed_bounded', sql`octet_length(${table.typed}::text) <= 4000`),
  ],
);

/**
 * A REMOVED TIMESHEET LINE STAYS REMOVED. PAYROLL-ONE-1 follow-up, migration
 * 0053. The id of every line its owner removed; a later save of that id —
 * one still on its way, or from another device — is refused. Write-once.
 */
export const timesheetLineRemovals = pgTable('timesheet_line_removals', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  removedBy: uuid('removed_by')
    .notNull()
    .references(() => users.id),
  removedAt: instant('removed_at').notNull(),
  createdAt: createdAt(),
});

/**
 * ONE FORM, COMPLETED AND LOCKED, WAITING FOR THE JOINT SUBMISSION.
 * FORM-LIFECYCLE-1, migration 0054 (the owner, 6 November 2026).
 *
 * Write-once (`payroll_form_completions_guard`): only `submission_id` is set,
 * once, when both forms go to the office together. At most one form of each
 * kind awaits per person. `content` is the frozen timesheet (lines and comment)
 * or attendance (days); `document` the PDF stored when it was completed.
 */
export const payrollFormCompletions = pgTable(
  'payroll_form_completions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    periodFrom: date('period_from').notNull(),
    periodTo: date('period_to').notNull(),
    fileName: text('file_name').notNull(),
    content: jsonb('content').notNull(),
    document: jsonb('document').notNull(),
    completedAt: instant('completed_at').notNull(),
    completedBy: uuid('completed_by')
      .notNull()
      .references(() => users.id),
    submissionId: uuid('submission_id').references(() => payrollSubmissions.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    // 0055 (FORM-WITHDRAW-1): withdrawn before Submit to Office — set once, never with a submission.
    withdrawnAt: instant('withdrawn_at'),
    withdrawnBy: uuid('withdrawn_by').references(() => users.id),
    correctsId: uuid('corrects_id').references((): AnyPgColumn => payrollFormCompletions.id, { onDelete: 'restrict' }),
  },
  (table) => [
    index('payroll_form_completions_user_idx').on(table.userId, table.completedAt),
    uniqueIndex('payroll_form_completions_awaiting_key')
      .on(table.userId, table.kind)
      .where(sql`${table.submissionId} is null and ${table.withdrawnAt} is null`),
    uniqueIndex('payroll_form_completions_corrects_key').on(table.correctsId).where(sql`${table.correctsId} is not null`),
    check('payroll_form_completions_withdrawn_together', sql`(${table.withdrawnAt} is null) = (${table.withdrawnBy} is null)`),
    check('payroll_form_completions_withdrawn_or_submitted', sql`${table.withdrawnAt} is null or ${table.submissionId} is null`),
    check('payroll_form_completions_kind_known', sql`${table.kind} in ('timesheet', 'attendance')`),
    check('payroll_form_completions_range_ordered', sql`${table.periodFrom} <= ${table.periodTo}`),
    check('payroll_form_completions_range_bounded', sql`${table.periodTo} - ${table.periodFrom} < 366`),
    check('payroll_form_completions_file_name_bounded', sql`char_length(${table.fileName}) between 5 and 120`),
  ],
);

/** 0055 (FORM-WITHDRAW-1): the correction draft a withdrawal opens. Write-once apart from `completed_id`; guarded in the migration. */
export const payrollFormCorrectionDrafts = pgTable(
  'payroll_form_correction_drafts',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    periodFrom: date('period_from').notNull(),
    periodTo: date('period_to').notNull(),
    withdrawnId: uuid('withdrawn_id')
      .notNull()
      .references(() => payrollFormCompletions.id, { onDelete: 'restrict' }),
    completedId: uuid('completed_id').references(() => payrollFormCompletions.id, { onDelete: 'restrict' }),
    openedAt: instant('opened_at').notNull(),
    openedBy: uuid('opened_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('payroll_form_correction_drafts_withdrawn_key').on(table.withdrawnId),
    uniqueIndex('payroll_form_correction_drafts_completed_key').on(table.completedId).where(sql`${table.completedId} is not null`),
    uniqueIndex('payroll_form_correction_drafts_open_key').on(table.userId, table.kind).where(sql`${table.completedId} is null`),
    check('payroll_form_correction_drafts_kind_known', sql`${table.kind} in ('timesheet', 'attendance')`),
    check('payroll_form_correction_drafts_range_ordered', sql`${table.periodFrom} <= ${table.periodTo}`),
  ],
);

/**
 * EVERY SUBMITTED TIMESHEET LINE, ONCE. REPEAT-DATES-1, migration 0056 (the
 * owner, 7 November 2026): a calendar date may be in any number of submitted
 * timesheets; a LINE is in exactly one. Written by the database itself as a
 * timesheet period is sent (`record_timesheet_submitted_lines`), which refuses
 * a line already here; append-only.
 */
export const timesheetSubmittedLines = pgTable(
  'timesheet_submitted_lines',
  {
    entryId: text('entry_id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    workDate: date('work_date').notNull(),
    periodId: uuid('period_id')
      .notNull()
      .references(() => timesheetPeriods.id, { onDelete: 'restrict' }),
    submittedAt: instant('submitted_at').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('timesheet_submitted_lines_user_date_idx').on(table.userId, table.workDate),
    index('timesheet_submitted_lines_period_idx').on(table.periodId),
    check('timesheet_submitted_lines_entry_bounded', sql`char_length(${table.entryId}) between 1 and 100`),
  ],
);
