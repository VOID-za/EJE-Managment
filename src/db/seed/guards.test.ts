import { describe, expect, it } from 'vitest';
import { resolveDemoSeedTarget, resolveSeedTarget, SeedRefused } from './guards';

const refuses = (env: Record<string, string | undefined>, because: RegExp): void => {
  expect(() => resolveSeedTarget(env)).toThrow(SeedRefused);
  expect(() => resolveSeedTarget(env)).toThrow(because);
};

describe('what the development seed refuses to run against', () => {
  it('refuses production outright, with no override', () => {
    refuses(
      {
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://eje@localhost:5432/eje_dev',
        EJE_SEED_ALLOW: 'i-understand',
      },
      /NODE_ENV is "production"/u,
    );
  });

  it('refuses a database that names itself production', () => {
    refuses(
      { DATABASE_URL: 'postgres://eje@db.example.com:5432/eje_production' },
      /names itself as production/u,
    );
  });

  it('refuses a production name even to somebody claiming to understand', () => {
    // There is no EJE_SEED_ALLOW for this case any more. `eje_production` is a
    // real database on a real VPS now, and the seed writes accounts whose
    // password is published in docs/. Rename the development copy instead.
    refuses(
      {
        DATABASE_URL: 'postgres://eje@localhost:5432/eje_production',
        EJE_SEED_ALLOW: 'i-understand',
      },
      /There is no override/u,
    );
  });

  it('refuses a host that names itself production', () => {
    refuses(
      { DATABASE_URL: 'postgres://eje@prod-db.example.com:5432/eje' },
      /names itself as production/u,
    );
  });

  it('refuses an unfamiliar remote host rather than guessing', () => {
    refuses(
      { DATABASE_URL: 'postgres://eje@db.example.com:5432/eje' },
      /neither a local host nor named/u,
    );
  });

  it('refuses when there is no DATABASE_URL at all', () => {
    refuses({}, /DATABASE_URL is not set/u);
  });

  it('accepts a local development database', () => {
    expect(resolveSeedTarget({ DATABASE_URL: 'postgres://eje@localhost:5432/eje_dev' })).toEqual({
      url: 'postgres://eje@localhost:5432/eje_dev',
      databaseName: 'eje_dev',
      host: 'localhost',
    });
  });

  it('accepts a remote database that says it is development', () => {
    expect(
      resolveSeedTarget({ DATABASE_URL: 'postgres://eje@db.example.com:5432/eje_demo' })
        .databaseName,
    ).toBe('eje_demo');
  });

  it('lets somebody take responsibility for an unfamiliar host, deliberately', () => {
    expect(
      resolveSeedTarget({
        DATABASE_URL: 'postgres://eje@db.example.com:5432/eje',
        EJE_SEED_ALLOW: 'i-understand',
      }).host,
    ).toBe('db.example.com');
  });

  it('is not satisfied by a vague override', () => {
    refuses(
      { DATABASE_URL: 'postgres://eje@db.example.com:5432/eje', EJE_SEED_ALLOW: 'yes' },
      /neither a local host nor named/u,
    );
  });
});

/**
 * `npm run db:seed:demo`.
 *
 * The staging deployment's database is called `eje_production`, and the whole
 * design question is how it gets demonstration data without the ordinary seed
 * ever learning how to write to a database by that name.
 */
describe('the demo seed, which may fill a named test deployment', () => {
  const PRODUCTION = 'postgresql://eje_app:pw@localhost:5432/eje_production';
  const DEVELOPMENT = 'postgres://eje@localhost:5432/eje_dev';

  const demoRefuses = (env: Record<string, string | undefined>, because: RegExp): void => {
    expect(() => resolveDemoSeedTarget(env)).toThrow(SeedRefused);
    expect(() => resolveDemoSeedTarget(env)).toThrow(because);
  };

  it('refuses production when nobody named it, and prints the exact line', () => {
    demoRefuses(
      { DATABASE_URL: PRODUCTION },
      /EJE_PRODUCTION_DEMO_SEED=eje_production npm run db:seed:demo/u,
    );
  });

  it('refuses the wrong name', () => {
    demoRefuses(
      { DATABASE_URL: PRODUCTION, EJE_PRODUCTION_DEMO_SEED: 'eje_dev' },
      /names itself as production/u,
    );
  });

  it('refuses a word that merely means yes', () => {
    for (const vague of ['true', 'yes', '1', 'i-understand', '']) {
      demoRefuses(
        { DATABASE_URL: PRODUCTION, EJE_PRODUCTION_DEMO_SEED: vague },
        /names the database out loud/u,
      );
    }
  });

  it('is not opened by the OTHER acknowledgements', () => {
    // Each gate is cut for one lock. The migration's key does not fit this door
    // and neither does the ordinary seed's override.
    demoRefuses(
      {
        DATABASE_URL: PRODUCTION,
        EJE_PRODUCTION_MIGRATION: 'eje_production',
        EJE_SEED_ALLOW: 'i-understand',
        EJE_DATABASE_ALLOW: 'i-understand',
      } as Record<string, string | undefined>,
      /EJE_PRODUCTION_DEMO_SEED=eje_production/u,
    );
  });

  it('accepts the database named exactly', () => {
    expect(
      resolveDemoSeedTarget({
        DATABASE_URL: PRODUCTION,
        EJE_PRODUCTION_DEMO_SEED: 'eje_production',
      }),
    ).toEqual({ url: PRODUCTION, databaseName: 'eje_production', host: 'localhost' });
  });

  it('also asks to be named when NODE_ENV says production, whatever the database is called', () => {
    // The VPS environment file carries NODE_ENV=production. Sourcing it must
    // not be what decides this.
    demoRefuses(
      { NODE_ENV: 'production', DATABASE_URL: DEVELOPMENT },
      /EJE_PRODUCTION_DEMO_SEED=eje_dev npm run db:seed:demo/u,
    );
    expect(
      resolveDemoSeedTarget({
        NODE_ENV: 'production',
        DATABASE_URL: DEVELOPMENT,
        EJE_PRODUCTION_DEMO_SEED: 'eje_dev',
      }).databaseName,
    ).toBe('eje_dev');
  });

  it('refuses when there is no DATABASE_URL at all', () => {
    demoRefuses({}, /DATABASE_URL is not set/u);
  });

  it('is the ORDINARY seed everywhere that is not production', () => {
    // Delegated, not restated: a development database behaves identically under
    // both commands, and an unfamiliar remote host is refused by both.
    expect(resolveDemoSeedTarget({ DATABASE_URL: DEVELOPMENT })).toEqual(
      resolveSeedTarget({ DATABASE_URL: DEVELOPMENT }),
    );
    demoRefuses(
      { DATABASE_URL: 'postgres://eje@db.example.com:5432/eje' },
      /neither a local host nor named/u,
    );
  });

  it('does not teach the ordinary seed anything', () => {
    // The point of the whole design: db:seed still refuses, acknowledgement or
    // not, because the acknowledgement is not its to read.
    refuses(
      { DATABASE_URL: PRODUCTION, EJE_PRODUCTION_DEMO_SEED: 'eje_production' },
      /There is no override/u,
    );
  });
});
