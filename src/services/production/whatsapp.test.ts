import { describe, expect, it } from 'vitest';
import { SystemClock, SequentialIdGenerator } from '@/services/simulated/system';
import {
  CloudApiWhatsAppService,
  readWhatsAppConfiguration,
  toE164,
  UnconfiguredWhatsAppService,
  WhatsAppNotConfigured,
  WhatsAppSendFailed,
  type WhatsAppConfiguration,
} from './whatsapp';

/**
 * The WhatsApp adapter, driven without a network.
 *
 * `fetch` is injected, so these exercise the REAL adapter — the request it
 * builds, the response it believes, and what it refuses to claim — rather than
 * a stand-in for it. What is not tested here is Meta's side of the wire, which
 * no test in this repository can honestly assert.
 */
const config: WhatsAppConfiguration = {
  phoneNumberId: '1234567890',
  accessToken: 'test-token',
  apiVersion: 'v21.0',
  baseUrl: 'https://graph.facebook.com',
};

const message = {
  to: '082 555 0134',
  templateName: 'eje_job_assigned',
  parameters: ['EJE-1103', 'ABC Engineering', 'Johannesburg', 'Leadwell V-40'],
  preview: 'EJE-1103 — assigned to you',
};

const adapterWith = (impl: typeof fetch) =>
  new CloudApiWhatsAppService(config, new SystemClock(), new SequentialIdGenerator(), impl);

const respondWith = (status: number, body: unknown): typeof fetch =>
  (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )) as unknown as typeof fetch;

describe('knowing whether WhatsApp is configured at all', () => {
  it('is not configured when either credential is missing', () => {
    expect(readWhatsAppConfiguration({})).toBeNull();
    expect(readWhatsAppConfiguration({ WHATSAPP_PHONE_NUMBER_ID: '123' })).toBeNull();
    expect(readWhatsAppConfiguration({ WHATSAPP_ACCESS_TOKEN: 'abc' })).toBeNull();
    // Whitespace is not a credential.
    expect(
      readWhatsAppConfiguration({ WHATSAPP_PHONE_NUMBER_ID: '  ', WHATSAPP_ACCESS_TOKEN: 'abc' }),
    ).toBeNull();
  });

  it('is configured when both are present, with sensible defaults', () => {
    const resolved = readWhatsAppConfiguration({
      WHATSAPP_PHONE_NUMBER_ID: '123',
      WHATSAPP_ACCESS_TOKEN: 'abc',
    });

    expect(resolved?.apiVersion).toBe('v21.0');
    expect(resolved?.baseUrl).toBe('https://graph.facebook.com');
  });
});

describe('an unconfigured deployment', () => {
  it('refuses, rather than quietly doing nothing', async () => {
    // The whole point. Silently succeeding would leave EJE believing
    // technicians had been messaged when nothing left the building.
    await expect(new UnconfiguredWhatsAppService().send()).rejects.toBeInstanceOf(
      WhatsAppNotConfigured,
    );
  });
});

describe('the number it sends to', () => {
  it('accepts the ways a South African number is actually written', () => {
    expect(toE164('082 555 0134')).toBe('27825550134');
    expect(toE164('0825550134')).toBe('27825550134');
    expect(toE164('+27 82 555 0134')).toBe('27825550134');
    expect(toE164('27825550134')).toBe('27825550134');
  });

  it('refuses a number it cannot make sense of, rather than guessing', () => {
    // A guess sends somebody's job card to a stranger.
    for (const bad of ['', '555', '0825', 'not a number']) {
      expect(() => toE164(bad)).toThrow(WhatsAppSendFailed);
    }
  });
});

describe('a message the provider accepts', () => {
  it('records the provider’s own message id', async () => {
    const adapter = adapterWith(respondWith(200, { messages: [{ id: 'wamid.HBg=' }] }));
    const entry = await adapter.send(message);

    expect(entry.id).toBe('wamid.HBg=');
    expect(entry.simulated).toBe(false);
  });

  it('says PENDING DELIVERY, never delivered', async () => {
    const adapter = adapterWith(respondWith(200, { messages: [{ id: 'wamid.HBg=' }] }));
    const entry = await adapter.send(message);

    // Meta answering 200 means Meta has the message. No handset has confirmed
    // anything, and an adapter that said "delivered" here would be lying to a
    // business that uses these messages to know a technician was told.
    expect(entry.delivery).toBe('pending_delivery');
    expect(entry.failureReason).toBe('');
  });

  it('posts an approved template to the right endpoint', async () => {
    let seenUrl = '';
    let seenBody: Record<string, unknown> = {};
    let seenAuth = '';

    const adapter = adapterWith(((url: string, init: RequestInit) => {
      seenUrl = url;
      seenAuth = String((init.headers as Record<string, string>).authorization);
      seenBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Promise.resolve(
        new Response(JSON.stringify({ messages: [{ id: 'wamid.X' }] }), { status: 200 }),
      );
    }) as unknown as typeof fetch);

    await adapter.send(message);

    expect(seenUrl).toBe('https://graph.facebook.com/v21.0/1234567890/messages');
    expect(seenAuth).toBe('Bearer test-token');
    expect(seenBody.messaging_product).toBe('whatsapp');
    expect(seenBody.type).toBe('template');
    // Normalised, not passed through as typed by a person.
    expect(seenBody.to).toBe('27825550134');
  });
});

describe('a message the provider does not accept', () => {
  it('raises, carrying the provider’s reason', async () => {
    const adapter = adapterWith(
      respondWith(400, { error: { message: 'Template name does not exist', code: 132001 } }),
    );

    await expect(adapter.send(message)).rejects.toThrow('Template name does not exist');
  });

  it('raises when the network could not be reached', async () => {
    const adapter = adapterWith((() =>
      Promise.reject(new Error('getaddrinfo ENOTFOUND'))) as unknown as typeof fetch);

    await expect(adapter.send(message)).rejects.toBeInstanceOf(WhatsAppSendFailed);
  });

  it('raises when the provider answers 200 with no message id', async () => {
    // A 200 is not a send. Without an id there is nothing to reconcile against
    // a delivery report later, so it is treated as a failure rather than a
    // success nobody can verify.
    const adapter = adapterWith(respondWith(200, {}));
    await expect(adapter.send(message)).rejects.toThrow(WhatsAppSendFailed);
  });

  it('never repeats the access token back in an error', async () => {
    const adapter = adapterWith((() =>
      Promise.reject(new Error('connect failed to test-token host'))) as unknown as typeof fetch);

    const failure = await adapter.send(message).catch((cause: unknown) => cause);
    // The token is in the request that failed; it must not travel back out in
    // a message that ends up on an audit trail.
    expect(String(failure)).not.toContain(config.accessToken);
  });
});
