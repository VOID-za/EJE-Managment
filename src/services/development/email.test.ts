import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SystemClock } from '@/services/simulated/system';
import { SimulatedOutbox } from '@/services/simulated/outbox';
import type { EmailMessage, StorageService, StoredDocument } from '@/services/ports';
import { readSmtpEmailConfiguration, SmtpEmailService, SmtpSendFailed } from './email';

/**
 * The development SMTP adapter, driven against a real SMTP conversation.
 *
 * The fake server below speaks the protocol on a loopback port, so these
 * exercise the adapter's actual dialogue — EHLO, AUTH, MAIL FROM, RCPT TO, DATA
 * — rather than a mock of it. Only what a real mail server would do differently
 * under load is out of reach, and no test here pretends otherwise.
 */
const document: StoredDocument = {
  storageKey: 'documents/EJE-1103.pdf',
  fileName: 'EJE-1103-Final-Job-Card.pdf',
  contentType: 'application/pdf',
  bytes: new Uint8Array([37, 80, 68, 70, 10]),
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
  cc: ['office@eje.example'],
  subject: 'EJE-1103 — your job card',
  body: 'The signed job card is attached.',
  attachments: [{ fileName: document.fileName, storageKey: document.storageKey }],
};

interface FakeServer {
  readonly port: number;
  readonly transcript: string[];
  readonly close: () => Promise<void>;
}

/** A mail server that answers the protocol, and records what it was told. */
const fakeSmtp = async (
  options: {
    readonly advertiseStartTls?: boolean;
    readonly reply?: (command: string) => string | null;
  } = {},
): Promise<FakeServer> => {
  const transcript: string[] = [];
  let inData = false;

  const server: Server = createServer((socket: Socket) => {
    socket.write('220 fake.eje.local ESMTP\r\n');
    socket.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (inData) {
        transcript.push(`DATA-BODY ${text.length} bytes`);
        if (text.includes('\r\n.')) {
          inData = false;
          socket.write('250 2.0.0 Ok: queued as FAKE1\r\n');
        }
        return;
      }
      for (const line of text.split('\r\n').filter((part) => part.length > 0)) {
        transcript.push(line);
        const override = options.reply?.(line) ?? null;
        if (override !== null) {
          socket.write(`${override}\r\n`);
          continue;
        }
        if (line.startsWith('EHLO')) {
          socket.write('250-fake.eje.local\r\n');
          if (options.advertiseStartTls === true) socket.write('250-STARTTLS\r\n');
          socket.write('250 AUTH PLAIN LOGIN\r\n');
        } else if (line.startsWith('AUTH')) socket.write('235 2.7.0 Authenticated\r\n');
        else if (line.startsWith('MAIL FROM')) socket.write('250 2.1.0 Ok\r\n');
        else if (line.startsWith('RCPT TO')) socket.write('250 2.1.5 Ok\r\n');
        else if (line.startsWith('DATA')) {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (line.startsWith('QUIT')) {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else socket.write('250 2.0.0 Ok\r\n');
      }
    });
    socket.on('error', () => {});
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    port,
    transcript,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

const servers: FakeServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

const adapterFor = (server: FakeServer, store: StorageService = storage(), password = 'smtp-pass') =>
  new SmtpEmailService(
    {
      host: '127.0.0.1',
      port: server.port,
      implicitTls: false,
      user: 'eje-dev',
      password,
      sender: 'jobcards@eje.example',
      replyTo: 'office@eje.example',
    },
    store,
    new SystemClock(),
    new SimulatedOutbox(),
    3_000,
  );

describe('reading the configuration', () => {
  it('is null without a host or a sender — there is no default account', () => {
    expect(readSmtpEmailConfiguration({})).toBeNull();
    expect(readSmtpEmailConfiguration({ EMAIL_SMTP_HOST: 'smtp.example' })).toBeNull();
    expect(readSmtpEmailConfiguration({ EMAIL_SENDER: 'a@b.example' })).toBeNull();
  });

  it('defaults the port to 587 and treats 465 as implicit TLS', () => {
    const plain = readSmtpEmailConfiguration({
      EMAIL_SMTP_HOST: 'smtp.example',
      EMAIL_SENDER: 'a@b.example',
    });
    expect(plain?.port).toBe(587);
    expect(plain?.implicitTls).toBe(false);

    const secure = readSmtpEmailConfiguration({
      EMAIL_SMTP_HOST: 'smtp.example',
      EMAIL_SENDER: 'a@b.example',
      EMAIL_SMTP_PORT: '465',
    });
    expect(secure?.implicitTls).toBe(true);

    const nonsense = readSmtpEmailConfiguration({
      EMAIL_SMTP_HOST: 'smtp.example',
      EMAIL_SENDER: 'a@b.example',
      EMAIL_SMTP_PORT: 'abc',
    });
    expect(nonsense?.port).toBe(587);
  });
});

describe('sending', () => {
  it('holds the whole conversation and reports ACCEPTED, not delivered', async () => {
    const server = await fakeSmtp();
    servers.push(server);
    const receipt = await adapterFor(server).send(message);

    expect(receipt.state).toBe('pending_delivery');
    expect(receipt.messageId).toMatch(/@eje\.local$/u);
    expect(receipt.entry?.simulated).toBe(false);
    expect(receipt.entry?.attachments).toEqual(['EJE-1103-Final-Job-Card.pdf']);

    const conversation = server.transcript.join('\n');
    expect(conversation).toContain('EHLO');
    expect(conversation).toContain('AUTH PLAIN');
    expect(conversation).toContain('MAIL FROM:<jobcards@eje.example>');
    expect(conversation).toContain('RCPT TO:<customer@abc-engineering.example>');
    expect(conversation).toContain('RCPT TO:<office@eje.example>');
    expect(conversation).toContain('DATA');
    expect(conversation).toContain('QUIT');
  });

  it('never puts the account password on the wire in the clear or in an error', async () => {
    const server = await fakeSmtp({
      reply: (command) => (command.startsWith('MAIL FROM') ? '550 Rejected smtp-pass leaked' : null),
    });
    servers.push(server);
    const failure = await adapterFor(server)
      .send(message)
      .then(() => null)
      .catch((error: unknown) => error as SmtpSendFailed);

    expect(failure).toBeInstanceOf(SmtpSendFailed);
    expect(failure?.message).not.toContain('smtp-pass');
    expect(failure?.message).toContain('[redacted]');
    // AUTH PLAIN is base64, not plaintext — the password never appears as typed.
    expect(server.transcript.join('\n')).not.toContain('smtp-pass');
  });

  it('sends nothing when the stored document cannot be read', async () => {
    const server = await fakeSmtp();
    servers.push(server);
    await expect(adapterFor(server, storage(null)).send(message)).rejects.toThrow(
      /could not be read, so nothing was sent/u,
    );
    // The conversation never started: no MAIL FROM reached the server.
    expect(server.transcript.join('\n')).not.toContain('MAIL FROM');
  });

  it('raises with the server code when a recipient is refused', async () => {
    const server = await fakeSmtp({
      reply: (command) => (command.startsWith('RCPT TO') ? '550 5.1.1 No such user' : null),
    });
    servers.push(server);
    const failure = await adapterFor(server)
      .send(message)
      .then(() => null)
      .catch((error: unknown) => error as SmtpSendFailed);
    expect(failure?.message).toContain('No such user');
    expect(failure?.providerCode).toBe('550');
  });

  it('raises when STARTTLS is advertised and then refused', async () => {
    const server = await fakeSmtp({
      advertiseStartTls: true,
      reply: (command) => (command === 'STARTTLS' ? '454 TLS not available' : null),
    });
    servers.push(server);
    await expect(adapterFor(server).send(message)).rejects.toThrow(/STARTTLS was refused/u);
  });

  it('refuses a recipient address that is not an address, before connecting', async () => {
    const server = await fakeSmtp();
    servers.push(server);
    await expect(
      adapterFor(server).send({ ...message, to: ['not-an-address'], cc: [] }),
    ).rejects.toThrow(/rejected before sending/u);
    expect(server.transcript).toHaveLength(0);
  });

  it('raises rather than hanging when nothing is listening', async () => {
    const server = await fakeSmtp();
    servers.push(server);
    const closedPort = server.port;
    await server.close();
    servers.splice(0);
    const adapter = new SmtpEmailService(
      {
        host: '127.0.0.1',
        port: closedPort,
        implicitTls: false,
        user: '',
        password: '',
        sender: 'jobcards@eje.example',
        replyTo: '',
      },
      storage(),
      new SystemClock(),
      new SimulatedOutbox(),
      2_000,
    );
    await expect(adapter.send(message)).rejects.toThrow();
  });
});

describe('asking what became of a message', () => {
  it('reports only what the outbox knows, and never claims delivery itself', async () => {
    const server = await fakeSmtp();
    servers.push(server);
    const outbox = new SimulatedOutbox();
    const adapter = new SmtpEmailService(
      {
        host: '127.0.0.1',
        port: server.port,
        implicitTls: false,
        user: '',
        password: '',
        sender: 'jobcards@eje.example',
        replyTo: '',
      },
      storage(),
      new SystemClock(),
      outbox,
      3_000,
    );

    const receipt = await adapter.send(message);
    const state = await adapter.deliveryState(receipt.messageId);
    expect(state?.state).toBe('pending_delivery');
    expect(await adapter.deliveryState('never-sent')).toBeNull();

    // Only the outbox screen can move it on — SMTP has no delivery reports.
    await outbox.setDelivery(receipt.messageId, 'delivered', '');
    expect((await adapter.deliveryState(receipt.messageId))?.state).toBe('delivered');
  });
});
