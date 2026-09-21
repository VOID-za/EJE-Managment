import { describe, expect, it } from 'vitest';
import { resolveSeedTarget, SeedRefused } from './guards';

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
