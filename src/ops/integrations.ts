import { loadEnvFiles } from '@/db/seed/env';
import {
  describeEmailConfiguration,
  readGraphEmailConfiguration,
} from '@/services/production/email';
import { readWhatsAppConfiguration } from '@/services/production/whatsapp';
import { ASSIGNMENT_TEMPLATE } from '@/application/assignment-notice';
import { SITE_LOCATION_TEMPLATE } from '@/application/job-operations';
import {
  checkEmailReadiness,
  checkWhatsAppReadiness,
  integrationsFailed,
  isCredentialRefusal,
  type IntegrationCheck,
  type ProviderProbe,
} from './integration-rules';

/**
 * `npm run integrations:check` — CAN THIS DEPLOYMENT REACH A CUSTOMER?
 * MANDATE-3, EMAIL-2, WHATSAPP-1.
 *
 *   npm run integrations:check              configuration only, no network
 *   npm run integrations:check -- --probe   ask the providers, SEND NOTHING
 *
 * WHAT `--probe` DOES. For Microsoft 365: acquires a client-credentials token
 * and reads the SENDER'S OWN mailbox (`GET /users/<sender>`). For Meta: reads
 * the configured phone number's own metadata. Both prove the credential and the
 * sender exist. NEITHER SENDS A MESSAGE, and no customer record is read — the
 * only address involved is EJE's own.
 *
 * WHY THAT IS THE RIGHT TEST TO HAVE NOW. EJE have not supplied a tenant, a
 * token or approved templates, so the integrations cannot be verified against
 * the providers yet. What CAN be built now is the thing that will verify them
 * in one command on the day the credentials arrive, without a customer being
 * emailed by a test. `/api/health` says which transport was selected; this says
 * whether that transport works.
 *
 * IT PRINTS NO VALUES. A verdict names a variable. Provider wording is passed
 * through the same redaction the adapters use before it is printed, because an
 * error from a token endpoint can quote the request it was given.
 */

const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const LABEL: Record<IntegrationCheck['readiness'], string> = {
  ready: ' READY ',
  configured: 'PENDING',
  not_configured: 'ABSENT ',
  refused: 'REFUSED',
};

/** Takes the credentials out of anything about to be printed. */
const redactor = (secrets: readonly string[]) => (text: string): string => {
  let safe = text;
  for (const secret of secrets) {
    if (secret.length > 8) safe = safe.split(secret).join('[redacted]');
  }
  return safe;
};

const withTimeout = async <T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await work(controller.signal);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * A token and a read of the sender's mailbox. No message.
 *
 * The sender is EJE's own address, which is in the environment file and is not
 * a secret; reading it proves both that the credential works and that the
 * mailbox named exists, which is the usual misconfiguration.
 */
const probeGraph = async (
  config: NonNullable<ReturnType<typeof readGraphEmailConfiguration>>,
): Promise<ProviderProbe> => {
  const redact = redactor([config.clientSecret]);
  try {
    const token = await withTimeout(
      (signal) =>
        fetch(`${config.loginUrl}/${config.tenantId}/oauth2/v2.0/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            scope: 'https://graph.microsoft.com/.default',
            grant_type: 'client_credentials',
          }).toString(),
          signal,
        }),
      config.timeoutMs,
    );

    if (!token.ok) {
      const body = redact((await token.text()).slice(0, 400));
      return {
        ok: false,
        detail: `the token endpoint answered ${token.status}: ${body}`,
        credentialRefused: isCredentialRefusal(token.status) || token.status === 400,
      };
    }

    const parsed = (await token.json()) as { access_token?: string };
    const bearer = parsed.access_token ?? '';
    if (bearer.length === 0) {
      return {
        ok: false,
        detail: 'the token endpoint answered 200 with no access_token in it.',
        credentialRefused: true,
      };
    }

    const mailbox = await withTimeout(
      (signal) =>
        fetch(`${config.baseUrl}/users/${encodeURIComponent(config.sender)}`, {
          headers: { authorization: `Bearer ${bearer}` },
          signal,
        }),
      config.timeoutMs,
    );

    if (!mailbox.ok) {
      const body = redactor([config.clientSecret, bearer])((await mailbox.text()).slice(0, 400));
      return {
        ok: false,
        detail:
          `a token was issued and reading the sender mailbox answered ${mailbox.status}: ${body}`,
        credentialRefused: isCredentialRefusal(mailbox.status),
      };
    }

    return {
      ok: true,
      detail: `A token was issued and ${config.sender} is readable. No message was sent.`,
      credentialRefused: false,
    };
  } catch (cause) {
    return {
      ok: false,
      detail: redact(cause instanceof Error ? cause.message : 'unknown error'),
      credentialRefused: false,
    };
  }
};

/** The phone number's own metadata. No message. */
const probeWhatsApp = async (
  config: NonNullable<ReturnType<typeof readWhatsAppConfiguration>>,
): Promise<ProviderProbe> => {
  const redact = redactor([config.accessToken]);
  try {
    const response = await withTimeout(
      (signal) =>
        fetch(`${config.baseUrl}/${config.apiVersion}/${config.phoneNumberId}`, {
          headers: { authorization: `Bearer ${config.accessToken}` },
          signal,
        }),
      20_000,
    );

    if (!response.ok) {
      return {
        ok: false,
        detail: `reading the phone number answered ${response.status}: ${redact(
          (await response.text()).slice(0, 400),
        )}`,
        credentialRefused: isCredentialRefusal(response.status),
      };
    }
    return {
      ok: true,
      detail: 'The phone number is readable. No message was sent.',
      credentialRefused: false,
    };
  } catch (cause) {
    return {
      ok: false,
      detail: redact(cause instanceof Error ? cause.message : 'unknown error'),
      credentialRefused: false,
    };
  }
};

/**
 * Whether Meta holds an APPROVED template for each name this build sends.
 *
 * Needs the WhatsApp Business Account id, which is a different identifier from
 * the phone number id and is not required to send — so it is optional here and
 * its absence answers null, meaning "nobody checked". Guessing it from the
 * phone number would be inventing configuration.
 */
const verifyTemplates = async (
  config: NonNullable<ReturnType<typeof readWhatsAppConfiguration>>,
  templates: readonly string[],
): Promise<boolean | null> => {
  const account = (process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ?? '').trim();
  if (account.length === 0) return null;

  try {
    const response = await withTimeout(
      (signal) =>
        fetch(
          `${config.baseUrl}/${config.apiVersion}/${account}/message_templates?limit=200&fields=name,status`,
          { headers: { authorization: `Bearer ${config.accessToken}` }, signal },
        ),
      20_000,
    );
    if (!response.ok) return null;

    const body = (await response.json()) as {
      data?: { name?: string; status?: string }[];
    };
    const approved = new Set(
      (body.data ?? [])
        .filter((entry) => (entry.status ?? '').toUpperCase() === 'APPROVED')
        .map((entry) => entry.name ?? ''),
    );
    return templates.every((name) => approved.has(name));
  } catch {
    // Unreachable is not "unapproved": null keeps the two apart.
    return null;
  }
};

const main = async (): Promise<void> => {
  loadEnvFiles();
  const probe = flag('probe');

  const emailReport = describeEmailConfiguration(process.env);
  const graph = readGraphEmailConfiguration(process.env);
  const whatsapp = readWhatsAppConfiguration(process.env);

  /*
   * THE TEMPLATE NAMES COME FROM THE APPLICATION, NOT FROM CONFIGURATION.
   *
   * They are constants in the code, so what EJE have to do is get templates
   * approved in Meta under exactly these names. Reading them from the
   * environment instead would let a deployment claim readiness for templates
   * the application never sends.
   */
  const templates = [ASSIGNMENT_TEMPLATE, SITE_LOCATION_TEMPLATE];

  const checks: IntegrationCheck[] = [
    checkEmailReadiness({
      configured: emailReport.configured,
      missing: emailReport.missing,
      problems: emailReport.problems,
      probe: probe && graph !== null ? await probeGraph(graph) : null,
    }),
    await (async () => {
      const probed = probe && whatsapp !== null ? await probeWhatsApp(whatsapp) : null;
      return checkWhatsAppReadiness({
        configured: whatsapp !== null,
        missing: [
          ...((process.env.WHATSAPP_PHONE_NUMBER_ID ?? '').trim().length === 0
            ? ['WHATSAPP_PHONE_NUMBER_ID']
            : []),
          ...((process.env.WHATSAPP_ACCESS_TOKEN ?? '').trim().length === 0
            ? ['WHATSAPP_ACCESS_TOKEN']
            : []),
        ],
        templates,
        /*
         * Only asked when there is a business account to ask about. Without
         * it the answer is NULL — "nobody checked" — rather than a guess in
         * either direction.
         */
        approvalVerified:
          probed?.ok === true && whatsapp !== null
            ? await verifyTemplates(whatsapp, templates)
            : null,
        probe: probed,
      });
    })(),
  ];

  process.stdout.write('\n=== EJE INTEGRATION CHECK ===\n');
  process.stdout.write(
    probe
      ? 'the providers were asked for a token and for their own metadata. NO MESSAGE WAS SENT.\n\n'
      : 'configuration only — nothing was asked of any provider. Add --probe to ask.\n\n',
  );

  for (const check of checks) {
    process.stdout.write(`[${LABEL[check.readiness]}] ${check.integration.padEnd(9)} ${check.detail}\n`);
    if (check.next.length > 0) {
      process.stdout.write(`${' '.repeat(10)} ${check.integration.padEnd(9)} NEXT: ${check.next}\n`);
    }
  }

  process.stdout.write(
    '\nA customer is messaged only by the application, on a job, and only once EJE have ' +
      'approved a live send. This command never sends anything.\n',
  );

  if (integrationsFailed(checks)) {
    process.stdout.write('INTEGRATION CHECK FAILED — a provider refused a credential.\n');
    process.exitCode = 1;
  }
};

void main().catch((cause: unknown) => {
  process.stderr.write(
    `integrations  FAILED: ${cause instanceof Error ? cause.message : String(cause)}\n`,
  );
  process.exitCode = 1;
});
