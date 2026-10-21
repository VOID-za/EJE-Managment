import { describe, expect, it } from 'vitest';
import { SystemClock } from '@/services/simulated/system';
import type { EmailMessage, StorageService, StoredDocument } from '@/services/ports';
import {
  chooseEmailTransport,
  classifyGraphFailure,
  describeEmailConfiguration,
  emailConfigurationSummary,
  EmailNotConfigured,
  EmailSendFailed,
  GraphEmailService,
  isRetryableFailure,
  MAX_ATTACHMENT_BYTES,
  readGraphEmailConfiguration,
  retryAfterSeconds,
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
  timeoutMs: 20_000,
};

const document: StoredDocument = {
  storageKey: 'documents/EJE-1103.pdf',
  fileName: 'EJE-1103-Final-Job-Card.pdf',
  contentType: 'application/pdf',
  bytes: new Uint8Array([37, 80, 68, 70]),
};

const storage = (stored: StoredDocument | null = document): StorageService => ({
  resolveUrl: () => 'inert',
  storeUpload: () => Promise.reject(new Error('not used')),
  putDocument: () => Promise.resolve(),
  getDocument: () => Promise.resolve(stored),
  remove: () => Promise.resolve(),
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
      // The deadline every request now carries, defaulted.
      timeoutMs: 20_000,
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
    // The wording now says which address and what to do about it; the rule it
    // asserts is unchanged — nothing is sent and no success is reported.
    await expect(adapter.send({ ...message, to: ['not-an-address'] })).rejects.toThrow(
      /no address to send to/u,
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

  it('says WHICH KIND of failure it is, so the job can record it', async () => {
    /*
     * "Not configured" is not "the provider refused": nobody is at fault on
     * the customer's side, nothing was sent, and what has to change is this
     * deployment. The job's delivery record stores that distinction, so the
     * office reads it off the job rather than out of a sentence.
     */
    const refusal = await new UnconfiguredEmailService().send().catch((error: unknown) => error);
    expect((refusal as { kind?: string }).kind).toBe('not_configured');
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

/**
 * WHICH OF NINE THINGS WENT WRONG. MANDATE-3.
 *
 * Every failure used to be one `EmailSendFailed` carrying the provider's
 * sentence, which left the office with one action for all of them: press *Send
 * again*. These assert the distinction that decides whether that button can
 * possibly work — and they assert it on the REAL adapter, driven by real
 * `Response` objects, so a status this system claims to tell apart is told
 * apart by the code and not by a comment.
 */
describe('telling the failures apart', () => {
  /** A fetch that answers the token, then one Graph response with headers. */
  const graphAnswering = (
    status: number,
    body: unknown,
    headers: Readonly<Record<string, string>> = {},
  ): typeof fetch =>
    ((url: string | URL | Request) => {
      if (String(url).includes('oauth2/v2.0/token')) {
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: 'token-abc', expires_in: 3600 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json', ...headers },
        }),
      );
    }) as typeof fetch;

  const failureFrom = async (impl: typeof fetch): Promise<EmailSendFailed> => {
    try {
      await adapterWith(impl).send(message);
    } catch (error) {
      expect(error).toBeInstanceOf(EmailSendFailed);
      return error as EmailSendFailed;
    }
    throw new Error('the adapter reported a success');
  };

  it('a refused credential is NOT something to retry', async () => {
    const failure = await failureFrom(
      graphAnswering(401, { error: { code: 'InvalidAuthenticationToken', message: 'denied' } }),
    );
    expect(failure.kind).toBe('credentials_rejected');
    expect(failure.retryable).toBe(false);
    expect(failure.message).toMatch(/EMAIL_GRAPH_CLIENT_SECRET|credential/u);
  });

  it('a missing Mail.Send permission says so, and is not retryable', async () => {
    const failure = await failureFrom(
      graphAnswering(403, { error: { code: 'ErrorAccessDenied', message: 'Access denied' } }),
    );
    expect(failure.kind).toBe('permission_denied');
    expect(failure.retryable).toBe(false);
    expect(failure.message).toMatch(/Mail\.Send/u);
  });

  it('throttling carries the wait Microsoft asked for', async () => {
    const failure = await failureFrom(
      graphAnswering(
        429,
        { error: { code: 'ApplicationThrottled', message: 'Too many requests' } },
        { 'retry-after': '30' },
      ),
    );
    expect(failure.kind).toBe('throttled');
    expect(failure.retryAfterSeconds).toBe(30);
    expect(failure.retryable).toBe(true);
    expect(failure.message).toMatch(/Try again in 30s/u);
  });

  it('treats a 503 as throttling rather than a refusal', async () => {
    const failure = await failureFrom(graphAnswering(503, { error: { message: 'busy' } }));
    expect(failure.kind).toBe('throttled');
    expect(failure.retryable).toBe(true);
  });

  it('a 500 is the provider having a bad time, and is worth retrying', async () => {
    const failure = await failureFrom(graphAnswering(500, { error: { message: 'oops' } }));
    expect(failure.kind).toBe('provider_unavailable');
    expect(failure.retryable).toBe(true);
  });

  it('an address Graph will not accept sends the office to the customer record', async () => {
    const failure = await failureFrom(
      graphAnswering(400, {
        error: { code: 'ErrorInvalidRecipients', message: 'At least one recipient is invalid' },
      }),
    );
    expect(failure.kind).toBe('invalid_recipient');
    expect(failure.retryable).toBe(false);
    expect(failure.message).toMatch(/address needs correcting/u);
  });

  /*
   * A 400 is NOT automatically a bad address. Treating it as one would send the
   * office editing a customer's record over a malformed request.
   */
  it('does not blame the address for every 400', async () => {
    const failure = await failureFrom(
      graphAnswering(400, { error: { code: 'BadRequest', message: 'Malformed payload' } }),
    );
    expect(failure.kind).toBe('provider_refused');
    expect(failure.retryable).toBe(false);
  });

  it('a message over the size limit is not retried into the same wall', async () => {
    const failure = await failureFrom(graphAnswering(413, { error: { message: 'too big' } }));
    expect(failure.kind).toBe('attachment_too_large');
    expect(failure.retryable).toBe(false);
  });

  it('a provider that goes quiet is a TIMEOUT, named in seconds', async () => {
    const hangs = (() => {
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'TimeoutError';
      return Promise.reject(error);
    }) as unknown as typeof fetch;

    const failure = await failureFrom(hangs);
    expect(failure.kind).toBe('timed_out');
    expect(failure.retryable).toBe(true);
    expect(failure.message).toMatch(/did not answer within 20s/u);
  });

  it('a provider that cannot be reached is not the same event as one that timed out', async () => {
    const refused = (() =>
      Promise.reject(new Error('connect ECONNREFUSED'))) as unknown as typeof fetch;
    const failure = await failureFrom(refused);
    expect(failure.kind).toBe('unreachable');
    expect(failure.retryable).toBe(true);
  });

  it('EVERY request carries a deadline, so nothing can hang a submission', async () => {
    const calls: Call[] = [];
    const impl = graphFetch([{ status: 201, body: { id: 'graph-1' } }, { status: 202, body: {} }], calls);
    await adapterWith(impl).send(message);

    expect(calls).toHaveLength(3); // token, create, send
    for (const call of calls) {
      expect(call.init?.signal, `${call.url} had no deadline`).toBeInstanceOf(AbortSignal);
    }
  });

  it('asks about a message with a deadline too', async () => {
    const calls: Call[] = [];
    const impl = ((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('oauth2/v2.0/token')) {
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ id: 'graph-1' }), { status: 200 }));
    }) as typeof fetch;

    await adapterWith(impl).deliveryState('graph-1');
    expect(calls.at(-1)?.init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('an attachment Graph would refuse', () => {
  it('is refused BEFORE any request is made', async () => {
    const huge: StoredDocument = {
      ...document,
      bytes: new Uint8Array(MAX_ATTACHMENT_BYTES + 1),
    };
    const calls: Call[] = [];
    const impl = graphFetch([], calls);

    await expect(adapterWith(impl, storage(huge)).send(message)).rejects.toThrow(
      /over the \d+ KB Microsoft 365 accepts/u,
    );
    // Not one call, not even for a token: the answer was knowable here.
    expect(calls).toEqual([]);
  });

  it('is reported as something a retry cannot fix', async () => {
    const huge: StoredDocument = { ...document, bytes: new Uint8Array(MAX_ATTACHMENT_BYTES + 1) };
    try {
      await adapterWith(graphFetch([]), storage(huge)).send(message);
      throw new Error('it was accepted');
    } catch (error) {
      expect((error as EmailSendFailed).kind).toBe('attachment_too_large');
      expect((error as EmailSendFailed).retryable).toBe(false);
    }
  });

  it('a document whose bytes are gone is a STORAGE failure, named as one', async () => {
    try {
      await adapterWith(graphFetch([]), storage(null)).send(message);
      throw new Error('it was accepted');
    } catch (error) {
      expect((error as EmailSendFailed).kind).toBe('document_unavailable');
      expect((error as EmailSendFailed).message).toMatch(/could not be read/u);
    }
  });

  it('an address that is not an address never reaches the provider', async () => {
    const calls: Call[] = [];
    try {
      await adapterWith(graphFetch([], calls)).send({ ...message, to: ['not-an-address'] });
      throw new Error('it was accepted');
    } catch (error) {
      expect((error as EmailSendFailed).kind).toBe('invalid_recipient');
      expect(calls).toEqual([]);
    }
  });
});

describe('classifying a provider answer', () => {
  it('maps the statuses this system claims to distinguish', () => {
    expect(classifyGraphFailure(401, '', '')).toBe('credentials_rejected');
    expect(classifyGraphFailure(403, '', '')).toBe('permission_denied');
    expect(classifyGraphFailure(429, '', '')).toBe('throttled');
    expect(classifyGraphFailure(503, '', '')).toBe('throttled');
    expect(classifyGraphFailure(500, '', '')).toBe('provider_unavailable');
    expect(classifyGraphFailure(502, '', '')).toBe('provider_unavailable');
    expect(classifyGraphFailure(413, '', '')).toBe('attachment_too_large');
    expect(classifyGraphFailure(400, 'ErrorInvalidRecipients', '')).toBe('invalid_recipient');
    expect(classifyGraphFailure(400, '', 'The SMTP address has no mailbox')).toBe(
      'invalid_recipient',
    );
    expect(classifyGraphFailure(400, '', 'maximum message size exceeded')).toBe(
      'attachment_too_large',
    );
    expect(classifyGraphFailure(400, '', 'something else entirely')).toBe('provider_refused');
  });

  it('knows which four a retry could resolve', () => {
    for (const kind of ['throttled', 'provider_unavailable', 'timed_out', 'unreachable'] as const) {
      expect(isRetryableFailure(kind), kind).toBe(true);
    }
    for (const kind of [
      'credentials_rejected',
      'permission_denied',
      'invalid_recipient',
      'attachment_too_large',
      'document_unavailable',
      'provider_refused',
    ] as const) {
      expect(isRetryableFailure(kind), kind).toBe(false);
    }
  });

  it('reads Retry-After in both forms, and ignores nonsense', () => {
    expect(retryAfterSeconds('45')).toBe(45);
    expect(retryAfterSeconds(null)).toBeNull();
    expect(retryAfterSeconds('soon')).toBeNull();
    const inTwoMinutes = new Date(Date.now() + 120_000).toUTCString();
    expect(retryAfterSeconds(inTwoMinutes)).toBeGreaterThan(100);
  });
});

/**
 * WHAT TO TELL WHOEVER HAS TO CONFIGURE THIS. MANDATE-3.
 *
 * "Customer email is not configured" does not say that three variables are set
 * and the fourth is empty, which is the actual state of a deployment somebody
 * is halfway through setting up.
 */
describe('diagnosing the configuration', () => {
  it('names the variables that are missing, and nothing else', () => {
    const report = describeEmailConfiguration({
      EMAIL_GRAPH_TENANT_ID: 'tenant-1',
      EMAIL_GRAPH_CLIENT_ID: 'client-1',
    });
    expect(report.configured).toBe(false);
    expect(report.missing).toEqual(['EMAIL_GRAPH_CLIENT_SECRET', 'EMAIL_SENDER']);
    expect(emailConfigurationSummary(report)).toMatch(
      /EMAIL_GRAPH_CLIENT_SECRET, EMAIL_SENDER are not set/u,
    );
  });

  it('NEVER reports a secret, not even its length', () => {
    const report = describeEmailConfiguration({
      EMAIL_GRAPH_TENANT_ID: 'tenant-1',
      EMAIL_GRAPH_CLIENT_ID: 'client-1',
      EMAIL_GRAPH_CLIENT_SECRET: 'super-secret-value',
      EMAIL_SENDER: 'jobcards@eje.example',
    });
    const printed = JSON.stringify(report) + emailConfigurationSummary(report);
    expect(printed).not.toContain('super-secret-value');
    expect(printed).not.toContain('18');
    expect(report.configured).toBe(true);
    expect(report.sender).toBe('jobcards@eje.example');
  });

  it('catches the mistakes that leave a configured deployment unable to send', () => {
    const report = describeEmailConfiguration({
      EMAIL_GRAPH_TENANT_ID: 'tenant@eje.example',
      EMAIL_GRAPH_CLIENT_ID: 'client-1',
      EMAIL_GRAPH_CLIENT_SECRET: 'secret',
      EMAIL_SENDER: 'EJE Job Cards',
      EMAIL_REPLY_TO: 'the office',
      EMAIL_GRAPH_TIMEOUT_MS: 'ten seconds',
    });
    const summary = emailConfigurationSummary(report);
    expect(summary).toMatch(/EMAIL_SENDER is not an address/u);
    expect(summary).toMatch(/EMAIL_REPLY_TO is set and is not an address/u);
    expect(summary).toMatch(/EMAIL_GRAPH_TENANT_ID looks like an address/u);
    expect(summary).toMatch(/EMAIL_GRAPH_TIMEOUT_MS is not a positive number/u);
    // Complete, in the sense that a transport is chosen — and still broken.
    expect(report.configured).toBe(true);
  });

  it('reports the endpoints and the deadline in use, so an override is visible', () => {
    const report = describeEmailConfiguration({
      EMAIL_GRAPH_TENANT_ID: 'tenant-1',
      EMAIL_GRAPH_CLIENT_ID: 'client-1',
      EMAIL_GRAPH_CLIENT_SECRET: 'secret',
      EMAIL_SENDER: 'jobcards@eje.example',
      EMAIL_GRAPH_BASE_URL: 'https://graph.example.test/v1.0/',
      EMAIL_GRAPH_TIMEOUT_MS: '5000',
    });
    expect(report.baseUrl).toBe('https://graph.example.test/v1.0');
    expect(report.timeoutMs).toBe(5000);
    expect(emailConfigurationSummary(report)).toBe('');
  });
});
