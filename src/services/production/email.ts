import {
  isRetryableDeliveryFailure,
  type DeliveryFailureKind,
} from '@/domain';
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
  /**
   * How long one Graph request may take before it is abandoned.
   *
   * THERE WAS NO TIMEOUT AT ALL. `fetch` with no signal waits as long as the
   * socket stays open, and the call sits inside the request that submits a
   * signed job card — so a Microsoft 365 endpoint that accepted the connection
   * and then went quiet held a technician's submission open until something
   * else gave up first. A timeout is not a tuning parameter here; it is the
   * difference between "the provider did not answer" and a screen that never
   * comes back.
   */
  readonly timeoutMs: number;
}

const DEFAULT_BASE_URL = 'https://graph.microsoft.com/v1.0';
const DEFAULT_LOGIN_URL = 'https://login.microsoftonline.com';
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * The largest attachment Graph will take on the message resource.
 *
 * Microsoft's limit for `attachments` on a created message is 3 MB; past that
 * an upload session is required, which is a different protocol. A job card with
 * a dozen photographs reaches this, and before this check the first anybody
 * heard of it was a Graph error nobody could act on. Checked against the RAW
 * bytes, because the base64 Graph wants is a third larger again and the limit
 * is on what is sent.
 */
export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

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

  const configuredTimeout = Number((env.EMAIL_GRAPH_TIMEOUT_MS ?? '').trim());

  return {
    tenantId,
    clientId,
    clientSecret,
    sender,
    replyTo: (env.EMAIL_REPLY_TO ?? '').trim(),
    baseUrl: ((env.EMAIL_GRAPH_BASE_URL ?? '').trim() || DEFAULT_BASE_URL).replace(/\/+$/u, ''),
    loginUrl: ((env.EMAIL_GRAPH_LOGIN_URL ?? '').trim() || DEFAULT_LOGIN_URL).replace(/\/+$/u, ''),
    // A nonsense value is the default rather than NaN, which would abort every
    // request immediately and look exactly like an unreachable provider.
    timeoutMs:
      Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : DEFAULT_TIMEOUT_MS,
  };
};

/**
 * WHAT IS WRONG WITH THIS DEPLOYMENT'S EMAIL, BY NAME. MANDATE-3.
 *
 * `readGraphEmailConfiguration` answers null for any incomplete configuration,
 * which is the right answer for CHOOSING a transport and a useless one for the
 * person who has to fix it: "customer email is not configured" does not say
 * that three variables are set and the fourth is empty.
 *
 * So this says which ones are missing, by variable name, and what is suspect
 * about the ones that are present. It NEVER reports a value — not the secret,
 * not a prefix of it, not its length — because this is read by diagnostics that
 * end up in logs and on screens. A name is enough to act on; a value is a leak.
 */
export interface EmailConfigurationReport {
  readonly configured: boolean;
  /** Variables that must be set and are not. */
  readonly missing: readonly string[];
  /** Things that are set and look wrong. Never includes a value. */
  readonly problems: readonly string[];
  /** The sending mailbox, which is not a secret and is the usual mistake. */
  readonly sender: string;
  /** Endpoints in use, so a staging override is visible. */
  readonly baseUrl: string;
  readonly loginUrl: string;
  readonly timeoutMs: number;
}

export const describeEmailConfiguration = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): EmailConfigurationReport => {
  const value = (name: string): string => (env[name] ?? '').trim();
  const required = [
    'EMAIL_GRAPH_TENANT_ID',
    'EMAIL_GRAPH_CLIENT_ID',
    'EMAIL_GRAPH_CLIENT_SECRET',
    'EMAIL_SENDER',
  ] as const;

  const missing = required.filter((name) => value(name).length === 0);
  const problems: string[] = [];

  const sender = value('EMAIL_SENDER');
  if (sender.length > 0 && !sender.includes('@')) {
    problems.push(
      'EMAIL_SENDER is not an address. Graph needs the sending MAILBOX, for example ' +
        'jobcards@eje.example — a display name will not resolve.',
    );
  }
  const replyTo = value('EMAIL_REPLY_TO');
  if (replyTo.length > 0 && !replyTo.includes('@')) {
    problems.push('EMAIL_REPLY_TO is set and is not an address, so replies would go nowhere.');
  }
  const tenant = value('EMAIL_GRAPH_TENANT_ID');
  if (tenant.length > 0 && tenant.includes('@')) {
    problems.push(
      'EMAIL_GRAPH_TENANT_ID looks like an address. It is the Entra ID tenant id or domain, ' +
        'not a mailbox.',
    );
  }
  const timeout = value('EMAIL_GRAPH_TIMEOUT_MS');
  if (timeout.length > 0 && !(Number(timeout) > 0)) {
    problems.push(
      `EMAIL_GRAPH_TIMEOUT_MS is not a positive number of milliseconds, so the default of ` +
        `${DEFAULT_TIMEOUT_MS} is in use.`,
    );
  }

  const configuration = readGraphEmailConfiguration(env);
  return {
    configured: configuration !== null,
    missing,
    problems,
    sender,
    baseUrl: configuration?.baseUrl ?? DEFAULT_BASE_URL,
    loginUrl: configuration?.loginUrl ?? DEFAULT_LOGIN_URL,
    timeoutMs: configuration?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
};

/**
 * One sentence an operator can act on, or the empty string when all is well.
 *
 * Built from the report rather than from the environment, so there is one
 * place that decides how this is worded and one place that decides what counts
 * as a problem.
 */
export const emailConfigurationSummary = (report: EmailConfigurationReport): string => {
  const parts: string[] = [];
  if (report.missing.length > 0) {
    parts.push(`Not configured: ${report.missing.join(', ')} ${report.missing.length === 1 ? 'is' : 'are'} not set.`);
  }
  parts.push(...report.problems);
  return parts.join(' ');
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

/**
 * WHY A SEND FAILED, IN THE ONLY TERMS THAT CHANGE WHAT ANYBODY DOES NEXT.
 *
 * Every failure used to arrive as one `EmailSendFailed` carrying whatever
 * sentence the provider offered, which left the office with one action for
 * nine situations: press *Send again*. For four of them that is right and the
 * message will go. For the other five it cannot possibly work — the credential
 * is wrong, the app registration lacks `Mail.Send`, the address is not an
 * address, the attachment is over Graph's limit — and pressing it again is a
 * person wasting their afternoon on a configuration problem nobody has told
 * them about.
 *
 * So the kind is part of the failure, and `retryable` is derived from it in one
 * place rather than guessed at each screen.
 */
/**
 * THE KIND OF FAILURE, NAMED BY THE DOMAIN RATHER THAN BY THIS ADAPTER.
 *
 * It was declared here first, which put a business question — can the office
 * retry this, or must somebody change something? — inside the Microsoft
 * adapter, where it could not be stored on a job or read on a screen. The
 * vocabulary moved to `DeliveryFailureKind` and this is the alias, kept so the
 * adapter's own tests and callers read naturally.
 */
export type EmailFailureKind = DeliveryFailureKind;

export const isRetryableFailure = isRetryableDeliveryFailure;

/** Raised when the provider did not accept the message. */
export class EmailSendFailed extends Error {
  constructor(
    message: string,
    /** The provider's own code, where it gave one. For the audit trail. */
    readonly providerCode: string = '',
    readonly kind: EmailFailureKind = 'provider_refused',
    /** From `Retry-After`, when the provider said how long to wait. */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'EmailSendFailed';
  }

  /** Whether trying the same send again could succeed. */
  get retryable(): boolean {
    return isRetryableFailure(this.kind);
  }
}

/**
 * Turns an HTTP answer into one of the kinds above. Pure, and exported, so
 * every status this system claims to distinguish is proved by a test rather
 * than by reading the adapter.
 *
 * Graph's own error codes are preferred over the status where they are more
 * specific: a 400 is only an invalid recipient if Graph says the recipient is
 * the problem, and treating every 400 as a bad address would send the office
 * editing a customer record over a malformed request.
 */
export const classifyGraphFailure = (
  status: number,
  providerCode: string,
  providerMessage: string,
): EmailFailureKind => {
  if (status === 401) return 'credentials_rejected';
  if (status === 403) return 'permission_denied';
  if (status === 429 || status === 503) return 'throttled';
  if (status === 413) return 'attachment_too_large';
  if (status >= 500) return 'provider_unavailable';

  const code = providerCode.toLowerCase();
  const text = providerMessage.toLowerCase();
  if (code.includes('invalidrecipients') || code === 'errorinvalidrecipients') {
    return 'invalid_recipient';
  }
  if (status === 400 && (text.includes('recipient') || text.includes('smtp address'))) {
    return 'invalid_recipient';
  }
  if (code.includes('messagesizeexceeded') || text.includes('maximum message size')) {
    return 'attachment_too_large';
  }
  return 'provider_refused';
};

/**
 * WHAT TO DO ABOUT IT, APPENDED TO THE PROVIDER'S OWN WORDS.
 *
 * The provider's sentence is kept — it is the only account of what actually
 * happened — and this says what it means for EJE. The text reaches the job's
 * delivery record and, through it, the office's screen, which is the one place
 * somebody decides between pressing *Send again* and telephoning whoever
 * administers the tenant.
 */
const ADVICE: Readonly<Record<EmailFailureKind, string>> = {
  not_configured: '',
  credentials_rejected:
    " This deployment's Microsoft 365 credential was refused, so sending again will fail the " +
    'same way. EMAIL_GRAPH_CLIENT_SECRET or the app registration needs attention.',
  permission_denied:
    ' Microsoft 365 authenticated this deployment and would not let it send. The app ' +
    'registration needs Mail.Send for the sending mailbox; a retry cannot grant it.',
  throttled: ' Microsoft 365 is asking for fewer requests.',
  provider_unavailable: ' Microsoft 365 is unavailable rather than refusing. Worth trying again.',
  invalid_recipient:
    " The customer's email address needs correcting on their record before this can be sent.",
  attachment_too_large:
    ' A retry sends the same bytes, so it will fail the same way — the document itself has to ' +
    'be smaller, or sent another way.',
  document_unavailable:
    ' The job card is in the database and its bytes are not in storage, which is a storage ' +
    'problem rather than a mail one.',
  timed_out: ' Worth trying again; nothing was sent.',
  unreachable: ' Worth trying again once the connection is back; nothing was sent.',
  provider_refused: '',
};

/** `Retry-After` in seconds, where the provider gave a usable one. */
export const retryAfterSeconds = (header: string | null): number | null => {
  if (header === null) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds);
  // The HTTP-date form. Anything unparseable is simply no advice.
  const when = Date.parse(header);
  if (Number.isNaN(when)) return null;
  return Math.max(0, Math.round((when - Date.now()) / 1000));
};

/** Raised when a deployment has no email configuration at all. */
export class EmailNotConfigured extends Error {
  /**
   * The kind the job's delivery record stores. MANDATE-3.
   *
   * "Not configured" is a different thing from "the provider refused": nobody
   * is at fault on the customer's side, nothing was sent, and what has to
   * change is this deployment. The office reads that distinction off the job
   * rather than off a sentence.
   */
  readonly kind: DeliveryFailureKind = 'not_configured';

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
        signal: this.deadline(),
      });
    } catch (cause) {
      throw this.unreachable('a token', cause);
    }

    const payload = (await response.json().catch(() => ({}))) as GraphTokenResponse;
    if (!response.ok || (payload.access_token ?? '').length === 0) {
      const kind =
        response.ok || response.status === 400 || response.status === 401
          ? 'credentials_rejected'
          : classifyGraphFailure(response.status, payload.error ?? '', payload.error_description ?? '');
      throw new EmailSendFailed(
        this.redact(
          payload.error_description ??
            `Microsoft 365 refused the credentials (HTTP ${response.status}).`,
        ),
        payload.error ?? '',
        /*
         * A TOKEN ENDPOINT THAT SAYS NO IS A CONFIGURATION PROBLEM, not
         * something to retry. The exceptions are the ones that are about the
         * service rather than the credential — throttling and a 5xx — and
         * `classifyGraphFailure` is what tells them apart.
         */
        kind,
        kind === 'throttled' ? retryAfterSeconds(response.headers.get('retry-after')) : null,
      );
    }

    // 60 seconds of slack, so a token never expires mid-request.
    const lifetime = (payload.expires_in ?? 3600) * 1000;
    this.token = { value: payload.access_token as string, expiresAt: now + lifetime - 60_000 };
    return this.token.value;
  }

  /** A deadline for one request. See `timeoutMs`. */
  private deadline(): AbortSignal {
    return AbortSignal.timeout(this.config.timeoutMs);
  }

  /**
   * A thrown `fetch`, told apart: a deadline that expired is not the same event
   * as a host that refused the connection, and the office can act on one of
   * them (wait) differently from the other (check the network).
   */
  private unreachable(what: string, cause: unknown): EmailSendFailed {
    const aborted =
      cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
    if (aborted) {
      return new EmailSendFailed(
        `Microsoft 365 did not answer within ${Math.round(this.config.timeoutMs / 1000)}s when ` +
          `asked for ${what}. Nothing was sent, and the job stays open.`,
        '',
        'timed_out',
      );
    }
    return new EmailSendFailed(
      `Microsoft 365 could not be reached for ${what}: ${this.redact(
        cause instanceof Error ? cause.message : 'network error',
      )}.`,
      '',
      'unreachable',
    );
  }

  private async call(path: string, body: unknown): Promise<GraphMessageResponse> {
    const token = await this.accessToken();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: this.deadline(),
      });
    } catch (cause) {
      throw this.unreachable('the message', cause);
    }

    if (response.status === 202 || response.status === 204) return {};

    const payload = (await response.json().catch(() => ({}))) as GraphMessageResponse;
    if (!response.ok) {
      const code = payload.error?.code ?? '';
      const detail =
        payload.error?.message ?? `Microsoft 365 refused the message (HTTP ${response.status}).`;
      const kind = classifyGraphFailure(response.status, code, detail);
      const wait = kind === 'throttled' ? retryAfterSeconds(response.headers.get('retry-after')) : null;
      throw new EmailSendFailed(
        this.redact(`${detail}${ADVICE[kind]}${wait === null ? '' : ` Try again in ${wait}s.`}`),
        code,
        kind,
        wait,
      );
    }
    return payload;
  }

  /** The job card's bytes, as Graph wants them. */
  private async attachmentsFor(message: EmailMessage): Promise<readonly unknown[]> {
    const wanted = message.attachments ?? [];
    const prepared: unknown[] = [];
    let total = 0;
    for (const attachment of wanted) {
      const stored = await this.storage.getDocument(attachment.storageKey);
      if (stored === null) {
        // The document is the point of the email. Sending the covering note
        // without it would be a delivery the customer cannot use, recorded as a
        // success.
        throw new EmailSendFailed(
          `The stored document ${attachment.fileName} could not be read, so nothing was sent.`,
          '',
          'document_unavailable',
        );
      }
      /*
       * CHECKED HERE, BEFORE A SINGLE CALL IS MADE. Graph would refuse this
       * eventually, in its own words, after a token request and a draft — and
       * the office would be told something about a message size by a system
       * that already knew. A retry cannot help: the same bytes are sent again.
       */
      total += stored.bytes.byteLength;
      if (total > MAX_ATTACHMENT_BYTES) {
        throw new EmailSendFailed(
          `${attachment.fileName} brings this message to ${Math.round(total / 1024)} KB, over ` +
            `the ${Math.round(MAX_ATTACHMENT_BYTES / 1024)} KB Microsoft 365 accepts on one ` +
            'message. Nothing was sent.' +
            ADVICE.attachment_too_large,
          '',
          'attachment_too_large',
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
      throw new EmailSendFailed(
        `There is no address to send to${message.to.length === 0 ? '' : ` — "${message.to.join(', ')}" is not one`}.` +
          ADVICE.invalid_recipient,
        '',
        'invalid_recipient',
      );
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

    return { messageId, state: 'pending_delivery', failureReason: '', failureKind: null, entry };
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
        { headers: { authorization: `Bearer ${token}` }, signal: this.deadline() },
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
    return { messageId, state: 'pending_delivery', failureReason: '', failureKind: null, entry: null };
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
