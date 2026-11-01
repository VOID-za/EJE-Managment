import { describe, expect, it } from 'vitest';
import { SystemClock, SequentialIdGenerator } from '@/services/simulated/system';
import {
  ActivationGatedWhatsAppService,
  CloudApiWhatsAppService,
  numberDigits,
  readWhatsAppConfiguration,
  whatsAppConfigurationProblems,
  WhatsAppNotActivated,
  WhatsAppSendFailed,
  type WhatsAppConfiguration,
} from './whatsapp';
import type { OutboxEntry, WhatsAppMessage, WhatsAppService } from '../ports';

/**
 * THE DEDICATED EJE NUMBER. The owner's decision (1 November 2026): system
 * notifications go from a NEW WhatsApp number of EJE's own; the office's
 * existing number is never connected, migrated or used. And WhatsApp stays
 * "Not configured" until that number and the Meta credentials are set AND a
 * real API test succeeded.
 *
 * Driven with an injected fetch: no network, no message to anybody.
 */

const DEDICATED = '27820000001';
const OFFICE = '27115550100';

const config: WhatsAppConfiguration = {
  phoneNumberId: '1234567890',
  accessToken: 'secret-token',
  apiVersion: 'v21.0',
  baseUrl: 'https://graph.facebook.com',
  templateLanguage: 'en',
  timeoutMs: 20_000,
  dedicatedNumber: DEDICATED,
  protectedNumbers: [OFFICE],
};

const message: WhatsAppMessage = {
  to: '082 555 0134',
  templateName: 'eje_job_assigned',
  parameters: ['EJE-1103', 'ABC Engineering', 'Johannesburg', 'Leadwell V-40', 'Not specified', 'https://example.test'],
  preview: 'EJE-1103 — assigned to you',
};

/** A fake Meta: says which number the id belongs to, and records every request. */
const meta = (display: string) => {
  const requests: { url: string; method: string }[] = [];
  const impl = ((url: string, init: RequestInit) => {
    requests.push({ url: String(url), method: init.method ?? 'GET' });
    const body = String(url).includes('?fields=display_phone_number')
      ? { display_phone_number: display }
      : { messages: [{ id: 'wamid.TEST' }] };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  }) as unknown as typeof fetch;
  return { impl, requests, posts: () => requests.filter((request) => request.method === 'POST') };
};

describe('the configuration names the dedicated number', () => {
  const base = { WHATSAPP_PHONE_NUMBER_ID: '123', WHATSAPP_ACCESS_TOKEN: 'abc' };

  it('is not configured without WHATSAPP_DEDICATED_NUMBER, even with both credentials', () => {
    expect(readWhatsAppConfiguration(base)).toBeNull();
  });

  it('is configured with it, kept as digits with the country code', () => {
    const resolved = readWhatsAppConfiguration({ ...base, WHATSAPP_DEDICATED_NUMBER: '+27 82 000 0001', WHATSAPP_PROTECTED_NUMBERS: '011 555 0100' });
    expect(resolved?.dedicatedNumber).toBe(DEDICATED);
    expect(resolved?.protectedNumbers).toEqual([OFFICE]);
  });

  it('refuses a dedicated number that is the protected office number', () => {
    const env = { ...base, WHATSAPP_DEDICATED_NUMBER: '011 555 0100', WHATSAPP_PROTECTED_NUMBERS: '+27 11 555 0100' };
    expect(readWhatsAppConfiguration(env)).toBeNull();
    expect(whatsAppConfigurationProblems(env).join(' ')).toContain('WHATSAPP_PROTECTED_NUMBERS');
  });

  it('refuses a dedicated number without a country code', () => {
    const env = { ...base, WHATSAPP_DEDICATED_NUMBER: '555 0134' };
    expect(readWhatsAppConfiguration(env)).toBeNull();
    expect(whatsAppConfigurationProblems(env)).toHaveLength(1);
  });

  it('compares numbers however they were written', () => {
    expect(numberDigits('+27 (82) 000-0001')).toBe(DEDICATED);
    expect(numberDigits('082 000 0001')).toBe(DEDICATED);
  });
});

describe('Meta is asked which number will send, before anything is sent', () => {
  it('sends when the phone number id is the dedicated number', async () => {
    const fake = meta('+27 82 000 0001');
    const adapter = new CloudApiWhatsAppService(config, new SystemClock(), new SequentialIdGenerator(), fake.impl);
    const entry = await adapter.send(message);
    expect(entry.id).toBe('wamid.TEST');
    expect(fake.requests[0]?.url).toContain('/1234567890?fields=display_phone_number');
    expect(fake.posts()).toHaveLength(1);
  });

  it('REFUSES, permanently and sending nothing, when the id belongs to the office number', async () => {
    const fake = meta('+27 11 555 0100');
    const adapter = new CloudApiWhatsAppService(config, new SystemClock(), new SequentialIdGenerator(), fake.impl);
    const failure = await adapter.send(message).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(WhatsAppSendFailed);
    expect((failure as WhatsAppSendFailed).permanent).toBe(true);
    expect((failure as WhatsAppSendFailed).providerCode).toBe('protected_number');
    expect(fake.posts()).toHaveLength(0);
  });

  it('refuses when the id belongs to any other number', async () => {
    const fake = meta('+27 83 999 9999');
    const adapter = new CloudApiWhatsAppService(config, new SystemClock(), new SequentialIdGenerator(), fake.impl);
    const failure = (await adapter.send(message).catch((cause: unknown) => cause)) as WhatsAppSendFailed;
    expect(failure.providerCode).toBe('wrong_number');
    expect(failure.message).toContain('…0001');
    expect(failure.message).not.toContain('secret-token');
    expect(fake.posts()).toHaveLength(0);
  });

  it('asks once, not before every message', async () => {
    const fake = meta('+27 82 000 0001');
    const adapter = new CloudApiWhatsAppService(config, new SystemClock(), new SequentialIdGenerator(), fake.impl);
    await adapter.send(message);
    await adapter.send(message);
    expect(fake.requests.filter((request) => request.method === 'GET')).toHaveLength(1);
    expect(fake.posts()).toHaveLength(2);
  });
});

describe('not in use until a real test passed', () => {
  const recording = () => {
    const sent: WhatsAppMessage[] = [];
    const inner: WhatsAppService = {
      configured: true,
      send: (sending) => {
        sent.push(sending);
        return Promise.resolve({ id: 'wamid.X' } as OutboxEntry);
      },
    };
    return { inner, sent };
  };

  it('says it is NOT configured, and refuses a job notification, before the test', async () => {
    const { inner, sent } = recording();
    const gated = new ActivationGatedWhatsAppService(inner, { active: false, confirm: () => Promise.resolve(false) });
    expect(gated.configured).toBe(false);
    await expect(gated.send(message)).rejects.toBeInstanceOf(WhatsAppNotActivated);
    expect(sent).toHaveLength(0);
  });

  it('lets the test itself through (to a configured internal number)', async () => {
    const { inner, sent } = recording();
    const gated = new ActivationGatedWhatsAppService(inner, { active: false, confirm: () => Promise.resolve(false) });
    await gated.send({ ...message, test: true });
    expect(sent).toHaveLength(1);
  });

  it('sends job notifications once the test has passed', async () => {
    const { inner, sent } = recording();
    const gated = new ActivationGatedWhatsAppService(inner, { active: true, confirm: () => Promise.resolve(true) });
    expect(gated.configured).toBe(true);
    await gated.send(message);
    expect(sent).toHaveLength(1);
  });

  it('a refusal before activation is permanent: not retried into a flood of stale notices', () => {
    expect(new WhatsAppNotActivated().permanent).toBe(true);
  });
});
