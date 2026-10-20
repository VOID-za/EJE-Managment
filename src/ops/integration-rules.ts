/**
 * IS THIS DEPLOYMENT READY TO MESSAGE A CUSTOMER — WITHOUT MESSAGING ONE.
 * MANDATE-3, EMAIL-2, WHATSAPP-1.
 *
 * The rules behind `npm run integrations:check`, pure so that every one of them
 * can be tested without a network, a tenant or a token.
 *
 * WHY A SEPARATE CHECK WHEN PREFLIGHT ALREADY REPORTS THE TRANSPORT. Preflight
 * answers "which adapter will this deployment select", which is a question
 * about the environment file. It cannot answer the two questions that actually
 * decide whether a customer receives their job card:
 *
 *   - will the provider accept these credentials at all; and
 *   - is the sender EJE configured a mailbox that exists and may send?
 *
 * Both need a request to the provider, and neither needs a MESSAGE. A token
 * request and a read of the sender's own mailbox prove the credential and the
 * sender without putting anything in anybody's inbox — which is the only kind
 * of live test that may be run before EJE have approved a real send.
 *
 * WHAT THIS WILL NOT DO, in any mode: send an email, send a WhatsApp message,
 * read a customer's record, or print a credential. A verdict names a VARIABLE,
 * never a value, and the probe results below carry provider wording that is
 * passed through the same redaction the adapters use.
 */

export type Readiness =
  /** Configured, and the provider accepted the credential. */
  | 'ready'
  /** Configured as far as this deployment can tell; nothing was asked of the provider. */
  | 'configured'
  /** Something is missing. The names are in the detail. */
  | 'not_configured'
  /** Configured and the provider refused. Nothing will reach a customer. */
  | 'refused';

export interface IntegrationCheck {
  readonly integration: 'email' | 'whatsapp';
  readonly readiness: Readiness;
  readonly detail: string;
  /** What somebody has to do next, in one sentence. Empty when nothing. */
  readonly next: string;
}

/** True when the run as a whole should fail. */
export const integrationsFailed = (checks: readonly IntegrationCheck[]): boolean =>
  checks.some((check) => check.readiness === 'refused');

export interface EmailFacts {
  /** From `describeEmailConfiguration`: every required variable is present and sane. */
  readonly configured: boolean;
  /** Variable NAMES that are missing. Never values. */
  readonly missing: readonly string[];
  /** Validation complaints about values that are present — again, names only. */
  readonly problems: readonly string[];
  /**
   * What the provider said, when a probe was made. Null when none was.
   *
   * Separated from the configuration so an offline run reports the
   * configuration honestly rather than reporting nothing.
   */
  readonly probe: ProviderProbe | null;
}

export interface ProviderProbe {
  readonly ok: boolean;
  /** The provider's own words, already redacted by the caller. */
  readonly detail: string;
  /**
   * True when the failure is the CREDENTIAL rather than the network.
   *
   * It decides the verdict: a refused credential is a deployment that cannot
   * send and must be reported as such, while an unreachable provider is a
   * network at this moment and says nothing about the configuration.
   */
  readonly credentialRefused: boolean;
}

export const checkEmailReadiness = (facts: EmailFacts): IntegrationCheck => {
  if (!facts.configured) {
    return {
      integration: 'email',
      readiness: 'not_configured',
      detail:
        `Microsoft 365 is not configured, so this deployment REFUSES to send and no customer ` +
        `receives a job card. Missing: ${facts.missing.join(', ') || 'nothing — see the problems below'}.` +
        (facts.problems.length === 0 ? '' : ` Problems: ${facts.problems.join('; ')}.`),
      next:
        'EJE must supply the tenant id, the application (client) id, a client secret and the ' +
        'sender mailbox. Nothing else here can proceed until then.',
    };
  }

  if (facts.probe === null) {
    return {
      integration: 'email',
      readiness: 'configured',
      detail:
        'Every required variable is present and passes validation. NOTHING WAS ASKED OF ' +
        'MICROSOFT: run with --probe to acquire a token and read the sender mailbox, which ' +
        'sends no message.' +
        (facts.problems.length === 0 ? '' : ` Worth reading: ${facts.problems.join('; ')}.`),
      next: 'Run `npm run integrations:check -- --probe` on the deployment to confirm the credential.',
    };
  }

  if (facts.probe.ok) {
    return {
      integration: 'email',
      readiness: 'ready',
      detail: `Microsoft accepted the credential and the sender mailbox is addressable. ${facts.probe.detail}`,
      next:
        'A live send to a REAL customer still needs EJE’s explicit approval; use the sender ' +
        'mailbox itself as the recipient for the first end-to-end test.',
    };
  }

  return {
    integration: 'email',
    readiness: facts.probe.credentialRefused ? 'refused' : 'configured',
    detail: facts.probe.credentialRefused
      ? `Microsoft REFUSED the credential: ${facts.probe.detail} No customer can receive a job card.`
      : `The configuration looks right and Microsoft could not be reached: ${facts.probe.detail} ` +
        'That is this moment’s network rather than a statement about the credential.',
    next: facts.probe.credentialRefused
      ? 'Check the app registration: the secret may have expired, or Mail.Send may not be granted.'
      : 'Try again; if it persists, check egress from the VPS to login.microsoftonline.com.',
  };
};

export interface WhatsAppFacts {
  /** Both the phone number id and the access token are present. */
  readonly configured: boolean;
  readonly missing: readonly string[];
  readonly probe: ProviderProbe | null;
  /**
   * The template names THIS BUILD will send, from the application's own
   * constants.
   *
   * Not an environment variable, and that matters: the names are decided in
   * the code (`eje_job_assigned`, `eje_site_location`), so what EJE have to do
   * is get templates approved in Meta UNDER EXACTLY THOSE NAMES. A check that
   * asked for the names in configuration would let a deployment claim
   * readiness for templates the application never sends.
   */
  readonly templates: readonly string[];
  /**
   * Whether approval of those names was actually confirmed with Meta.
   *
   * NULL MEANS NOBODY ASKED, which is the honest answer without a WhatsApp
   * Business Account id to query. Meta delivers a business-initiated message
   * only as an APPROVED template, so a perfect token with an unapproved name
   * reaches nobody — and nothing in this repository can approve one.
   */
  readonly approvalVerified: boolean | null;
}

export const checkWhatsAppReadiness = (facts: WhatsAppFacts): IntegrationCheck => {
  if (!facts.configured) {
    return {
      integration: 'whatsapp',
      readiness: 'not_configured',
      detail:
        'WhatsApp is not configured, so the office queues messages to the simulated outbox and ' +
        `nothing is transmitted. Missing: ${facts.missing.join(', ')}.`,
      next:
        'EJE must supply the Meta phone number id, a permanent access token, and the names of ' +
        'the APPROVED templates. A token alone is not enough to message a customer.',
    };
  }

  if (facts.approvalVerified === false) {
    return {
      integration: 'whatsapp',
      readiness: 'refused',
      detail:
        `Meta does not have an approved template under the name(s) this build sends: ` +
        `${facts.templates.join(', ')}. A business-initiated message is delivered only as an ` +
        'approved template, so nothing reaches a customer however good the token is.',
      next:
        'EJE must have templates approved in Meta Business Manager under exactly those names, ' +
        'or the names in the application must be changed to match approved ones.',
    };
  }

  if (facts.probe === null) {
    return {
      integration: 'whatsapp',
      readiness: 'configured',
      detail:
        'Credentials present. NOTHING WAS ASKED OF META: run with --probe to read the phone ' +
        `number’s own metadata, which sends no message. This build sends the template(s) ` +
        `${facts.templates.join(', ')}, which must be APPROVED under those exact names.`,
      next: 'Run `npm run integrations:check -- --probe` on the deployment.',
    };
  }

  if (facts.probe.ok) {
    return {
      integration: 'whatsapp',
      readiness: facts.approvalVerified === true ? 'ready' : 'configured',
      detail:
        `Meta accepted the token and the phone number is readable. ${facts.probe.detail}` +
        (facts.approvalVerified === true
          ? ` The template(s) ${facts.templates.join(', ')} are approved.`
          : ' TEMPLATE APPROVAL WAS NOT CHECKED: set WHATSAPP_BUSINESS_ACCOUNT_ID to have it ' +
            `read, or confirm by hand that ${facts.templates.join(', ')} are approved. A token ` +
            'alone does not let a business-initiated message through.'),
      next:
        facts.approvalVerified === true
          ? 'A live message to a REAL customer still needs EJE’s explicit approval; send the ' +
            'first one to a number EJE control.'
          : 'Confirm template approval in Meta Business Manager before any live message.',
    };
  }

  return {
    integration: 'whatsapp',
    readiness: facts.probe.credentialRefused ? 'refused' : 'configured',
    detail: facts.probe.credentialRefused
      ? `Meta REFUSED the token: ${facts.probe.detail} Nothing will reach a customer.`
      : `The configuration looks right and Meta could not be reached: ${facts.probe.detail}`,
    next: facts.probe.credentialRefused
      ? 'The access token may have expired or lack whatsapp_business_messaging.'
      : 'Try again; if it persists, check egress from the VPS to graph.facebook.com.',
  };
};

/**
 * Whether an HTTP status from either provider means "your credential is wrong"
 * as opposed to "something went wrong".
 *
 * 401 and 403 are the credential. 404 on a sender mailbox is also the
 * configuration — the mailbox named does not exist, which no retry fixes. A
 * 429 or a 5xx is the provider having a bad day and says nothing about the
 * credential, which is why it must not be reported as a refusal.
 */
export const isCredentialRefusal = (status: number): boolean =>
  status === 401 || status === 403 || status === 404;
