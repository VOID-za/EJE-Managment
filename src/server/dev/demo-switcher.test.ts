import { beforeEach, describe, expect, it } from 'vitest';
import {
  ApiTestClient,
  DEMO_PASSWORD,
  DEMO_USERS,
  signedInAs,
  startTestServer,
} from '@/test/api-harness';
import {
  isDemoAccount,
  isDemoSwitcherEnabled,
  DEMO_ACCOUNTS,
  SWITCH_NOT_SEEDED,
  SWITCH_REFUSED,
} from './demo-switcher';

/**
 * The development user switcher.
 *
 * Two things are being proved here, and the second matters more than the
 * first: that it does what a developer needs, and that a production deployment
 * cannot reach it however hard it tries.
 */
describe('when the switcher exists at all', () => {
  const STAGING = 'postgresql://eje_app:pw@localhost:5432/eje_production';

  it('is on in development and in test', () => {
    expect(isDemoSwitcherEnabled({ NODE_ENV: 'development' })).toBe(true);
    expect(isDemoSwitcherEnabled({ NODE_ENV: 'test' })).toBe(true);
    expect(isDemoSwitcherEnabled({ NODE_ENV: undefined })).toBe(true);
  });

  it('is OFF in a production build that has not said otherwise', () => {
    // Which is every deployment by default, including the live one: the flag
    // below has to be added on purpose, to one machine, naming one database.
    expect(isDemoSwitcherEnabled({ NODE_ENV: 'production', DATABASE_URL: STAGING })).toBe(false);
    expect(isDemoSwitcherEnabled({ NODE_ENV: 'PRODUCTION', DATABASE_URL: STAGING })).toBe(false);
  });

  it('is on in a production build that names its own database', () => {
    // The staging deployment. `next build` makes NODE_ENV production there and
    // always will, so the question this asks is which DATABASE, not which build.
    expect(
      isDemoSwitcherEnabled({
        NODE_ENV: 'production',
        DATABASE_URL: STAGING,
        EJE_DEMO_SWITCHER: 'eje_production',
      }),
    ).toBe(true);
  });

  it('is not turned on by a word that merely means yes', () => {
    for (const vague of ['true', 'yes', '1', 'on', 'enabled', 'i-understand', '']) {
      expect(
        isDemoSwitcherEnabled({
          NODE_ENV: 'production',
          DATABASE_URL: STAGING,
          EJE_DEMO_SWITCHER: vague,
        }),
        vague,
      ).toBe(false);
    }
  });

  it('is not turned on by a flag that names some OTHER database', () => {
    /*
     * The case this shape exists for. An environment file copied from the
     * staging machine to the live one carries `EJE_DEMO_SWITCHER=eje_production`
     * — and against a live database called anything else it is simply wrong,
     * which is exactly when being wrong is useful.
     */
    expect(
      isDemoSwitcherEnabled({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://eje_app:pw@localhost:5432/eje_live',
        EJE_DEMO_SWITCHER: 'eje_production',
      }),
    ).toBe(false);
  });

  it('is off when there is no readable database to name', () => {
    // Fails closed rather than matching an empty name against an empty flag.
    expect(
      isDemoSwitcherEnabled({ NODE_ENV: 'production', EJE_DEMO_SWITCHER: 'eje_production' }),
    ).toBe(false);
    expect(
      isDemoSwitcherEnabled({
        NODE_ENV: 'production',
        DATABASE_URL: 'not a url',
        EJE_DEMO_SWITCHER: '',
      }),
    ).toBe(false);
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

  it('switches into every one of the five, with the role the seed gave them', async () => {
    // The control offers five buttons. Each of them has to work, and each has
    // to arrive at the role the seed says — not the role the browser asked for.
    for (const account of DEMO_ACCOUNTS) {
      const client = new ApiTestClient();
      const switched = await client.post('/api/dev/demo-users', { email: account.email });
      expect(switched.status, account.email).toBe(200);

      const me = await client.get<{ user: { email: string; role: string } }>('/api/auth/me');
      expect(me.data.user.email, account.email).toBe(account.email);
      expect(me.data.user.role, account.email).toBe(account.role);
    }
  });

  it('is gone entirely — both verbs — when the gate is shut', async () => {
    /*
     * The route reads the gate on every request rather than at module load, so
     * this is the real thing rather than a stand-in: a production build with no
     * `EJE_DEMO_SWITCHER` has no switcher, and knowing the URL does not help.
     */
    const env = process.env as Record<string, string | undefined>;
    const saved = { NODE_ENV: env.NODE_ENV, EJE_DEMO_SWITCHER: env.EJE_DEMO_SWITCHER };
    env.NODE_ENV = 'production';
    delete env.EJE_DEMO_SWITCHER;
    try {
      expect((await new ApiTestClient().get('/api/dev/demo-users')).status).toBe(404);

      const attempt = await new ApiTestClient().post('/api/dev/demo-users', {
        email: 'master@eje-demo.local',
      });
      expect(attempt.status).toBe(404);
      // And it issued nothing: a 404 must not hand out a session.
      expect(JSON.stringify(attempt.raw)).not.toContain('user');
    } finally {
      if (saved.NODE_ENV === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = saved.NODE_ENV;
      if (saved.EJE_DEMO_SWITCHER === undefined) delete env.EJE_DEMO_SWITCHER;
      else env.EJE_DEMO_SWITCHER = saved.EJE_DEMO_SWITCHER;
    }
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

  /**
   * A MIGRATED BUT UNSEEDED DATABASE used to be a dead end.
   *
   * `db:migrate` builds all 49 tables and creates nobody. The list endpoint
   * still draws the control, every switch answers 404, and a 404 on a route
   * that plainly exists reads as a routing fault — which is exactly how a day
   * goes into looking for a missing route that was never missing.
   */
  it('tells an unseeded database to run the seed, rather than only refusing', () => {
    expect(SWITCH_NOT_SEEDED).toContain('npm run db:seed');
    expect(SWITCH_NOT_SEEDED).not.toBe(SWITCH_REFUSED);
  });

  it('still says nothing at all about an address it will not switch into', () => {
    // The generic refusal covers a wrong password, a disabled account and an
    // address that is not one of the five. It must not distinguish them, and it
    // must not offer the seed as an explanation for any of them.
    expect(SWITCH_REFUSED).not.toContain('db:seed');
    expect(SWITCH_REFUSED).not.toContain('password');
    expect(SWITCH_REFUSED).not.toContain('@');
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
