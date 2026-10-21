import { classifyDatabaseUrl } from '@/db/connection-guard';

/**
 * WHICH DEPLOYMENT THIS IS, SAID OUT LOUD RATHER THAN INFERRED.
 * October mandate, Workstream A.
 *
 * THE PROBLEM. `eje.syncza.co.za` is a real server, started by systemd, built
 * by `next build`, with a database called `eje_production` — and everything in
 * it is demonstration data, deliberately, because that is where EJE try the
 * application out. Every existing guard in this repository therefore has to
 * answer "is this production?" from circumstantial evidence:
 *
 *   - `NODE_ENV` says `production` on the demonstration site, because that is
 *     what makes Next serve a production build;
 *   - the database NAME says production, because somebody named it that
 *     before the distinction mattered;
 *   - `EJE_DEMO_SWITCHER` naming its own database is the nearest thing to a
 *     declaration, and it is a feature flag rather than a statement about the
 *     deployment.
 *
 * The result is a preflight that FAILS the one deployment it was written for:
 * an armed switcher is a deployment blocker, and on the demonstration site it
 * is the point. A check that must be ignored to deploy is not a check.
 *
 * SO THE DEPLOYMENT DECLARES ITSELF, in one line in `/etc/eje/eje.env`:
 *
 *     EJE_DEPLOYMENT=demonstration     # or: production
 *
 * WHAT THAT BUYS, and it is not tidiness:
 *
 *   1. A deployment declared `production` can never arm the demonstration
 *      switcher, whatever else its environment says. That is a RUNTIME
 *      refusal, not a preflight warning — see `isDemoSwitcherEnabled`.
 *   2. The demonstration deployment becomes a configuration that PASSES,
 *      so its preflight is read rather than waved through.
 *   3. The two can be told apart, which is what makes "do not interchange
 *      them" enforceable: a deployment declared `demonstration` pointed at a
 *      database named production is refused, and so is the reverse.
 *
 * WHAT IT DOES NOT BUY. A declaration is a line in a file and lines get
 * copied. It is the THIRD line of defence, behind separate credentials and the
 * published-password check in `demo-switcher.ts` that fails closed on the only
 * thing an attacker cannot change. It is written down here so nobody mistakes
 * a label for an airlock — which is exactly the mistake the mandate warns
 * about ("do not assume that a provenance label alone isolates data").
 */

export const DEPLOYMENT = 'EJE_DEPLOYMENT';

/**
 * Names that say, in the database name itself, "this is not the real thing".
 *
 * ITS OWN LIST RATHER THAN `DEVELOPMENT_NAMES`, deliberately, and the
 * direction is the reason. `DEVELOPMENT_NAMES` is an ALLOW-list: matching it
 * lets a development process open the connection, so adding a word to it
 * makes `assertDevelopmentDatabase` more permissive. This list is only ever
 * used to REFUSE — a deployment that declares itself production and is
 * pointed at a database with one of these words in its name — so a broader
 * list here is strictly stricter, and `demonstration` can be on it without
 * opening anything.
 */
const DEMONSTRATION_NAMES =
  /(^|[-_])(demo|demonstration|dev|development|local|test|testing|sandbox|staging|scratch)([-_]|$)/iu;

export type DeploymentMode =
  /** Real customers, real documents. No demonstration anything. */
  | 'production'
  /** EJE trying the application out. Demonstration fixtures expected. */
  | 'demonstration'
  /** Nobody said. Every guard then behaves as it did before this existed. */
  | 'undeclared';

/**
 * The two lines this reads, and nothing else.
 *
 * Deliberately a plain shape rather than `ProcessEnv`: every caller passes the
 * narrow environment IT reads, and a test passes an object literal. See
 * `PreflightEnvironment`, which is the same decision.
 */
export interface DeploymentEnvironment {
  readonly EJE_DEPLOYMENT?: string | undefined;
  readonly DATABASE_URL?: string | undefined;
  /** So `process.env` satisfies it, exactly as `PreflightEnvironment` does. */
  readonly [key: string]: string | undefined;
}



export const deploymentModeOf = (env: DeploymentEnvironment = process.env): DeploymentMode => {
  const declared = (env.EJE_DEPLOYMENT ?? '').trim().toLowerCase();
  if (declared === 'production') return 'production';
  if (declared === 'demonstration' || declared === 'demo') return 'demonstration';
  /*
   * ANYTHING ELSE IS `undeclared`, INCLUDING A TYPO, and that is deliberate.
   * Reading `EJE_DEPLOYMENT=prod` as production would be a guess; reading it as
   * demonstration would be a dangerous one. `undeclared` keeps every existing
   * guard in force and the preflight says the line was not understood.
   */
  return 'undeclared';
};

/** True when the deployment has declared itself to be the real thing. */
export const isDeclaredProduction = (env: DeploymentEnvironment = process.env): boolean =>
  deploymentModeOf(env) === 'production';

/**
 * Whether a declared mode and the database it is pointed at can both be true.
 *
 * THE INTERCHANGE THIS CATCHES. `/etc/eje/eje.env` for one deployment copied
 * to the other is the single most likely way EJE's real data and its
 * demonstration data end up in the same place — and the two files differ in
 * exactly two lines, one of which is the connection string. Comparing the
 * declaration against the database NAME turns a copied file into a refusal.
 *
 * Names are all there is to go on, which is the same honest limit
 * `connection-guard.ts` records. A `production` deployment on a database whose
 * name says nothing passes here; its protection is separate credentials.
 */
export interface DeploymentMismatch {
  readonly mode: DeploymentMode;
  readonly databaseName: string;
  readonly reason: string;
}

export const deploymentMismatch = (
  env: DeploymentEnvironment = process.env,
): DeploymentMismatch | null => {
  const mode = deploymentModeOf(env);
  if (mode === 'undeclared') return null;

  const url = (env.DATABASE_URL ?? '').trim();
  if (url.length === 0) return null;

  const { databaseName, kind } = classifyDatabaseUrl(url);
  if (databaseName.length === 0) return null;

  if (mode === 'demonstration' && kind === 'production') {
    return {
      mode,
      databaseName,
      reason:
        'This deployment declares itself a DEMONSTRATION deployment and is pointed at a ' +
        'database whose name says production. One of the two lines is wrong, and the dangerous ' +
        'reading is that an environment file was copied — a demonstration deployment writing ' +
        'fictional customers into the live register.',
    };
  }

  /*
   * A PRODUCTION DEPLOYMENT ON A DATABASE NAMED AS DEMONSTRATION. The mirror
   * case, and the one that loses real work rather than corrupting it: real job
   * cards accumulating in a database nobody backs up and everybody is willing
   * to reset.
   */
  if (mode === 'production' && DEMONSTRATION_NAMES.test(databaseName)) {
    return {
      mode,
      databaseName,
      reason:
        'This deployment declares itself PRODUCTION and is pointed at a database whose name ' +
        'says demonstration, development or test. Real job cards would accumulate in a ' +
        'database that is expected to be disposable.',
    };
  }

  return null;
};
