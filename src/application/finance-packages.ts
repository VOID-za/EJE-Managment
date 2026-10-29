import {
  FINANCE_PACKAGE_MAX_BYTES,
  can,
  userFullName,
  type FinancePackage,
  type FinancePackageAttachment,
  type IsoDateTime,
  type PayrollDocumentKind,
  type User,
  type UserId,
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
import { assertPayrollMonth, loadAttendanceDocument } from './attendance-document';
import { loadMonthlyForms } from './monthly-submissions';
import { loadTimesheetDocument } from './timesheets';

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
  throw refuse('Only the office prepares the Finance package.', 'not_permitted', 'A Master or a Coordinator does.');
};

export type PayrollRowStatus =
  | 'not_submitted'
  | 'ready'
  | 'correction_pending'
  | 'sent'
  | 'corrected_after_sent';

export interface PayrollMonthRow {
  readonly technician: { readonly id: UserId; readonly name: string; readonly documentName: string; readonly active: boolean };
  readonly status: PayrollRowStatus;
  /** Plain words for the status, and anything the office should look at. */
  readonly detail: string;
  readonly submittedAt: IsoDateTime | null;
  readonly fileNames: { readonly timesheet: string; readonly attendance: string };
  readonly timesheetVersion: string;
  readonly attendanceChangedAfterSubmission: number;
  readonly unrecordedWeekdays: number;
  /** The last SENT package carrying this technician's month, if any. */
  readonly sentIn: { readonly packageId: string; readonly sentAt: IsoDateTime } | null;
  /** May be ticked for a new package. */
  readonly selectable: boolean;
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
const correctedSince = async (context: OperationContext, person: User, month: string, since: IsoDateTime): Promise<boolean> => {
  const { from, to } = monthBounds(month);
  const period = await context.repos.attendance.findPeriod(person.id, from, to);
  if (period !== null) {
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
  const [users, submissions, packages, settings] = await Promise.all([
    context.repos.users.list(),
    context.repos.payroll.listSubmissions(month),
    context.repos.payroll.listPackages(month),
    context.repos.settings.get(),
  ]);
  const submitted = new Map(submissions.map((submission) => [submission.userId, submission]));
  const sentPackages = packages.filter((financePackage) => financePackage.status === 'sent');
  const people = users
    .filter((user) => user.role === 'technician' && (user.active || submitted.has(user.id)))
    .sort((a, b) => a.firstName.localeCompare(b.firstName) || a.lastName.localeCompare(b.lastName));

  const rows: PayrollMonthRow[] = [];
  for (const person of people) {
    const forms = await loadMonthlyForms(context, person.id, month);
    const lastSent = sentPackages
      .filter((financePackage) => financePackage.attachments.some((attachment) => attachment.technicianId === person.id))
      .sort((a, b) => (b.sentAt ?? '').localeCompare(a.sentAt ?? ''))[0];
    const submission = submitted.get(person.id) ?? null;
    let status: PayrollRowStatus;
    let detail: string;
    if (submission === null) {
      status = 'not_submitted';
      detail = forms.problems.length > 0 && !forms.monthEnded ? 'Month not ended' : 'Not submitted by the technician';
    } else if (forms.timesheet.correctionPending) {
      status = 'correction_pending';
      detail = 'A timesheet correction is waiting for the office’s decision';
    } else if (lastSent !== undefined && lastSent.sentAt !== null) {
      const corrected = await correctedSince(context, person, month, lastSent.sentAt);
      status = corrected ? 'corrected_after_sent' : 'sent';
      detail = corrected
        ? `Corrected after it was sent to Finance on ${lastSent.sentAt.slice(0, 10)} — can be sent again, marked CORRECTED`
        : `Sent to Finance on ${lastSent.sentAt.slice(0, 10)}`;
    } else {
      status = 'ready';
      detail = 'Submitted — ready to include';
    }
    if (submission !== null && forms.attendance.changedAfterSubmission.length > 0) {
      detail += `; attendance corrected by the office after submission (${forms.attendance.changedAfterSubmission.length} day(s))`;
    }
    rows.push({
      technician: { id: person.id, name: userFullName(person), documentName: documentNameOf(person), active: person.active },
      status,
      detail,
      submittedAt: submission?.submittedAt ?? null,
      fileNames: forms.fileNames,
      timesheetVersion: forms.timesheet.versionInForce,
      attendanceChangedAfterSubmission: forms.attendance.changedAfterSubmission.length,
      unrecordedWeekdays: submission === null ? forms.attendance.unrecordedWeekdays.length : submission.attendance.days.filter((day) => day.status === null).length,
      sentIn: lastSent === undefined || lastSent.sentAt === null ? null : { packageId: lastSent.id, sentAt: lastSent.sentAt },
      selectable: status === 'ready' || status === 'corrected_after_sent',
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
    throw refuse('No Finance recipient is set.', 'finance_recipient_missing', 'A Master sets the Finance email address in Administration → Settings.');
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
  for (const technicianId of unique) {
    const row = month_.rows.find((candidate) => candidate.technician.id === technicianId);
    if (row === undefined) throw refuse('That person is not a technician on this month’s list.', 'unknown_technician', 'Reload the month.');
    if (!row.selectable) {
      throw refuse(`${row.technician.name} cannot be included.`, `payroll_${row.status}`, row.detail);
    }
    const { from, to } = monthBounds(month);
    const correctedResend = row.status === 'corrected_after_sent';
    let timesheet;
    let attendance;
    try {
      const timesheetDocument = await loadTimesheetDocument(context, technicianId, from, to);
      timesheet = { document: timesheetDocument, rendered: renderTimesheetPdf(timesheetDocument, { generatedAt: now }) };
      const attendanceDocument = await loadAttendanceDocument(context, technicianId, month);
      attendance = { document: attendanceDocument, rendered: renderAttendancePdf(attendanceDocument, { generatedAt: now }) };
    } catch (cause) {
      if (cause instanceof OnePageOverflow) {
        throw refuse(`${row.technician.name}’s forms do not fit on one page.`, 'form_too_long_for_one_page', `${cause.message} Shorten the longest comments or notes.`);
      }
      throw cause;
    }
    for (const [kind, rendered, versionLabel] of [
      ['timesheet', timesheet.rendered, timesheet.document.versionLabel || 'Original submission'],
      ['attendance', attendance.rendered, attendance.document.versionLabel],
    ] as const) {
      if (rendered.pageCount !== 1) {
        throw refuse(`${row.technician.name}’s ${kind} is not one page.`, 'form_not_one_page', 'Every payroll form must be exactly one page.');
      }
      const fileName = correctedResend ? correctedFileName(rendered.fileName) : rendered.fileName;
      if (attachments.some((attachment) => attachment.fileName === fileName)) {
        throw refuse(
          `Two attachments would both be called ${fileName}.`,
          'duplicate_file_name',
          'Give each technician a distinct name on documents (Administration → Users) so their files cannot be confused.',
        );
      }
      const storageKey = `finance-packages/${packageId}/${fileName}`;
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
        versionLabel,
        correctedResend,
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
