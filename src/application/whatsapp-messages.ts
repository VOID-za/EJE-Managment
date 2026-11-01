import {
  advancesDeliveryStatus,
  can,
  userFullName,
  type JobId,
  type OutboxMessage,
} from '@/domain';
import type { ParsedWebhook } from '@/services/production/whatsapp-webhook';
import type { OperationContext } from './context';
import { audit, notifyOffice } from './audit';
import { WorkflowError } from './errors';

/**
 * WHAT META SAID ABOUT EJE'S WHATSAPP MESSAGES, AND THE OFFICE'S RETRY.
 * INT-WA-2/3.
 *
 * Statuses arrive by webhook (verified before they reach this file — see the
 * route), at least once and in any order. Each is recorded once under its own
 * key (a repeat changes nothing), and moves its message only FORWARD: sent,
 * delivered, read; `failed` is final and never undoes a delivery.
 *
 * A failure is put on the job's activity trail with Meta's own words (e.g.
 * "131026 Message undeliverable" — a number not on WhatsApp). Nothing here can
 * affect the assignment, transfer or acceptance the message was about.
 */

export interface WebhookOutcome {
  readonly applied: number;
  readonly duplicates: number;
  readonly unmatched: number;
  readonly templates: number;
}

export const applyWhatsAppWebhook = async (context: OperationContext, parsed: ParsedWebhook): Promise<WebhookOutcome> => {
  const now = context.services.clock.now();
  let applied = 0;
  let duplicates = 0;
  let unmatched = 0;

  for (const status of parsed.statuses) {
    const message = await context.repos.outbox.findByProviderMessageId(status.providerMessageId);
    const fresh = await context.repos.integrations.recordWebhookEvent({
      id: status.eventId,
      providerMessageId: status.providerMessageId,
      status: status.status,
      errorCode: status.errorCode,
      errorTitle: status.errorTitle,
      occurredAt: status.occurredAt,
      receivedAt: now,
      matched: message !== null,
    });
    if (!fresh) {
      duplicates += 1;
      continue;
    }
    if (message === null) {
      unmatched += 1;
      continue;
    }
    if (!advancesDeliveryStatus(message.deliveryStatus, status.status)) continue;
    const error = [status.errorCode, status.errorTitle].filter((part) => part.length > 0).join(' ');
    await context.repos.outbox.recordDeliveryStatus(message.id, status.status, status.occurredAt ?? now, error);
    applied += 1;
    if (status.status === 'failed' && message.jobId !== null) {
      await audit(context, {
        jobId: message.jobId,
        type: 'whatsapp_delivery_failed',
        summary: 'WhatsApp message could not be delivered',
        detail: `Meta could not deliver the ${purposeLabel(message)} to ${maskNumber(message.recipient)}: ${error.length > 0 ? error : 'no reason given'}. The job is unaffected; the office can retry it from the job.`,
      });
    }
  }

  for (const template of parsed.templates) {
    const fresh = await context.repos.integrations.recordWebhookEvent({
      id: template.eventId,
      providerMessageId: `template:${template.templateName}`,
      status: template.event,
      errorCode: '',
      errorTitle: template.reason,
      occurredAt: null,
      receivedAt: now,
      matched: true,
    });
    if (!fresh) continue;
    await audit(context, {
      jobId: null,
      type: 'whatsapp_template_status',
      summary: `WhatsApp template ${template.templateName}: ${template.event}`,
      detail: `Meta reported ${template.event} for the template ${template.templateName} (${template.language || 'language not given'})${template.reason.length > 0 ? `: ${template.reason}` : ''}.`,
    });
    if (template.event !== 'APPROVED') {
      await notifyOffice(context, {
        type: 'job_submitted',
        title: `WhatsApp template ${template.templateName}: ${template.event}`,
        body: `Meta reported ${template.event} for ${template.templateName}. Messages that use it are refused until it is approved again.`,
        link: '/admin',
      });
    }
  }
  return { applied, duplicates, unmatched, templates: parsed.templates.length };
};

const purposeLabel = (message: OutboxMessage): string =>
  message.purpose === 'transfer'
    ? 'transfer notice'
    : message.purpose === 'site_location'
      ? 'site location'
      : message.purpose === 'test'
        ? 'test message'
        : 'assignment notice';

/** Enough of a number to recognise it, not enough to copy it. */
export const maskNumber = (number: string): string => {
  const digits = number.replace(/\D/g, '');
  return digits.length <= 4 ? '••••' : `••• ${digits.slice(-4)}`;
};

const refuse = (message: string, code: string, detail: string): WorkflowError =>
  new WorkflowError(message, [{ code, message: detail }]);

/** The WhatsApp messages about one job, for the office. */
export const listJobWhatsAppMessages = async (context: OperationContext, jobId: JobId): Promise<readonly OutboxMessage[]> => {
  if (!can(context.actor.role, 'jobs.officeHandling')) {
    throw refuse('Only the office sees a job’s messages.', 'not_permitted', 'A Master or a Coordinator handles messages.');
  }
  return (await context.repos.outbox.listForJob(jobId)).filter((message) => message.channel === 'whatsapp');
};

/**
 * THE OFFICE'S RETRY, for a message that failed — given up on by the outbox,
 * or reported undeliverable by Meta. A NEW message, the same template, words
 * and recipient; the failed one stays as it was. Nothing that is pending or
 * was accepted and not reported failed can be retried: that would be a
 * second copy on the technician's phone.
 */
export const retryWhatsAppMessage = async (context: OperationContext, messageId: string): Promise<OutboxMessage> => {
  if (!can(context.actor.role, 'jobs.officeHandling')) {
    throw refuse('Only the office retries messages.', 'not_permitted', 'A Master or a Coordinator handles messages.');
  }
  const message = await context.repos.outbox.findById(messageId);
  if (message === null || message.channel !== 'whatsapp') throw refuse('That message does not exist.', 'unknown_message', 'Reload the job.');
  const failed = message.state === 'failed' || message.deliveryStatus === 'failed';
  if (!failed) {
    throw refuse(
      'Only a failed message can be retried.',
      'not_failed',
      message.state === 'pending' ? 'It is still waiting to be sent.' : 'Meta accepted it and has not reported a failure.',
    );
  }
  const retried = (await context.repos.outbox.list(500)).some((candidate) => candidate.retryOf === message.id);
  if (retried) throw refuse('This message was already retried.', 'already_retried', 'See the newer message on the job.');
  const now = context.services.clock.now();
  const next: OutboxMessage = {
    ...message,
    id: context.services.ids.next('outbox'),
    state: 'pending',
    attempts: 0,
    providerMessageId: null,
    failureReason: '',
    createdAt: now,
    lastAttemptAt: null,
    deliveryStatus: null,
    deliveredAt: null,
    readAt: null,
    providerError: '',
    retryOf: message.id,
  };
  await context.repos.outbox.enqueue(next);
  if (message.jobId !== null) {
    await audit(context, {
      jobId: message.jobId,
      type: 'whatsapp_retried',
      summary: 'WhatsApp message retried',
      detail: `${userFullName(context.actor)} retried the ${purposeLabel(message)} to ${maskNumber(message.recipient)} after: ${message.providerError || message.failureReason || 'a failure'}.`,
    });
  }
  return next;
};
