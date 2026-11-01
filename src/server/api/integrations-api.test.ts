import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiTestClient, DEMO_USERS, signedInAs, startTestServer } from '@/test/api-harness';

/**
 * INT-EMAIL-1/4, INT-WA-2, INT-MAP-2, INT-ADMIN-1 over the real routes: who
 * may manage templates and read a job's emails, that the public webhook takes
 * nothing it cannot verify, and that Administration never shows a secret.
 */

const refused = (answer: { readonly status: number; readonly error: unknown }) => {
  expect(answer.status, JSON.stringify(answer.error)).toBeGreaterThanOrEqual(400);
  expect(answer.status).toBeLessThan(500);
};

const SECRETS = {
  EMAIL_GRAPH_CLIENT_SECRET: 'graph-secret-value-NEVER-SHOWN',
  WHATSAPP_ACCESS_TOKEN: 'EAAG-whatsapp-token-NEVER-SHOWN',
  WHATSAPP_APP_SECRET: 'meta-app-secret-NEVER-SHOWN',
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'verify-token-NEVER-SHOWN',
  GOOGLE_MAPS_GEOCODING_API_KEY: 'AIza-google-key-NEVER-SHOWN',
};

const setEnv = (values: Record<string, string>) => {
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
};
const clearEnv = (names: readonly string[]) => {
  for (const name of names) delete process.env[name];
};

describe('email templates over the API', () => {
  beforeEach(() => startTestServer());

  it('the Master and the Coordinator see the same templates and both may create; a technician is refused', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const coordinator = await signedInAs(DEMO_USERS.coordinator);
    const technician = await signedInAs(DEMO_USERS.technician);

    const listed = await master.get<{ templates: readonly { id: string }[]; placeholders: readonly unknown[] }>('/api/admin/email-templates');
    expect(listed.status).toBe(200);
    expect(listed.data.templates.length).toBe(5);
    expect(listed.data.placeholders.length).toBeGreaterThanOrEqual(12);

    const created = await coordinator.post<{ id: string; active: boolean }>('/api/admin/email-templates', {
      op: 'create',
      event: 'signed_job_card',
      jobType: 'service',
      name: 'Service (short)',
      description: '',
      subject: '{{job_number}}',
      body: 'Hello {{customer_name}}',
    });
    expect(created.status, JSON.stringify(created.error)).toBe(200);
    expect(created.data.active).toBe(false);

    const seen = await master.get<{ templates: readonly { id: string }[] }>('/api/admin/email-templates');
    expect(seen.data.templates.map((template) => template.id)).toContain(created.data.id);

    refused(await technician.get('/api/admin/email-templates'));
    refused(await technician.post('/api/admin/email-templates', { op: 'preview', name: 'x', subject: 'x', body: 'x' }));
    refused(await technician.post(`/api/admin/email-templates/${created.data.id}`, { op: 'make_default' }));
  });

  it('refuses an unknown placeholder, and saves an edit as the next version', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const bad = await master.post('/api/admin/email-templates', {
      op: 'create', event: 'signed_job_card', jobType: 'breakdown', name: 'Bad', description: '', subject: '{{job_numbr}}', body: 'x',
    });
    refused(bad);
    expect(JSON.stringify(bad.error)).toContain('unknown_placeholder');

    const { data } = await master.get<{ templates: readonly { id: string; currentVersion: number; name: string; description: string; current: { body: string } }[] }>('/api/admin/email-templates');
    const first = data.templates[0]!;
    const saved = await master.send<{ currentVersion: number }>('PATCH', `/api/admin/email-templates/${first.id}`, {
      body: { name: first.name, description: first.description, subject: 'Edited {{job_number}}', body: first.current.body, changeNote: 'api', expectedVersion: first.currentVersion },
    });
    expect(saved.status, JSON.stringify(saved.error)).toBe(200);
    expect(saved.data.currentVersion).toBe(first.currentVersion + 1);
  });
});

describe('a job’s email history over the API', () => {
  beforeEach(() => startTestServer());

  it('is the office’s: a technician is refused', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const technician = await signedInAs(DEMO_USERS.technician);
    const ok = await master.get<{ emails: readonly unknown[]; whatsapp: readonly unknown[] }>('/api/jobs/EJE-1048/emails');
    expect(ok.status, JSON.stringify(ok.error)).toBe(200);
    expect(Array.isArray(ok.data.emails)).toBe(true);
    refused(await technician.get('/api/jobs/EJE-1048/emails'));
  });
});

describe('the WhatsApp webhook', () => {
  beforeEach(() => startTestServer());
  afterEach(() => clearEnv(['WHATSAPP_APP_SECRET', 'WHATSAPP_WEBHOOK_VERIFY_TOKEN']));

  const body = {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.unknown', status: 'delivered', timestamp: '1' }] } }] }],
  };
  const signature = (secret: string) => `sha256=${createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex')}`;

  it('answers Meta’s handshake only with the configured token', async () => {
    setEnv({ WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'the-verify-token' });
    const anonymous = new ApiTestClient();
    const good = await anonymous.send('GET', '/api/integrations/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=the-verify-token&hub.challenge=987654');
    expect(good.status).toBe(200);
    const wrong = await anonymous.send('GET', '/api/integrations/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=guess&hub.challenge=987654');
    expect(wrong.status).toBe(403);
  });

  it('refuses everything while no app secret is configured', async () => {
    const answer = await new ApiTestClient().post('/api/integrations/whatsapp/webhook', body, { headers: { 'x-hub-signature-256': signature('') } });
    expect(answer.status).toBe(503);
  });

  it('refuses an unsigned or wrongly signed body, and accepts a correctly signed one', async () => {
    setEnv({ WHATSAPP_APP_SECRET: 'the-app-secret' });
    const anonymous = new ApiTestClient();
    expect((await anonymous.post('/api/integrations/whatsapp/webhook', body)).status).toBe(401);
    expect((await anonymous.post('/api/integrations/whatsapp/webhook', body, { headers: { 'x-hub-signature-256': signature('wrong') } })).status).toBe(401);
    const accepted = await anonymous.post<unknown>('/api/integrations/whatsapp/webhook', body, { headers: { 'x-hub-signature-256': signature('the-app-secret') } });
    expect(accepted.status).toBe(200);
    expect(accepted.raw).toMatchObject({ ok: true, unmatched: 1 });
    // The same delivery again is recognised.
    const again = await anonymous.post<unknown>('/api/integrations/whatsapp/webhook', body, { headers: { 'x-hub-signature-256': signature('the-app-secret') } });
    expect(again.raw).toMatchObject({ duplicates: 1 });
  });
});

describe('Administration → Integrations', () => {
  beforeEach(() => startTestServer());
  afterEach(() =>
    clearEnv([
      ...Object.keys(SECRETS),
      'EMAIL_GRAPH_TENANT_ID',
      'EMAIL_GRAPH_CLIENT_ID',
      'EMAIL_SENDER',
      'WHATSAPP_PHONE_NUMBER_ID',
      'WHATSAPP_DEDICATED_NUMBER',
      'WHATSAPP_PROTECTED_NUMBERS',
      'EMAIL_TEST_RECIPIENTS',
    ]),
  );

  it('NEVER shows a secret — not a value, not a fragment — even with everything configured', async () => {
    setEnv({
      ...SECRETS,
      EMAIL_GRAPH_TENANT_ID: 'tenant-00000000-1234',
      EMAIL_GRAPH_CLIENT_ID: 'client-00000000-5678',
      EMAIL_SENDER: 'sales@ejeie.co.za',
      WHATSAPP_PHONE_NUMBER_ID: '1098765432',
    });
    const master = await signedInAs(DEMO_USERS.master);
    const answer = await master.get('/api/admin/integrations');
    expect(answer.status, JSON.stringify(answer.error)).toBe(200);
    const text = JSON.stringify(answer.raw);
    for (const secret of Object.values(SECRETS)) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(secret.slice(0, 8));
      expect(text).not.toContain(secret.slice(-8));
    }
    expect(text).toContain('sales@ejeie.co.za');
  });

  it('says plainly what is not configured, and is refused to a technician', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const answer = await master.get<{ statuses: readonly { service: string; state: string }[] }>('/api/admin/integrations');
    const states = Object.fromEntries(answer.data.statuses.map((status) => [status.service, status.state]));
    // The test server is the demonstration backend: its adapters say so.
    expect(states).toEqual({ email: 'simulated', whatsapp: 'simulated', maps: 'simulated' });
    refused(await (await signedInAs(DEMO_USERS.technician)).get('/api/admin/integrations'));
  });

  it('WhatsApp is the DEDICATED EJE number, and stays Not configured until a real test passes', async () => {
    type Status = { service: string; state: string; title: string; summary: string; checks: readonly { label: string; ok: boolean; detail: string }[] };
    const master = await signedInAs(DEMO_USERS.master);
    setEnv({
      WHATSAPP_PHONE_NUMBER_ID: '1098765432',
      WHATSAPP_ACCESS_TOKEN: SECRETS.WHATSAPP_ACCESS_TOKEN,
      WHATSAPP_APP_SECRET: SECRETS.WHATSAPP_APP_SECRET,
      WHATSAPP_WEBHOOK_VERIFY_TOKEN: SECRETS.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
      WHATSAPP_DEDICATED_NUMBER: '+27 82 000 0001',
      WHATSAPP_PROTECTED_NUMBERS: '+27 11 555 0100',
    });
    const whatsapp = async () =>
      (await master.get<{ statuses: readonly Status[] }>('/api/admin/integrations')).data.statuses.find((status) => status.service === 'whatsapp')!;

    // Everything set, but no real test has passed: still "Not configured".
    const complete = await whatsapp();
    expect(complete.state).toBe('not_configured');
    expect(complete.title).toContain('dedicated EJE number');
    expect(complete.summary).toContain('no real test has passed');
    const check = (label: string) => complete.checks.find((entry) => entry.label === label)!;
    expect(check('Dedicated EJE number')).toMatchObject({ ok: true });
    expect(check('Dedicated EJE number').detail).toContain('…0001');
    expect(check('Office WhatsApp number').detail).toContain('Not connected and never used');
    expect(check('Office WhatsApp number').detail).toContain('1 protected number');
    expect(check('Real API test')).toMatchObject({ ok: false });
    // Neither number is shown in full.
    expect(JSON.stringify(complete)).not.toContain('820000001');
    expect(JSON.stringify(complete)).not.toContain('115550100');

    // The office number set as the dedicated one is refused outright.
    setEnv({ WHATSAPP_DEDICATED_NUMBER: '011 555 0100' });
    const office = await whatsapp();
    expect(office.state).toBe('incomplete');
    expect(office.summary).toContain('WHATSAPP_PROTECTED_NUMBERS');
    clearEnv(['WHATSAPP_DEDICATED_NUMBER', 'WHATSAPP_PROTECTED_NUMBERS']);

    // Without the dedicated number, the rest is not enough.
    const without = await whatsapp();
    expect(without.state).toBe('incomplete');
    expect(without.summary).toContain('WHATSAPP_DEDICATED_NUMBER');
  });

  it('sends a test email ONLY to a configured test recipient', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const none = await master.post('/api/admin/integrations', { action: 'test_email', recipientIndex: 0 });
    refused(none);
    expect(JSON.stringify(none.error)).toContain('EMAIL_TEST_RECIPIENTS');

    setEnv({ EMAIL_TEST_RECIPIENTS: 'office-test@ejeie.co.za' });
    const sent = await master.post<{ ok: boolean }>('/api/admin/integrations', { action: 'test_email', recipientIndex: 0 });
    expect(sent.status, JSON.stringify(sent.error)).toBe(200);
    expect(sent.data.ok).toBe(true);
    refused(await master.post('/api/admin/integrations', { action: 'test_email', recipientIndex: 1 }));
    // There is no way to name an address in the request at all.
    refused(await master.post('/api/admin/integrations', { action: 'test_email', recipientIndex: 0, to: 'customer@example.com' }));
  });
});

describe('site pins over the API', () => {
  beforeEach(() => startTestServer());

  it('the office verifies or corrects a pin; a technician cannot', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const technician = await signedInAs(DEMO_USERS.technician);
    const corrected = await master.post<{ latitude: number; geocode: { status: string; source: string } }>('/api/sites/site-abc-jhb/verify_location', {
      kind: 'manual',
      latitude: -26.2041,
      longitude: 28.0473,
    });
    expect(corrected.status, JSON.stringify(corrected.error)).toBe(200);
    expect(corrected.data.latitude).toBe(-26.2041);
    expect(corrected.data.geocode).toMatchObject({ status: 'verified', source: 'manual' });
    refused(await technician.post('/api/sites/site-abc-jhb/verify_location', { kind: 'current' }));
    refused(await master.post('/api/sites/site-abc-jhb/verify_location', { kind: 'manual', latitude: 'north' }));
  });
});
