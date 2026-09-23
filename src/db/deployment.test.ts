import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { databaseUrlFromEnv } from './client';
import {
  assertProductionMigrationIntent,
  ProductionDatabaseRefused,
  ProductionMigrationRefused,
} from './connection-guard';
import { loadEnvFiles } from './seed/env';
import {
  resolveDemoSeedTarget,
  resolveResetTarget,
  resolveSeedTarget,
  SeedRefused,
} from './seed/guards';

/**
 * THE VPS, WRITTEN DOWN.
 *
 * `docs/vps-deployment.md` describes a machine this repository's test suite has
 * never run on: no `.env.local`, `DATABASE_URL` and `NODE_ENV` arriving from
 * `/etc/eje/eje.env` through systemd or a sourced shell, and a database called
 * `eje_production` that every safety check in `src/db` is built to refuse.
 *
 * Every one of those is a way the deployment can fail at the worst possible
 * moment — half-migrated, or seeded with fictional customers. So the deployment
 * is asserted here, from the same functions the commands actually call, rather
 * than discovered on the VPS with a terminal open.
 */
const PRODUCTION = 'postgresql://eje_app:a-real-password@localhost:5432/eje_production';
const DEVELOPMENT = 'postgresql://eje_dev:pw@localhost:5432/eje_dev';

const KEYS = ['DATABASE_URL', 'NODE_ENV', 'EJE_PRODUCTION_MIGRATION', 'EJE_DATABASE_ALLOW'] as const;

/*
 * `process.env.NODE_ENV` is typed readonly, and these tests are about what
 * happens when a deployment sets it. Widened once, here, rather than cast at
 * each of the five places that write it.
 */
const env = process.env as Record<string, string | undefined>;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, env[key]]));
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete env[key];
    else env[key] = saved[key];
  }
});

/** A directory with no `.env.local` and no `.env` — which is what the VPS is. */
const emptyDirectory = (): string => mkdtempSync(join(tmpdir(), 'eje-deployment-'));

describe('the environment on the VPS, where there is no .env.local', () => {
  it('reads no files, and says so by returning none', () => {
    expect(loadEnvFiles(emptyDirectory())).toEqual([]);
  });

  it('leaves a DATABASE_URL supplied by the environment usable', () => {
    // The exact sequence `src/db/migrate.ts` runs: load the files, then read
    // the variable. On the VPS the first step finds nothing and the second must
    // still see what systemd or `set -a; . /etc/eje/eje.env` put there.
    env.NODE_ENV = 'production';
    env.DATABASE_URL = PRODUCTION;

    loadEnvFiles(emptyDirectory());

    expect(databaseUrlFromEnv()).toBe(PRODUCTION);
  });

  it('does not let a stale .env.local override the environment either', () => {
    // The same guarantee on a DEVELOPER's machine, which is the case that keeps
    // `DATABASE_URL=… npm run db:migrate` meaning what it says.
    const path = emptyDirectory();
    writeFileSync(join(path, '.env.local'), `DATABASE_URL=${DEVELOPMENT}\n`);

    env.DATABASE_URL = 'postgresql://eje_dev:pw@localhost:5432/eje_other_dev';
    loadEnvFiles(path);

    expect(env.DATABASE_URL).toBe('postgresql://eje_dev:pw@localhost:5432/eje_other_dev');
  });
});

describe('migrating the production database', () => {
  const refusal = (url: string, env: Record<string, string | undefined>): string => {
    try {
      assertProductionMigrationIntent(url, env);
    } catch (cause) {
      if (cause instanceof ProductionMigrationRefused) return cause.message;
      throw cause;
    }
    return '';
  };

  it('is allowed ONLY when the database is named out loud', () => {
    expect(
      refusal(PRODUCTION, {
        NODE_ENV: 'production',
        EJE_PRODUCTION_MIGRATION: 'eje_production',
      }),
    ).toBe('');
  });

  it('is refused when nobody named it, and is told the exact command', () => {
    const message = refusal(PRODUCTION, { NODE_ENV: 'production' });
    expect(message).toContain('EJE_PRODUCTION_MIGRATION=eje_production npm run db:migrate');
    // The refusal is pasted into a deployment log. It must not carry the
    // password out of the connection string with it.
    expect(message).not.toContain('a-real-password');
  });

  it('is refused when the wrong database is named', () => {
    // Set once in a profile and forgotten is exactly what this shape prevents.
    expect(refusal(PRODUCTION, { NODE_ENV: 'production', EJE_PRODUCTION_MIGRATION: 'eje_dev' })).not.toBe('');
  });

  it('is refused a vague intent', () => {
    for (const vague of ['true', 'yes', '1', 'i-understand', '']) {
      expect(refusal(PRODUCTION, { NODE_ENV: 'production', EJE_PRODUCTION_MIGRATION: vague })).not.toBe('');
    }
  });

  it('is refused outright from a process that is not production', () => {
    const message = refusal(PRODUCTION, { NODE_ENV: 'development', EJE_PRODUCTION_MIGRATION: 'eje_production' });
    expect(message).toContain('not running as production');
  });

  it('holds even where the connection guard has been overridden', () => {
    // `EJE_DATABASE_ALLOW=i-understand` gets a developer past
    // `assertDevelopmentDatabase`. It must not also hand them the live schema.
    expect(() =>
      assertProductionMigrationIntent(PRODUCTION, {
        NODE_ENV: 'development',
        ...({ EJE_DATABASE_ALLOW: 'i-understand' } as Record<string, string>),
      }),
    ).toThrow(ProductionMigrationRefused);
  });

  it('says nothing at all about a development database', () => {
    // Not a second opinion about the cases the connection guard already owns.
    expect(refusal(DEVELOPMENT, {})).toBe('');
    expect(refusal('postgresql://eje@db.internal:5432/eje', {})).toBe('');
  });
});

describe('a normal development command', () => {
  it('cannot reach eje_production, whatever it was asked to do', () => {
    env.NODE_ENV = 'development';
    env.DATABASE_URL = PRODUCTION;

    expect(() => databaseUrlFromEnv()).toThrow(ProductionDatabaseRefused);
  });

  it('cannot seed it', () => {
    expect(() => resolveSeedTarget({ DATABASE_URL: PRODUCTION })).toThrow(SeedRefused);
  });

  it('cannot seed it even by taking responsibility — there is no override', () => {
    expect(() =>
      resolveSeedTarget({ DATABASE_URL: PRODUCTION, EJE_SEED_ALLOW: 'i-understand' }),
    ).toThrow(/There is no override/u);
  });

  it('cannot reset it, named or not', () => {
    expect(() => resolveResetTarget({ DATABASE_URL: PRODUCTION })).toThrow(
      /no override for this command/u,
    );
    expect(() =>
      resolveResetTarget({ DATABASE_URL: PRODUCTION, EJE_RESET_CONFIRM: 'eje_production' }),
    ).toThrow(SeedRefused);
  });

  it('cannot seed or reset under NODE_ENV=production either', () => {
    expect(() => resolveSeedTarget({ NODE_ENV: 'production', DATABASE_URL: DEVELOPMENT })).toThrow(
      /NODE_ENV is "production"/u,
    );
    expect(() => resolveResetTarget({ NODE_ENV: 'production', DATABASE_URL: DEVELOPMENT })).toThrow(
      /NODE_ENV is "production"/u,
    );
  });

  it('still has eje_dev, which is the point of all of the above', () => {
    env.NODE_ENV = 'development';
    env.DATABASE_URL = DEVELOPMENT;

    expect(databaseUrlFromEnv()).toBe(DEVELOPMENT);
    expect(resolveSeedTarget({ DATABASE_URL: DEVELOPMENT }).databaseName).toBe('eje_dev');
    expect(
      resolveResetTarget({ DATABASE_URL: DEVELOPMENT, EJE_RESET_CONFIRM: 'eje_dev' }).databaseName,
    ).toBe('eje_dev');
  });
});

describe('filling the TEST deployment with demonstration data', () => {
  /*
   * eje.syncza.co.za is staging, its database is called `eje_production`, and
   * it is useless empty. `npm run db:seed:demo` is how it is filled — and the
   * contract is that nothing about it makes `npm run db:seed` any weaker.
   */
  it('needs the database named, and says so with the line to type', () => {
    expect(() => resolveDemoSeedTarget({ DATABASE_URL: PRODUCTION })).toThrow(
      /EJE_PRODUCTION_DEMO_SEED=eje_production npm run db:seed:demo/u,
    );
  });

  it('proceeds when it is named', () => {
    expect(
      resolveDemoSeedTarget({
        DATABASE_URL: PRODUCTION,
        EJE_PRODUCTION_DEMO_SEED: 'eje_production',
      }).databaseName,
    ).toBe('eje_production');
  });

  it('still needs it under the VPS environment, which sets NODE_ENV=production', () => {
    expect(() =>
      resolveDemoSeedTarget({ NODE_ENV: 'production', DATABASE_URL: PRODUCTION }),
    ).toThrow(SeedRefused);
    expect(
      resolveDemoSeedTarget({
        NODE_ENV: 'production',
        DATABASE_URL: PRODUCTION,
        EJE_PRODUCTION_DEMO_SEED: 'eje_production',
      }).host,
    ).toBe('localhost');
  });

  it('leaves db:seed, db:reset and db:migrate exactly as they were', () => {
    const acknowledged = {
      DATABASE_URL: PRODUCTION,
      EJE_PRODUCTION_DEMO_SEED: 'eje_production',
    };
    // The demo acknowledgement opens ONE door. It is not a key to the building.
    expect(() => resolveSeedTarget(acknowledged)).toThrow(SeedRefused);
    expect(() => resolveResetTarget(acknowledged)).toThrow(SeedRefused);
    expect(() =>
      assertProductionMigrationIntent(PRODUCTION, {
        NODE_ENV: 'production',
        ...(acknowledged as Record<string, string>),
      }),
    ).toThrow(ProductionMigrationRefused);
  });

  it('is the ordinary seed against eje_dev, with nothing extra to say', () => {
    expect(resolveDemoSeedTarget({ DATABASE_URL: DEVELOPMENT })).toEqual(
      resolveSeedTarget({ DATABASE_URL: DEVELOPMENT }),
    );
  });
});

describe('a production database on loopback', () => {
  it('is production, not "local"', () => {
    /*
     * THE ONE THAT WOULD HAVE BITTEN. On the VPS the production database IS on
     * localhost — the whole architecture is that there is no tunnel. If the
     * host were read before the name, `eje_production` would classify as a
     * local development database and every check above would wave it through.
     */
    env.NODE_ENV = 'development';
    env.DATABASE_URL = PRODUCTION;
    expect(() => databaseUrlFromEnv()).toThrow(/names itself as production/u);

    expect(() => resolveSeedTarget({ DATABASE_URL: PRODUCTION })).toThrow(
      /names itself as production/u,
    );
    expect(() =>
      assertProductionMigrationIntent(PRODUCTION, { NODE_ENV: 'production' }),
    ).toThrow(ProductionMigrationRefused);
  });
});
