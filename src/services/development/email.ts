import { connect as connectPlain, type Socket } from 'node:net';
import { connect as connectTls, type TLSSocket } from 'node:tls';
import { randomUUID } from 'node:crypto';
import type {
  Clock,
  DeliveryReceipt,
  EmailMessage,
  EmailService,
  StorageService,
} from '../ports';
import type { SimulatedOutbox } from '../simulated/outbox';

/**
 * SMTP email, FOR DEVELOPMENT AND TESTING ONLY.
 *
 * THIS IS NOT THE PRODUCTION ARCHITECTURE. EJE's production mail provider is
 * Microsoft 365 through the Graph API — see `../production/email.ts`. This
 * adapter exists because SMTP is the only mail capability available while the
 * Graph app registration does not yet exist, and it lets a developer watch a
 * real message arrive instead of trusting a simulation. The composition root
 * REFUSES to use it in production; that refusal is the point of it being here
 * rather than there.
 *
 * WHAT IT CANNOT DO, AND WHY THAT MATTERS. SMTP has no delivery reports. Once
 * the receiving server has answered `250 OK` to the DATA command, this adapter
 * knows the message was ACCEPTED and can never learn anything more. So
 * `deliveryState` reads the outbox and nothing else: it will never move a job to
 * `delivered` on its own. A job in development therefore stays in
 * `awaiting_delivery` until somebody confirms it from the outbox screen, exactly
 * as it does with the simulator. That limitation is a large part of why SMTP is
 * not the production answer.
 *
 * WHY NO LIBRARY. The project avoids dependencies it does not need, and this is
 * a development transport: EHLO, optional STARTTLS, AUTH, MAIL FROM, RCPT TO,
 * DATA. Roughly a hundred lines of protocol against a mail server a developer
 * controls, rather than a dependency in the production tree for something
 * production does not use.
 */
export interface SmtpEmailConfiguration {
  readonly host: string;
  readonly port: number;
  /** True for implicit TLS (465). False starts plain and upgrades with STARTTLS. */
  readonly implicitTls: boolean;
  readonly user: string;
  readonly password: string;
  readonly sender: string;
  readonly replyTo: string;
}

/**
 * The configuration, or null when this deployment has none.
 *
 * CREDENTIALS COME FROM THE ENVIRONMENT AND NOWHERE ELSE. There is no default
 * host, no default account and no fallback: an incomplete configuration is null,
 * which the composition root turns into the simulator in a demonstration or a
 * refusal anywhere else. Nothing here is ever written to the repository.
 */
export const readSmtpEmailConfiguration = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): SmtpEmailConfiguration | null => {
  const host = (env.EMAIL_SMTP_HOST ?? '').trim();
  const sender = (env.EMAIL_SENDER ?? '').trim();
  if (host.length === 0 || sender.length === 0) return null;

  const port = Number.parseInt((env.EMAIL_SMTP_PORT ?? '').trim(), 10);
  const resolvedPort = Number.isInteger(port) && port > 0 && port < 65536 ? port : 587;
  return {
    host,
    port: resolvedPort,
    implicitTls: (env.EMAIL_SMTP_IMPLICIT_TLS ?? '').trim() === 'yes' || resolvedPort === 465,
    user: (env.EMAIL_SMTP_USER ?? '').trim(),
    password: env.EMAIL_SMTP_PASSWORD ?? '',
    sender,
    replyTo: (env.EMAIL_REPLY_TO ?? '').trim(),
  };
};

/** Raised when the mail server refused the message. */
export class SmtpSendFailed extends Error {
  constructor(
    message: string,
    readonly providerCode: string = '',
  ) {
    super(message);
    this.name = 'SmtpSendFailed';
  }
}

/** One SMTP conversation. Opened per message, closed when it ends. */
interface Conversation {
  readonly send: (line: string) => Promise<string>;
  readonly upgrade: () => Promise<void>;
  readonly close: () => void;
}

const CRLF = '\r\n';

/**
 * Reads SMTP replies, which are line-based and may be multi-line.
 *
 * A reply is finished when a line's fourth character is a space rather than a
 * hyphen: "250-STARTTLS" continues, "250 HELP" ends. Getting this wrong is how
 * an SMTP client hangs, so it is explicit rather than assumed.
 */
const replyComplete = (buffer: string): boolean => {
  const lines = buffer.split(CRLF).filter((line) => line.length > 0);
  if (lines.length === 0) return false;
  const last = lines[lines.length - 1] ?? '';
  return last.length >= 4 && last[3] === ' ';
};

const openConversation = (config: SmtpEmailConfiguration, timeoutMs: number): Promise<Conversation> =>
  new Promise((resolve, reject) => {
    let socket: Socket | TLSSocket = config.implicitTls
      ? connectTls({ host: config.host, port: config.port, servername: config.host })
      : connectPlain({ host: config.host, port: config.port });

    let buffer = '';
    let waiting: { resolve: (reply: string) => void; reject: (error: Error) => void } | null = null;

    const attach = (target: Socket | TLSSocket) => {
      target.setTimeout(timeoutMs);
      target.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        if (waiting !== null && replyComplete(buffer)) {
          const reply = buffer;
          buffer = '';
          const pending = waiting;
          waiting = null;
          pending.resolve(reply);
        }
      });
      target.on('error', (error: Error) => {
        const pending = waiting;
        waiting = null;
        if (pending !== null) pending.reject(error);
        else reject(error);
      });
      target.on('timeout', () => {
        target.destroy();
        const pending = waiting;
        waiting = null;
        const error = new SmtpSendFailed(`${config.host} did not answer within ${timeoutMs} ms.`);
        if (pending !== null) pending.reject(error);
        else reject(error);
      });
    };

    const nextReply = (): Promise<string> =>
      new Promise((resolveReply, rejectReply) => {
        if (replyComplete(buffer)) {
          const reply = buffer;
          buffer = '';
          resolveReply(reply);
          return;
        }
        waiting = { resolve: resolveReply, reject: rejectReply };
      });

    const send = async (line: string): Promise<string> => {
      socket.write(line + CRLF);
      return nextReply();
    };

    const upgrade = async (): Promise<void> => {
      const plain = socket;
      plain.removeAllListeners('data');
      plain.removeAllListeners('error');
      plain.removeAllListeners('timeout');
      await new Promise<void>((resolveUpgrade, rejectUpgrade) => {
        const secure = connectTls({ socket: plain, servername: config.host }, () => {
          socket = secure;
          buffer = '';
          attach(secure);
          resolveUpgrade();
        });
        secure.on('error', rejectUpgrade);
      });
    };

    attach(socket);
    const ready = () => {
      void nextReply()
        .then((greeting) => {
          if (!greeting.startsWith('220')) {
            socket.destroy();
            reject(new SmtpSendFailed(`${config.host} did not greet us: ${greeting.trim()}`));
            return;
          }
          resolve({ send, upgrade, close: () => socket.destroy() });
        })
        .catch(reject);
    };
    socket.on(config.implicitTls ? 'secureConnect' : 'connect', ready);
  });

const expect = (reply: string, codes: readonly string[], what: string): void => {
  if (codes.some((code) => reply.startsWith(code))) return;
  throw new SmtpSendFailed(`${what}: ${reply.trim()}`, reply.slice(0, 3));
};

export class SmtpEmailService implements EmailService {
  constructor(
    private readonly config: SmtpEmailConfiguration,
    private readonly storage: StorageService,
    private readonly clock: Clock,
    /**
     * The outbox this records into, so the delivery handshake has something to
     * read and the office can see what went out. The same outbox the simulated
     * adapter uses — a real send is recorded with `simulated: false`.
     */
    private readonly outbox: SimulatedOutbox,
    private readonly timeoutMs = 15_000,
  ) {}

  /** Keeps the account password out of anything that is about to be reported. */
  private redact(text: string): string {
    return this.config.password.length === 0
      ? text
      : text.split(this.config.password).join('[redacted]');
  }

  /** The message, as MIME. One part for the note, one per attachment. */
  private async mime(message: EmailMessage, messageId: string): Promise<string> {
    const boundary = `eje-${randomUUID()}`;
    const recipients = message.to.join(', ');
    const headers = [
      `From: ${this.config.sender}`,
      `To: ${recipients}`,
      ...((message.cc ?? []).length === 0 ? [] : [`Cc: ${(message.cc ?? []).join(', ')}`]),
      ...(this.config.replyTo.length === 0 ? [] : [`Reply-To: ${this.config.replyTo}`]),
      `Subject: ${message.subject}`,
      `Message-ID: <${messageId}>`,
      `Date: ${new Date(this.clock.now()).toUTCString()}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ];

    const parts = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      message.body,
    ];

    for (const attachment of message.attachments ?? []) {
      const stored = await this.storage.getDocument(attachment.storageKey);
      if (stored === null) {
        // The document is the point of the email; a covering note on its own
        // would be a delivery the customer cannot use.
        throw new SmtpSendFailed(
          `The stored document ${attachment.fileName} could not be read, so nothing was sent.`,
        );
      }
      const encoded = Buffer.from(stored.bytes).toString('base64').replace(/(.{76})/gu, `$1${CRLF}`);
      parts.push(
        `--${boundary}`,
        `Content-Type: ${stored.contentType}; name="${attachment.fileName}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${attachment.fileName}"`,
        '',
        encoded,
      );
    }
    parts.push(`--${boundary}--`, '');

    // A bare "." would end the DATA command early; the protocol's own escape.
    const body = parts.join(CRLF).split(CRLF).map((line) => (line === '.' ? '..' : line)).join(CRLF);
    return `${headers.join(CRLF)}${CRLF}${CRLF}${body}`;
  }

  async send(message: EmailMessage): Promise<DeliveryReceipt> {
    const recipients = message.to.filter((address) => address.includes('@'));
    if (recipients.length === 0) {
      throw new SmtpSendFailed('The recipient address was rejected before sending.');
    }

    const messageId = `${randomUUID()}@eje.local`;
    const payload = await this.mime(message, messageId);
    const conversation = await openConversation(this.config, this.timeoutMs);

    try {
      let greeting = await conversation.send(`EHLO eje-tracker`);
      expect(greeting, ['250'], `${this.config.host} refused EHLO`);

      if (!this.config.implicitTls && /STARTTLS/iu.test(greeting)) {
        expect(await conversation.send('STARTTLS'), ['220'], 'STARTTLS was refused');
        await conversation.upgrade();
        greeting = await conversation.send(`EHLO eje-tracker`);
        expect(greeting, ['250'], `${this.config.host} refused EHLO after STARTTLS`);
      }

      if (this.config.user.length > 0) {
        const credential = Buffer.from(
          `\u0000${this.config.user}\u0000${this.config.password}`,
          'utf8',
        ).toString('base64');
        expect(
          await conversation.send(`AUTH PLAIN ${credential}`),
          ['235'],
          'The mail server rejected the account',
        );
      }

      expect(
        await conversation.send(`MAIL FROM:<${this.config.sender}>`),
        ['250'],
        'The sender was rejected',
      );
      for (const address of [...recipients, ...(message.cc ?? [])]) {
        if (!address.includes('@')) continue;
        expect(
          await conversation.send(`RCPT TO:<${address}>`),
          ['250', '251'],
          `The recipient ${address} was rejected`,
        );
      }
      expect(await conversation.send('DATA'), ['354'], 'The server refused the message body');
      const accepted = await conversation.send(`${payload}${CRLF}.`);
      expect(accepted, ['250'], 'The server did not accept the message');
      await conversation.send('QUIT').catch(() => '');
    } catch (error) {
      conversation.close();
      throw error instanceof SmtpSendFailed
        ? new SmtpSendFailed(this.redact(error.message), error.providerCode)
        : new SmtpSendFailed(
            this.redact(error instanceof Error ? error.message : 'The mail server could not be reached.'),
          );
    }
    conversation.close();

    const entry = await this.outbox.record({
      id: messageId,
      channel: 'email',
      to: recipients.join(', '),
      subject: message.subject,
      body: message.body,
      attachments: (message.attachments ?? []).map((attachment) => attachment.fileName),
      createdAt: this.clock.now(),
      // A real message left the building, so this is NOT a simulated entry.
      simulated: false,
      /*
       * ACCEPTED, NOT DELIVERED. The receiving server took it. SMTP will never
       * tell us more than that, which is why this adapter is for development.
       */
      delivery: 'pending_delivery',
      failureReason: '',
    });

    return { messageId, state: 'pending_delivery', failureReason: '', entry };
  }

  /**
   * What the outbox knows, which is all SMTP can ever offer.
   *
   * It reports no delivery of its own: a job moves to `closed` only when
   * somebody confirms it from the outbox screen. See the class comment.
   */
  async deliveryState(messageId: string): Promise<DeliveryReceipt | null> {
    const entry = (await this.outbox.list()).find((candidate) => candidate.id === messageId);
    if (entry === undefined) return null;
    return {
      messageId: entry.id,
      state: entry.delivery,
      failureReason: entry.failureReason,
      entry,
    };
  }
}
