import {
  EMAIL_MAX_ATTEMPTS,
  EMAIL_SENDING_STALE_MS,
  UnknownPlaceholderError,
  can,
  canResendCustomerCopy,
  deliveryRetryAdvice,
  emailRetryAt,
  getJobTypeDefinition,
  isDeliveryFailureKind,
  isPlausibleEmailAddress,
  isRetryableDeliveryFailure,
  renderEmailBody,
  renderEmailSubject,
  siteAddressLine,
  userFullName,
  type CustomerEmail,
  type DeliveryFailureKind,
  type DeliveryRecord,
  type EmailTemplateWithVersion,
  type IsoDateTime,
  type Job,
  type JobId,
  type PlaceholderValues,
} from '@/domain';
import type { AppServices, OperationContext } from './context';
import { audit, notifyOffice } from './audit';
import { WorkflowError } from './errors';
import { ensureSystemEmailTemplates } from './email-templates';

/**
 * THE SIGNED JOB CARD, EMAILED AUTOMATICALLY. INT-EMAIL-3/4 (the owner,
 * 1 November 2026: "A signed job card must automatically be emailed to the
 * customer immediately after the customer signature has been successfully
 * saved and the final signed PDF has been generated").
 *
 * THE SEQUENCE. Issuing a job card (`performIssue`) stores the signed PDF and
 * then calls `queueSignedJobCardEmail` IN THE SAME TRANSACTION: the recipient,
 * the active template for the job type, every placeholder filled, and the
 * stored PDF's key and SHA-256 are written as ONE `email_messages` row. The
 * transaction commits; only then is the email handed to Microsoft — by the
 * API's drain straight after the response is decided, and by the background
 * worker every minute (which is also what resumes after a restart).
 *
 * WHAT CANNOT HAPPEN, and why:
 *  - Two copies for one signature: the row's idempotency key is the job and
 *    the stored document; the database also allows only one queued, sending
 *    or sent email per job, event and document. A replayed signature event
 *    finds the row that exists and changes nothing.
 *  - A guessed address: the recipient is the contact on the job, as it always
 *    was. No address, or not an address → not sent, flagged for the office.
 *  - A wrong or stale attachment: the email carries the key AND checksum of
 *    the stored final PDF; before sending, the stored bytes are checked
 *    against that checksum.
 *  - A composed-wrong email: no active default template, or a template with a
 *    placeholder EJE cannot fill → not sent, flagged for the office.
 *  - The signature failing because Microsoft is down: nothing here is sent
 *    inside the issue, and a provider failure is retried with back-off.
 *  - A permanent error retried for ever: only temporary failures are retried,
 *    at most EMAIL_MAX_ATTEMPTS times.
 *  - An email resent that may already have gone: one that stops in `sending`
 *    (a crash) or times out mid-request is NEVER re-sent automatically; the
 *    office checks Sent Items, then retries if it did not go.
 *  - "Delivered" claimed on Microsoft's say-so: `sent` means Microsoft 365
 *    ACCEPTED it, and the screens say exactly that.
 */

export const SIGNED_JOB_CARD_EVENT = 'signed_job_card' as const;

/** How many due emails one dispatch takes. Small: each is a call to Microsoft. */
const DISPATCH_BATCH = 5;

const refuse = (message: string, code: string, detail: string): WorkflowError =>
  new WorkflowError(message, [{ code, message: detail }]);

/** The idempotency key of the automatic email for one issued document. */
export const signedJobCardKey = (job: Pick<Job, 'id'>, storageKey: string): string =>
  `${SIGNED_JOB_CARD_EVENT}:${job.id}:${storageKey}`;

export const documentTitleFor = (job: Job): string =>
  job.jobType === 'parts' ? (job.courierCollection ? 'Delivery Note' : 'Parts Collection Note') : 'Signed Job Card';

export interface JobCardRecipient {
  /** The address as recorded. May be empty or not an address — that is checked, not guessed. */
  readonly email: string;
  readonly displayName: string;
}

/**
 * Who the customer's copy goes to: the contact named on the job — EJE's
 * existing, designated recipient (DECISION 4) — with the company name as the
 * greeting when the contact record is gone. The address has no fallback.
 */
export const resolveJobCardRecipient = async (context: OperationContext, job: Job): Promise<JobCardRecipient> => {
  const [contact, customer] = await Promise.all([
    context.repos.customers.findContactById(job.contactId),
    context.repos.customers.findById(job.customerId),
  ]);
  return {
    email: contact?.email.trim() ?? '',
    displayName: contact === null ? (customer?.name ?? 'the customer') : `${contact.firstName} ${contact.lastName}`.trim(),
  };
};

const longDate = (iso: string | null): string => {
  if (iso === null || iso.length === 0) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-ZA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Johannesburg' }).format(date);
};

/** Every placeholder's value for this job, read from the records that own them. */
export const signedJobCardValues = async (
  context: OperationContext,
  job: Job,
  recipient: JobCardRecipient,
): Promise<PlaceholderValues> => {
  const [customer, site, machine, technician] = await Promise.all([
    context.repos.customers.findById(job.customerId),
    context.repos.customers.findSiteById(job.siteId),
    job.machineId === null ? Promise.resolve(null) : context.repos.machines.findById(job.machineId),
    job.primaryTechnicianId === null ? Promise.resolve(null) : context.repos.users.findById(job.primaryTechnicianId),
  ]);
  const machineName =
    machine === null
      ? ''
      : [`${machine.manufacturer} ${machine.model}`.trim(), machine.serialNumber.trim().length > 0 ? `(SN ${machine.serialNumber.trim()})` : '']
          .filter((part) => part.length > 0)
          .join(' ');
  return {
    customer_name: recipient.displayName.length > 0 ? recipient.displayName : (customer?.name ?? ''),
    company_name: customer?.name ?? '',
    customer_email: recipient.email,
    job_number: job.jobNumber,
    job_type: getJobTypeDefinition(job.jobType).label,
    machine_name: machineName,
    site_name: site?.name ?? '',
    site_address: site === null ? '' : siteAddressLine(site),
    technician_name: technician === null ? '' : userFullName(technician),
    completion_date: longDate(job.completedAt ?? job.submittedAt ?? null),
    order_number: job.orderNumber.trim(),
    reference: job.referenceNumber.trim(),
    document_title: documentTitleFor(job),
  };
};

/** The job's delivery summary, kept in step with its newest customer email. */
const deliveryFor = (job: Job, email: CustomerEmail, now: IsoDateTime, attempted: boolean): DeliveryRecord => {
  const kind: DeliveryFailureKind | null =
    email.failureKind === null
      ? null
      : isDeliveryFailureKind(email.failureKind)
        ? email.failureKind
        : email.failureKind === 'no_recipient'
          ? 'invalid_recipient'
          : null;
  const previous = job.delivery;
  return {
    messageId: email.providerRequestId ?? '',
    state:
      email.state === 'sent'
        ? 'pending_delivery'
        : email.state === 'failed' || email.state === 'attention'
          ? 'failed'
          : 'sending',
    to: email.recipient,
    acceptedAt: email.state === 'sent' ? (email.sentAt ?? now) : null,
    confirmedAt: null,
    updatedAt: now,
    attempts: (previous?.attempts ?? 0) + (attempted ? 1 : 0),
    failureReason: email.state === 'failed' || email.state === 'attention' ? email.failureReason : '',
    failureKind: email.state === 'failed' || email.state === 'attention' ? kind : null,
  };
};

const syncJobDelivery = async (context: OperationContext, email: CustomerEmail, attempted: boolean): Promise<void> => {
  if (email.jobId === null) return;
  const job = await context.repos.jobs.findById(email.jobId as JobId);
  if (job === null || job.finalDocument === null) return;
  // Only the email for the document the job carries now speaks for it.
  if (email.attachment !== null && email.attachment.storageKey !== job.finalDocument.storageKey) return;
  await context.repos.jobs.save({ ...job, delivery: deliveryFor(job, email, context.services.clock.now(), attempted) });
};

interface Composition {
  readonly state: 'queued' | 'attention';
  readonly recipient: string;
  readonly subject: string;
  readonly body: string;
  readonly template: EmailTemplateWithVersion | null;
  readonly failureKind: string | null;
  readonly failureReason: string;
}

const compose = async (
  context: OperationContext,
  job: Job,
  recipient: JobCardRecipient,
  pinned: { readonly templateId: string; readonly version: number } | null,
): Promise<Composition> => {
  const address = recipient.email.trim();
  const attention = (failureKind: string, failureReason: string, template: EmailTemplateWithVersion | null = null): Composition => ({
    state: 'attention',
    recipient: isPlausibleEmailAddress(address) ? address : '',
    subject: '',
    body: '',
    template,
    failureKind,
    failureReason,
  });

  if (address.length === 0) {
    return attention('no_recipient', 'No email address is recorded for the contact on this job.');
  }
  if (!isPlausibleEmailAddress(address)) {
    return attention('invalid_recipient', `The contact's email address “${address.slice(0, 120)}” is not a valid address.`);
  }

  let template: EmailTemplateWithVersion | null = null;
  if (pinned !== null) {
    const found = await context.repos.emailTemplates.findById(pinned.templateId);
    const version = found === null ? null : await context.repos.emailTemplates.findVersion(pinned.templateId, pinned.version);
    template = found === null || version === null ? null : { ...found, current: version };
  }
  if (template === null) {
    await ensureSystemEmailTemplates(context);
    template = await context.repos.emailTemplates.findDefault(SIGNED_JOB_CARD_EVENT, job.jobType);
  }
  if (template === null) {
    return attention(
      'template_missing',
      `There is no active default email template for ${getJobTypeDefinition(job.jobType).label} signed job cards.`,
    );
  }

  const values = await signedJobCardValues(context, job, { ...recipient, email: address });
  try {
    const subject = renderEmailSubject(template.current.subject, values);
    const body = renderEmailBody(template.current.body, values);
    if (subject.length === 0 || body.length === 0) {
      return attention('template_invalid', `The template “${template.name}” produces an empty subject or message for this job.`, template);
    }
    return { state: 'queued', recipient: address, subject, body, template, failureKind: null, failureReason: '' };
  } catch (cause) {
    if (cause instanceof UnknownPlaceholderError) {
      return attention('template_invalid', `The template “${template.name}” cannot be sent: ${cause.message}`, template);
    }
    throw cause;
  }
};

/**
 * Writes the automatic email for a job's issued document. Idempotent: called
 * twice for the same document (a replayed signature, a double submit) it
 * returns the email written the first time and writes nothing.
 */
export const queueSignedJobCardEmail = async (
  context: OperationContext,
  job: Job,
  recipient: JobCardRecipient,
  options: {
    readonly idempotencyKey?: string;
    readonly retryOf?: CustomerEmail | null;
  } = {},
): Promise<CustomerEmail> => {
  const document = job.finalDocument;
  if (document === null) throw refuse(`${job.jobNumber} has no signed job card to send.`, 'no_final_document', 'Issue the job card first.');

  const key = options.idempotencyKey ?? signedJobCardKey(job, document.storageKey);
  const existing = await context.repos.customerEmails.findByIdempotencyKey(key);
  if (existing !== null) return existing;

  const retryOf = options.retryOf ?? null;
  const pinned =
    retryOf !== null && retryOf.templateId !== null && retryOf.templateVersion !== null && retryOf.failureKind !== 'template_missing' && retryOf.failureKind !== 'template_invalid'
      ? { templateId: retryOf.templateId, version: retryOf.templateVersion }
      : null;
  const composed = await compose(context, job, recipient, pinned);
  const now = context.services.clock.now();

  const email: CustomerEmail = {
    id: context.services.ids.next('email'),
    idempotencyKey: key,
    event: SIGNED_JOB_CARD_EVENT,
    jobId: job.id,
    templateId: composed.template?.id ?? null,
    templateVersionId: composed.template?.current.id ?? null,
    templateName: composed.template?.name ?? '',
    templateVersion: composed.template?.current.version ?? null,
    sender: context.services.email.sender ?? '',
    recipient: composed.recipient,
    cc: [],
    subject: composed.subject,
    body: composed.body,
    // The final signed PDF and nothing else, named by key AND checksum.
    attachment: { storageKey: document.storageKey, fileName: document.fileName, sha256: document.checksumSha256 ?? null },
    state: composed.state,
    attempts: 0,
    nextAttemptAt: composed.state === 'queued' ? now : null,
    lastAttemptAt: null,
    sentAt: null,
    providerRequestId: null,
    failureKind: composed.failureKind,
    failureReason: composed.failureReason,
    retryOf: retryOf?.id ?? null,
    createdAt: now,
    createdBy: context.actor.id,
    updatedAt: now,
  };

  const written = await context.repos.customerEmails.insert(email);
  if (written === 'duplicate') {
    const live = (await context.repos.customerEmails.listForJob(job.id)).find(
      (candidate) =>
        (candidate.state === 'queued' || candidate.state === 'sending' || candidate.state === 'sent') &&
        candidate.attachment?.storageKey === document.storageKey,
    );
    if (live !== undefined) return live;
    const again = await context.repos.customerEmails.findByIdempotencyKey(key);
    if (again !== null) return again;
    throw refuse(`${job.jobNumber}'s email could not be recorded.`, 'email_not_recorded', 'Try again.');
  }

  await audit(context, {
    jobId: job.id,
    type: email.state === 'queued' ? 'customer_email_queued' : 'customer_email_attention',
    summary: email.state === 'queued' ? 'Signed job card email queued' : 'Signed job card email needs the office',
    detail:
      email.state === 'queued'
        ? `“${email.subject}” to ${email.recipient}, from ${email.sender.length > 0 ? email.sender : 'the configured mailbox'}, with ${document.fileName} attached (template “${email.templateName}”, version ${email.templateVersion}). Queued is not sent: the email history records what Microsoft 365 says.`
        : `${email.failureReason} Nothing was composed or sent.`,
  });
  if (email.state === 'attention') {
    await notifyOffice(context, {
      type: 'job_submitted',
      title: `${job.jobNumber} — signed job card not emailed`,
      body: `${job.jobNumber}'s signed job card could not be emailed to the customer: ${email.failureReason} Correct it and retry from the job.`,
      jobId: job.id,
      link: `/jobs/${job.jobNumber}`,
    });
  }
  await syncJobDelivery(context, email, false);
  return email;
};

/* -------------------------------------------------------------------------- */
/* Sending                                                                    */
/* -------------------------------------------------------------------------- */

export type EmailAttemptOutcome =
  | { readonly kind: 'sent'; readonly providerRequestId: string }
  | {
      readonly kind: 'failed';
      readonly failureKind: string;
      readonly reason: string;
      readonly retryable: boolean;
      readonly retryAfterSeconds: number | null;
    };

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

/**
 * One attempt at one claimed email. Touches NO repository: it runs outside
 * any transaction, between the claim and the record. Never throws.
 */
export const attemptCustomerEmail = async (services: AppServices, email: CustomerEmail): Promise<EmailAttemptOutcome> => {
  if (email.attachment !== null) {
    const stored = await services.storage.getDocument(email.attachment.storageKey).catch(() => null);
    if (stored === null) {
      return { kind: 'failed', failureKind: 'document_unavailable', reason: 'The signed job card PDF could not be read from storage, so nothing was sent.', retryable: false, retryAfterSeconds: null };
    }
    if (email.attachment.sha256 !== null) {
      const actual = stored.sha256 ?? (await sha256Hex(stored.bytes));
      if (actual.toLowerCase() !== email.attachment.sha256.toLowerCase()) {
        return {
          kind: 'failed',
          failureKind: 'document_changed',
          reason: 'The stored PDF no longer matches the signed job card this email was composed for, so it was not sent.',
          retryable: false,
          retryAfterSeconds: null,
        };
      }
    }
  }
  try {
    const receipt = await services.email.send({
      to: [email.recipient],
      cc: [...email.cc],
      subject: email.subject,
      body: email.body,
      attachments: email.attachment === null ? [] : [{ fileName: email.attachment.fileName, storageKey: email.attachment.storageKey }],
      reference: email.id,
    });
    if (receipt.state === 'failed') {
      const kind = receipt.failureKind ?? null;
      return {
        kind: 'failed',
        failureKind: kind ?? 'unclassified',
        reason: receipt.failureReason,
        retryable: kind !== null && isRetryableDeliveryFailure(kind),
        retryAfterSeconds: null,
      };
    }
    return { kind: 'sent', providerRequestId: receipt.messageId };
  } catch (cause) {
    const failure = cause as { kind?: unknown; retryAfterSeconds?: unknown; uncertain?: unknown; message?: unknown };
    const reason = typeof failure.message === 'string' && failure.message.length > 0 ? failure.message : 'The email could not be sent.';
    if (failure.uncertain === true) {
      return {
        kind: 'failed',
        failureKind: 'uncertain',
        reason: `${reason} Microsoft 365 may have accepted it before the connection was lost.`,
        retryable: false,
        retryAfterSeconds: null,
      };
    }
    /*
     * A transport that names no kind is recorded as UNCLASSIFIED — not
     * guessed at — and is not retried by itself: nobody knows that trying
     * again could help. The office can retry it.
     */
    if (!isDeliveryFailureKind(failure.kind)) {
      return { kind: 'failed', failureKind: 'unclassified', reason, retryable: false, retryAfterSeconds: null };
    }
    return {
      kind: 'failed',
      failureKind: failure.kind,
      reason,
      retryable: isRetryableDeliveryFailure(failure.kind),
      retryAfterSeconds: typeof failure.retryAfterSeconds === 'number' ? failure.retryAfterSeconds : null,
    };
  }
};

const UNCERTAIN_ADVICE =
  'Check the Sent Items of the sending mailbox before retrying: if the email is there, it went and must not be sent again.';

/** Records what an attempt achieved, and keeps the job's summary in step. */
export const recordCustomerEmailOutcome = async (
  context: OperationContext,
  email: CustomerEmail,
  outcome: EmailAttemptOutcome,
): Promise<CustomerEmail> => {
  const now = context.services.clock.now();
  let next: CustomerEmail;
  if (outcome.kind === 'sent') {
    next = { ...email, state: 'sent', sentAt: now, nextAttemptAt: null, providerRequestId: outcome.providerRequestId, failureKind: null, failureReason: '', updatedAt: now };
  } else {
    const retryAt = outcome.retryable ? emailRetryAt(now, email.attempts, outcome.retryAfterSeconds) : null;
    next = {
      ...email,
      state: retryAt === null ? 'failed' : 'queued',
      nextAttemptAt: retryAt,
      failureKind: outcome.failureKind,
      failureReason:
        outcome.failureKind === 'uncertain'
          ? `${outcome.reason} ${UNCERTAIN_ADVICE}`
          : retryAt === null && outcome.retryable
            ? `${outcome.reason} Gave up after ${email.attempts} attempts.`
            : outcome.reason,
      updatedAt: now,
    };
  }
  await context.repos.customerEmails.recordOutcome(email.id, next);

  const job = email.jobId === null ? null : await context.repos.jobs.findById(email.jobId as JobId);
  if (job !== null) {
    if (next.state === 'sent') {
      await audit(context, {
        jobId: job.id,
        type: 'customer_email_sent',
        summary: 'Signed job card email accepted by Microsoft 365',
        detail: `Attempt ${email.attempts}: “${next.subject}” to ${next.recipient} from ${next.sender}, with ${next.attachment?.fileName ?? 'no attachment'}. Accepted for delivery (reference ${next.providerRequestId}); this is not a confirmation that the customer received it.`,
      });
    } else if (next.state === 'queued') {
      await audit(context, {
        jobId: job.id,
        type: 'customer_email_failed',
        summary: 'Signed job card email attempt failed — will retry',
        detail: `Attempt ${email.attempts} to ${next.recipient} failed: ${next.failureReason} The next attempt is at ${next.nextAttemptAt}.`,
      });
    } else {
      await audit(context, {
        jobId: job.id,
        type: 'customer_email_failed',
        summary: 'Signed job card email failed',
        detail: `Attempt ${email.attempts} to ${next.recipient} failed and will not be retried automatically: ${next.failureReason}${
          isDeliveryFailureKind(next.failureKind) && deliveryRetryAdvice(next.failureKind).length > 0 ? ` ${deliveryRetryAdvice(next.failureKind)}` : ''
        }`,
      });
      await notifyOffice(context, {
        type: 'job_submitted',
        title: `${job.jobNumber} — signed job card email failed`,
        body: `The signed job card for ${job.jobNumber} could not be emailed to ${next.recipient}: ${next.failureReason}`,
        jobId: job.id,
        link: `/jobs/${job.jobNumber}`,
      });
    }
  }
  await syncJobDelivery(context, next, true);
  return next;
};

/**
 * An email that has sat in `sending` for ten minutes belongs to a process
 * that stopped mid-send. It may have gone. It is marked failed (uncertain) and
 * NOT re-sent — the office decides, after checking Sent Items.
 */
export const expireStuckCustomerEmails = async (context: OperationContext): Promise<number> => {
  const before = new Date(Date.parse(context.services.clock.now()) - EMAIL_SENDING_STALE_MS).toISOString() as IsoDateTime;
  const stuck = await context.repos.customerEmails.listStuckSending(before);
  for (const email of stuck) {
    await recordCustomerEmailOutcome(context, email, {
      kind: 'failed',
      failureKind: 'uncertain',
      reason: 'The application stopped while this email was being handed to Microsoft 365.',
      retryable: false,
      retryAfterSeconds: null,
    });
  }
  return stuck.length;
};

/**
 * Claim, attempt and record, all in ONE context. What a test or a script
 * does after an operation; the server instead claims and records in separate
 * transactions with the attempt between them (`server/api/email-dispatch.ts`).
 */
export const dispatchCustomerEmailsInline = async (context: OperationContext): Promise<number> => {
  await expireStuckCustomerEmails(context);
  const claimed = await context.repos.customerEmails.claimDue(context.services.clock.now(), DISPATCH_BATCH);
  for (const email of claimed) {
    await recordCustomerEmailOutcome(context, email, await attemptCustomerEmail(context.services, email));
  }
  return claimed.length;
};

/**
 * After an issue: queue the email and — outside the API, where nothing will
 * drain it after a commit — dispatch it now. Returns the job as it then is.
 */
export const emailIssuedJobCard = async (context: OperationContext, job: Job, recipient: JobCardRecipient): Promise<Job> => {
  await queueSignedJobCardEmail(context, job, recipient);
  if (context.deferDelivery !== true) await dispatchCustomerEmailsInline(context);
  return (await context.repos.jobs.findById(job.id)) ?? job;
};

/* -------------------------------------------------------------------------- */
/* History and retry                                                          */
/* -------------------------------------------------------------------------- */

const assertOffice = (context: OperationContext): void => {
  if (!can(context.actor.role, 'jobs.officeHandling')) {
    throw refuse('Only the office sees and retries customer emails.', 'not_permitted', 'A Master or a Coordinator handles customer emails.');
  }
};

/** The job's customer emails, newest first: exactly what was (or will be) sent. */
export const listJobEmails = async (context: OperationContext, job: Job): Promise<readonly CustomerEmail[]> => {
  assertOffice(context);
  return context.repos.customerEmails.listForJob(job.id);
};

/**
 * THE OFFICE'S RETRY. Only once the newest email for the job's document has
 * STOPPED (failed, or needing attention) — never while one is queued or with
 * Microsoft, and never once one was sent. A retry is a NEW email record: the
 * failed one stays in the history exactly as it was. The recipient is read
 * again (so a corrected address is used) and the same template version is
 * used again, unless the template itself was the problem.
 *
 * An UNCERTAIN failure may already be in the customer's inbox: retrying it
 * requires `confirmNotSent`, the office's statement that Sent Items was checked.
 */
export const retryCustomerEmail = async (
  context: OperationContext,
  job: Job,
  options: { readonly confirmNotSent?: boolean } = {},
): Promise<CustomerEmail> => {
  // The office, and the technician who submits job cards (CR-07): the same
  // people who could always re-send the customer's copy.
  if (!canResendCustomerCopy(context.actor.role)) {
    throw refuse(`${job.jobNumber} cannot be re-sent by you.`, 'not_permitted', 'Your role does not send a customer their job card.');
  }
  const document = job.finalDocument;
  if (document === null) throw refuse(`${job.jobNumber} has no signed job card to send.`, 'no_final_document', 'Issue the job card first.');
  const history = (await context.repos.customerEmails.listForJob(job.id)).filter(
    (email) => email.attachment?.storageKey === document.storageKey,
  );
  const latest = history[0] ?? null;
  /*
   * RETRY NOW. An email waiting out a back-off after a temporary failure is
   * not re-written — that would be a second copy waiting — it is simply made
   * due now, the same record, the same idempotency key.
   */
  if (latest !== null && latest.state === 'queued' && latest.attempts > 0) {
    const now = context.services.clock.now();
    await context.repos.customerEmails.recordOutcome(latest.id, { ...latest, nextAttemptAt: now, updatedAt: now });
    await audit(context, {
      jobId: job.id,
      type: 'customer_email_retried',
      summary: 'Signed job card email retried now',
      detail: `${userFullName(context.actor)} asked for the waiting email to ${latest.recipient} to be tried now, instead of at ${latest.nextAttemptAt}.`,
    });
    if (context.deferDelivery !== true) await dispatchCustomerEmailsInline(context);
    return (await context.repos.customerEmails.findById(latest.id)) ?? latest;
  }
  if (latest !== null && (latest.state === 'queued' || latest.state === 'sending')) {
    throw refuse(
      `${job.jobNumber}'s email is already on its way.`,
      'delivery_in_flight',
      latest.state === 'queued'
        ? `It is queued${latest.nextAttemptAt === null ? '' : ` for ${latest.nextAttemptAt}`}. Wait for it rather than sending the customer a second copy.`
        : 'It is with Microsoft 365 right now. Wait for the result rather than sending a second copy.',
    );
  }
  if (latest !== null && latest.state === 'sent') {
    throw refuse(
      `${job.jobNumber}'s signed job card was already sent.`,
      'already_sent',
      `Microsoft 365 accepted it for ${latest.recipient} on ${latest.sentAt}. Sending it again would give the customer a second copy.`,
    );
  }
  if (latest !== null && latest.failureKind === 'uncertain' && options.confirmNotSent !== true) {
    throw refuse(
      'Check Sent Items first.',
      'confirm_not_sent',
      `The last attempt may have reached Microsoft 365. ${UNCERTAIN_ADVICE} Then confirm it is not there to retry.`,
    );
  }

  const recipient = await resolveJobCardRecipient(context, job);
  const email = await queueSignedJobCardEmail(context, job, recipient, {
    // Never the automatic key: a retry is its own, new record.
    idempotencyKey: latest === null ? signedJobCardKey(job, document.storageKey) : `${signedJobCardKey(job, document.storageKey)}:retry:${history.length}`,
    retryOf: latest,
  });
  await audit(context, {
    jobId: job.id,
    type: 'customer_email_retried',
    summary: 'Signed job card email retried',
    detail:
      `${userFullName(context.actor)} retried the signed job card email` +
      (latest === null ? '.' : ` after: ${latest.failureReason}`) +
      (latest?.failureKind === 'uncertain' ? ' They confirmed it was not in Sent Items.' : '') +
      (email.state === 'attention' ? ` It still cannot be sent: ${email.failureReason}` : ` Queued for ${email.recipient}.`),
  });
  if (context.deferDelivery !== true) await dispatchCustomerEmailsInline(context);
  return (await context.repos.customerEmails.findById(email.id)) ?? email;
};

/** True when the job has a customer email still to settle. For the screens. */
export const emailMaxAttempts = EMAIL_MAX_ATTEMPTS;
