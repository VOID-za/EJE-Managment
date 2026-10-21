import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_USERS, signedInAs, startTestServer, type ApiTestClient } from '@/test/api-harness';

/**
 * WHAT THE SCREENS ARE TOLD ABOUT WHETHER ANYTHING ACTUALLY GOES OUT.
 * MANDATE-3.
 *
 * THE DEFECT THIS FIXES. The notifications screen read "(simulated)" against
 * every e-mail and WhatsApp channel — hard-coded, written when both of them
 * were simulated. Both are real adapters now wherever they are configured, so
 * on a deployment with a Microsoft 365 tenant the screen would call a message
 * that genuinely reached a customer simulated. That is a screen somebody reads
 * to decide whether to telephone the customer instead, so being wrong in the
 * cautious direction is still being wrong.
 *
 * WHAT IS ASSERTED HERE is the SERVER's answer, because the one thing that must
 * be true of it is that it comes from the deployment's own configuration rather
 * than from a constant — and that it names the transport and nothing else. A
 * tenant id, a phone number id or an address in this payload would be a
 * credential on a screen.
 */

interface ShellBody {
  readonly unreadNotifications: number;
  readonly delivery?: {
    readonly email: string;
    readonly whatsapp: string;
  };
}

interface NotificationsBody {
  readonly delivery?: { readonly email: string; readonly whatsapp: string };
}

/** Every variable the two transports are decided from. */
const CREDENTIALS = [
  'EMAIL_GRAPH_TENANT_ID',
  'EMAIL_GRAPH_CLIENT_ID',
  'EMAIL_GRAPH_CLIENT_SECRET',
  'EMAIL_SENDER',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_ACCESS_TOKEN',
] as const;

describe('what the screens are told about delivery', () => {
  let saved: Record<string, string | undefined>;
  let master: ApiTestClient;

  beforeEach(async () => {
    saved = Object.fromEntries(CREDENTIALS.map((name) => [name, process.env[name]]));
    for (const name of CREDENTIALS) delete process.env[name];
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('says the demonstration keeps messages in its outbox', async () => {
    const shell = await master.get<ShellBody>('/api/shell');

    expect(shell.status).toBe(200);
    // The demonstration backend has a visible outbox and transmits nothing,
    // which is what `simulated` means and what the badge should say.
    expect(shell.data.delivery?.email).toBe('simulated');
    expect(shell.data.delivery?.whatsapp).toBe('simulated');
  });

  it('says the same thing on the notifications screen, from the same function', async () => {
    const screen = await master.get<NotificationsBody>('/api/notifications');

    // Two views, one decision. If these could disagree, the badge and the
    // health route could too.
    expect(screen.data.delivery?.email).toBe('simulated');
    expect(screen.data.delivery?.whatsapp).toBe('simulated');
  });

  it('CHANGES WITH THE CONFIGURATION, which is the whole point', async () => {
    /*
     * A constant would pass every assertion above. This is the one it cannot:
     * the answer has to be read from the deployment, so that a deployment with
     * a tenant stops being described as simulated.
     */
    process.env.EMAIL_GRAPH_TENANT_ID = 'a-tenant-id';
    process.env.EMAIL_GRAPH_CLIENT_ID = 'a-client-id';
    process.env.EMAIL_GRAPH_CLIENT_SECRET = 'a-secret';
    process.env.EMAIL_SENDER = 'office@example-test.co.za';
    process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
    process.env.WHATSAPP_ACCESS_TOKEN = 'a-token';
    startTestServer();
    const configured = await signedInAs(DEMO_USERS.master);

    const shell = await configured.get<ShellBody>('/api/shell');

    expect(shell.data.delivery?.email).toBe('graph');
    expect(shell.data.delivery?.whatsapp).toBe('cloud_api');
  });

  it('NEVER PUTS A CREDENTIAL IN THE ANSWER', async () => {
    process.env.EMAIL_GRAPH_TENANT_ID = 'a-very-distinctive-tenant-id';
    process.env.EMAIL_GRAPH_CLIENT_ID = 'a-very-distinctive-client-id';
    process.env.EMAIL_GRAPH_CLIENT_SECRET = 'a-very-distinctive-secret';
    process.env.EMAIL_SENDER = 'office@example-test.co.za';
    process.env.WHATSAPP_PHONE_NUMBER_ID = '999888777';
    process.env.WHATSAPP_ACCESS_TOKEN = 'a-very-distinctive-token';
    startTestServer();
    const configured = await signedInAs(DEMO_USERS.master);

    const body = JSON.stringify((await configured.get<ShellBody>('/api/shell')).data);

    // The transport NAME and nothing else. A tenant id or a token here would
    // be a credential rendered on a screen.
    for (const secret of [
      'a-very-distinctive-tenant-id',
      'a-very-distinctive-client-id',
      'a-very-distinctive-secret',
      '999888777',
      'a-very-distinctive-token',
      'office@example-test.co.za',
    ]) {
      expect(body, secret).not.toContain(secret);
    }
  });
});
