import { NextResponse, type NextRequest } from 'next/server';
import { getServerRuntime } from '@/server/runtime';
import { integrationWorkerActor } from '@/server/api/integration-dispatch';
import { applyWhatsAppWebhook } from '@/application/whatsapp-messages';
import {
  answerVerification,
  parseWebhook,
  readWhatsAppWebhookConfiguration,
  verifySignature,
} from '@/services/production/whatsapp-webhook';

/**
 * META'S WHATSAPP WEBHOOK. INT-WA-2. Public by necessity — Meta has no EJE
 * session — so it authenticates the REQUEST instead: the GET handshake by the
 * verify token, every POST by its HMAC signature over the raw body. Nothing
 * unverified is parsed, stored or acted on. See `whatsapp-webhook.ts`.
 *
 * Answers 200 to a verified POST even when no message matches: Meta retries a
 * non-2xx for days, and a status for a message this deployment did not send is
 * not an error to be retried.
 */
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 512 * 1024;

export const GET = (request: NextRequest): NextResponse => {
  const challenge = answerVerification(request.nextUrl.searchParams, readWhatsAppWebhookConfiguration());
  if (challenge === null) return new NextResponse('Forbidden', { status: 403 });
  return new NextResponse(challenge, { status: 200, headers: { 'content-type': 'text/plain' } });
};

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  const config = readWhatsAppWebhookConfiguration();
  if (config.appSecret.length === 0) {
    // No secret, no way to tell Meta from anybody else: refuse everything.
    return new NextResponse('Webhook not configured', { status: 503 });
  }
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return new NextResponse('Too large', { status: 413 });
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > MAX_BODY_BYTES) return new NextResponse('Too large', { status: 413 });
  if (!verifySignature(raw, request.headers.get('x-hub-signature-256'), config.appSecret)) {
    return new NextResponse('Invalid signature', { status: 401 });
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return new NextResponse('Not JSON', { status: 400 });
  }
  const parsed = parseWebhook(body);
  try {
    const outcome = await getServerRuntime().write((unit) =>
      applyWhatsAppWebhook(
        { repos: unit.repos, services: unit.services, actor: integrationWorkerActor(unit.services.clock.now()) },
        parsed,
      ),
    );
    return NextResponse.json({ ok: true, ...outcome });
  } catch (cause) {
    // A store failure: 500, so Meta delivers it again later. Never the body or a secret.
    console.error('[whatsapp] webhook could not be recorded', cause instanceof Error ? cause.message : 'unknown error');
    return new NextResponse('Not recorded', { status: 500 });
  }
};
