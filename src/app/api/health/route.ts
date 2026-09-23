import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { getDatabase } from '@/db/client';
import { selectPersistenceBackend } from '@/data/backend';
import { isDemoSwitcherEnabled } from '@/server/dev/demo-switcher';

/**
 * Is this deployment actually working?
 *
 * WHAT A HEALTH CHECK IS FOR: telling a process manager, a reverse proxy or a
 * person whether to send traffic here. So it answers the one question that
 * matters — can this process reach its database — rather than "is the Node
 * process alive", which is already obvious from the connection succeeding.
 *
 * UNAUTHENTICATED ON PURPOSE, and therefore deliberately dull. It reports the
 * build, the backend and whether a `select 1` came back. It does NOT report the
 * database name, the host, the user, the version, a connection string, a row
 * count or an error from the driver: a failed health check says `"database":
 * "unreachable"` and the reason goes to the logs, where the operator is, and
 * not to whoever asked.
 *
 * `503` when the database cannot be reached, so a proxy can act on the status
 * line without parsing the body.
 *
 * IT ALSO SAYS WHETHER THIS IS A DEMONSTRATION DEPLOYMENT, and that is the one
 * field here that is about safety rather than uptime. `EJE_DEMO_SWITCHER` turns
 * on one-click sign-in as the published demonstration accounts; a deployment
 * that has it on by mistake is a thing somebody needs to be able to NOTICE, and
 * "read the environment file on the server" is not noticing. This reports it
 * from outside, in one request, and `docs/vps-smoke-test.md` checks it.
 *
 * It discloses nothing new: `GET /api/dev/demo-users` already answers 200 with
 * the five addresses when the switcher is on and 404 when it is not, so this
 * field says strictly less than the feature it describes.
 */
export const dynamic = 'force-dynamic';

export const GET = async (): Promise<NextResponse> => {
  const backend = selectPersistenceBackend();
  const build = {
    commit: process.env.EJE_BUILD_COMMIT ?? 'unknown',
    builtAt: process.env.EJE_BUILD_TIME ?? 'unknown',
  };
  const demoSwitcher = isDemoSwitcherEnabled();

  if (backend !== 'postgres') {
    // Nothing to check: no database is configured for this process.
    return NextResponse.json({
      status: 'ok',
      backend,
      database: 'not-configured',
      demoSwitcher,
      build,
    });
  }

  try {
    await getDatabase().execute(sql`select 1`);
    return NextResponse.json({
      status: 'ok',
      backend,
      database: 'reachable',
      demoSwitcher,
      build,
    });
  } catch (cause) {
    // The reason belongs in the log, next to the operator — not in a response
    // to an unauthenticated caller.
    console.error('[health] database unreachable', cause);
    return NextResponse.json(
      { status: 'degraded', backend, database: 'unreachable', demoSwitcher, build },
      { status: 503 },
    );
  }
};
