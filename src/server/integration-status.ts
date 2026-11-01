import 'server-only';
import { createHash } from 'node:crypto';
import { selectPersistenceBackend } from '@/data/backend';
import { getServerRuntime } from '@/server/runtime';
import { readSmtpEmailConfiguration } from '@/services/development/email';
import {
  chooseEmailTransport,
  describeEmailConfiguration,
  readGraphEmailConfiguration,
} from '@/services/production/email';
import { numberDigits, readWhatsAppConfiguration, whatsAppConfigurationProblems } from '@/services/production/whatsapp';
import { readWhatsAppActivation } from '@/server/whatsapp-activation';
import { readWhatsAppWebhookConfiguration } from '@/services/production/whatsapp-webhook';
import { readGoogleGeocodingConfiguration } from '@/services/production/geocoding';
import { ASSIGNMENT_TEMPLATE, TRANSFER_TEMPLATE } from '@/application/assignment-notice';
import { SITE_LOCATION_TEMPLATE } from '@/application/job-operations';
import { GEOCODING_SERVICE_NAME } from '@/application/site-geocoding';
import { integrationWorkerActor } from '@/server/api/integration-dispatch';
import { audit } from '@/application/audit';
import { siteLocationNeedsAttention, siteLocationOf } from '@/domain';

/**
 * WHAT ADMINISTRATION IS TOLD ABOUT EACH INTEGRATION. INT-ADMIN-1.
 *
 * Built from the server's environment and its own records. NEVER a secret:
 * not a value, not a length, not a prefix. The non-secret identifiers that
 * help an administrator check the setup (the sender mailbox, the region) are
 * shown; a tenant or client id is shown only as its last four characters.
 *
 * The status is honest about what it knows. Configuration alone is
 * "Configured — not yet verified"; "Connected" needs evidence — an email
 * Microsoft accepted, a WhatsApp message Meta accepted, a pin Google returned.
 */

export type IntegrationState =
  | 'not_configured'
  | 'incomplete'
  | 'configured'
  | 'connected'
  | 'authentication_failed'
  | 'service_unavailable'
  | 'action_required'
  | 'simulated';

export interface IntegrationCheck {
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface IntegrationStatus {
  readonly service: 'email' | 'whatsapp' | 'maps';
  readonly title: string;
  readonly state: IntegrationState;
  readonly summary: string;
  readonly checks: readonly IntegrationCheck[];
  /** Variable NAMES that must be set and are not. */
  readonly missing: readonly string[];
  readonly testRecipients: number;
}

const env = (name: string): string => (process.env[name] ?? '').trim();
const tail = (value: string): string => (value.length <= 4 ? '••••' : `…${value.slice(-4)}`);

export const testRecipientsFor = (service: 'email' | 'whatsapp'): readonly string[] =>
  env(service === 'email' ? 'EMAIL_TEST_RECIPIENTS' : 'WHATSAPP_TEST_RECIPIENTS')
    .split(/[,;\s]+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

const AUTH_KINDS = new Set(['credentials_rejected', 'permission_denied']);
const UNAVAILABLE_KINDS = new Set(['throttled', 'provider_unavailable', 'timed_out', 'unreachable']);

export const emailStatus = async (): Promise<IntegrationStatus> => {
  const backend = selectPersistenceBackend();
  const report = describeEmailConfiguration();
  const graph = readGraphEmailConfiguration();
  const transport = chooseEmailTransport({
    graphConfigured: graph !== null,
    smtpConfigured: readSmtpEmailConfiguration() !== null,
    isProduction: process.env.NODE_ENV === 'production',
    isDemoBackend: backend === 'demo',
  });
  const recent = await getServerRuntime().read((unit) => unit.repos.customerEmails.list(50));
  const lastSent = recent.find((email) => email.state === 'sent') ?? null;
  const lastFailure = recent.find((email) => email.state === 'failed') ?? null;
  const waiting = recent.filter((email) => email.state === 'failed' || email.state === 'attention').length;

  const checks: IntegrationCheck[] = [
    { label: 'Sending mailbox', ok: report.sender.length > 0, detail: report.sender.length > 0 ? report.sender : 'EMAIL_SENDER is not set.' },
    { label: 'Tenant', ok: env('EMAIL_GRAPH_TENANT_ID').length > 0, detail: env('EMAIL_GRAPH_TENANT_ID').length > 0 ? `Set (${tail(env('EMAIL_GRAPH_TENANT_ID'))})` : 'Not set.' },
    { label: 'App registration (client)', ok: env('EMAIL_GRAPH_CLIENT_ID').length > 0, detail: env('EMAIL_GRAPH_CLIENT_ID').length > 0 ? `Set (${tail(env('EMAIL_GRAPH_CLIENT_ID'))})` : 'Not set.' },
    {
      label: 'Credential',
      ok: graph !== null,
      detail:
        graph === null
          ? 'No certificate or client secret is configured.'
          : graph.certificatePath.length > 0
            ? 'Certificate (preferred). The private key stays on the server.'
            : 'Client secret. A certificate is preferred; a secret expires.',
    },
    { label: 'Transport in use', ok: transport === 'graph', detail: transport === 'graph' ? 'Microsoft 365 (Graph, sendMail, Mail.Send only)' : transport === 'simulated' ? 'Demonstration outbox — nothing leaves the building' : transport === 'smtp' ? 'SMTP (development only)' : 'None — customer emails are queued and not sent' },
    { label: 'Last accepted by Microsoft 365', ok: lastSent !== null, detail: lastSent === null ? 'None yet.' : `${lastSent.sentAt} to ${lastSent.recipient}` },
    ...report.problems.map((problem) => ({ label: 'Configuration problem', ok: false, detail: problem })),
  ];

  let state: IntegrationState;
  if (transport === 'simulated') state = 'simulated';
  else if (graph === null) state = env('EMAIL_GRAPH_TENANT_ID') || env('EMAIL_GRAPH_CLIENT_ID') || env('EMAIL_SENDER') ? 'incomplete' : 'not_configured';
  else if (lastFailure !== null && AUTH_KINDS.has(lastFailure.failureKind ?? '') && (lastSent === null || lastFailure.updatedAt > (lastSent.sentAt ?? ''))) state = 'authentication_failed';
  else if (lastFailure !== null && UNAVAILABLE_KINDS.has(lastFailure.failureKind ?? '') && (lastSent === null || lastFailure.updatedAt > (lastSent.sentAt ?? ''))) state = 'service_unavailable';
  else if (waiting > 0) state = 'action_required';
  else state = lastSent !== null ? 'connected' : 'configured';

  return {
    service: 'email',
    title: 'Email (Microsoft 365)',
    state,
    summary:
      state === 'simulated'
        ? 'Demonstration: emails are recorded in the outbox and never sent.'
        : state === 'not_configured'
          ? 'Not configured. Signed job cards are stored and their emails queued; nothing is sent until Microsoft 365 is set up.'
          : state === 'incomplete'
            ? `Configuration incomplete: ${report.missing.join(', ')}.`
            : state === 'action_required'
              ? `${waiting} customer email${waiting === 1 ? '' : 's'} need the office (failed or needing attention).`
              : state === 'authentication_failed'
                ? 'Microsoft 365 refused the credential or the Mail.Send permission. See the last failure on the job.'
                : state === 'service_unavailable'
                  ? 'Microsoft 365 was unavailable on the last attempt; emails are retried automatically.'
                  : state === 'connected'
                    ? 'Connected: Microsoft 365 accepted the last email.'
                    : 'Configured, not yet verified: no email has been accepted by Microsoft 365 yet. Send a test.',
    checks,
    missing: report.missing,
    testRecipients: testRecipientsFor('email').length,
  };
};

export const whatsappStatus = async (): Promise<IntegrationStatus> => {
  const backend = selectPersistenceBackend();
  const config = readWhatsAppConfiguration();
  const webhook = readWhatsAppWebhookConfiguration();
  const runtime = getServerRuntime();
  const [messages, events] = await Promise.all([
    runtime.read((unit) => unit.repos.outbox.list(50)),
    runtime.read((unit) => unit.repos.integrations.listWebhookEvents(1)),
  ]);
  const activation = backend === 'demo' ? { active: false, provenAt: null } : await readWhatsAppActivation(runtime);
  const whatsapp = messages.filter((message) => message.channel === 'whatsapp');
  const lastSent = whatsapp.find((message) => message.state === 'sent') ?? null;
  // Refusals before activation are the gate working, not failures to act on.
  const failed = whatsapp.filter(
    (message) => (message.state === 'failed' || message.deliveryStatus === 'failed') && !message.failureReason.includes('not yet in use'),
  ).length;
  const problems = whatsAppConfigurationProblems();
  const dedicated = numberDigits(env('WHATSAPP_DEDICATED_NUMBER'));
  const protectedCount = env('WHATSAPP_PROTECTED_NUMBERS').split(/[,;]+/).filter((value) => value.trim().length > 0).length;
  const missing = [
    ...(env('WHATSAPP_DEDICATED_NUMBER').length === 0 ? ['WHATSAPP_DEDICATED_NUMBER'] : []),
    ...(env('WHATSAPP_PHONE_NUMBER_ID').length === 0 ? ['WHATSAPP_PHONE_NUMBER_ID'] : []),
    ...(env('WHATSAPP_ACCESS_TOKEN').length === 0 ? ['WHATSAPP_ACCESS_TOKEN'] : []),
    ...(webhook.appSecret.length === 0 ? ['WHATSAPP_APP_SECRET'] : []),
    ...(webhook.verifyToken.length === 0 ? ['WHATSAPP_WEBHOOK_VERIFY_TOKEN'] : []),
  ];
  const checks: IntegrationCheck[] = [
    {
      label: 'Dedicated EJE number',
      ok: dedicated.length > 0 && problems.length === 0,
      detail:
        dedicated.length === 0
          ? 'WHATSAPP_DEDICATED_NUMBER is not set. EJE sends only from a new number of its own, named here.'
          : `…${dedicated.slice(-4)} — a separate number used only for EJE notifications. Meta is asked before every send that the phone number id is this number.`,
    },
    {
      label: 'Office WhatsApp number',
      ok: true,
      detail: `Not connected and never used: the office keeps its WhatsApp Business app and its chats. ${protectedCount > 0 ? `${protectedCount} protected number${protectedCount === 1 ? '' : 's'} (WHATSAPP_PROTECTED_NUMBERS): EJE refuses to send if Meta reports one of them.` : 'Optionally list it in WHATSAPP_PROTECTED_NUMBERS so EJE refuses it outright.'}`,
    },
    ...problems.map((problem) => ({ label: 'Configuration problem', ok: false, detail: problem })),
    { label: 'Phone number id', ok: env('WHATSAPP_PHONE_NUMBER_ID').length > 0, detail: env('WHATSAPP_PHONE_NUMBER_ID').length > 0 ? `Set (${tail(env('WHATSAPP_PHONE_NUMBER_ID'))})` : 'Not set.' },
    { label: 'Access token', ok: env('WHATSAPP_ACCESS_TOKEN').length > 0, detail: env('WHATSAPP_ACCESS_TOKEN').length > 0 ? 'Set (never shown).' : 'Not set.' },
    { label: 'Business account id', ok: env('WHATSAPP_BUSINESS_ACCOUNT_ID').length > 0, detail: env('WHATSAPP_BUSINESS_ACCOUNT_ID').length > 0 ? 'Set — template approval can be checked.' : 'Not set — template approval cannot be checked.' },
    { label: 'Webhook signature secret', ok: webhook.appSecret.length > 0, detail: webhook.appSecret.length > 0 ? 'Set — webhooks are verified.' : 'Not set — every webhook is refused.' },
    { label: 'Webhook verify token', ok: webhook.verifyToken.length > 0, detail: webhook.verifyToken.length > 0 ? 'Set.' : 'Not set — Meta cannot verify the callback URL.' },
    { label: 'Templates', ok: true, detail: `${ASSIGNMENT_TEMPLATE}, ${TRANSFER_TEMPLATE}, ${SITE_LOCATION_TEMPLATE} — language “${config?.templateLanguage ?? (env('WHATSAPP_TEMPLATE_LANGUAGE') || 'en')}”. Messages go only once Meta has approved them.` },
    { label: 'Last accepted by Meta', ok: lastSent !== null, detail: lastSent === null ? 'None yet.' : `${lastSent.lastAttemptAt ?? lastSent.createdAt}` },
    { label: 'Last webhook received', ok: events.length > 0, detail: events[0] === undefined ? 'None yet.' : events[0].receivedAt },
    {
      label: 'Real API test',
      ok: activation.active,
      detail: activation.active
        ? `Passed ${activation.provenAt ?? ''} with this configuration. Job notifications are sent.`
        : 'Not passed with this configuration. Until a test to an internal number is accepted by Meta, no job notification is sent.',
    },
  ];
  /*
   * THE OWNER'S RULE: "Not configured" until the dedicated number and the Meta
   * credentials are set AND a real API test succeeded. Complete but unproven
   * is therefore still not configured — the summary says what is missing.
   */
  const complete = config !== null && webhook.appSecret.length > 0 && webhook.verifyToken.length > 0;
  let state: IntegrationState;
  if (config === null && backend === 'demo' && missing.length === 5) state = 'simulated';
  else if (!complete) state = missing.length === 5 && problems.length === 0 ? 'not_configured' : 'incomplete';
  else if (!activation.active) state = 'not_configured';
  else if (failed > 0) state = 'action_required';
  else state = 'connected';
  return {
    service: 'whatsapp',
    title: 'WhatsApp — dedicated EJE number (Meta Cloud API)',
    state,
    summary:
      state === 'simulated'
        ? 'Demonstration: messages are recorded in the outbox and never sent.'
        : state === 'not_configured' && !complete
          ? 'Not configured. Assignments and transfers stand and notify in the app; no WhatsApp message is sent. The office WhatsApp number is not connected.'
          : state === 'not_configured'
            ? 'Not configured yet: the dedicated number and the Meta credentials are set, but no real test has passed. Send a test to an internal number; until Meta accepts it, no job notification is sent.'
            : state === 'incomplete'
              ? `Configuration incomplete: ${[...missing, ...problems].join(' ')}`
              : state === 'action_required'
                ? `${failed} WhatsApp message${failed === 1 ? '' : 's'} failed. See the job's messages.`
                : lastSent !== null
                  ? 'Connected: the dedicated number passed a real test, and Meta accepted the last message.'
                  : 'Connected: the dedicated number passed a real test.',
    checks,
    missing,
    testRecipients: testRecipientsFor('whatsapp').length,
  };
};

export const mapsStatus = async (): Promise<IntegrationStatus> => {
  const backend = selectPersistenceBackend();
  const config = readGoogleGeocodingConfiguration();
  const runtime = getServerRuntime();
  const day = new Date().toISOString().slice(0, 10);
  const [used, sites] = await Promise.all([
    runtime.read((unit) => unit.repos.integrations.requestsOn(day, GEOCODING_SERVICE_NAME)),
    runtime.read((unit) => unit.repos.customers.listSites()),
  ]);
  const live = sites.filter((site) => site.archivedAt === null);
  const attention = live.filter((site) => siteLocationNeedsAttention(siteLocationOf(site).status)).length;
  const failing = live.filter((site) => siteLocationOf(site).status === 'failed');
  const authFailure = failing.some((site) => /API key|refused/i.test(siteLocationOf(site).error));
  const found = live.filter((site) => siteLocationOf(site).source === 'geocoded').length;
  const checks: IntegrationCheck[] = [
    { label: 'API key (server-side)', ok: config !== null, detail: config === null ? 'GOOGLE_MAPS_GEOCODING_API_KEY is not set.' : 'Set (never shown, never sent to a browser).' },
    { label: 'Region', ok: true, detail: config?.region ?? (env('GOOGLE_GEOCODING_REGION') || 'za') },
    { label: 'Look-ups today', ok: true, detail: `${used} of ${config?.dailyLimit ?? 500} allowed by EJE today` },
    { label: 'Sites pinned automatically', ok: true, detail: `${found} of ${live.length}` },
    { label: 'Sites needing the office', ok: attention === 0, detail: `${attention}` },
    { label: 'Navigation links', ok: true, detail: 'Google Maps links need no key; an unverified pin falls back to an address search, labelled as such.' },
  ];
  const state: IntegrationState =
    config === null
      ? backend === 'demo'
        ? 'simulated'
        : 'not_configured'
      : authFailure
        ? 'authentication_failed'
        : attention > 0
          ? 'action_required'
          : found > 0
            ? 'connected'
            : 'configured';
  return {
    service: 'maps',
    title: 'Google Maps (geocoding)',
    state,
    summary:
      state === 'simulated'
        ? 'Demonstration: pins come from a simulated geocoder and are labelled as such.'
        : state === 'not_configured'
          ? 'Not configured. Sites keep the pins the office sets by hand; technicians get an address search for the rest.'
          : state === 'authentication_failed'
            ? 'Google refused the API key. Check the key and its restrictions in Google Cloud.'
            : state === 'action_required'
              ? `${attention} site pin${attention === 1 ? '' : 's'} need checking.`
              : state === 'connected'
                ? 'Connected: Google has returned pins.'
                : 'Configured, not yet verified: no pin has been returned by Google yet.',
    checks,
    missing: config === null ? ['GOOGLE_MAPS_GEOCODING_API_KEY'] : [],
    testRecipients: 0,
  };
};

/**
 * A FINGERPRINT of each integration's configuration, compared with the last
 * one recorded; a difference goes on the audit trail (INT-ADMIN-1:
 * "integration configuration changes audited"). The fingerprint is a hash of
 * everything, secrets included — so a rotated secret is noticed — and the
 * summary written to the trail names only what is SET, never a value.
 */
const CONFIG_NAMES: Record<'email' | 'whatsapp' | 'maps', readonly string[]> = {
  email: ['EMAIL_GRAPH_TENANT_ID', 'EMAIL_GRAPH_CLIENT_ID', 'EMAIL_GRAPH_CLIENT_SECRET', 'EMAIL_GRAPH_CERTIFICATE_PATH', 'EMAIL_GRAPH_CERTIFICATE_THUMBPRINT', 'EMAIL_SENDER', 'EMAIL_REPLY_TO', 'EMAIL_TEST_RECIPIENTS'],
  whatsapp: ['WHATSAPP_DEDICATED_NUMBER', 'WHATSAPP_PROTECTED_NUMBERS', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_BUSINESS_ACCOUNT_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_WEBHOOK_VERIFY_TOKEN', 'WHATSAPP_TEMPLATE_LANGUAGE', 'WHATSAPP_TEST_RECIPIENTS'],
  maps: ['GOOGLE_MAPS_GEOCODING_API_KEY', 'GOOGLE_GEOCODING_REGION', 'GOOGLE_GEOCODING_DAILY_LIMIT'],
};

export const configurationFingerprint = (names: readonly string[], source: Readonly<Record<string, string | undefined>> = process.env) =>
  createHash('sha256')
    .update(names.map((name) => `${name}=${(source[name] ?? '').trim()}`).join('\n'))
    .digest('hex');

export const recordIntegrationConfiguration = async (): Promise<void> => {
  const runtime = getServerRuntime();
  for (const service of ['email', 'whatsapp', 'maps'] as const) {
    const names = CONFIG_NAMES[service];
    const fingerprint = configurationFingerprint(names);
    const summary = `Set: ${names.filter((name) => env(name).length > 0).join(', ') || 'nothing'}.`;
    await runtime.write(async (unit) => {
      const previous = await unit.repos.integrations.findState(service);
      if (previous !== null && previous.fingerprint === fingerprint) return;
      const now = unit.services.clock.now();
      await unit.repos.integrations.saveState(service, fingerprint, summary, now);
      if (previous === null && summary === 'Set: nothing.') return;
      await audit(
        { repos: unit.repos, services: unit.services, actor: integrationWorkerActor(now) },
        {
          jobId: null,
          type: 'integration_configuration_changed',
          summary: `${service === 'email' ? 'Email' : service === 'whatsapp' ? 'WhatsApp' : 'Google Maps'} configuration ${previous === null ? 'recorded' : 'changed'}`,
          detail: `The server's ${service} configuration ${previous === null ? 'was recorded for the first time' : 'changed since it was last recorded'}. ${summary} (No value is ever recorded.)`,
          changes: previous === null ? [] : [{ field: 'Configured variables', from: previous.summary, to: summary }],
        },
      );
    });
  }
};
