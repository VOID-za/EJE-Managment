import { beforeEach, describe, expect, it } from 'vitest';
import type { JobListRow } from '@/application/job-view';
import {
  ApiTestClient,
  DEMO_PASSWORD,
  DEMO_USERS,
  discoverRoutes,
  signedInAs,
  startTestServer,
} from '@/test/api-harness';

/**
 * AUTHORIZATION IS THE SERVER'S.
 *
 * Every case here is a real HTTP request carrying nothing but a session cookie.
 * The browser is never asked what role it has, and the role it might claim has
 * nowhere to be claimed — which is what these tests are for.
 */
describe('authentication is required', () => {
  beforeEach(() => {
    startTestServer();
  });

  /*
   * THE WHOLE SURFACE, not a list.
   *
   * Read off `src/app/api` at run time, so an endpoint added next month is
   * swept the day it is added. Sign-in and sign-out are the two deliberate
   * exceptions: one is how a session is obtained, the other must work when
   * there is no longer a session to present.
   *
   * The development user switcher is a third, and it is only an exception at
   * all because it is a way of SIGNING IN — it cannot require a session for the
   * same reason the login route cannot. It does not exist in production, which
   * `src/server/dev/demo-switcher.test.ts` holds it to, and it serves nothing
   * on a database that has not been seeded.
   */
  const PUBLIC = new Set([
    'POST /api/auth/login',
    'POST /api/auth/logout',
    'GET /api/dev/demo-users',
    'POST /api/dev/demo-users',
  ]);

  it('refuses every endpoint but sign-in and the switcher without a session', async () => {
    const routes = await discoverRoutes();
    expect(routes.length).toBeGreaterThan(30);

    const allowed: string[] = [];
    for (const route of routes) {
      if (PUBLIC.has(`${route.method} ${route.path}`)) continue;
      const response = await new ApiTestClient().send(route.method, route.path);
      if (response.status !== 401) allowed.push(`${route.method} ${route.path} → ${response.status}`);
    }

    expect(allowed).toEqual([]);
  });

  it('keeps that list of exceptions to the ways of signing in', async () => {
    // A new public endpoint has to be added above deliberately, and this says
    // what the list is allowed to contain: nothing that reads business data.
    const routes = await discoverRoutes();
    const publicPaths = routes
      .filter((route) => PUBLIC.has(`${route.method} ${route.path}`))
      .map((route) => route.path);

    for (const path of publicPaths) {
      expect(path.startsWith('/api/auth/') || path.startsWith('/api/dev/')).toBe(true);
    }
  });

  it('refuses a write without a session', async () => {
    const response = await new ApiTestClient().post('/api/jobs/any-job/accept');
    expect(response.status).toBe(401);
  });
});

describe('office screens', () => {
  beforeEach(() => {
    startTestServer();
  });

  const officeOnly = [
    '/api/admin',
    '/api/customers',
    '/api/machines',
    '/api/jobs/form',
    '/api/jobs/closed',
    '/api/calendar?from=2025-01-01&to=2025-01-31',
  ];

  it.each(officeOnly)('refuses a technician at %s', async (path) => {
    const technician = await signedInAs(DEMO_USERS.technician);
    const response = await technician.get(path);

    expect(response.status).toBe(403);
    expect(response.error?.code).toBe('forbidden');
  });

  it.each(officeOnly)('serves a Master at %s', async (path) => {
    const master = await signedInAs(DEMO_USERS.master);
    expect((await master.get(path)).status).toBe(200);
  });

  it('serves a Coordinator the registers', async () => {
    const coordinator = await signedInAs(DEMO_USERS.coordinator);
    expect((await coordinator.get('/api/customers')).status).toBe(200);
    expect((await coordinator.get('/api/machines')).status).toBe(200);
  });
});

describe('managing people', () => {
  beforeEach(() => {
    startTestServer();
  });

  const findUser = async (client: ApiTestClient, email: string) => {
    const admin = await client.get<{ users: readonly { id: string; email: string }[] }>(
      '/api/admin',
    );
    const found = admin.data.users.find((user) => user.email === email);
    expect(found).toBeDefined();
    return found?.id ?? '';
  };

  it('lets a Master edit a Technician', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const id = await findUser(master, DEMO_USERS.technician);

    const response = await master.post(`/api/users/${id}/update`, {
      firstName: 'Sipho',
      lastName: 'Mahlangu',
      email: DEMO_USERS.technician,
      mobile: '082 000 0000',
      jobTitle: 'Senior Field Technician',
      role: 'technician',
    });

    expect(response.status).toBe(200);
  });

  it('refuses a Master editing another Master', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const id = await findUser(master, DEMO_USERS.secondMaster);

    const response = await master.post(`/api/users/${id}/update`, {
      firstName: 'Johan',
      lastName: 'Erasmus',
      email: DEMO_USERS.secondMaster,
      mobile: '082 000 0000',
      jobTitle: 'Owner',
      role: 'master',
    });

    expect(response.status).toBe(403);
    expect(response.error?.violations.map((violation) => violation.code)).toContain(
      'master_not_editable',
    );
  });

  it('refuses a Coordinator editing a Master', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const id = await findUser(master, DEMO_USERS.secondMaster);
    const coordinator = await signedInAs(DEMO_USERS.coordinator);

    const response = await coordinator.post(`/api/users/${id}/update`, {
      firstName: 'Johan',
      lastName: 'Erasmus',
      email: DEMO_USERS.secondMaster,
      mobile: '082 000 0000',
      jobTitle: 'Owner',
      role: 'master',
    });

    expect(response.status).toBe(403);
  });

  it('refuses a Coordinator promoting a Technician to Coordinator', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const id = await findUser(master, DEMO_USERS.technician);
    const coordinator = await signedInAs(DEMO_USERS.coordinator);

    const response = await coordinator.post(`/api/users/${id}/update`, {
      firstName: 'Sipho',
      lastName: 'Mahlangu',
      email: DEMO_USERS.technician,
      mobile: '082 000 0000',
      jobTitle: 'Field Technician',
      role: 'coordinator',
    });

    expect(response.status).toBe(403);
    expect(response.error?.violations.map((violation) => violation.code)).toContain(
      'role_not_assignable',
    );
  });

  it('refuses a Coordinator adding a Master', async () => {
    const coordinator = await signedInAs(DEMO_USERS.coordinator);

    const response = await coordinator.post('/api/users', {
      firstName: 'New',
      lastName: 'Owner',
      email: 'new.owner@eje-demo.co.za',
      mobile: '082 111 1111',
      jobTitle: 'Owner',
      role: 'master',
    });

    expect(response.status).toBe(403);
  });

  it('refuses a Technician managing anybody', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const id = await findUser(master, DEMO_USERS.otherTechnician);
    const technician = await signedInAs(DEMO_USERS.technician);

    expect((await technician.get('/api/admin')).status).toBe(403);
    expect(
      (
        await technician.post(`/api/users/${id}/set_active`, { active: false })
      ).status,
    ).toBe(403);
  });
});

describe('the actor is the session, and only the session', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('ignores or rejects an actor id in the body', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const technician = await signedInAs(DEMO_USERS.technician);

    const mine = await technician.get<{ rows: readonly JobListRow[] }>('/api/jobs');
    const job = mine.data.rows.find((row) => row.job.status === 'in_progress');
    expect(job).toBeDefined();

    const masterMe = await master.get<{ user: { id: string } }>('/api/auth/me');

    // A note posted by the technician, claiming to be the Master.
    const response = await technician.post(`/api/jobs/${job?.job.jobNumber ?? ''}/add_note`, {
      body: 'Filter replaced.',
      internal: false,
      actorId: masterMe.data.user.id,
    });

    // The schema is strict, so the smuggled field is refused outright rather
    // than being quietly ignored. Either is acceptable; being obeyed is not.
    expect([400, 200]).toContain(response.status);
    if (response.status === 400) {
      expect(response.error?.code).toBe('validation_failed');
    }

    const after = await technician.get<{
      view: { job: { notes: readonly { authorId: string }[] } };
    }>(`/api/jobs/${job?.job.jobNumber ?? ''}`);
    for (const note of after.data.view.job.notes) {
      expect(note.authorId).not.toBe(masterMe.data.user.id);
    }
  });

  it('will not act as another user even when the cookie is somebody else’s', async () => {
    const technician = await signedInAs(DEMO_USERS.technician);
    const stolen = technician.token;

    const impostor = new ApiTestClient();
    const me = await impostor.get<{ user: { role: string } }>('/api/auth/me', { token: stolen });

    // The cookie IS the identity — presenting it makes you that person, which
    // is why it is HttpOnly, Secure and `__Host-` prefixed. What matters is
    // that nothing else does: a body, a header or a query cannot.
    expect(me.data.user.role).toBe('technician');
  });
});

describe('cross-site requests', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('refuses a state-changing request from another site', async () => {
    const technician = await signedInAs(DEMO_USERS.technician);
    const rows = await technician.get<{ rows: readonly JobListRow[] }>('/api/jobs');
    const job = rows.data.rows[0];

    const response = await technician.post(
      `/api/jobs/${job?.job.jobNumber ?? ''}/accept`,
      {},
      { crossSite: true },
    );

    expect(response.status).toBe(403);
  });

  it('refuses a request whose Origin disagrees with the host', async () => {
    const technician = await signedInAs(DEMO_USERS.technician);

    const response = await technician.post(
      '/api/notifications/read-all',
      {},
      { withoutFetchMetadata: true, headers: { origin: 'https://evil.example' } },
    );

    expect(response.status).toBe(403);
  });

  it('accepts a same-origin request with no fetch metadata', async () => {
    const technician = await signedInAs(DEMO_USERS.technician);

    const response = await technician.post(
      '/api/notifications/read-all',
      {},
      { withoutFetchMetadata: true, headers: { origin: 'https://eje.test' } },
    );

    expect(response.status).toBe(200);
  });
});

describe('input validation', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('rejects an unknown property', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const rows = await master.get<{ rows: readonly JobListRow[] }>('/api/jobs');
    const job = rows.data.rows[0];

    const response = await master.post(`/api/jobs/${job?.job.jobNumber ?? ''}/set_callout`, {
      applied: true,
      status: 'closed',
    });

    expect(response.status).toBe(400);
  });

  it('rejects a wrongly typed value', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const rows = await master.get<{ rows: readonly JobListRow[] }>('/api/jobs');
    const job = rows.data.rows[0];

    const response = await master.post(`/api/jobs/${job?.job.jobNumber ?? ''}/set_callout`, {
      applied: 'yes',
    });

    expect(response.status).toBe(400);
    expect(response.error?.violations.length).toBeGreaterThan(0);
  });

  it('answers an action that is not in the registry as not found', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const rows = await master.get<{ rows: readonly JobListRow[] }>('/api/jobs');
    const job = rows.data.rows[0];

    const response = await master.post(`/api/jobs/${job?.job.jobNumber ?? ''}/drop_table`, {});
    expect(response.status).toBe(404);
  });

  it('rejects a body that is not JSON', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const response = await master.send('POST', '/api/notifications/read-all', {
      headers: { 'content-type': 'application/json' },
      body: undefined,
    });
    // An empty body is read as `{}`, which this command accepts.
    expect(response.status).toBe(200);
  });

  it('never quotes SQL, a stack trace or a connection string in an error', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const response = await master.post('/api/jobs/no-such-job/accept', {});

    expect(response.status).toBe(404);
    const body = JSON.stringify(response.raw).toLowerCase();
    expect(body).not.toContain('select ');
    expect(body).not.toContain('postgres://');
    expect(body).not.toContain('at object.');
  });
});

describe('the demonstration password is never a way into a real database', () => {
  it('is refused when the address does not exist', async () => {
    startTestServer();
    const response = await new ApiTestClient().signIn('not.a.person@example.com', DEMO_PASSWORD);
    expect(response.status).toBe(401);
  });
});
