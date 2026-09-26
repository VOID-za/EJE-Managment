import { describe, expect, it } from 'vitest';
import { SystemClock } from '@/services/simulated/system';
import type { EmailMessage, StorageService, StoredDocument } from '@/services/ports';
import {
  chooseEmailTransport,
  EmailNotConfigured,
  EmailSendFailed,
  GraphEmailService,
  readGraphEmailConfiguration,
  UnconfiguredEmailService,
  type GraphEmailConfiguration,
} from './email';

/**
 * The Microsoft 365 adapter, driven without a network.
 *
 * `fetch` is injected, so these exercise the REAL adapter — the requests it
 * builds, the responses it believes, and what it refuses to claim — rather than
 * a stand-in for it. What is not tested here is Microsoft's side of the wire,
 * which no test in this repository can honestly assert.
 */
const config: GraphEmailConfiguration = {
  tenantId: 'tenant-1',
  clientId: 'client-1',
  clientSecret: 'super-secret-value',
  sender: 'jobcards@eje.example',
  replyTo: 'office@eje.example',
  baseUrl: 'https://graph.microsoft.com/v1.0',
  loginUrl: 'https://login.microsoftonline.com',
};

const document: StoredDocument = {
  storageKey: 'documents/EJE-1103.pdf',
  fileName: 'EJE-1103-Final-Job-Card.pdf',
  contentType: 'application/pdf',
  bytes: new Uint8Array([37, 80, 68, 70]),
};

const storage = (stored: StoredDocument | null = document): StorageService => ({
  resolveUrl: () => 'inert',
  put: () => Promise.reject(new Error('not used')),
  storeUpload: () => Promise.reject(new Error('not used')),
  putDocument: () => Promise.resolve(),
  getDocument: () => Promise.resolve(stored),
});

const message: EmailMessage = {
  to: ['customer@abc-engineering.example'],
  subject: 'EJE-1103 — your job card',
  body: 'The signed job card is attached.',
  attachments: [{ fileName: document.fileName, storageKey: document.storageKey }],
};

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** A fetch that answers the token call, then each Graph call in turn. */
const graphFetch = (
  responses: { status: number; body: unknown }[],
  calls: Call[] = [],
): typeof fetch =>
  ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('oauth2/v2.0/token')) {
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: 'token-abc', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    const next = responses.shift() ?? { status: 200, body: {} };
    return Promise.resolve(
      new Response(next.status === 202 ? null : JSON.stringify(next.body), {
        status: next.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;

const adapterWith = (impl: typeof fetch, store: StorageService = storage()) =>
  new GraphEmailService(config, store, new SystemClock(), impl);

describe('reading the configuration', () => {
  it('is null unless every part of it is present', () => {
    expect(readGraphEmailConfiguration({})).toBeNull();
    expect(
      readGraphEmailConfiguration({
        EMAIL_GRAPH_TENANT_ID: 't',
        EMAIL_GRAPH_CLIENT_ID: 'c',
        // secret missing
        EMAIL_SENDER: 'a@b.example',
      }),
    ).toBeNull();
    expect(
      readGraphEmailConfiguration({
        EMAIL_GRAPH_TENANT_ID: 't',
        EMAIL_GRAPH_CLIENT_ID: 'c',
        EMAIL_GRAPH_CLIENT_SECRET: 's',
        // sender missing: Graph needs a mailbox to send AS
      }),
    ).toBeNull();
  });

  it('reads a complete configuration and defaults the endpoints', () => {
    const read = readGraphEmailConfiguration({
      EMAIL_GRAPH_TENANT_ID: ' t ',
      EMAIL_GRAPH_CLIENT_ID: 'c',
      EMAIL_GRAPH_CLIENT_SECRET: 's',
      EMAIL_SENDER: 'jobcards@eje.example',
    });
    expect(read).toEqual({
      tenantId: 't',
      clientId: 'c',
      clientSecret: 's',
      sender: 'jobcards@eje.example',
      replyTo: '',
      baseUrl: 'https://graph.microsoft.com/v1.0',
      loginUrl: 'https://login.microsoftonline.com',
    });
  });
});

describe('sending', () => {
  it('creates the message, sends it, and reports ACCEPTED not delivered', async () => {
    const calls: Call[] = [];
    const adapter = adapterWith(
      graphFetch([{ status: 201, body: { id: 'AAMkAGI2' } }, { status: 202, body: {} }], calls),
    );

    const receipt = await adapter.send(message);

    expect(receipt.state).toBe('pending_delivery');
    expect(receipt.messageId).toBe('AAMkAGI2');
    expect(receipt.entry?.simulated).toBe(false);
    expect(receipt.entry?.id).toBe('AAMkAGI2');
    expect(receipt.entry?.attachments).toEqual(['EJE-1103-Final-Job-Card.pdf']);

    // A token, then create, then send — the id comes from Graph, not from us.
    expect(calls).toHaveLength(3);
    expect(calls[1]?.url).toBe(
      'https://graph.microsoft.com/v1.0/users/jobcards%40eje.example/messages',
    );
    expect(calls[2]?.url).toBe(
      'https://graph.microsoft.com/v1.0/users/jobcards%40eje.example/messages/AAMkAGI2/send',
    );
  });

  it('attaches the STORED document bytes, base64, with its own content type', async () => {
    const calls: Call[] = [];
    const adapter = adapterWith(
      graphFetch([{ status: 201, body: { id: 'id-1' } }, { status: 202, body: {} }], calls),
    );
    await adapter.send(message);

    const draft = JSON.parse(String(calls[1]?.init?.body)) as {
      attachments: { name: string; contentType: string; contentBytes: string }[];
      toRecipients: { emailAddress: { address: string } }[];
      replyTo: { emailAddress: { address: string } }[];
    };
    expect(draft.attachments[0]).toEqual({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: 'EJE-1103-Final-Job-Card.pdf',
      contentType: 'application/pdf',
      contentBytes: Buffer.from(document.bytes).toString('base64'),
    });
    expect(draft.toRecipients[0]?.emailAddress.address).toBe('customer@abc-engineering.example');
    expect(draft.replyTo[0]?.emailAddress.address).toBe('office@eje.example');
  });

  it('sends nothing at all when the stored document cannot be read', async () => {
    const calls: Call[] = [];
    const adapter = adapterWith(graphFetch([], calls), storage(null));
    await expect(adapter.send(message)).rejects.toThrow(EmailSendFailed);
    await expect(adapter.send(message)).rejects.toThrow(/could not be read, so nothing was sent/u);
    // Not one Graph call was made: no covering note went without its job card.
    expect(calls.filter((call) => call.url.includes('/messages'))).toHaveLength(0);
  });

  it('refuses a recipient the provider would reject', async () => {
    const adapter = adapterWith(graphFetch([]));
    await expect(adapter.send({ ...message, to: ['not-an-address'] })).rejects.toThrow(
      /rejected the recipient address/u,
    );
  });

  it('raises on a refusal and never reports a success', async () => {
    const adapter = adapterWith(
      graphFetch([
        { status: 403, body: { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } } },
      ]),
    );
    await expect(adapter.send(message)).rejects.toThrow(/Access is denied/u);
  });

  it('raises when the network is unreachable', async () => {
    const adapter = adapterWith((() => Promise.reject(new Error('ENOTFOUND'))) as typeof fetch);
    await expect(adapter.send(message)).rejects.toThrow(/could not be reached for a token/u);
  });

  it('never puts the client secret or the token in a failure message', async () => {
    const adapter = adapterWith(
      graphFetch([
        {
          status: 400,
          body: {
            error: {
              code: 'BadRequest',
              message: `Request used secret ${config.clientSecret} and bearer token-abc`,
            },
          },
        },
      ]),
    );
    const failure = await adapter
      .send(message)
      .then(() => null)
      .catch((error: unknown) => error as EmailSendFailed);
    expect(failure?.message).not.toContain(config.clientSecret);
    expect(failure?.message).not.toContain('token-abc');
    expect(failure?.message).toContain('[redacted]');
  });

  it('refuses the credentials honestly when Microsoft rejects them', async () => {
    const adapter = adapterWith(
      (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ error: 'invalid_client', error_description: 'Bad client secret.' }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          ),
        )) as typeof fetch,
    );
    await expect(adapter.send(message)).rejects.toThrow(/Bad client secret/u);
  });

  it('reuses the token rather than asking for one per call', async () => {
    const calls: Call[] = [];
    const adapter = adapterWith(
      graphFetch(
        [
          { status: 201, body: { id: 'a' } },
          { status: 202, body: {} },
          { status: 201, body: { id: 'b' } },
          { status: 202, body: {} },
        ],
        calls,
      ),
    );
    await adapter.send(message);
    await adapter.send(message);
    expect(calls.filter((call) => call.url.includes('oauth2'))).toHaveLength(1);
  });
});

describe('asking what became of a message', () => {
  it('reports pending_delivery while Graph still knows the message', async () => {
    const adapter = adapterWith(
      ((url: string) =>
        Promise.resolve(
          String(url).includes('oauth2')
            ? new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 })
            : new Response(JSON.stringify({ id: 'AAMkAGI2' }), { status: 200 }),
        )) as typeof fetch,
    );
    const receipt = await adapter.deliveryState('AAMkAGI2');
    expect(receipt?.state).toBe('pending_delivery');
  });

  it('says nothing rather than guessing when the message is unknown or the call fails', async () => {
    const gone = adapterWith(
      ((url: string) =>
        Promise.resolve(
          String(url).includes('oauth2')
            ? new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 })
            : new Response('', { status: 404 }),
        )) as typeof fetch,
    );
    expect(await gone.deliveryState('missing')).toBeNull();
    expect(await gone.deliveryState('')).toBeNull();
  });
});

describe('a deployment with no configuration', () => {
  it('refuses to send, and says what to set', async () => {
    const adapter = new UnconfiguredEmailService();
    await expect(adapter.send()).rejects.toThrow(EmailNotConfigured);
    const failure = await adapter
      .send()
      .then(() => null)
      .catch((error: unknown) => error as EmailNotConfigured);
    expect(failure?.message).toContain('EMAIL_GRAPH_TENANT_ID');
    expect(failure?.message).toContain('docs/integrations.md');
  });

  it('explains itself when SMTP was configured in production', async () => {
    const adapter = new UnconfiguredEmailService(
      'SMTP is configured, but SMTP is a development transport and is never used in production.',
    );
    const failure = await adapter
      .send()
      .then(() => null)
      .catch((error: unknown) => error as EmailNotConfigured);
    expect(failure?.message).toContain('never used in production');
  });

  it('reports no delivery state, so nothing closes a job on its silence', async () => {
    expect(await new UnconfiguredEmailService().deliveryState()).toBeNull();
  });
});

describe('choosing a transport', () => {
  const choose = (options: Partial<Parameters<typeof chooseEmailTransport>[0]>) =>
    chooseEmailTransport({
      graphConfigured: false,
      smtpConfigured: false,
      isProduction: false,
      isDemoBackend: false,
      ...options,
    });

  it('uses Microsoft 365 wherever it is configured', () => {
    expect(choose({ graphConfigured: true })).toBe('graph');
    expect(choose({ graphConfigured: true, isProduction: true })).toBe('graph');
    // Even with SMTP also set, and even in a demonstration: Graph is the answer.
    expect(choose({ graphConfigured: true, smtpConfigured: true, isDemoBackend: true })).toBe('graph');
  });

  it('REFUSES on a real database in production rather than falling back', () => {
    expect(choose({ isProduction: true })).toBe('refuse');
    // The single most important line in this change: SMTP set in production is
    // still a refusal, never a send.
    expect(choose({ isProduction: true, smtpConfigured: true })).toBe('refuse');
    // And a real database with nothing configured refuses even outside
    // production — it must never quietly simulate against real data.
    expect(choose({})).toBe('refuse');
  });

  it('NEVER selects SMTP in production, whatever else is set', () => {
    expect(choose({ smtpConfigured: true, isProduction: true })).toBe('refuse');
    expect(choose({ smtpConfigured: true, isProduction: true, isDemoBackend: true })).toBe(
      'simulated',
    );
  });

  it('uses SMTP for development and testing', () => {
    expect(choose({ smtpConfigured: true })).toBe('smtp');
    // Even with the demonstration backend: a developer who configured SMTP
    // asked to watch a real message arrive.
    expect(choose({ smtpConfigured: true, isDemoBackend: true })).toBe('smtp');
  });

  it('keeps the simulator for the demonstration, which next start also serves', () => {
    expect(choose({ isDemoBackend: true })).toBe('simulated');
    // The demonstration is served by `next start`, so NODE_ENV is production
    // there. Testing NODE_ENV before the backend would have broken the demo's
    // visible outbox — DELIV-2 requires it to keep working.
    expect(choose({ isDemoBackend: true, isProduction: true })).toBe('simulated');
  });
});
