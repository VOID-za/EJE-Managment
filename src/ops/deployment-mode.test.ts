import { describe, expect, it } from 'vitest';
import { deploymentMismatch, deploymentModeOf, isDeclaredProduction } from './deployment-mode';
import { checkDemoSwitcher, checkDeployment } from './preflight-rules';
import { isDemoSwitcherEnabled } from '@/server/dev/demo-switcher';
import { resolveDemoSeedTarget, SeedRefused } from '@/db/seed/guards';

/**
 * TELLING THE TWO DEPLOYMENTS APART. October mandate, Workstream A.
 *
 * `eje.syncza.co.za` is a production BUILD, started by systemd, with a
 * database called `eje_production`, holding nothing but demonstration data.
 * Every guard in this repository used to answer "is this production?" from
 * that circumstantial evidence, and the preflight consequently FAILED the one
 * deployment it was written for. These are the rules that replace the guess.
 */
const PRODUCTION_URL = 'postgres://eje:x@127.0.0.1:5432/eje_production';
const DEMO_URL = 'postgres://eje:x@127.0.0.1:5432/eje_demonstration';

const verdictFor = (checks: readonly { name: string; verdict: string }[], name: string): string =>
  checks.find((check) => check.name === name)?.verdict ?? 'absent';

describe('what the deployment says it is', () => {
  it('reads the two values it understands', () => {
    expect(deploymentModeOf({ EJE_DEPLOYMENT: 'production' })).toBe('production');
    expect(deploymentModeOf({ EJE_DEPLOYMENT: 'demonstration' })).toBe('demonstration');
    // `demo` is accepted because somebody will write it.
    expect(deploymentModeOf({ EJE_DEPLOYMENT: 'demo' })).toBe('demonstration');
    expect(deploymentModeOf({ EJE_DEPLOYMENT: '  PRODUCTION  ' })).toBe('production');
  });

  /**
   * A TYPO IS NOT A DECLARATION. Reading `prod` as production would be a
   * guess; reading it as demonstration would be a dangerous one.
   */
  it('treats anything else as undeclared rather than guessing', () => {
    expect(deploymentModeOf({})).toBe('undeclared');
    expect(deploymentModeOf({ EJE_DEPLOYMENT: '' })).toBe('undeclared');
    expect(deploymentModeOf({ EJE_DEPLOYMENT: 'prod' })).toBe('undeclared');
    expect(deploymentModeOf({ EJE_DEPLOYMENT: 'live' })).toBe('undeclared');
    expect(deploymentModeOf({ EJE_DEPLOYMENT: 'true' })).toBe('undeclared');
    expect(isDeclaredProduction({ EJE_DEPLOYMENT: 'prod' })).toBe(false);
  });
});

describe('a deployment and the database it is pointed at', () => {
  /**
   * THE INTERCHANGE THIS EXISTS FOR: one deployment's `/etc/eje/eje.env`
   * copied to the other. The two files differ in about two lines.
   */
  it('REFUSES a demonstration deployment pointed at a production database', () => {
    const mismatch = deploymentMismatch({
      EJE_DEPLOYMENT: 'demonstration',
      DATABASE_URL: PRODUCTION_URL,
    });
    expect(mismatch?.reason).toMatch(/copied/u);
    expect(verdictFor(
      checkDeployment({ EJE_DEPLOYMENT: 'demonstration', DATABASE_URL: PRODUCTION_URL }),
      'Deployment target',
    )).toBe('fail');
  });

  it('REFUSES a production deployment pointed at a demonstration database', () => {
    // The mirror case, and the one that loses real work rather than
    // corrupting it: real job cards in a database everybody is willing to reset.
    const mismatch = deploymentMismatch({
      EJE_DEPLOYMENT: 'production',
      DATABASE_URL: DEMO_URL,
    });
    expect(mismatch?.reason).toMatch(/disposable/u);
  });

  it('passes each deployment on its own database', () => {
    expect(deploymentMismatch({ EJE_DEPLOYMENT: 'production', DATABASE_URL: PRODUCTION_URL })).toBeNull();
    expect(deploymentMismatch({ EJE_DEPLOYMENT: 'demonstration', DATABASE_URL: DEMO_URL })).toBeNull();
  });

  it('says nothing when nobody declared anything', () => {
    // Undeclared keeps every other guard in force; it must not invent a verdict.
    expect(deploymentMismatch({ DATABASE_URL: PRODUCTION_URL })).toBeNull();
  });
});

describe('the demonstration switcher, against a declared deployment', () => {
  /**
   * THE RUNTIME REFUSAL, which is the one that matters. A production
   * deployment cannot arm the switcher however the rest of its environment
   * reads — including a production deployment running a development build,
   * which is exactly when the old `NODE_ENV` condition handed out one-click
   * sign-in to five published accounts.
   */
  it('is OFF on a declared production deployment, whatever else is set', () => {
    expect(
      isDemoSwitcherEnabled({
        NODE_ENV: 'production',
        EJE_DEPLOYMENT: 'production',
        EJE_DEMO_SWITCHER: 'eje_production',
        DATABASE_URL: PRODUCTION_URL,
      }),
    ).toBe(false);

    // Not even on a development build on the production machine.
    expect(
      isDemoSwitcherEnabled({
        NODE_ENV: 'development',
        EJE_DEPLOYMENT: 'production',
        DATABASE_URL: PRODUCTION_URL,
      }),
    ).toBe(false);
  });

  it('is ON for the demonstration deployment that names its own database', () => {
    expect(
      isDemoSwitcherEnabled({
        NODE_ENV: 'production',
        EJE_DEPLOYMENT: 'demonstration',
        EJE_DEMO_SWITCHER: 'eje_demonstration',
        DATABASE_URL: DEMO_URL,
      }),
    ).toBe(true);
  });

  /** The owner's instruction: the switcher stays available for testing. */
  it('PASSES preflight on the demonstration deployment rather than blocking it', () => {
    const checks = checkDemoSwitcher({
      EJE_DEPLOYMENT: 'demonstration',
      EJE_DEMO_SWITCHER: 'eje_demonstration',
      DATABASE_URL: DEMO_URL,
    });
    expect(verdictFor(checks, 'EJE_DEMO_SWITCHER')).toBe('ok');
    expect(checks[0]?.detail).toMatch(/must not be carried/u);
  });

  it('FAILS preflight when it is set on a declared production deployment', () => {
    const checks = checkDemoSwitcher({
      EJE_DEPLOYMENT: 'production',
      EJE_DEMO_SWITCHER: 'eje_production',
      DATABASE_URL: PRODUCTION_URL,
    });
    expect(verdictFor(checks, 'EJE_DEMO_SWITCHER')).toBe('fail');
  });

  /**
   * AN UNDECLARED DEPLOYMENT KEEPS THE ORIGINAL, STRICTER READING. It is the
   * state the live site is in today, and it must not become more permissive
   * because a new setting exists.
   */
  it('still FAILS an armed switcher on an undeclared deployment', () => {
    const checks = checkDemoSwitcher({
      EJE_DEMO_SWITCHER: 'eje_production',
      DATABASE_URL: PRODUCTION_URL,
    });
    expect(verdictFor(checks, 'EJE_DEMO_SWITCHER')).toBe('fail');
    expect(checks[0]?.detail).toMatch(/EJE_DEPLOYMENT=demonstration/u);
  });

  it('warns a demonstration deployment that has no switcher at all', () => {
    const checks = checkDemoSwitcher({ EJE_DEPLOYMENT: 'demonstration', DATABASE_URL: DEMO_URL });
    expect(verdictFor(checks, 'EJE_DEMO_SWITCHER')).toBe('warn');
  });
});

describe('the demonstration seed, against a declared deployment', () => {
  /**
   * NO OVERRIDE, and that is the point. `EJE_PRODUCTION_DEMO_SEED` names a
   * DATABASE, which is how the staging site's `eje_production` can be filled.
   * This names the DEPLOYMENT, and a deployment holding real customers has no
   * door at all.
   */
  it('REFUSES outright on a declared production deployment', () => {
    expect(() =>
      resolveDemoSeedTarget({
        EJE_DEPLOYMENT: 'production',
        DATABASE_URL: PRODUCTION_URL,
        EJE_PRODUCTION_DEMO_SEED: 'eje_production',
      }),
    ).toThrow(SeedRefused);

    try {
      resolveDemoSeedTarget({
        EJE_DEPLOYMENT: 'production',
        DATABASE_URL: PRODUCTION_URL,
        EJE_PRODUCTION_DEMO_SEED: 'eje_production',
      });
    } catch (error) {
      expect((error as Error).message).toMatch(/no override/u);
    }
  });

  it('still allows the named-database door on a deployment that is not declared production', () => {
    const target = resolveDemoSeedTarget({
      EJE_DEPLOYMENT: 'demonstration',
      NODE_ENV: 'production',
      DATABASE_URL: PRODUCTION_URL,
      EJE_PRODUCTION_DEMO_SEED: 'eje_production',
    });
    expect(target.databaseName).toBe('eje_production');
  });
});
