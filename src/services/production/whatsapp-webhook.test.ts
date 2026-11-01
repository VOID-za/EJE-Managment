import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { answerVerification, parseWebhook, verifySignature } from './whatsapp-webhook';
import { CloudApiWhatsAppService, isPermanentWhatsAppFailure, readWhatsAppConfiguration } from './whatsapp';
import { SequentialIdGenerator, SystemClock } from '../simulated/system';

/**
 * INT-WA-2/3: Meta's webhook — the handshake, the signature, what is read out
 * of a body and what is deliberately not — and the office-number safety rule:
 * this code only ever SENDS template messages; it has no call that registers,
 * deregisters, migrates or reconfigures a phone number.
 */

const SECRET = 'app-secret-for-tests';
const sign = (body: string, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('the verification handshake', () => {
  const config = { appSecret: SECRET, verifyToken: 'verify-me-0123456789' };
  const params = (token: string, challenge = '1158201444', mode = 'subscribe') =>
    new URLSearchParams({ 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge });

  it('echoes the challenge for the right token', () => {
    expect(answerVerification(params('verify-me-0123456789'), config)).toBe('1158201444');
  });

  it('refuses a wrong token, a wrong mode, an empty configured token, and a challenge that is not a plain value', () => {
    expect(answerVerification(params('wrong'), config)).toBeNull();
    expect(answerVerification(params('verify-me-0123456789', '1', 'unsubscribe'), config)).toBeNull();
    expect(answerVerification(params(''), { ...config, verifyToken: '' })).toBeNull();
    expect(answerVerification(params('verify-me-0123456789', '<script>alert(1)</script>'), config)).toBeNull();
  });
});

describe('the signature', () => {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
  const raw = new TextEncoder().encode(body);

  it('accepts Meta’s HMAC-SHA256 of the raw body', () => {
    expect(verifySignature(raw, sign(body), SECRET)).toBe(true);
  });

  it('refuses a missing, malformed, wrong-secret or altered signature — and everything without a secret', () => {
    expect(verifySignature(raw, null, SECRET)).toBe(false);
    expect(verifySignature(raw, 'sha1=abc', SECRET)).toBe(false);
    expect(verifySignature(raw, sign(body, 'another-secret'), SECRET)).toBe(false);
    expect(verifySignature(new TextEncoder().encode(`${body} `), sign(body), SECRET)).toBe(false);
    expect(verifySignature(raw, sign(body, ''), '')).toBe(false);
  });
});

const statusBody = (statuses: unknown[], extra: Record<string, unknown> = {}) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', statuses, ...extra } }] }],
});

describe('reading a verified body', () => {
  it('reads sent, delivered, read and failed statuses, with Meta’s error', () => {
    const parsed = parseWebhook(
      statusBody([
        { id: 'wamid.1', status: 'delivered', timestamp: '1793520000', recipient_id: '27821234567' },
        { id: 'wamid.2', status: 'failed', timestamp: '1793520001', errors: [{ code: 131026, title: 'Message undeliverable' }] },
      ]),
    );
    expect(parsed.statuses).toHaveLength(2);
    expect(parsed.statuses[0]).toMatchObject({ providerMessageId: 'wamid.1', status: 'delivered', occurredAt: new Date(1793520000 * 1000).toISOString() });
    expect(parsed.statuses[1]).toMatchObject({ status: 'failed', errorCode: '131026', errorTitle: 'Message undeliverable' });
  });

  it('keeps no phone number and no message text, and ignores inbound messages', () => {
    const parsed = parseWebhook(
      statusBody([{ id: 'wamid.1', status: 'read', timestamp: '1793520000', recipient_id: '27821234567' }], {
        messages: [{ from: '27821234567', text: { body: 'private words' } }],
      }),
    );
    expect(parsed.ignoredMessages).toBe(1);
    expect(JSON.stringify(parsed)).not.toContain('27821234567');
    expect(JSON.stringify(parsed)).not.toContain('private words');
  });

  it('gives a repeated delivery the same key, and a different status a different one', () => {
    const one = parseWebhook(statusBody([{ id: 'wamid.1', status: 'delivered', timestamp: '1' }])).statuses[0]!;
    const again = parseWebhook(statusBody([{ id: 'wamid.1', status: 'delivered', timestamp: '1' }])).statuses[0]!;
    const read = parseWebhook(statusBody([{ id: 'wamid.1', status: 'read', timestamp: '2' }])).statuses[0]!;
    expect(again.eventId).toBe(one.eventId);
    expect(read.eventId).not.toBe(one.eventId);
  });

  it('reads template review results (approved, rejected)', () => {
    const parsed = parseWebhook({
      entry: [{ changes: [{ field: 'message_template_status_update', value: { event: 'REJECTED', message_template_name: 'eje_job_assigned', message_template_language: 'en', reason: 'INVALID_FORMAT' } }] }],
    });
    expect(parsed.templates).toEqual([expect.objectContaining({ templateName: 'eje_job_assigned', event: 'REJECTED', reason: 'INVALID_FORMAT' })]);
  });

  it('survives a body of the wrong shape without throwing', () => {
    for (const body of [null, 'text', 42, { entry: 'x' }, { entry: [{ changes: [null] }] }]) {
      expect(parseWebhook(body)).toEqual({ statuses: [], templates: [], ignoredMessages: 0 });
    }
  });
});

describe('the existing office number is never touched', () => {
  it('the adapter only READS the dedicated number and POSTs template messages to /messages — never /register, /deregister or a number’s settings', async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const fetchImpl = ((url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: JSON.parse(String(init?.body ?? '{}')) });
      return Promise.resolve(
        new Response(JSON.stringify(String(url).includes('?fields=') ? { display_phone_number: '+27 82 000 0001' } : { messages: [{ id: 'wamid.x' }] }), { status: 200 }),
      );
    }) as typeof fetch;
    const config = readWhatsAppConfiguration({ WHATSAPP_PHONE_NUMBER_ID: '123', WHATSAPP_ACCESS_TOKEN: 'token', WHATSAPP_DEDICATED_NUMBER: '+27820000001' })!;
    const service = new CloudApiWhatsAppService(config, new SystemClock(), new SequentialIdGenerator(), fetchImpl);
    await service.send({ to: '0821234567', templateName: 'eje_job_assigned', parameters: ['a'], preview: '' });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET https://graph.facebook.com/v21.0/123?fields=display_phone_number,verified_name',
      'POST https://graph.facebook.com/v21.0/123/messages',
    ]);
    expect(calls[1]!.body).toMatchObject({ type: 'template', template: { name: 'eje_job_assigned', language: { code: 'en' } } });
    // No method of the adapter can do anything else.
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(service)).filter((name) => name !== 'constructor');
    expect(methods.sort()).toEqual(['confirmSendingNumber', 'redact', 'send']);
  });

  it('uses the language the templates were approved in', async () => {
    const calls: unknown[] = [];
    const fetchImpl = ((url: string, init?: RequestInit) => {
      if (String(url).includes('?fields=')) {
        return Promise.resolve(new Response(JSON.stringify({ display_phone_number: '27820000001' }), { status: 200 }));
      }
      calls.push(JSON.parse(String(init?.body)));
      return Promise.resolve(new Response(JSON.stringify({ messages: [{ id: 'wamid.x' }] }), { status: 200 }));
    }) as typeof fetch;
    const config = readWhatsAppConfiguration({ WHATSAPP_PHONE_NUMBER_ID: '1', WHATSAPP_ACCESS_TOKEN: 't', WHATSAPP_DEDICATED_NUMBER: '0820000001', WHATSAPP_TEMPLATE_LANGUAGE: 'en_GB' })!;
    await new CloudApiWhatsAppService(config, new SystemClock(), new SequentialIdGenerator(), fetchImpl).send({ to: '27821234567', templateName: 't', parameters: [], preview: '' });
    expect(calls[0]).toMatchObject({ template: { language: { code: 'en_GB' } } });
  });

  it('tells permanent refusals (a bad token, a missing template, an undeliverable number) from temporary ones', () => {
    expect(isPermanentWhatsAppFailure(401, 190)).toBe(true);
    expect(isPermanentWhatsAppFailure(400, 132001)).toBe(true);
    expect(isPermanentWhatsAppFailure(400, 131026)).toBe(true);
    expect(isPermanentWhatsAppFailure(429, 130429)).toBe(false);
    expect(isPermanentWhatsAppFailure(503, undefined)).toBe(false);
  });
});
