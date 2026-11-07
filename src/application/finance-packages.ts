import {
  FINANCE_PACKAGE_MAX_BYTES,
  can,
  completesTimesheet,
  userFullName,
  type FinancePackage,
  type FinancePackageAttachment,
  type IsoDateTime,
  type PayrollSubmission,
  type PayrollDocumentKind,
  type User,
  type UserId,
  type UserRole,
} from '@/domain';
import { sha256Hex } from '@/lib/job-card/document-identity';
import { correctedFileName, documentNameOf, monthBounds, monthTitle } from '@/lib/payroll-files';
import { deliveryFailureKindOf } from '@/services/ports';
import { renderAttendancePdf } from '@/services/simulated/attendance-pdf';
import { OnePageOverflow } from '@/services/simulated/one-page-form';
import { renderTimesheetPdf } from '@/services/simulated/timesheet-pdf';
import type { OperationContext } from './context';
import { audit } from './audit';
import { WorkflowError } from './errors';
import { assertPayrollMonth, attendanceChanges, loadAttendanceDocument } from './attendance-document';
import { loadMonthlyForms } from './monthly-submissions';
import { loadSubmissionDocument, type TimesheetDocument } from './timesheets';
import { formatPeriod } from '@/lib/timesheet-dates';
import { attendancePeriodDays, currentSubmissions, loadSubmittedPayrollDocument } from './payroll-forms';

/**
 * THE TIMESHEETS OF A MONTH: every CURRENT submission whose To falls in it.
 * TS-PAPER (4 November 2026), made the one rule by TS-PAPER-7: 25 Nov →
 * November; 15 Dec → December; 25 Jan → January — and a calendar-month
 * timesheet submitted before TS-PAPER is a submission ending on its month's
 * last day, printed for its month while it is current. Once a later submission
 * has replaced it (one that covers every one of its days), the replacement is
 * printed instead, for the month IT ends in, and the replaced one is never
 * printed again. Current submissions never share a day (the database refuses
 * it) and each ends in exactly one month, so across the months every submitted
 * line is printed once: none missing, none twice.
 */
const paydayTimesheetsEnding = async (context: OperationContext, technicianId: UserId, month: string) =>
  (await context.repos.attendance.listSubmissions(technicianId))
    .filter((period) => (period.supersededAt ?? null) === null && period.to.slice(0, 7) === month)
    .sort((a, b) => a.to.localeCompare(b.to));

/**
 * WHAT A PERSON'S FILES FOR A MONTH ARE MADE FROM (5 November 2026): each
 * current timesheet submission ending in the month with the corrections
 * accepted on it, each current payroll submission, and a current calendar-month
 * submission. Recorded on a package's attachments when it is prepared; a
 * package whose basis no longer matches is never sent (a submission made,
 * replaced or corrected between Prepare and Send would otherwise be missed, or
 * an old version sent in its place), and a sent package counts as "sent" only
 * for the basis it carried.
 */
const partsOf = (basis: string | undefined): readonly string[] => (basis === undefined || basis === '' ? [] : basis.split(' '));
/** A part without its corrections: `timesheet:<period>`, `period:<submission>`, `month:<submission>`. */
const rootOf = (part: string): string => part.split('+')[0] ?? part;

/**
 * WHAT FINANCE ALREADY HAS OF A PERSON'S MONTH (REPEAT-DATES-1, 7 November 2026): every part of every SENT package
 * that carried them — each submission, and each timesheet in the version it went in. A submission is sent ONCE;
 * it goes again only marked CORRECTED, when a correction was accepted on it (or it was replaced) after it went.
 */
const sentPartsFor = (packages: readonly FinancePackage[], technicianId: UserId): ReadonlySet<string> =>
  new Set(
    packages
      .filter((financePackage) => financePackage.status === 'sent')
      .flatMap((financePackage) => financePackage.attachments.filter((attachment) => attachment.technicianId === technicianId).flatMap((attachment) => partsOf(attachment.basis))),
  );

/**
 * How the month stands against what was sent: nothing new; NEW submissions only (each goes once, in addition —
 * a repeated date is no reason to send an earlier one again); or something Finance has CHANGED since (corrected,
 * or replaced), which re-sends the month marked CORRECTED, as before.
 */
const freshAgainst = (basis: string, sent: ReadonlySet<string>): { readonly fresh: readonly string[]; readonly changed: boolean } => {
  const current = partsOf(basis);
  const fresh = current.filter((part) => !sent.has(part));
  const sentRoots = new Set([...sent].map(rootOf));
  const currentRoots = new Set(current.map(rootOf));
  const changed = fresh.some((part) => sentRoots.has(rootOf(part))) || [...sentRoots].some((root) => !currentRoots.has(root));
  return { fresh, changed };
};

const basisOf = async (context: OperationContext, technicianId: UserId, month: string): Promise<string> => {
  const parts: string[] = [];
  for (const period of await paydayTimesheetsEnding(context, technicianId, month)) {
    const accepted = (await context.repos.attendance.listCorrections(period.id)).filter((correction) => correction.status === 'accepted').map((correction) => correction.id).sort();
    parts.push(`timesheet:${period.id}${accepted.length === 0 ? '' : `+${accepted.join('+')}`}`);
  }
  for (const submission of await context.repos.payroll.listPayrollSubmissionsForMonth(month)) {
    if (submission.userId === technicianId && (submission.supersededAt ?? null) === null) parts.push(`period:${submission.id}`);
  }
  const legacy = await context.repos.payroll.findSubmission(technicianId, month);
  if (legacy !== null && (legacy.supersededAt ?? null) === null) parts.push(`month:${legacy.id}`);
  return parts.sort().join(' ');
};

/**
 * THE MONTHLY PAYROLL PACKAGE FOR FINANCE. PAY-05 … PAY-08 (29 October 2026).
 *
 * The office chooses a month, sees every technician's status, selects the
 * technicians whose submitted forms are complete, reviews the exact
 * attachments, and sends Finance ONE email carrying BOTH PDFs for every
 * selected technician — ten technicians, twenty PDFs, one email.
 *
 *   PREPARE renders each selected technician's timesheet and attendance with
 *     the SAME renderers the preview and download use (the version in force),
 *     requires each to be exactly one page, stores every file write-once under
 *     the package, and records a MANIFEST: technician, document, file name,
 *     storage key, SHA-256, size, page count and version. Nothing is sent.
 *     Refused, naming the technician, when a selected month is not submitted,
 *     has a correction waiting, or was already sent and not corrected since;
 *     refused when the files together are over Microsoft 365's limit for one
 *     email — never split into several emails. One open package per month.
 *   SEND claims the package (prepared or failed → sending) in one conditional
 *     write, so two clicks, a retry or two office users produce ONE send; asks
 *     the email adapter whether this deployment can send at all BEFORE claiming;
 *     hands the provider one message with every stored attachment; records
 *     what the PROVIDER said (accepted for delivery is not "delivered"). A
 *     failure is recorded as failed, with its reason, and may be sent again;
 *     a sent package never changes.
 *   A COORDINATOR'S MONTH (TS-ROLE-1, 1 November 2026) carries ONE PDF, the
 *     attendance: Coordinators keep no timesheet.
 *   AFTER A CORRECTION. A sent package is never altered or re-sent. A
 *     technician whose month was corrected after their package was sent (an
 *     accepted timesheet correction, or the office correcting the register)
 *     shows as "corrected after sending", and may be included in a NEW package,
 *     whose files are marked CORRECTED in their names.
 *
 * Everything is audited: who prepared and who sent, the month, the recipient,
 * the technicians, the file names, the time, the provider's answer and the
 * package's identifier. The files of any package can be downloaded again by
 * the office exactly as they were stored.
 */

const refuse = (message: string, code: string, detail: string): WorkflowError =>
  new WorkflowError(message, [{ code, message: detail }]);

const assertFinance = (context: OperationContext): void => {
  if (can(context.actor.role, 'payroll.finance')) return;
  throw refuse('Only the office prepares the Finance package.', 'not_permitted', 'A Senior Tech or the Office does.');
};

export type PayrollRowStatus =
  | 'not_submitted'
  | 'ready'
  | 'correction_pending'
  | 'sent'
  | 'corrected_after_sent'
  /** REPEAT-DATES-1: sent before, and a further submission made since — only that one goes, in addition. */
  | 'added_after_sent';

/** PAYROLL-ONE-1: one payroll submission a month's package carries for a person. */
export interface PayrollMonthSubmission {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly label: string;
  /** "Timesheet and attendance", or "Attendance only — no timesheet required". */
  readonly type: string;
  readonly timesheetRequired: boolean;
  readonly fileNames: { readonly timesheet: string; readonly attendance: string };
  readonly submittedAt: IsoDateTime;
  /** True when it replaced an earlier submission (kept, and no longer counted). */
  readonly replacesEarlier: boolean;
}

export interface PayrollMonthRow {
  readonly technician: { readonly id: UserId; readonly name: string; readonly documentName: string; readonly active: boolean; readonly role: UserRole };
  readonly status: PayrollRowStatus;
  /** Plain words for the status, and anything the office should look at. */
  readonly detail: string;
  readonly submittedAt: IsoDateTime | null;
  readonly fileNames: { readonly timesheet: string; readonly attendance: string };
  /** False for a month that is attendance only — a Coordinator's (TS-ROLE-1). */
  readonly timesheetRequired: boolean;
  readonly timesheetVersion: string;
  readonly attendanceChangedAfterSubmission: number;
  readonly unrecordedWeekdays: number;
  /** The last SENT package carrying this technician's month, if any. */
  readonly sentIn: { readonly packageId: string; readonly sentAt: IsoDateTime } | null;
  /** May be ticked for a new package. */
  readonly selectable: boolean;
  /** PAYROLL-ONE-1: the CURRENT payroll submissions whose Finance month (the month of To) is this one. */
  readonly submissions: readonly PayrollMonthSubmission[];
  /**
   * REPEAT-DATES-1: for the office to REVIEW, never a refusal — each of this month's submissions that shares days
   * with another of the person's submissions (any month, any kind), named both ways, with the shared days and
   * whether the other one already went to Finance. A repeated date alone is not a duplicate: each submission
   * carries its own lines, and no line is in two (`timesheet_submitted_lines`).
   */
  readonly repeatedDates: readonly RepeatedDates[];
}

export interface RepeatedDates {
  readonly submission: { readonly id: string; readonly label: string; readonly submittedAt: IsoDateTime };
  readonly earlier: { readonly id: string; readonly kind: 'payroll' | 'monthly' | 'timesheet'; readonly label: string; readonly submittedAt: IsoDateTime | null; readonly sentToFinanceAt: IsoDateTime | null; readonly timesheetRequired: boolean };
  readonly from: string;
  readonly to: string;
  readonly label: string;
}

export interface FinancePackageView extends FinancePackage {
  readonly preparedByName: string | null;
  readonly sentByName: string | null;
  readonly technicianNames: readonly string[];
}

export interface PayrollMonthView {
  readonly month: string;
  readonly monthLabel: string;
  readonly rows: readonly PayrollMonthRow[];
  readonly recipient: string;
  readonly email: { readonly ready: boolean; readonly detail: string };
  readonly maxBytes: number;
  readonly packages: readonly FinancePackageView[];
}

const nameOf = async (context: OperationContext, id: UserId | null): Promise<string | null> => {
  if (id === null) return null;
  const user = await context.repos.users.findById(id);
  return user === null ? null : userFullName(user);
};

const emailReadiness = (context: OperationContext): { ready: boolean; detail: string } =>
  context.services.email.readiness?.() ?? { ready: true, detail: 'The email adapter is configured.' };

const viewOf = async (context: OperationContext, financePackage: FinancePackage): Promise<FinancePackageView> => ({
  ...financePackage,
  preparedByName: await nameOf(context, financePackage.preparedBy),
  sentByName: await nameOf(context, financePackage.sentBy),
  technicianNames: [...new Set(financePackage.attachments.map((attachment) => attachment.technicianName))],
});

/** When this technician's month last changed after submission: an accepted correction, or the office's register correction. */
/**
 * The timesheet periods a month's package prints for one person: the month's
 * own (a month submitted with it, before TS-PAPER), or the payday submissions
 * ending in the month.
 */
const timesheetPeriodsOf = async (context: OperationContext, person: User, month: string) =>
  paydayTimesheetsEnding(context, person.id, month);

const correctedSince = async (context: OperationContext, person: User, month: string, since: IsoDateTime): Promise<boolean> => {
  const { from, to } = monthBounds(month);
  for (const period of await timesheetPeriodsOf(context, person, month)) {
    const corrections = await context.repos.attendance.listCorrections(period.id);
    if (corrections.some((correction) => correction.status === 'accepted' && (correction.decidedAt ?? '') > since)) return true;
  }
  const records = await context.repos.attendance.listRecords(from, to, person.id);
  return records.some((record) => record.recordedAt > since && record.recordedBy !== person.id);
};

/** The month for the office: every technician, their status, the recipient and the packages. */
export const loadPayrollMonth = async (context: OperationContext, month: string): Promise<PayrollMonthView> => {
  assertFinance(context);
  assertPayrollMonth(month);
  const [users, submissions, packages, settings, periodSubmissions] = await Promise.all([
    context.repos.users.list(),
    context.repos.payroll.listSubmissions(month),
    context.repos.payroll.listPackages(month),
    context.repos.settings.get(),
    context.repos.payroll.listPayrollSubmissionsForMonth(month),
  ]);
  // PAYROLL-ONE-1: a replaced submission is kept and never counted again; only the current ones are.
  const submitted = new Map(submissions.filter((submission) => (submission.supersededAt ?? null) === null).map((submission) => [submission.userId, submission]));
  const currentPeriods = periodSubmissions.filter((submission) => (submission.supersededAt ?? null) === null);
  const allReplaced = new Set(periodSubmissions.map((submission) => submission.supersededBySubmission).filter((id) => id !== null));
  const replacedMonthly = new Set(submissions.map((submission) => submission.supersededBySubmission ?? null).filter((id) => id !== null));
  const sentPackages = packages.filter((financePackage) => financePackage.status === 'sent');
  // EVERY USER — Masters, Coordinators and Technicians (the tester, 30 October
  // 2026): everybody on the payroll submits a month. A disabled user still
  // appears for a month they submitted, so nothing submitted is ever hidden.
  const people = users
    .filter((user) => user.active || submitted.has(user.id) || currentPeriods.some((submission) => submission.userId === user.id))
    .sort((a, b) => a.firstName.localeCompare(b.firstName) || a.lastName.localeCompare(b.lastName));

  const rows: PayrollMonthRow[] = [];
  for (const person of people) {
    const forms = await loadMonthlyForms(context, person.id, month);
    const lastSent = sentPackages
      .filter((financePackage) => financePackage.attachments.some((attachment) => attachment.technicianId === person.id))
      .sort((a, b) => (b.sentAt ?? '').localeCompare(a.sentAt ?? ''))[0];
    const legacy = submitted.get(person.id) ?? null;
    const mine = currentPeriods.filter((submission) => submission.userId === person.id);
    const latest = [legacy?.submittedAt ?? null, ...mine.map((submission) => submission.submittedAt)].filter((at): at is string => at !== null).sort().at(-1) ?? null;
    const basis = await basisOf(context, person.id, month);
    const sentBasis = lastSent?.attachments.find((attachment) => attachment.technicianId === person.id)?.basis;
    // A period's attendance changed in the register after it was submitted: said to the office; Finance gets it as submitted.
    const periodChanges: string[] = [];
    for (const period of mine) {
      const records = await context.repos.attendance.listRecords(period.from, period.to, person.id);
      periodChanges.push(...attendanceChanges(period.attendance.days, attendancePeriodDays(period.from, period.to, records)));
    }
    // Either kind of submission makes the month submitted; `submission` keeps its old meaning (the legacy month) below.
    const submission = legacy === null && mine.length === 0 ? null : { submittedAt: latest!, attendance: legacy?.attendance ?? null };
    const periods = await timesheetPeriodsOf(context, person, month);
    let correctionPending = forms.timesheet.correctionPending;
    for (const period of periods) {
      if ((await context.repos.attendance.listCorrections(period.id)).some((correction) => correction.status === 'pending')) correctionPending = true;
    }
    let status: PayrollRowStatus;
    let detail: string;
    if (submission === null) {
      status = 'not_submitted';
      detail = 'Not submitted yet';
    } else if (correctionPending) {
      status = 'correction_pending';
      detail = 'A timesheet correction is waiting for the office’s decision';
    } else if (lastSent !== undefined && lastSent.sentAt !== null) {
      // What was sent is known exactly when the packages recorded their basis; before v1.5.2, by time.
      const against = sentBasis !== undefined ? freshAgainst(basis, sentPartsFor(sentPackages, person.id)) : null;
      const corrected = against !== null
        ? against.changed
        : submission.submittedAt > lastSent.sentAt || (await correctedSince(context, person, month, lastSent.sentAt));
      status = corrected ? 'corrected_after_sent' : against !== null && against.fresh.length > 0 ? 'added_after_sent' : 'sent';
      detail = corrected
        ? `Corrected after it was sent to Finance on ${lastSent.sentAt.slice(0, 10)} — can be sent again, marked CORRECTED`
        : status === 'added_after_sent'
          ? `Sent to Finance on ${lastSent.sentAt.slice(0, 10)}; a further submission was made since — only it can be sent, in addition (what was sent is never sent again)`
          : `Sent to Finance on ${lastSent.sentAt.slice(0, 10)}`;
    } else {
      status = 'ready';
      detail = 'Submitted — ready to include';
    }
    for (const period of mine) {
      detail += `; ${formatPeriod(period.from, period.to)}: ${period.timesheetRequired ? 'timesheet and attendance' : 'attendance only — no timesheet required'}`;
    }
    const changedDays = (legacy === null ? 0 : forms.attendance.changedAfterSubmission.length) + periodChanges.length;
    if (changedDays > 0) {
      detail += `; ${changedDays} attendance day(s) changed in the register after submission — Finance gets the attendance as submitted`;
    }
    // REPEAT-DATES-1: each pair said once, on the later submission of this month.
    const others = await currentSubmissions(context, person);
    const repeatedDates: RepeatedDates[] = [];
    const sentAtOf = async (kind: 'payroll' | 'monthly' | 'timesheet', id: string, financeMonth: string): Promise<IsoDateTime | null> => {
      const part = kind === 'payroll' ? `period:${id}` : kind === 'monthly' ? `month:${id}` : `timesheet:${id}`;
      const found = (financeMonth === month ? packages : await context.repos.payroll.listPackages(financeMonth))
        .filter((financePackage) => financePackage.status === 'sent' && financePackage.attachments.some((attachment) => attachment.technicianId === person.id && partsOf(attachment.basis).some((sent) => rootOf(sent) === part)))
        .map((financePackage) => financePackage.sentAt ?? '')
        .sort()[0];
      return found ?? null;
    };
    for (const period of mine) {
      const candidates = [
        ...others.payroll.filter((other) => other.id !== period.id).map((other) => ({ kind: 'payroll' as const, id: other.id, from: other.from, to: other.to, submittedAt: other.submittedAt as IsoDateTime | null, financeMonth: other.financeMonth, timesheetRequired: other.timesheetRequired })),
        ...others.monthly.map((other) => ({ kind: 'monthly' as const, id: other.id, ...monthBounds(other.month), submittedAt: other.submittedAt as IsoDateTime | null, financeMonth: other.month, timesheetRequired: other.timesheetPeriodId !== null })),
        ...others.periods
          .filter((other) => !others.payroll.some((submission) => submission.timesheetPeriodId === other.id))
          .map((other) => ({ kind: 'timesheet' as const, id: other.id, from: other.from, to: other.to, submittedAt: other.submittedAt, financeMonth: other.to.slice(0, 7), timesheetRequired: true })),
      ];
      for (const other of candidates) {
        const from = other.from > period.from ? other.from : period.from;
        const to = other.to < period.to ? other.to : period.to;
        if (from > to) continue;
        // Both in this month: said on the later one only (the same moment: on the later id).
        const otherAt = other.submittedAt ?? '';
        if (other.kind === 'payroll' && mine.some((candidate) => candidate.id === other.id) && (otherAt > period.submittedAt || (otherAt === period.submittedAt && other.id > period.id))) continue;
        repeatedDates.push({
          submission: { id: period.id, label: formatPeriod(period.from, period.to), submittedAt: period.submittedAt },
          earlier: {
            id: other.id,
            kind: other.kind,
            label: `${other.kind === 'monthly' ? 'Monthly forms ' : other.kind === 'timesheet' ? 'Timesheet ' : ''}${formatPeriod(other.from, other.to)}`,
            submittedAt: other.submittedAt,
            sentToFinanceAt: await sentAtOf(other.kind, other.id, other.financeMonth),
            timesheetRequired: other.timesheetRequired,
          },
          from,
          to,
          label: formatPeriod(from, to),
        });
      }
    }
    if (repeatedDates.length > 0) {
      detail += `; review: ${repeatedDates.length} submission pair${repeatedDates.length === 1 ? ' shares' : 's share'} dates — allowed, each with its own lines`;
    }
    rows.push({
      technician: { id: person.id, name: userFullName(person), documentName: documentNameOf(person), active: person.active, role: person.role },
      status,
      detail,
      submittedAt: submission?.submittedAt ?? null,
      fileNames: mine.length > 0 && legacy === null
        ? { timesheet: mine.map((period) => period.fileNames.timesheet).filter((name) => name !== '').join(', '), attendance: mine.map((period) => period.fileNames.attendance).join(', ') }
        : forms.fileNames,
      timesheetRequired: forms.timesheetRequired || mine.some((period) => period.timesheetRequired),
      timesheetVersion: periods.length === 0 && !completesTimesheet(person.role)
        ? forms.timesheet.versionInForce
        : periods.length === 0
          ? 'No timesheet submitted ending in this month'
          : `Timesheet${periods.length === 1 ? '' : 's'} submitted: ${periods.map((period) => formatPeriod(period.from, period.to)).join('; ')}`,
      attendanceChangedAfterSubmission: changedDays,
      unrecordedWeekdays:
        submission === null
          ? forms.attendance.unrecordedWeekdays.length
          : [...(legacy?.attendance.days ?? []), ...mine.flatMap((period) => period.attendance.days)].filter((day) => day.status === null).length,
      sentIn: lastSent === undefined || lastSent.sentAt === null ? null : { packageId: lastSent.id, sentAt: lastSent.sentAt },
      selectable: status === 'ready' || status === 'corrected_after_sent' || status === 'added_after_sent',
      submissions: mine.map((period) => ({
        id: period.id,
        from: period.from,
        to: period.to,
        label: formatPeriod(period.from, period.to),
        type: period.timesheetRequired ? 'Timesheet and attendance' : 'Attendance only — no timesheet required',
        timesheetRequired: period.timesheetRequired,
        fileNames: period.fileNames,
        submittedAt: period.submittedAt,
        replacesEarlier: allReplaced.has(period.id) || replacedMonthly.has(period.id),
      })),
      repeatedDates,
    });
  }
  return {
    month,
    monthLabel: monthTitle(month),
    rows,
    recipient: settings.financeEmail ?? '',
    email: emailReadiness(context),
    maxBytes: FINANCE_PACKAGE_MAX_BYTES,
    packages: await Promise.all(packages.map((financePackage) => viewOf(context, financePackage))),
  };
};

const isEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);

/** PREPARE: render, check, store and record — nothing is sent. */
export const prepareFinancePackage = async (
  context: OperationContext,
  month: string,
  technicianIds: readonly string[],
): Promise<FinancePackageView> => {
  assertFinance(context);
  assertPayrollMonth(month);
  const settings = await context.repos.settings.get();
  const recipient = (settings.financeEmail ?? '').trim();
  if (!isEmail(recipient)) {
    throw refuse('No Finance recipient is set.', 'finance_recipient_missing', 'A Senior Tech sets the Finance email address in Administration → Settings.');
  }
  const unique = [...new Set(technicianIds)];
  if (unique.length === 0) throw refuse('Choose at least one technician.', 'no_technicians', 'Tick the technicians to include.');
  if (unique.length !== technicianIds.length) throw refuse('A technician was chosen twice.', 'duplicate_technician', 'Choose each technician once.');

  const month_ = await loadPayrollMonth(context, month);
  const open = month_.packages.find((financePackage) => ['prepared', 'sending', 'failed'].includes(financePackage.status));
  if (open !== undefined) {
    throw refuse(
      `A package for ${month_.monthLabel} is already ${open.status === 'failed' ? 'waiting after a failed send' : open.status}.`,
      'package_open',
      'Send it or discard it first — only one package per month is open at a time.',
    );
  }
  const now = context.services.clock.now();
  const packageId = context.services.ids.next('fpk');
  const attachments: FinancePackageAttachment[] = [];
  // Names people chose themselves (PAYROLL-ONE-1): another person's may be the same, and is told apart by whose it is.
  const chosenNames = new Set<string>();
  for (const technicianId of unique) {
    const row = month_.rows.find((candidate) => candidate.technician.id === technicianId);
    if (row === undefined) throw refuse('That person is not a technician on this month’s list.', 'unknown_technician', 'Reload the month.');
    if (!row.selectable) {
      throw refuse(`${row.technician.name} cannot be included.`, `payroll_${row.status}`, row.detail);
    }
    const correctedResend = row.status === 'corrected_after_sent';
    const basis = await basisOf(context, row.technician.id, month);
    // REPEAT-DATES-1: a further submission goes on its own — what Finance already has is never sent again.
    const already = row.status === 'added_after_sent' ? sentPartsFor(month_.packages, row.technician.id) : new Set<string>();
    const fresh = (part: string) => ![...already].some((sent) => rootOf(sent) === part);
    const sheets: { readonly document: TimesheetDocument; readonly rendered: ReturnType<typeof renderTimesheetPdf> }[] = [];
    const attendances: { readonly rendered: { readonly fileName: string; readonly bytes: Uint8Array; readonly pageCount: number }; readonly versionLabel: string }[] = [];
    // PAYROLL-ONE-1: this person's current payroll submissions of the month, each with the names it went under.
    const periodsOfMonth: readonly PayrollSubmission[] = (await context.repos.payroll.listPayrollSubmissionsForMonth(month)).filter(
      (submission) => submission.userId === row.technician.id && (submission.supersededAt ?? null) === null,
    );
    try {
      // TS-PAPER-7: the one rule — every current submission ending in the month, in its version in force.
      for (const period of await paydayTimesheetsEnding(context, row.technician.id, month)) {
        if (!fresh(`timesheet:${period.id}`)) continue;
        const timesheetDocument = await loadSubmissionDocument(context, period.id);
        const half = periodsOfMonth.find((submission) => submission.timesheetPeriodId === period.id);
        const document = half === undefined ? timesheetDocument : { ...timesheetDocument, fileName: half.fileNames.timesheet };
        if (half !== undefined) chosenNames.add(half.fileNames.timesheet);
        sheets.push({ document, rendered: renderTimesheetPdf(document, { generatedAt: now }) });
      }
      // The calendar month's attendance, when it was submitted the way it was before PAYROLL-ONE-1 (and is still current).
      const legacy = await context.repos.payroll.findSubmission(row.technician.id, month);
      if (legacy !== null && (legacy.supersededAt ?? null) === null && fresh(`month:${legacy.id}`)) {
        // As SUBMITTED: a submitted record is what goes to Finance, never the register as it is now.
        const attendanceDocument = await loadAttendanceDocument(context, technicianId, month, 'submitted');
        attendances.push({ rendered: renderAttendancePdf(attendanceDocument, { generatedAt: now }), versionLabel: attendanceDocument.versionLabel });
      }
      // A period's attendance: exactly the PDF stored when it was submitted, under its name.
      for (const submission of periodsOfMonth) {
        if (!fresh(`period:${submission.id}`)) continue;
        const stored = await loadSubmittedPayrollDocument(context, submission.id, 'attendance');
        chosenNames.add(stored.fileName);
        attendances.push({ rendered: { fileName: stored.fileName, bytes: stored.bytes, pageCount: stored.pageCount }, versionLabel: `As submitted for ${formatPeriod(submission.from, submission.to)}` });
      }
    } catch (cause) {
      if (cause instanceof OnePageOverflow) {
        throw refuse(`${row.technician.name}’s forms do not fit on one page.`, 'form_too_long_for_one_page', `${cause.message} Shorten the longest comments or notes.`);
      }
      throw cause;
    }
    for (const [kind, rendered, versionLabel] of [
      // Two payday submissions ending in one month: the second file is numbered, never confused with the first.
      ...sheets.map((sheet, index) => ['timesheet', index === 0 ? sheet.rendered : { ...sheet.rendered, fileName: sheet.rendered.fileName.replace(/\.pdf$/u, ` ${index + 1}.pdf`) }, sheet.document.versionLabel || 'Original submission'] as const),
      ...attendances.map((attendance) => ['attendance', attendance.rendered, attendance.versionLabel] as const),
    ]) {
      // TS-PAPER-6: a timesheet may run to several pages; every other payroll form is one page.
      if (kind !== 'timesheet' && rendered.pageCount !== 1) {
        throw refuse(`${row.technician.name}’s ${kind} is not one page.`, 'form_not_one_page', 'Every payroll form except a timesheet must be exactly one page.');
      }
      let fileName = correctedResend ? correctedFileName(rendered.fileName) : rendered.fileName;
      // A name a person chose may be another person's too ("Timesheet.pdf"): it is told apart by whose it is.
      if (chosenNames.has(rendered.fileName) && attachments.some((attachment) => attachment.fileName.toLowerCase() === fileName.toLowerCase())) {
        fileName = `${row.technician.name} - ${fileName}`;
      }
      if (attachments.some((attachment) => attachment.fileName.toLowerCase() === fileName.toLowerCase())) {
        throw refuse(
          `Two attachments would both be called ${fileName}.`,
          'duplicate_file_name',
          'Give each technician a distinct name on documents (Administration → Users) so their files cannot be confused.',
        );
      }
      // The KEY is storage's (letters, digits and . _ - / only — the production
      // store refuses anything else); the human file name travels in the
      // manifest and the stored document beside it.
      const storageKey = `finance-packages/${packageId}/${String(attachments.length + 1).padStart(2, '0')}-${kind}.pdf`;
      await context.services.storage.putDocument({
        storageKey, fileName, contentType: 'application/pdf', bytes: rendered.bytes, renderer: 1, backfilled: false,
      });
      const stored = await context.services.storage.getDocument(storageKey);
      if (stored === null || stored.bytes.byteLength !== rendered.bytes.byteLength) {
        throw refuse('A payroll form could not be stored.', 'payroll_file_not_stored', 'Nothing was prepared. Try again.');
      }
      attachments.push({
        technicianId: row.technician.id,
        technicianName: row.technician.name,
        kind: kind as PayrollDocumentKind,
        fileName,
        storageKey,
        sha256: await sha256Hex(rendered.bytes),
        sizeBytes: rendered.bytes.byteLength,
        pageCount: rendered.pageCount,
        versionLabel: row.status === 'added_after_sent' ? `Additional submission — ${versionLabel}` : versionLabel,
        correctedResend,
        basis,
      });
    }
  }
  const totalBytes = attachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0);
  if (totalBytes > FINANCE_PACKAGE_MAX_BYTES) {
    throw refuse(
      `These ${attachments.length} files come to ${Math.round(totalBytes / 1024)} KB, over the ${Math.round(FINANCE_PACKAGE_MAX_BYTES / 1024)} KB one email may carry.`,
      'package_too_large',
      'Nothing was prepared. The package is never split into several emails; include fewer technicians in this package and the rest in another.',
    );
  }
  const created = await context.repos.payroll.createPackage({
    id: packageId, month, status: 'prepared', recipient, attachments, totalBytes,
    preparedBy: context.actor.id, preparedAt: now, sentBy: null, sendStartedAt: null, sentAt: null,
    providerMessageId: null, providerState: null, failureReason: '', failureKind: null, attempts: 0,
  });
  if (created === null) {
    throw refuse(`A package for ${month_.monthLabel} is already open.`, 'package_open', 'Send it or discard it first.');
  }
  await audit(context, {
    jobId: null,
    type: 'finance_package_prepared',
    summary: `Finance package prepared: ${month_.monthLabel}, ${attachments.length} files for ${unique.length} technician(s)`,
    detail: `Package ${created.id} for ${recipient}, prepared by ${userFullName(context.actor)}. Files: ${attachments.map((attachment) => attachment.fileName).join(', ')}.`,
  });
  return viewOf(context, created);
};

const packageEmail = (financePackage: FinancePackage): { subject: string; body: string } => {
  const technicians = [...new Set(financePackage.attachments.map((attachment) => attachment.technicianName))];
  const corrected = financePackage.attachments.some((attachment) => attachment.correctedResend);
  return {
    subject: `EJE payroll — ${monthTitle(financePackage.month)} — timesheets and attendance (${technicians.length} technician${technicians.length === 1 ? '' : 's'})${corrected ? ' — includes CORRECTED forms' : ''}`,
    body: [
      `Monthly timesheets and attendance for ${monthTitle(financePackage.month)}.`,
      '',
      ...technicians.map((name) => {
        const files = financePackage.attachments.filter((attachment) => attachment.technicianName === name).map((attachment) => attachment.fileName);
        return `${name}: ${files.join(', ')}`;
      }),
      '',
      `${financePackage.attachments.length} attachments. Package reference ${financePackage.id}.`,
      corrected ? 'Files marked CORRECTED replace the versions sent earlier for those technicians.' : '',
      financePackage.attachments.some((attachment) => attachment.versionLabel.startsWith('Additional submission'))
        ? 'Some files are an ADDITIONAL submission, made after an earlier package: they are in addition to what was sent before, never instead of it, and nothing sent before is in them again.'
        : '',
    ].filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\n'),
  };
};

/** SEND: once. Two clicks, a retry or two office users produce one send. */
export const sendFinancePackage = async (context: OperationContext, packageId: string): Promise<FinancePackageView> => {
  assertFinance(context);
  const existing = await context.repos.payroll.findPackage(packageId);
  if (existing === null) throw refuse('That package does not exist.', 'package_not_found', 'Reload the month.');
  if (existing.status === 'sent') {
    throw refuse('This package has already been sent.', 'package_sent', `It was sent ${existing.sentAt?.slice(0, 10) ?? ''}; it is never sent twice.`);
  }
  if (existing.status === 'sending') {
    throw refuse('This package is being sent now.', 'package_sending', 'Wait for the result; it is not sent twice.');
  }
  if (existing.status === 'discarded') throw refuse('This package was discarded.', 'package_discarded', 'Prepare a new one.');
  for (const technicianId of new Set(existing.attachments.map((attachment) => attachment.technicianId))) {
    const recorded = existing.attachments.find((attachment) => attachment.technicianId === technicianId)?.basis;
    if (recorded !== undefined && recorded !== (await basisOf(context, technicianId, existing.month))) {
      const name = existing.attachments.find((attachment) => attachment.technicianId === technicianId)?.technicianName ?? 'A technician';
      throw refuse(
        `${name}’s forms changed after this package was prepared.`,
        'package_out_of_date',
        'A submission was made, replaced or corrected since. Nothing was sent. Discard this package and prepare it again, so Finance gets exactly what is current.',
      );
    }
  }
  const readiness = emailReadiness(context);
  if (!readiness.ready) {
    throw refuse('Email cannot be sent from this deployment.', 'email_not_configured', `${readiness.detail} Nothing was sent; the package stays prepared.`);
  }
  const now = context.services.clock.now();
  const claimed = await context.repos.payroll.transitionPackage(existing.id, ['prepared', 'failed'], 'sending', {
    sentBy: context.actor.id,
    sendStartedAt: now,
    attempts: existing.attempts + 1,
  });
  if (claimed === null) {
    throw refuse('This package is already being sent, or has been.', 'package_not_sendable', 'Reload the month to see its result.');
  }
  const message = packageEmail(claimed);
  let finished: FinancePackage | null;
  try {
    const receipt = await context.services.email.send({
      to: [claimed.recipient],
      subject: message.subject,
      body: message.body,
      attachments: claimed.attachments.map((attachment) => ({ fileName: attachment.fileName, storageKey: attachment.storageKey })),
    });
    finished = receipt.state === 'failed'
      ? await context.repos.payroll.transitionPackage(claimed.id, ['sending'], 'failed', {
          failureReason: receipt.failureReason || 'The provider refused the message.',
          failureKind: receipt.failureKind ?? null,
          providerMessageId: receipt.messageId,
          providerState: receipt.state,
        })
      : await context.repos.payroll.transitionPackage(claimed.id, ['sending'], 'sent', {
          sentAt: context.services.clock.now(),
          providerMessageId: receipt.messageId,
          providerState: receipt.state,
          failureReason: '',
          failureKind: null,
        });
  } catch (cause) {
    finished = await context.repos.payroll.transitionPackage(claimed.id, ['sending'], 'failed', {
      failureReason: cause instanceof Error ? cause.message : String(cause),
      failureKind: deliveryFailureKindOf(cause),
    });
  }
  if (finished === null) throw new Error(`Finance package ${claimed.id} left the sending state unexpectedly`);
  const technicians = [...new Set(finished.attachments.map((attachment) => attachment.technicianName))];
  await audit(context, {
    jobId: null,
    type: finished.status === 'sent' ? 'finance_package_sent' : 'finance_package_failed',
    summary:
      finished.status === 'sent'
        ? `Finance package sent: ${monthTitle(finished.month)} to ${finished.recipient}, ${finished.attachments.length} files`
        : `Finance package NOT sent: ${monthTitle(finished.month)} — ${finished.failureReason}`,
    detail:
      `Package ${finished.id}, attempt ${finished.attempts}, by ${userFullName(context.actor)}. Technicians: ${technicians.join(', ')}. ` +
      `Files: ${finished.attachments.map((attachment) => attachment.fileName).join(', ')}. ` +
      `Provider: ${finished.providerState ?? 'no answer'}${finished.providerMessageId === null ? '' : ` (${finished.providerMessageId})`}.`,
  });
  return viewOf(context, finished);
};

/** DISCARD a prepared or failed package (never a sent one). Its files stay stored, its record stays. */
export const discardFinancePackage = async (context: OperationContext, packageId: string): Promise<FinancePackageView> => {
  assertFinance(context);
  const discarded = await context.repos.payroll.transitionPackage(packageId, ['prepared', 'failed'], 'discarded', {});
  if (discarded === null) {
    throw refuse('Only a package that has not been sent can be discarded.', 'package_not_discardable', 'Reload the month.');
  }
  await audit(context, {
    jobId: null,
    type: 'finance_package_discarded',
    summary: `Finance package discarded: ${monthTitle(discarded.month)}`,
    detail: `Package ${discarded.id}, discarded by ${userFullName(context.actor)}. Nothing was sent.`,
  });
  return viewOf(context, discarded);
};

/** One stored attachment of a package, exactly as it was stored (and sent). The office only. */
export const loadFinancePackageFile = async (
  context: OperationContext,
  packageId: string,
  fileName: string,
): Promise<{ fileName: string; bytes: Uint8Array }> => {
  assertFinance(context);
  const financePackage = await context.repos.payroll.findPackage(packageId);
  const attachment = financePackage?.attachments.find((candidate) => candidate.fileName === fileName);
  if (financePackage === null || attachment === undefined) {
    throw refuse('That file is not in the package.', 'package_file_not_found', 'Reload the month.');
  }
  const stored = await context.services.storage.getDocument(attachment.storageKey);
  if (stored === null) throw refuse('That file could not be read.', 'package_file_missing', 'The stored copy is missing.');
  return { fileName: attachment.fileName, bytes: stored.bytes };
};
