import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IsoDateTime, OutboxDeliveryStatus } from '@/domain';

/**
 * META'S WEBHOOKS FOR THE WHATSAPP CLOUD API. INT-WA-2.
 *
 * Two requests, both from Meta to `/api/integrations/whatsapp/webhook`:
 *
 *  - GET, once, when the callback URL is saved in the Meta app dashboard:
 *    `hub.mode=subscribe`, `hub.verify_token` (the string EJE chose,
 *    WHATSAPP_WEBHOOK_VERIFY_TOKEN) and `hub.challenge`, which must be echoed
 *    back as the whole body. A wrong token gets 403 and nothing else.
 *  - POST, for every status change: the JSON body, signed by Meta with the
 *    app secret (WHATSAPP_APP_SECRET) as `X-Hub-Signature-256: sha256=<hex>`,
 *    an HMAC-SHA256 of the RAW body bytes. A body whose signature does not
 *    verify is refused before it is parsed — anyone on the internet can POST
 *    to a public URL.
 *
 * Nothing here stores message content. Only statuses of messages EJE SENT are
 * read (`statuses[]`) and template review results; an inbound message from a
 * technician (`messages[]`) is counted and otherwise ignored — EJE does not
 * run a WhatsApp inbox, and keeping what people write to the office number is
 * not this integration's job.
 */

export interface WhatsAppWebhookConfiguration {
  readonly appSecret: string;
  readonly verifyToken: string;
}

export const readWhatsAppWebhookConfiguration = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): WhatsAppWebhookConfiguration => ({
  appSecret: (env.WHATSAPP_APP_SECRET ?? '').trim(),
  verifyToken: (env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ?? '').trim(),
});

const sameText = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * The verification handshake. The challenge to echo, or null to refuse. A
 * deployment with no verify token refuses every attempt: an empty token must
 * never match an empty query parameter.
 */
export const answerVerification = (
  params: URLSearchParams,
  config: WhatsAppWebhookConfiguration,
): string | null => {
  if (config.verifyToken.length === 0) return null;
  if (params.get('hub.mode') !== 'subscribe') return null;
  const token = params.get('hub.verify_token') ?? '';
  const challenge = params.get('hub.challenge') ?? '';
  if (!sameText(token, config.verifyToken)) return null;
  // Meta's challenge is a number; anything else is not echoed into a response.
  return /^[A-Za-z0-9_-]{1,128}$/.test(challenge) ? challenge : null;
};

/** Does the signature header match the raw body? False without an app secret. */
export const verifySignature = (
  rawBody: Uint8Array,
  header: string | null,
  appSecret: string,
): boolean => {
  if (appSecret.length === 0 || header === null) return false;
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (match === null) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(match[1]!, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
};

export interface WebhookStatus {
  /** A stable key for this exact report, so a repeated delivery is recognised. */
  readonly eventId: string;
  readonly providerMessageId: string;
  readonly status: OutboxDeliveryStatus;
  readonly occurredAt: IsoDateTime | null;
  readonly errorCode: string;
  readonly errorTitle: string;
}

export interface TemplateStatusUpdate {
  readonly eventId: string;
  readonly templateName: string;
  readonly language: string;
  /** APPROVED, REJECTED, PAUSED, DISABLED, PENDING_DELETION, … as Meta sends it. */
  readonly event: string;
  readonly reason: string;
}

export interface ParsedWebhook {
  readonly statuses: readonly WebhookStatus[];
  readonly templates: readonly TemplateStatusUpdate[];
  /** Inbound messages seen and deliberately not processed. */
  readonly ignoredMessages: number;
}

const KNOWN_STATUSES: readonly OutboxDeliveryStatus[] = ['sent', 'delivered', 'read', 'failed'];

const text = (value: unknown, limit = 300): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, limit) : '';

const digest = (...parts: string[]): string =>
  createHash('sha256').update(parts.join('|')).digest('hex');

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

/**
 * Reads what EJE needs out of a verified body. Tolerant of shapes it does not
 * know (Meta adds fields), strict about what it keeps: ids, statuses, Meta's
 * error code and title. Never the recipient's number, never message text.
 */
export const parseWebhook = (body: unknown): ParsedWebhook => {
  const statuses: WebhookStatus[] = [];
  const templates: TemplateStatusUpdate[] = [];
  let ignoredMessages = 0;

  for (const entry of asArray(asRecord(body).entry)) {
    for (const change of asArray(asRecord(entry).changes)) {
      const field = text(asRecord(change).field);
      const value = asRecord(asRecord(change).value);

      if (field === 'message_template_status_update') {
        const templateName = text(value.message_template_name, 200);
        const event = text(value.event, 60);
        if (templateName.length > 0 && event.length > 0) {
          templates.push({
            eventId: digest('template', text(value.message_template_id), templateName, event, text(value.reason)),
            templateName,
            language: text(value.message_template_language, 20),
            event,
            reason: text(value.reason, 300),
          });
        }
        continue;
      }

      ignoredMessages += asArray(value.messages).length;
      for (const raw of asArray(value.statuses)) {
        const status = asRecord(raw);
        const providerMessageId = text(status.id, 200);
        const kind = text(status.status) as OutboxDeliveryStatus;
        if (providerMessageId.length === 0 || !KNOWN_STATUSES.includes(kind)) continue;
        const seconds = Number(text(status.timestamp));
        const error = asRecord(asArray(status.errors)[0]);
        const errorCode = text(error.code, 20);
        const errorTitle = text(error.title ?? error.message, 300);
        statuses.push({
          eventId: digest('status', providerMessageId, kind, text(status.timestamp), errorCode),
          providerMessageId,
          status: kind,
          occurredAt: Number.isFinite(seconds) && seconds > 0 ? (new Date(seconds * 1000).toISOString() as IsoDateTime) : null,
          errorCode,
          errorTitle,
        });
      }
    }
  }
  return { statuses, templates, ignoredMessages };
};
