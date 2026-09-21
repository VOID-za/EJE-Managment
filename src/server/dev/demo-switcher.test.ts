import { beforeEach, describe, expect, it } from 'vitest';
import {
  ApiTestClient,
  DEMO_PASSWORD,
  DEMO_USERS,
  signedInAs,
  startTestServer,
} from '@/test/api-harness';
import { isDemoAccount, isDemoSwitcherEnabled, DEMO_ACCOUNTS } from './demo-switcher';

/**
 * The development user switcher.
 *
 * Two things are being proved here, and the second matters more than the
 * first: that it does what a developer needs, and that a production deployment
 * cannot reach it however hard it tries.
 */
describe('when the switcher exists at all', () => {
  it('is off in production, and no flag turns it back on', () => {
    expect(isDemoSwitcherEnabled({ NODE_ENV: 'production' })).toBe(false);
    expect(isDemoSwitcherEnabled({ NODE_ENV: 'PRODUCTION' })).toBe(false);
  });

  it('is on in development and in test', () => {
    expect(isDemoSwitcherEnabled({ NODE_ENV: 'development' })).toBe(true);
    expect(isDemoSwitcherEnabled({ NODE_ENV: 'test' })).toBe(true);
    expect(isDemoSwitcherEnabled({ NODE_ENV: undefined })).toBe(true);
  });

  it('names only the accounts the development seed creates', () => {
    expect(DEMO_ACCOUNTS.map((account) => account.email)).toEqual([
      'master@eje-demo.local',
      'coordinator@eje-demo.local',
      'technician1@eje-demo.local',
      'technician2@eje-demo.local',
      'technician3@eje-demo.local',
    ]);

    expect(isDemoAccount('MASTER@EJE-DEMO.LOCAL')).toBe(true);
    expect(isDemoAccount(' master@eje-demo.local ')).toBe(true);
    // Anybody else, including the browser demonstration's own people.
    expect(isDemoAccount('elmarie.coetzee@eje-demo.co.za')).toBe(false);
    expect(isDemoAccount('someone@example.com')).toBe(false);
  });
});

/**
 * Against the running API.
 *
 * The demonstration backend is what `npm test` has, and its seeded people are
 * NOT the switcher's accounts — which is exactly the case worth proving: the
 * switcher refuses an account that is not on its list even when that account
 * exists and its password is known.
 */
describe('POST /api/dev/demo-users', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('lists the development accounts even on a database nobody has seeded', async () => {
    /*
     * The demonstration backend holds none of these five. The list is served
     * anyway, because a control that hides itself gives a developer no way to
     * tell a missing feature from an unseeded database — the refusal below is
     * where they are told which it is.
     */
    const response = await new ApiTestClient().get<{
      users: readonly { email: string; role: string }[];
    }>('/api/dev/demo-users');

    expect(response.status).toBe(200);
    expect(response.data.users.map((user) => user.email)).toEqual([
      'master@eje-demo.local',
      'coordinator@eje-demo.local',
      'technician1@eje-demo.local',
      'technician2@eje-demo.local',
      'technician3@eje-demo.local',
    ]);
  });

  it('switches into an account on the in-memory store, with no database at all', async () => {
    /*
     * `npm run dev` with no DATABASE_URL runs this store, and its people are
     * EJE's fictional staff rather than these five — so the switcher puts them
     * in the register on demand. Requiring a PostgreSQL install before a
     * developer could change role would defeat the point of the control.
     */
    const client = new ApiTestClient();
    const switched = await client.post('/api/dev/demo-users', {
      email: 'technician1@eje-demo.local',
    });

    expect(switched.status).toBe(200);
    expect(client.token).not.toBeNull();

    // An ordinary session, and the server decides the role.
    const me = await client.get<{ user: { email: string; role: string } }>('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.data.user.email).toBe('technician1@eje-demo.local');
    expect(me.data.user.role).toBe('technician');
  });

  it('applies the ordinary authorization rules to a switched session', async () => {
    const technician = new ApiTestClient();
    await technician.post('/api/dev/demo-users', { email: 'technician1@eje-demo.local' });
    expect((await technician.get('/api/admin')).status).toBe(403);

    const master = new ApiTestClient();
    await master.post('/api/dev/demo-users', { email: 'master@eje-demo.local' });
    expect((await master.get('/api/admin')).status).toBe(200);
  });

  it('leaves the demonstration store’s own people signing in as they always did', async () => {
    await new ApiTestClient().post('/api/dev/demo-users', { email: 'master@eje-demo.local' });

    const elmarie = await new ApiTestClient().signIn(DEMO_USERS.master, DEMO_PASSWORD);
    expect(elmarie.status).toBe(200);
  });

  it('never puts a password in the list', async () => {
    const response = await new ApiTestClient().get('/api/dev/demo-users');
    const body = JSON.stringify(response.raw).toLowerCase();

    expect(body).not.toContain('password');
    expect(body).not.toContain('ejedemo');
  });

  it('refuses an account that is not one of the seeded five', async () => {
    // A real account, with a real password, that the switcher may not touch.
    const response = await new ApiTestClient().post('/api/dev/demo-users', {
      email: DEMO_USERS.master,
    });

    expect(response.status).toBe(404);
  });

  it('refuses an unknown address', async () => {
    const response = await new ApiTestClient().post('/api/dev/demo-users', {
      email: 'nobody@eje-demo.local',
    });

    expect(response.status).toBe(404);
  });

  it('refuses a cross-site switch', async () => {
    const response = await new ApiTestClient().post(
      '/api/dev/demo-users',
      { email: 'master@eje-demo.local' },
      { crossSite: true },
    );

    expect(response.status).toBe(403);
  });

  it('rejects an unknown property rather than ignoring it', async () => {
    const response = await new ApiTestClient().post('/api/dev/demo-users', {
      email: 'master@eje-demo.local',
      role: 'master',
    });

    expect(response.status).toBe(400);
  });

  it('leaves the caller signed in when the switch is refused', async () => {
    const client = await signedInAs(DEMO_USERS.technician);
    const before = client.token;

    const refused = await client.post('/api/dev/demo-users', { email: 'nobody@eje-demo.local' });
    expect(refused.status).toBe(404);

    // Still the same session, still the same person.
    expect(client.token).toBe(before);
    const me = await client.get<{ user: { role: string } }>('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.data.user.role).toBe('technician');
  });
});
