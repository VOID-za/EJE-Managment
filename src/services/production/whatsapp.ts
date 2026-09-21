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
}

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
  if (phoneNumberId.length === 0 || accessToken.length === 0) return null;

  return {
    phoneNumberId,
    accessToken,
    apiVersion: (env.WHATSAPP_API_VERSION ?? '').trim() || DEFAULT_API_VERSION,
    baseUrl: ((env.WHATSAPP_API_BASE_URL ?? '').trim() || DEFAULT_BASE_URL).replace(/\/+$/u, ''),
  };
};

/** Raised when the provider did not accept the message. */
export class WhatsAppSendFailed extends Error {
  constructor(
    message: string,
    /** The provider's own code, where it gave one. For the audit trail. */
    readonly providerCode: string = '',
  ) {
    super(message);
    this.name = 'WhatsAppSendFailed';
  }
}

/** Raised when a deployment has no WhatsApp configuration at all. */
export class WhatsAppNotConfigured extends Error {
  constructor() {
    super(
      'WhatsApp is not configured on this deployment. Set WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN.',
    );
    this.name = 'WhatsAppNotConfigured';
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

interface CloudApiResponse {
  readonly messages?: readonly { readonly id?: string }[];
  readonly error?: { readonly message?: string; readonly code?: number };
}

export class CloudApiWhatsAppService implements WhatsAppService {
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

  async send(message: WhatsAppMessage): Promise<OutboxEntry> {
    const to = toE164(message.to);
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
        language: { code: 'en' },
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
export class UnconfiguredWhatsAppService implements WhatsAppService {
  send(): Promise<OutboxEntry> {
    return Promise.reject(new WhatsAppNotConfigured());
  }
}
