import {
  can,
  deliveryStateLabel,
  deliveryRetryAdvice,
  emptyDelivery,
  signatureOutcomeOf,
  userFullName,
  type DeliveryRecord,
  type Job,
  type UnsignedDeliveryAuthorisation,
} from '@/domain';
import type { OperationContext } from './context';
import { WorkflowError } from './errors';
import { audit } from './audit';
import { deliveryFailureKindOf } from '@/services/ports';

/**
 * SENDING A JOB CARD THE CUSTOMER DID NOT SIGN. BD-06, DELIV-7, AUD-4.
 *
 * WHAT WAS TRUE BEFORE THIS, and it was an acceptance blocker: closing a job
 * without a signature sent the customer **nothing**. The unsigned document was
 * rendered, stored and downloadable, and the send was deliberately left as an
 * open business decision. The default was right — a customer who declined to
 * sign must not be e-mailed a copy automatically — and the consequence was
 * that EJE could not send one at all.
 *
 * THE OWNER'S RULE, implemented here in the order they wrote it:
 *
 *   - a technician cannot silently bypass signature/refusal handling (that was
 *     already true: `checkReadyForSubmission` refuses, and the refusal has to
 *     be recorded with a reason);
 *   - the job enters the existing Signature Refused / Master Review workflow
 *     (already true);
 *   - NO automatic delivery merely because the job closed unsigned (already
 *     true, and now true on purpose rather than by omission);
 *   - a MASTER must explicitly authorise any exceptional delivery;
 *   - the authorising user, time, reason, document version, destination and
 *     outcome are recorded;
 *   - nothing is sent to a recipient who was not selected by the existing
 *     customer-communication rules;
 *   - failures stay visible and retryable;
 *   - repeated retries do not produce uncontrolled duplicate messages.
 *
 * WHY THIS IS NOT `sendFinalDocument`. That function belongs to the ORDINARY
 * lifecycle: it moves a job through `awaiting_delivery` and closes it when the
 * provider confirms. This job is already `closed` and must stay closed — BD-06
 * says the resolution ends the job, and a delivery afterwards is an extra act
 * rather than a step. Sharing the function would have meant teaching it a
 * second lifecycle, and the first thing it would have got wrong is the status.
 *
 * AND THE MAIL SAYS SOMETHING DIFFERENT. `finalDocumentMail` says "signed job
 * card", because every document it sends is one. Reusing it here would e-mail
 * a customer who refused to sign a message telling them they had.
 */

const REASON_LIMIT = 2000;

/**
 * The window in which a send already in flight blocks another.
 *
 * The same value and the same reasoning as `retryJobCardDelivery`: a second
 * attempt pressed while the first is still with the provider would send a
 * second copy, and the guard expires so a crash cannot leave a job that can
 * never be sent.
 */
const SENDING_STALE_AFTER_MS = 10 * 60 * 1000;

/** The subject and body of an UNSIGNED copy. One place, so retries match. */
const unsignedDocumentMail = (job: Job) => ({
  subject: `${job.jobNumber} — Job Card (issued without signature)`,
  body:
    `Good day,\n\n` +
    `Please find attached the job card for ${job.jobNumber}.\n\n` +
    'This copy was issued WITHOUT a customer signature. The document itself records that, ' +
    'and why. If anything on it is not as you understood it, please reply to this message.\n\n' +
    `Kind regards\nEJE Industrial Electronics`,
});

/**
 * Is this a job the owner's rule is about: closed, unsigned, with a document?
 *
 * Exported because two screens ask it and the answer must not be worked out
 * twice. It is not an authorisation — see `requireMaster`.
 */
export const isUnsignedIssuedJob = (job: Job): boolean =>
  job.status === 'closed' && job.signature === null && job.finalDocument !== null;

const requireMaster = (context: OperationContext, what: string): void => {
  if (can(context.actor.role, 'jobs.authoriseUnsignedDelivery')) return;
  throw new WorkflowError(what, [
    {
      code: 'not_permitted',
      message:
        'Sending a customer a job card they declined to sign is a Master’s decision. Closing ' +
        'the job without a signature is the office’s, and it has already been done.',
    },
  ]);
};

export const findUnsignedDeliveryAuthorisation = (
  context: OperationContext,
  job: Job,
): Promise<UnsignedDeliveryAuthorisation | null> =>
  context.repos.jobs.findUnsignedDeliveryAuthorisation(job.id);

/**
 * Records a Master's decision to send the unsigned document, and sends it.
 *
 * The authorisation is written BEFORE the attempt, deliberately: if the
 * provider fails, the decision still stands and a retry needs no second one.
 * Writing it afterwards would mean a failed send left no record of who had
 * decided to make it.
 */
export const authoriseUnsignedDelivery = async (
  context: OperationContext,
  job: Job,
  input: { readonly reason: string },
): Promise<{ readonly job: Job; readonly delivery: DeliveryRecord }> => {
  requireMaster(context, `${job.jobNumber} cannot be sent to the customer by you.`);

  const document = job.finalDocument;
  if (document === null) {
    throw new WorkflowError(`${job.jobNumber} has no issued job card to send.`, [
      { code: 'nothing_issued', message: 'There is no document, so there is nothing to send.' },
    ]);
  }
  /*
   * THE SIGNATURE IS CHECKED BEFORE THE STATUS, and the order is the message.
   * A signed job card sitting at `awaiting_delivery` would otherwise be
   * refused as "not closed", which is true and tells the office nothing: the
   * reason they cannot do this is that the customer signed.
   */
  if (job.signature !== null) {
    throw new WorkflowError(`${job.jobNumber} was signed by the customer.`, [
      {
        code: 'already_signed',
        message:
          'A signed job card is sent by the ordinary delivery path, which needs no exceptional ' +
          'authorisation.',
      },
    ]);
  }
  if (job.status !== 'closed') {
    throw new WorkflowError(`${job.jobNumber} is not closed.`, [
      {
        code: 'not_closed',
        message:
          'This is for a job the office closed WITHOUT a customer signature. A job still in ' +
          'the workflow follows the ordinary delivery path.',
      },
    ]);
  }
  /*
   * AND IT MUST BE THE REFUSAL OUTCOME, not merely an unsigned job.
   *
   * `signatureOutcomeOf` is the domain's own reading: a refusal the office
   * resolved by issuing the card as it stands. A job that reached `closed`
   * some other way without a signature is not what this rule is about, and
   * guessing would make this a general-purpose way to e-mail any document.
   */
  if (signatureOutcomeOf(job) !== 'refused') {
    throw new WorkflowError(`${job.jobNumber} has no recorded signature refusal.`, [
      {
        code: 'not_a_refusal',
        message:
          'This authorises sending a job card the customer DECLINED to sign. There is no ' +
          'refusal on this job, so there is nothing exceptional to authorise.',
      },
    ]);
  }

  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw new WorkflowError('Say why this is being sent.', [
      {
        code: 'reason_required',
        message:
          'A customer who refused to sign is being sent the document anyway. The reason is ' +
          'recorded on the audit trail, and somebody will be asked for it.',
      },
    ]);
  }
  if (reason.length > REASON_LIMIT) {
    throw new WorkflowError('That reason is too long.', [
      { code: 'reason_too_long', message: `Keep it under ${REASON_LIMIT} characters.` },
    ]);
  }

  /*
   * THE RECIPIENT IS THE JOB'S OWN CONTACT, AND NOTHING ELSE MAY SUPPLY ONE.
   *
   * It is the SAME resolution the ordinary delivery path uses — the contact
   * person named on the job, never a company mailbox and never a browser's
   * suggestion. The mandate: "Do not send to a recipient who has not been
   * authorised or selected according to the existing customer communication
   * rules."
   *
   * WHY NOT `document.issuedTo`. On an unsigned document that field is empty,
   * and correctly so: it records where the signed copy WAS e-mailed, and
   * nothing was. Filling it in at issue would have made a document that was
   * never sent claim a destination. So the address is resolved here and
   * recorded on the AUTHORISATION, which is where the decision lives.
   */
  const contact = await context.repos.customers.findContactById(job.contactId);
  const recipient = (contact?.email ?? '').trim();
  if (recipient.length === 0) {
    throw new WorkflowError(`${job.jobNumber} has nobody to send the job card to.`, [
      {
        code: 'no_recipient',
        message:
          'The contact person on this job has no e-mail address, so there is nowhere to send ' +
          'it. Add one to the customer’s contact rather than inventing a destination here.',
      },
    ]);
  }

  const existing = await context.repos.jobs.findUnsignedDeliveryAuthorisation(job.id);
  if (existing !== null) {
    throw new WorkflowError(`${job.jobNumber} has already been authorised.`, [
      {
        code: 'already_authorised',
        message:
          `${existing.recipient} was authorised already. Use *Send again* to retry a failed ` +
          'delivery — a second authorisation is a second decision and is not recorded as one.',
      },
    ]);
  }

  const now = context.services.clock.now();
  const authorisation = await context.repos.jobs.saveUnsignedDeliveryAuthorisation({
    id: context.services.ids.next('unsigned-delivery-authorisation'),
    jobId: job.id,
    documentKey: document.storageKey,
    recipient,
    reason,
    authorisedBy: context.actor.id,
    authorisedAt: now,
    createdAt: now,
  });

  await audit(context, {
    jobId: job.id,
    type: 'unsigned_delivery_authorised',
    summary: `Unsigned job card authorised for sending`,
    detail:
      `${userFullName(context.actor)} authorised sending ${document.fileName} — the job card ` +
      `${job.jobNumber} was CLOSED WITHOUT A CUSTOMER SIGNATURE — to ${recipient}. ` +
      `Reason: ${reason}`,
  });

  const delivery = await send(context, job, authorisation);
  return delivery;
};

/**
 * Retries a failed send of an already authorised unsigned document.
 *
 * No second authorisation, by design: the decision was taken and a provider
 * failure does not undo it. What this does re-check is that the document has
 * not changed — a correction does not alter it, and nothing else can, so the
 * check is cheap insurance rather than a live risk.
 */
export const retryUnsignedDelivery = async (
  context: OperationContext,
  job: Job,
): Promise<{ readonly job: Job; readonly delivery: DeliveryRecord }> => {
  requireMaster(context, `${job.jobNumber} cannot be re-sent by you.`);

  const document = job.finalDocument;
  if (document === null) {
    throw new WorkflowError(`${job.jobNumber} has no issued job card to send.`, []);
  }

  const authorisation = await context.repos.jobs.findUnsignedDeliveryAuthorisation(job.id);
  if (authorisation === null) {
    throw new WorkflowError(`${job.jobNumber} has not been authorised for sending.`, [
      {
        code: 'not_authorised',
        message:
          'A job card the customer did not sign is sent only once a Master has authorised it. ' +
          'Nothing has been sent, so there is nothing to retry.',
      },
    ]);
  }
  if (authorisation.documentKey !== document.storageKey) {
    throw new WorkflowError('That authorisation is for a different document.', [
      {
        code: 'authorisation_stale',
        message:
          'The job card on this job is not the one that was authorised. Nothing has been sent.',
      },
    ]);
  }

  return send(context, job, authorisation);
};

/**
 * Hands the stored bytes to the provider and records what it said.
 *
 * NOTHING ABOUT THE JOB'S STATUS CHANGES. It is closed, it stays closed, and
 * a confirmed delivery does not reopen or re-close it — the ordinary path's
 * "delivered closes the job" rule does not apply to a job that is already
 * finished.
 */
const send = async (
  context: OperationContext,
  job: Job,
  authorisation: UnsignedDeliveryAuthorisation,
): Promise<{ readonly job: Job; readonly delivery: DeliveryRecord }> => {
  const document = job.finalDocument;
  if (document === null) {
    throw new WorkflowError(`${job.jobNumber} has no issued job card to send.`, []);
  }

  /*
   * NOT WHILE ONE IS ALREADY IN FLIGHT. The same guard the signed path uses,
   * for the same reason: `sending` is recorded BEFORE the provider is called,
   * so a second press would send the customer a second copy — and with two
   * copies neither the customer nor EJE can tell which is the record. It
   * expires, because a crash between the save and the answer must not leave a
   * job nobody can ever send.
   */
  if (job.delivery !== null && job.delivery.state === 'sending') {
    const startedAt = Date.parse(job.delivery.updatedAt);
    const now = Date.parse(context.services.clock.now());
    const waited = now - startedAt;
    if (Number.isFinite(startedAt) && Number.isFinite(now) && waited < SENDING_STALE_AFTER_MS) {
      throw new WorkflowError(`${job.jobNumber} is being sent right now.`, [
        {
          code: 'delivery_in_flight',
          message:
            `An attempt to send ${job.jobNumber} to ${job.delivery.to} is still with the mail ` +
            'provider. Wait for it to finish rather than sending the customer a second copy.',
        },
      ]);
    }
  }

  const at = context.services.clock.now();
  const attempts = (job.delivery?.attempts ?? 0) + 1;
  const mail = unsignedDocumentMail(job);

  const sending = await context.repos.jobs.save({
    ...job,
    delivery: { ...emptyDelivery(authorisation.recipient, at), state: 'sending', attempts },
  });

  let receipt;
  try {
    receipt = await context.services.email.send({
      to: [authorisation.recipient],
      subject: mail.subject,
      body: mail.body,
      attachments: [{ fileName: document.fileName, storageKey: document.storageKey }],
    });
  } catch (error) {
    receipt = {
      messageId: '',
      state: 'failed' as const,
      failureReason: error instanceof Error ? error.message : 'The provider could not be reached.',
      failureKind: deliveryFailureKindOf(error),
      entry: null,
    };
  }

  const delivery: DeliveryRecord = {
    messageId: receipt.messageId,
    state: receipt.state,
    to: authorisation.recipient,
    acceptedAt: receipt.state === 'failed' ? null : at,
    confirmedAt: receipt.state === 'delivered' ? at : null,
    updatedAt: at,
    attempts,
    failureReason: receipt.failureReason,
    failureKind: receipt.state === 'failed' ? (receipt.failureKind ?? null) : null,
  };

  const saved = await context.repos.jobs.save({ ...sending, delivery });

  await audit(context, {
    jobId: job.id,
    type: 'delivery_state_changed',
    summary: `Unsigned customer copy ${deliveryStateLabel(delivery.state).toLowerCase()}`,
    detail:
      delivery.state === 'failed'
        ? `Attempt ${attempts} to send the UNSIGNED job card to ${authorisation.recipient} ` +
          `failed: ${delivery.failureReason}${
            deliveryRetryAdvice(delivery.failureKind).length === 0
              ? ''
              : ` ${deliveryRetryAdvice(delivery.failureKind)}`
          }`
        : `Attempt ${attempts}: the provider accepted the UNSIGNED job card ` +
          `${document.fileName} for ${authorisation.recipient}. Delivery is ` +
          `${deliveryStateLabel(delivery.state).toLowerCase()}. Authorised by ` +
          `${authorisation.authorisedBy.length === 0 ? 'a Master' : userFullName(context.actor)}.`,
  });

  return { job: saved, delivery };
};
