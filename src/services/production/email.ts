import type {
  Clock,
  DeliveryReceipt,
  EmailMessage,
  EmailService,
  OutboxEntry,
  StorageService,
} from '../ports';

/**
 * Microsoft 365 email, for real, through the Graph API.
 *
 * WHAT THIS IS. EJE's production mail provider is Microsoft 365, and this is
 * the adapter for it, behind the same `EmailService` port the rest of the system
 * already talks to. Nothing above it changes: the submission still calls
 * `services.email.send(...)` and the delivery handshake still calls
 * `services.email.deliveryState(...)`.
 *
 * WHY create-THEN-send RATHER THAN sendMail. Graph's `sendMail` answers 202 with
 * an empty body — no message id. An id is not a nicety here: `OutboxEntry.id`
 * for a production adapter is the provider's own id, and it is the only thing
 * that makes an entry reconcilable against a delivery report later. So this
 * creates a draft (`POST /users/{sender}/messages`), which returns Graph's id,
 * then sends that draft. One extra round trip buys a message the office can
 * still ask about tomorrow.
 *
 * WHAT IT WILL NOT DO. It will not say a message was delivered. Graph accepting
 * a send means Exchange has it, not that a customer's mail server took it and
 * certainly not that anybody read it. That is `pending_delivery`, and only
 * `deliveryState` reading the message back may move it on. An adapter that
 * returned `delivered` on a 202 would close a job on a lie.
 *
 * A FAILURE IS A FAILURE. A non-2xx response, a network error or a timeout
 * raises `EmailSendFailed`. The submission path catches it, records the failure
 * with its reason on the job's delivery record, and leaves the job in
 * `awaiting_delivery` where the office can re-send the STORED document — see
 * `resendCustomerCopy`. Nothing is swallowed into a success.
 */
export interface GraphEmailConfiguration {
  /** The Entra ID tenant that owns the mailbox. */
  readonly tenantId: string;
  readonly clientId: string;
  /** A client secret or certificate credential for the app registration. */
  readonly clientSecret: string;
  /** The mailbox that sends, e.g. "jobcards@eje.example". Graph's `{sender}`. */
  readonly sender: string;
  /** Where replies should go, when it is not the sending mailbox. */
  readonly replyTo: string;
  readonly baseUrl: string;
  readonly loginUrl: string;
}

const DEFAULT_BASE_URL = 'https://graph.microsoft.com/v1.0';
const DEFAULT_LOGIN_URL = 'https://login.microsoftonline.com';

/**
 * The configuration, or null when this deployment has none.
 *
 * Null is a legitimate answer and is NOT a fallback to a fake sender: the
 * composition root turns it into `UnconfiguredEmailService`, which refuses and
 * says why. All three of tenant, client id and secret are required together —
 * two out of three is a half-configured deployment, and guessing which half was
 * meant is how a production system ends up sending nothing quietly.
 */
export const readGraphEmailConfiguration = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): GraphEmailConfiguration | null => {
  const tenantId = (env.EMAIL_GRAPH_TENANT_ID ?? '').trim();
  const clientId = (env.EMAIL_GRAPH_CLIENT_ID ?? '').trim();
  const clientSecret = (env.EMAIL_GRAPH_CLIENT_SECRET ?? '').trim();
  const sender = (env.EMAIL_SENDER ?? '').trim();
  if (
    tenantId.length === 0 ||
    clientId.length === 0 ||
    clientSecret.length === 0 ||
    sender.length === 0
  ) {
    return null;
  }

  return {
    tenantId,
    clientId,
    clientSecret,
    sender,
    replyTo: (env.EMAIL_REPLY_TO ?? '').trim(),
    baseUrl: ((env.EMAIL_GRAPH_BASE_URL ?? '').trim() || DEFAULT_BASE_URL).replace(/\/+$/u, ''),
    loginUrl: ((env.EMAIL_GRAPH_LOGIN_URL ?? '').trim() || DEFAULT_LOGIN_URL).replace(/\/+$/u, ''),
  };
};

/**
 * Which transport a deployment gets, decided in one place and testable.
 *
 * THE ORDER IS THE ARCHITECTURE:
 *
 *   'graph'     Microsoft 365, wherever it is configured. The only production
 *               answer, because it is EJE's mail provider.
 *   'smtp'      Development and testing only, and only outside production. It is
 *               unreachable in production by construction: the check below reads
 *               `isProduction`, so no combination of variables can select SMTP
 *               there. SMTP has no delivery reports and is not the production
 *               architecture.
 *   'simulated' The DEMONSTRATION — the in-memory backend, which has no database
 *               and no mail account and must keep working with neither
 *               (DELIV-2). This is decided by the backend, NOT by NODE_ENV: the
 *               demonstration is served by `next start`, so testing NODE_ENV
 *               first would have broken the demo's visible outbox, which is the
 *               whole of how the demonstration shows what would be sent.
 *   'refuse'    A real-database deployment with no email configuration. NOT the
 *               simulator: it says so on every job rather than leaving EJE
 *               believing customers were sent their job cards when nothing left
 *               the building (MANDATE-3).
 *
 * This is a function of configuration and nothing else, so the rule can be
 * proved without starting a server.
 */
export type EmailTransport = 'graph' | 'refuse' | 'smtp' | 'simulated';

export const chooseEmailTransport = (options: {
  readonly graphConfigured: boolean;
  readonly smtpConfigured: boolean;
  readonly isProduction: boolean;
  readonly isDemoBackend: boolean;
}): EmailTransport => {
  if (options.graphConfigured) return 'graph';
  if (options.smtpConfigured && !options.isProduction) return 'smtp';
  if (options.isDemoBackend) return 'simulated';
  return 'refuse';
};

/** Raised when the provider did not accept the message. */
export class EmailSendFailed extends Error {
  constructor(
    message: string,
    /** The provider's own code, where it gave one. For the audit trail. */
    readonly providerCode: string = '',
  ) {
    super(message);
    this.name = 'EmailSendFailed';
  }
}

/** Raised when a deployment has no email configuration at all. */
export class EmailNotConfigured extends Error {
  constructor(detail = '') {
    super(
      'Customer email is not configured on this deployment. Set EMAIL_GRAPH_TENANT_ID, ' +
        'EMAIL_GRAPH_CLIENT_ID, EMAIL_GRAPH_CLIENT_SECRET and EMAIL_SENDER — see ' +
        `docs/integrations.md.${detail.length === 0 ? '' : ` ${detail}`}`,
    );
    this.name = 'EmailNotConfigured';
  }
}

interface GraphTokenResponse {
  readonly access_token?: string;
  readonly expires_in?: number;
  readonly error_description?: string;
  readonly error?: string;
}

interface GraphMessageResponse {
  readonly id?: string;
  readonly error?: { readonly code?: string; readonly message?: string };
}

export class GraphEmailService implements EmailService {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: GraphEmailConfiguration,
    /** Where an attachment's bytes come from. Attachments carry keys, not bytes. */
    private readonly storage: StorageService,
    private readonly clock: Clock,
    /*
     * No id generator. Graph supplies the message id, and that id IS the outbox
     * entry's id — which is what makes the entry reconcilable later. An adapter
     * that minted its own would be inventing a reference nobody can look up.
     */
    /** Injected so a test can drive the adapter without a network. */
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * Takes the credential out of anything that is about to be reported.
   *
   * A failure message from here reaches the job's delivery record and, through
   * it, a screen. The secret and the bearer token are in the request that
   * failed — an HTTP client that quotes the request it could not make, or a
   * provider that echoes a header, would put a permanent credential somewhere it
   * can never be removed from.
   */
  private redact(text: string): string {
    let safe = text;
    for (const secret of [this.config.clientSecret, this.token?.value ?? '']) {
      if (secret.length > 0) safe = safe.split(secret).join('[redacted]');
    }
    return safe;
  }

  /** A client-credentials token, cached until shortly before it expires. */
  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.token !== null && this.token.expiresAt > now) return this.token.value;

    const url = `${this.config.loginUrl}/${this.config.tenantId}/oauth2/v2.0/token`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          scope: 'https://graph.microsoft.com/.default',
          grant_type: 'client_credentials',
        }).toString(),
      });
    } catch (cause) {
      throw new EmailSendFailed(
        `Microsoft 365 could not be reached for a token: ${this.redact(
          cause instanceof Error ? cause.message : 'network error',
        )}.`,
      );
    }

    const payload = (await response.json().catch(() => ({}))) as GraphTokenResponse;
    if (!response.ok || (payload.access_token ?? '').length === 0) {
      throw new EmailSendFailed(
        this.redact(
          payload.error_description ??
            `Microsoft 365 refused the credentials (HTTP ${response.status}).`,
        ),
        payload.error ?? '',
      );
    }

    // 60 seconds of slack, so a token never expires mid-request.
    const lifetime = (payload.expires_in ?? 3600) * 1000;
    this.token = { value: payload.access_token as string, expiresAt: now + lifetime - 60_000 };
    return this.token.value;
  }

  private async call(path: string, body: unknown): Promise<GraphMessageResponse> {
    const token = await this.accessToken();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new EmailSendFailed(
        `Microsoft 365 could not be reached: ${this.redact(
          cause instanceof Error ? cause.message : 'network error',
        )}.`,
      );
    }

    if (response.status === 202 || response.status === 204) return {};

    const payload = (await response.json().catch(() => ({}))) as GraphMessageResponse;
    if (!response.ok) {
      throw new EmailSendFailed(
        this.redact(
          payload.error?.message ?? `Microsoft 365 refused the message (HTTP ${response.status}).`,
        ),
        payload.error?.code ?? '',
      );
    }
    return payload;
  }

  /** The job card's bytes, as Graph wants them. */
  private async attachmentsFor(message: EmailMessage): Promise<readonly unknown[]> {
    const wanted = message.attachments ?? [];
    const prepared: unknown[] = [];
    for (const attachment of wanted) {
      const stored = await this.storage.getDocument(attachment.storageKey);
      if (stored === null) {
        // The document is the point of the email. Sending the covering note
        // without it would be a delivery the customer cannot use, recorded as a
        // success.
        throw new EmailSendFailed(
          `The stored document ${attachment.fileName} could not be read, so nothing was sent.`,
        );
      }
      prepared.push({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: attachment.fileName,
        contentType: stored.contentType,
        contentBytes: Buffer.from(stored.bytes).toString('base64'),
      });
    }
    return prepared;
  }

  async send(message: EmailMessage): Promise<DeliveryReceipt> {
    const recipients = message.to.filter((address) => address.includes('@'));
    if (recipients.length === 0) {
      throw new EmailSendFailed('The provider rejected the recipient address.');
    }

    const draft = {
      subject: message.subject,
      body: { contentType: 'Text', content: message.body },
      toRecipients: recipients.map((address) => ({ emailAddress: { address } })),
      ccRecipients: (message.cc ?? [])
        .filter((address) => address.includes('@'))
        .map((address) => ({ emailAddress: { address } })),
      ...(this.config.replyTo.length === 0
        ? {}
        : { replyTo: [{ emailAddress: { address: this.config.replyTo } }] }),
      attachments: await this.attachmentsFor(message),
    };

    const sender = encodeURIComponent(this.config.sender);
    const created = await this.call(`/users/${sender}/messages`, draft);
    const messageId = created.id ?? '';
    if (messageId.length === 0) {
      throw new EmailSendFailed('Microsoft 365 created the message without returning an id.');
    }

    await this.call(`/users/${sender}/messages/${encodeURIComponent(messageId)}/send`, {});

    const entry: OutboxEntry = {
      id: messageId,
      channel: 'email',
      to: recipients.join(', '),
      subject: message.subject,
      body: message.body,
      attachments: (message.attachments ?? []).map((attachment) => attachment.fileName),
      createdAt: this.clock.now(),
      simulated: false,
      /*
       * ACCEPTED, NOT DELIVERED.
       *
       * Exchange has the message. Whether the customer's mail server took it is
       * something only a delivery report can say, and this deployment does not
       * yet receive one — see `docs/integrations.md`.
       */
      delivery: 'pending_delivery',
      failureReason: '',
    };

    return { messageId, state: 'pending_delivery', failureReason: '', entry };
  }

  /**
   * Asks Graph what became of a message it accepted earlier.
   *
   * A message that is still readable is one Exchange accepted and nothing has
   * contradicted, which is `pending_delivery`. A message Graph no longer knows
   * about answers null, and the job keeps the state it already had rather than
   * being moved on a shrug.
   */
  async deliveryState(messageId: string): Promise<DeliveryReceipt | null> {
    if (messageId.length === 0) return null;
    const token = await this.accessToken();
    const sender = encodeURIComponent(this.config.sender);
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.config.baseUrl}/users/${sender}/messages/${encodeURIComponent(messageId)}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
    } catch {
      // A reporting call that cannot be made says nothing. It must not be read
      // as a failed delivery: the message may well have arrived.
      return null;
    }
    if (response.status === 404) return null;
    if (!response.ok) return null;

    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (payload === null) return null;
    /*
     * Graph exposes no per-recipient delivery verdict on the message resource.
     * A message that is still readable was accepted and nothing has
     * contradicted it, which is exactly `pending_delivery`. Moving a job to
     * `delivered` needs a real delivery report, which this deployment does not
     * yet receive — see `docs/integrations.md`. Until it does, this adapter
     * cannot close a job, and it says so rather than guessing.
     */
    return { messageId, state: 'pending_delivery', failureReason: '', entry: null };
  }
}

/**
 * What a deployment with no email configuration has.
 *
 * It REFUSES rather than pretending. The alternative — quietly recording a
 * simulated entry on a production database — would leave EJE believing
 * customers had their job cards when nothing left the building. That is the one
 * outcome MANDATE-3 exists to prevent, so a production deployment that has not
 * been configured says so on the job, every time, and the office can re-send
 * once it is configured.
 */
export class UnconfiguredEmailService implements EmailService {
  constructor(private readonly detail = '') {}

  send(): Promise<DeliveryReceipt> {
    return Promise.reject(new EmailNotConfigured(this.detail));
  }

  deliveryState(): Promise<DeliveryReceipt | null> {
    return Promise.resolve(null);
  }
}
