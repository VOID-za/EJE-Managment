import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { can, isPlausibleEmailAddress } from '@/domain';
import { audit } from '@/application/audit';
import { requeueUnpinnedSites, listSitesNeedingAttention } from '@/application/site-geocoding';
import { maskNumber } from '@/application/whatsapp-messages';
import { getServerRuntime } from '@/server/runtime';
import { requireAuthenticatedActor, type AuthenticatedActor } from './actor';
import { assertSameOrigin } from './csrf';
import { errorResponse, forbidden, logUnexpected, toApiError } from './errors';
import { parseWith } from './handler';
import { dispatchSiteGeocodes } from './integration-dispatch';
import { emailStatus, mapsStatus, testRecipientsFor, whatsappStatus } from '@/server/integration-status';

/**
 * ADMINISTRATION → INTEGRATIONS. INT-ADMIN-1.
 *
 * GET: the status of email, WhatsApp and Google Maps (never a secret), the
 * recent customer emails, and the sites whose pin needs somebody.
 *
 * POST: the SAFE tests. A test email or WhatsApp message goes ONLY to an
 * address the server's configuration names as a test recipient
 * (EMAIL_TEST_RECIPIENTS, WHATSAPP_TEST_RECIPIENTS) — the request may choose
 * among them, never add one, so this cannot message a customer by accident or
 * anybody on purpose. A test geocode looks one address up and stores nothing
 * on any site. The provider is called with no transaction open; the test is
 * then recorded on the audit trail.
 */

const assertAdmin = (actor: AuthenticatedActor): void => {
  if (!can(actor.user.role, 'admin.access')) throw forbidden('Only the office sees the integrations.');
};

const guarded = async (route: string, work: () => Promise<NextResponse>): Promise<NextResponse> => {
  try {
    return await work();
  } catch (cause) {
    logUnexpected(route, cause);
    return errorResponse(toApiError(cause));
  }
};

export const integrationsGet = async (request: NextRequest): Promise<NextResponse> =>
  guarded('admin.integrations', async () => {
    const actor = await requireAuthenticatedActor(request);
    assertAdmin(actor);
    const runtime = getServerRuntime();
    const [email, whatsapp, maps] = await Promise.all([emailStatus(), whatsappStatus(), mapsStatus()]);
    const operation = (unit: Parameters<Parameters<typeof runtime.read>[0]>[0]) => ({ repos: unit.repos, services: unit.services, actor: actor.user });
    const [recentEmails, sites] = await Promise.all([
      runtime.read((unit) => unit.repos.customerEmails.list(25)),
      can(actor.user.role, 'customers.manage') ? runtime.read((unit) => listSitesNeedingAttention(operation(unit))) : Promise.resolve([]),
    ]);
    return NextResponse.json({
      data: {
        statuses: [email, whatsapp, maps],
        testRecipients: {
          email: testRecipientsFor('email'),
          whatsapp: testRecipientsFor('whatsapp').map(maskNumber),
        },
        recentEmails: recentEmails.map((entry) => ({
          id: entry.id,
          jobId: entry.jobId,
          recipient: entry.recipient,
          subject: entry.subject,
          state: entry.state,
          attempts: entry.attempts,
          createdAt: entry.createdAt,
          sentAt: entry.sentAt,
          failureReason: entry.failureReason,
          templateName: entry.templateName,
          templateVersion: entry.templateVersion,
        })),
        sites: sites.slice(0, 100).map(({ site, customerName }) => ({ site, customerName })),
      },
    });
  });

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('test_email'), recipientIndex: z.number().int().min(0).max(50) }).strict(),
  z.object({ action: z.literal('test_whatsapp'), recipientIndex: z.number().int().min(0).max(50) }).strict(),
  z.object({ action: z.literal('test_geocode'), address: z.string().trim().min(3).max(300) }).strict(),
  z.object({ action: z.literal('find_unpinned') }).strict(),
]);

export const integrationsPost = async (request: NextRequest): Promise<NextResponse> =>
  guarded('admin.integrations.action', async () => {
    assertSameOrigin(request);
    const actor = await requireAuthenticatedActor(request);
    assertAdmin(actor);
    const input = parseWith(actionSchema, await request.json().catch(() => null));
    const runtime = getServerRuntime();
    const record = (summary: string, detail: string) =>
      runtime.write((unit) =>
        audit({ repos: unit.repos, services: unit.services, actor: actor.user }, { jobId: null, type: 'integration_test_sent', summary, detail }),
      );

    switch (input.action) {
      case 'test_email': {
        const recipient = testRecipientsFor('email')[input.recipientIndex];
        if (recipient === undefined || !isPlausibleEmailAddress(recipient)) {
          throw forbidden('That is not a configured test recipient.', [
            { code: 'not_a_test_recipient', message: 'Test emails go only to an address in EMAIL_TEST_RECIPIENTS on the server.' },
          ]);
        }
        const result = await runtime.read(async ({ services }) => {
          try {
            const receipt = await services.email.send({
              to: [recipient],
              subject: 'EJE test email — please ignore',
              body:
                'This is a test from EJE Administration → Integrations.\n\n' +
                `It was sent from ${services.email.sender ?? 'the configured mailbox'} to a configured test recipient. ` +
                'No customer was emailed.\n\nEJE Industrial Electronics',
              reference: `test-${Date.now()}`,
            });
            return { ok: receipt.state !== 'failed', detail: receipt.state === 'failed' ? receipt.failureReason : `Accepted (reference ${receipt.messageId}).` };
          } catch (cause) {
            return { ok: false, detail: cause instanceof Error ? cause.message : 'The email could not be sent.' };
          }
        });
        await record('Test email', `${actor.user.firstName} ${actor.user.lastName} sent a test email to ${recipient}: ${result.ok ? 'accepted by the provider' : 'failed'} — ${result.detail}`);
        return NextResponse.json({ data: result });
      }
      case 'test_whatsapp': {
        const recipient = testRecipientsFor('whatsapp')[input.recipientIndex];
        if (recipient === undefined) {
          throw forbidden('That is not a configured test recipient.', [
            { code: 'not_a_test_recipient', message: 'Test messages go only to a number in WHATSAPP_TEST_RECIPIENTS on the server.' },
          ]);
        }
        const result = await runtime.read(async ({ services }) => {
          try {
            // The assignment template, with sample values that say what it is.
            const entry = await services.whatsapp.send({
              to: recipient,
              templateName: 'eje_job_assigned',
              parameters: ['EJE-TEST', 'Test', 'EJE test message', 'Not a real job', 'Not specified', 'https://eje.syncza.co.za'],
              preview: 'EJE test message (assignment template, sample values).',
            });
            return { ok: true, detail: `Accepted by Meta (message ${entry.id}). Delivery is reported by webhook.` };
          } catch (cause) {
            return { ok: false, detail: cause instanceof Error ? cause.message : 'The message could not be sent.' };
          }
        });
        await record('Test WhatsApp message', `${actor.user.firstName} ${actor.user.lastName} sent a test WhatsApp message to ${maskNumber(recipient)}: ${result.ok ? 'accepted' : 'failed'} — ${result.detail}`);
        return NextResponse.json({ data: result });
      }
      case 'test_geocode': {
        const answer = await runtime.read(async ({ services }) =>
          services.geocoding === undefined || !services.geocoding.configured
            ? null
            : services.geocoding.geocode(input.address),
        );
        if (answer === null) return NextResponse.json({ data: { ok: false, detail: 'Automatic pins are not set up on this system.' } });
        await record('Test address look-up', `${actor.user.firstName} ${actor.user.lastName} looked up a test address: ${answer.outcome}.`);
        return NextResponse.json({ data: { ok: answer.outcome === 'match' || answer.outcome === 'ambiguous', answer } });
      }
      case 'find_unpinned': {
        if (!can(actor.user.role, 'customers.manage')) throw forbidden('Only the office manages site pins.');
        const queued = await runtime.write((unit) =>
          requeueUnpinnedSites({ repos: unit.repos, services: unit.services, actor: actor.user, deferDelivery: true }),
        );
        await dispatchSiteGeocodes(runtime).catch(() => 0);
        return NextResponse.json({ data: { ok: true, detail: `${queued} site${queued === 1 ? '' : 's'} queued for a pin.` } });
      }
    }
  });
