import type { Clock, IdGenerator, OutboxEntry, WhatsAppMessage, WhatsAppService } from '../ports';

/**
 * The WhatsApp Business Platform, for real.
 *
 * WHAT THIS IS. An adapter for Meta's Cloud API, behind the same
 * `WhatsAppService` port the rest of the system already talks to. Nothing above
 * it changes: the assignment notification and the site-location message call
 * `services.whatsapp.send(...)` exactly as they did.
 *
 * WHAT IT WILL NOT DO. It will not say a message was delivered. The Cloud API
 * answers a send with `messages[0].id` and a status of `accepted`, which means
 * Meta has the message — not that a handset has it. That is `pending_delivery`,
 * and only a delivery webhook may ever move it to `delivered`. An adapter that
 * returned `delivered` on a 200 would be lying to a business that uses these
 * messages to know a technician was told about a job.
 *
 * A FAILURE IS A FAILURE. A non-2xx response, a network error or a timeout
 * raises `WhatsAppSendFailed`. It is never swallowed into a success, and the
 * caller decides what that means for the work in hand — for an assignment
 * notification the job stays assigned and the audit trail records that the
 * message did not go.
 */
export interface WhatsAppConfiguration {
  /** The sending number's id on the WhatsApp Business account. */
  readonly phoneNumberId: string;
  /** A permanent System User token. Never a temporary one from the dashboard. */
  readonly accessToken: string;
  readonly apiVersion: string;
  readonly baseUrl: string;
  /**
   * The language the templates were APPROVED in (WHATSAPP_TEMPLATE_LANGUAGE,
   * default `en`). Meta looks a template up by name AND language, so a
   * mismatch is refused as "template does not exist".
   */
  readonly templateLanguage: string;
  /** How long one request to Meta may take. WHATSAPP_TIMEOUT_MS, default 20 s. */
  readonly timeoutMs: number;
  /**
   * THE DEDICATED EJE NUMBER (WHATSAPP_DEDICATED_NUMBER), in digits with the
   * country code. The owner's decision (1 November 2026): EJE notifications go
   * from a NEW number of their own, never from the office's WhatsApp. Before
   * anything is sent, Meta is asked which number the phone number id belongs
   * to, and nothing goes unless it is this one.
   */
  readonly dedicatedNumber: string;
  /**
   * Numbers EJE must never send from (WHATSAPP_PROTECTED_NUMBERS) — the
   * office's existing WhatsApp. Optional; a phone number id that Meta says
   * belongs to one of them is refused even if it were set as the dedicated one.
   */
  readonly protectedNumbers: readonly string[];
}

/** Digits only, a South African 0 turned into 27: how two numbers are compared. */
export const numberDigits = (raw: string): string => {
  const digits = raw.replace(/\D/gu, '');
  return digits.startsWith('0') && digits.length === 10 ? `27${digits.slice(1)}` : digits;
};

const numberList = (raw: string | undefined): readonly string[] =>
  (raw ?? '')
    .split(/[,;]+/u)
    .map(numberDigits)
    .filter((digits) => digits.length >= 9);

/**
 * What is wrong with the WhatsApp configuration, in names and plain words —
 * never a value. Empty when it is complete. Read by Administration.
 */
export const whatsAppConfigurationProblems = (env: Readonly<Record<string, string | undefined>> = process.env): readonly string[] => {
  const dedicated = numberDigits(env.WHATSAPP_DEDICATED_NUMBER ?? '');
  const problems: string[] = [];
  if ((env.WHATSAPP_DEDICATED_NUMBER ?? '').trim().length > 0 && (dedicated.length < 11 || dedicated.length > 15)) {
    problems.push('WHATSAPP_DEDICATED_NUMBER is not a full number with its country code (e.g. +27 …).');
  }
  if (dedicated.length > 0 && numberList(env.WHATSAPP_PROTECTED_NUMBERS).includes(dedicated)) {
    problems.push('WHATSAPP_DEDICATED_NUMBER is one of WHATSAPP_PROTECTED_NUMBERS (the office number). EJE refuses to send from it.');
  }
  return problems;
};

const DEFAULT_BASE_URL = 'https://graph.facebook.com';
const DEFAULT_API_VERSION = 'v21.0';

/**
 * The configuration, or null when this deployment has none.
 *
 * Null is a legitimate answer and is NOT a fallback to a fake sender: the
 * composition root turns it into `UnconfiguredWhatsAppService`, which refuses
 * and says why.
 */
export const readWhatsAppConfiguration = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): WhatsAppConfiguration | null => {
  const phoneNumberId = (env.WHATSAPP_PHONE_NUMBER_ID ?? '').trim();
  const accessToken = (env.WHATSAPP_ACCESS_TOKEN ?? '').trim();
  const dedicatedNumber = numberDigits(env.WHATSAPP_DEDICATED_NUMBER ?? '');
  if (phoneNumberId.length === 0 || accessToken.length === 0) return null;
  // Partly configured is not configured: without the dedicated number named
  // (and not the office's), nothing is sent.
  if (dedicatedNumber.length === 0 || whatsAppConfigurationProblems(env).length > 0) return null;

  return {
    phoneNumberId,
    accessToken,
    dedicatedNumber,
    protectedNumbers: numberList(env.WHATSAPP_PROTECTED_NUMBERS),
    apiVersion: (env.WHATSAPP_API_VERSION ?? '').trim() || DEFAULT_API_VERSION,
    baseUrl: ((env.WHATSAPP_API_BASE_URL ?? '').trim() || DEFAULT_BASE_URL).replace(/\/+$/u, ''),
    templateLanguage: (env.WHATSAPP_TEMPLATE_LANGUAGE ?? '').trim() || 'en',
    timeoutMs: (() => {
      const value = Number((env.WHATSAPP_TIMEOUT_MS ?? '').trim());
      return Number.isFinite(value) && value >= 1000 && value <= 120_000 ? value : 20_000;
    })(),
  };
};

/** Raised when the provider did not accept the message. */
export class WhatsAppSendFailed extends Error {
  constructor(
    message: string,
    /** The provider's own code, where it gave one. For the audit trail. */
    readonly providerCode: string = '',
    /**
     * TRYING AGAIN WILL NOT HELP (INT-WA-3): a refused token, a template Meta
     * does not have, a number that is not on WhatsApp. The outbox gives up on
     * such a message at once instead of spending its remaining attempts.
     */
    readonly permanent: boolean = false,
  ) {
    super(message);
    this.name = 'WhatsAppSendFailed';
  }
}

/** Raised when a deployment has no WhatsApp configuration at all. */
export class WhatsAppNotConfigured extends Error {
  constructor() {
    super(
      'WhatsApp is not configured on this deployment. Set WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN and WHATSAPP_DEDICATED_NUMBER.',
    );
    this.name = 'WhatsAppNotConfigured';
  }
}

/**
 * Raised for a job notification while the dedicated number has not passed a
 * real test (Administration → Integrations → send a test). Permanent: the
 * message is not retried into the activation, which would send stale notices.
 */
export class WhatsAppNotActivated extends Error {
  readonly permanent = true;
  readonly providerCode = 'not_activated';
  constructor() {
    super(
      'WhatsApp is not yet in use: the dedicated EJE number has not passed a real test. Send a test from Administration → Integrations.',
    );
    this.name = 'WhatsAppNotActivated';
  }
}

/**
 * South African mobile numbers, as the Cloud API wants them.
 *
 * EJE hold numbers the way people write them here — "082 555 0134",
 * "+27 82 555 0134", "0825550134". The API wants digits with a country code and
 * no leading plus. A number it cannot make sense of is refused rather than
 * guessed at, because a guess sends a job card to a stranger.
 */
export const toE164 = (raw: string): string => {
  const digits = raw.replace(/\D/gu, '');
  if (digits.startsWith('27') && digits.length === 11) return digits;
  if (digits.startsWith('0') && digits.length === 10) return `27${digits.slice(1)}`;
  // Already international, for a number outside South Africa.
  if (digits.length >= 11 && digits.length <= 15 && !digits.startsWith('0')) return digits;
  throw new WhatsAppSendFailed(`"${raw}" is not a mobile number this can send to.`);
};

/**
 * Which refusals a retry cannot fix. Meta's error codes (Cloud API reference,
 * "Error codes"): 190 an expired or invalid token, 10/200/299 permissions,
 * 100 an invalid parameter, 131008/131009 a missing or invalid parameter,
 * 131026 a number that cannot receive the message, 131030 a recipient not on
 * the test allow-list, 131051 an unsupported type, 132000-132069 template
 * problems (missing, paused, disabled, wrong parameter count), 133010 a phone
 * number that is not registered. Throttling (4, 80007, 130429, 131048, 131056)
 * and 5xx are temporary.
 */
export const isPermanentWhatsAppFailure = (status: number, code: number | undefined): boolean => {
  if (code !== undefined) {
    if ([4, 80007, 130429, 131048, 131056, 131000, 1, 2].includes(code)) return false;
    if ([10, 100, 190, 200, 299, 131008, 131009, 131026, 131030, 131031, 131051, 133010].includes(code)) return true;
    if (code >= 132000 && code < 133000) return true;
  }
  if (status === 401 || status === 403 || status === 404) return true;
  return false;
};

interface CloudApiResponse {
  readonly messages?: readonly { readonly id?: string }[];
  readonly error?: { readonly message?: string; readonly code?: number };
}

export class CloudApiWhatsAppService implements WhatsAppService {
  /** It exists because `readWhatsAppConfiguration` returned credentials. */
  readonly configured = true;

  constructor(
    private readonly config: WhatsAppConfiguration,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    /** Injected so a test can drive the adapter without a network. */
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * Takes the access token out of anything that is about to be reported.
   *
   * A failure message from here reaches the audit trail and, through it, a
   * screen. The token is in the request that failed — an HTTP client that
   * quotes the request it could not make, or a provider that echoes a header,
   * would put a permanent credential somewhere it can never be removed from.
   * Cheap insurance against a class of leak that is unrecoverable once it
   * happens.
   */
  private redact(text: string): string {
    return this.config.accessToken.length === 0
      ? text
      : text.split(this.config.accessToken).join('[redacted]');
  }

  /** When the sending number was last confirmed as the dedicated one. */
  private numberConfirmedAt = 0;

  /**
   * ASKS META WHICH NUMBER WILL SEND, before anything is sent: the phone
   * number id's `display_phone_number` must be the dedicated EJE number and
   * none of the protected (office) numbers. A mistyped id that belongs to the
   * office's number is refused here — permanently, and nothing is sent.
   * Confirmed once every six hours; a failure to ask is temporary.
   */
  async confirmSendingNumber(): Promise<string> {
    if (Date.now() - this.numberConfirmedAt < 6 * 3600_000) return this.config.dedicatedNumber;
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.config.baseUrl}/${this.config.apiVersion}/${this.config.phoneNumberId}?fields=display_phone_number,verified_name`,
        { method: 'GET', headers: { authorization: `Bearer ${this.config.accessToken}` }, signal: AbortSignal.timeout(this.config.timeoutMs) },
      );
    } catch (cause) {
      throw new WhatsAppSendFailed(
        `WhatsApp could not be reached to confirm the sending number: ${this.redact(cause instanceof Error ? cause.message : 'network error')}.`,
      );
    }
    const payload = (await response.json().catch(() => ({}))) as { display_phone_number?: string; error?: { message?: string; code?: number } };
    if (!response.ok) {
      throw new WhatsAppSendFailed(
        this.redact(payload.error?.message ?? `WhatsApp refused to describe the sending number (HTTP ${response.status}).`),
        payload.error?.code === undefined ? '' : String(payload.error.code),
        isPermanentWhatsAppFailure(response.status, payload.error?.code),
      );
    }
    const actual = numberDigits(payload.display_phone_number ?? '');
    const last4 = (digits: string) => `…${digits.slice(-4)}`;
    if (actual.length > 0 && this.config.protectedNumbers.includes(actual)) {
      throw new WhatsAppSendFailed(
        `The configured phone number id belongs to a protected number (${last4(actual)}) — the office's WhatsApp. Nothing was sent.`,
        'protected_number',
        true,
      );
    }
    if (actual !== this.config.dedicatedNumber) {
      throw new WhatsAppSendFailed(
        `The configured phone number id belongs to ${actual.length === 0 ? 'an unknown number' : last4(actual)}, not the dedicated EJE number (${last4(this.config.dedicatedNumber)}). Nothing was sent.`,
        'wrong_number',
        true,
      );
    }
    this.numberConfirmedAt = Date.now();
    return actual;
  }

  async send(message: WhatsAppMessage): Promise<OutboxEntry> {
    const to = toE164(message.to);
    await this.confirmSendingNumber();
    const url = `${this.config.baseUrl}/${this.config.apiVersion}/${this.config.phoneNumberId}/messages`;

    /*
     * A TEMPLATE, not free text.
     *
     * Outside a 24-hour customer service window — which is every assignment
     * notification, since EJE contact the technician first — WhatsApp accepts
     * only a template that Meta has approved. `templateName` is that approved
     * name and `parameters` fill its body placeholders in order.
     */
    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: message.templateName,
        language: { code: this.config.templateLanguage },
        components: [
          {
            type: 'body',
            parameters: message.parameters.map((text) => ({ type: 'text', text })),
          },
        ],
      },
    };

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (cause) {
      throw new WhatsAppSendFailed(
        `WhatsApp could not be reached: ${this.redact(cause instanceof Error ? cause.message : 'network error')}.`,
      );
    }

    const payload = (await response.json().catch(() => ({}))) as CloudApiResponse;
    if (!response.ok) {
      throw new WhatsAppSendFailed(
        this.redact(
          payload.error?.message ?? `WhatsApp refused the message (HTTP ${response.status}).`,
        ),
        payload.error?.code === undefined ? '' : String(payload.error.code),
        isPermanentWhatsAppFailure(response.status, payload.error?.code),
      );
    }

    const messageId = payload.messages?.[0]?.id ?? '';
    if (messageId.length === 0) {
      throw new WhatsAppSendFailed('WhatsApp accepted the request without returning a message id.');
    }

    return {
      id: messageId,
      channel: 'whatsapp',
      to,
      subject: `Template: ${message.templateName}`,
      body: message.preview,
      attachments: [],
      createdAt: this.clock.now(),
      simulated: false,
      /*
       * ACCEPTED, NOT DELIVERED.
       *
       * Meta has the message. Whether the technician's handset ever gets it is
       * something only a delivery webhook can say, and this deployment does not
       * yet receive one — see `docs/integrations.md`.
       */
      delivery: 'pending_delivery',
      failureReason: '',
    };
  }
}

/**
 * What a deployment with no WhatsApp configuration has.
 *
 * It REFUSES rather than pretending. The alternative — quietly doing nothing,
 * or recording a simulated entry on a production database — would leave EJE
 * believing technicians had been messaged when nothing left the building, which
 * is the single worst outcome available to an integration.
 */
export interface WhatsAppActivationGate {
  /** The last known answer, for the synchronous `configured`. */
  readonly active: boolean;
  /** Asks the store again (the dedicated number passed a real test). */
  confirm(): Promise<boolean>;
}

/**
 * THE DEDICATED NUMBER IS NOT IN USE UNTIL A REAL TEST PASSED. The owner's
 * decision: WhatsApp stays "Not configured" until the number and the Meta
 * credentials are set AND a real API test succeeded. Until then the adapter
 * says it is not configured, so no job notification is queued, and a send
 * that is not a test is refused — only the test from Administration (to a
 * configured internal number) goes through.
 */
export class ActivationGatedWhatsAppService implements WhatsAppService {
  constructor(
    private readonly inner: WhatsAppService,
    private readonly gate: WhatsAppActivationGate,
  ) {}

  get configured(): boolean {
    return this.gate.active;
  }

  async send(message: WhatsAppMessage): Promise<OutboxEntry> {
    if (message.test !== true && !(await this.gate.confirm())) throw new WhatsAppNotActivated();
    return this.inner.send(message);
  }
}

export class UnconfiguredWhatsAppService implements WhatsAppService {
  readonly configured = false;

  send(): Promise<OutboxEntry> {
    return Promise.reject(new WhatsAppNotConfigured());
  }
}
