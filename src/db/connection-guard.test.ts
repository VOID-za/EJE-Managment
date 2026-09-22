import { describe, expect, it } from 'vitest';
import {
  assertDevelopmentDatabase,
  classifyDatabaseUrl,
  ProductionDatabaseRefused,
} from './connection-guard';

/**
 * What stops a development process connecting to EJE's live database.
 *
 * The mistake being guarded against is one line in a `.env` file: a developer
 * copies a connection string to check something, runs `npm run dev`, and is now
 * signed into the real system with the demonstration switcher on screen.
 */
const dev = 'postgres://eje:secret@db.example.com:5432/eje_dev';
const local = 'postgres://postgres@127.0.0.1:5432/eje';
const production = 'postgres://eje:secret@db.example.com:5432/eje_production';
const unnamed = 'postgres://eje:secret@db.example.com:5432/eje';

const refusal = (url: string, env: Record<string, string | undefined> = {}): string => {
  try {
    assertDevelopmentDatabase(url, { NODE_ENV: 'development', ...env });
  } catch (cause) {
    if (cause instanceof ProductionDatabaseRefused) return cause.message;
    throw cause;
  }
  return '';
};

describe('what a connection string appears to be', () => {
  it('reads a development name, wherever it is hosted', () => {
    expect(classifyDatabaseUrl(dev).kind).toBe('development');
    expect(classifyDatabaseUrl(dev).databaseName).toBe('eje_dev');
  });

  it('reads a local host, whatever the database is called', () => {
    expect(classifyDatabaseUrl(local).kind).toBe('local');
  });

  it('reads a production name', () => {
    expect(classifyDatabaseUrl(production).kind).toBe('production');
    expect(classifyDatabaseUrl('postgres://x@db.example.com/eje_live').kind).toBe('production');
    expect(classifyDatabaseUrl('postgres://x@prod-db.example.com/eje').kind).toBe('production');
  });

  it('calls a remote database with an unrevealing name UNKNOWN, not safe', () => {
    expect(classifyDatabaseUrl(unnamed).kind).toBe('unknown');
  });

  it('treats production wearing a development word as production', () => {
    // The more dangerous reading wins. `eje_prod_test` is not a test database.
    expect(classifyDatabaseUrl('postgres://x@db.example.com/eje_prod_test').kind).toBe(
      'production',
    );
  });

  it('calls an unreadable URL unknown rather than throwing', () => {
    expect(classifyDatabaseUrl('not a url').kind).toBe('unknown');
  });
});

describe('a development process', () => {
  it('may connect to a development database', () => {
    expect(refusal(dev)).toBe('');
  });

  it('may connect to a local one', () => {
    expect(refusal(local)).toBe('');
  });

  it('is REFUSED a database that names itself production', () => {
    const message = refusal(production);
    expect(message).toContain('names itself as production');
    expect(message).toContain('eje_production');
  });

  it('is REFUSED a remote database whose name says nothing', () => {
    // The case that matters most: EJE's real database will not necessarily
    // have "production" in its name, and nothing in this repository
    // establishes what it will be called. Refusing to guess is the point.
    expect(refusal(unnamed)).toContain('will not assume it is safe');
  });

  it('is REFUSED a connection string it cannot read', () => {
    expect(refusal('postgres://')).not.toBe('');
  });

  it('is told how to proceed, and how to override, without being told a credential', () => {
    const message = refusal(production);
    expect(message).toContain('EJE_DATABASE_ALLOW=i-understand');
    expect(message).toContain('docs/database.md');
    // The refusal is read in a terminal and pasted into chat. It must not carry
    // the password out of the connection string with it.
    expect(message).not.toContain('secret');
  });
});

describe('production itself', () => {
  it('is never second-guessed', () => {
    // The deployment has said it is production. It is not the job of a safety
    // check to argue with production about its own database.
    expect(() =>
      assertDevelopmentDatabase(production, { NODE_ENV: 'production' }),
    ).not.toThrow();
    expect(() => assertDevelopmentDatabase(unnamed, { NODE_ENV: 'production' })).not.toThrow();
  });
});

describe('taking responsibility deliberately', () => {
  it('lets an explicit override through', () => {
    expect(refusal(production, { EJE_DATABASE_ALLOW: 'i-understand' })).toBe('');
    expect(refusal(unnamed, { EJE_DATABASE_ALLOW: 'I-Understand' })).toBe('');
  });

  it('is not satisfied by a vague one', () => {
    for (const vague of ['true', 'yes', '1', 'please', '']) {
      expect(refusal(production, { EJE_DATABASE_ALLOW: vague })).not.toBe('');
    }
  });
});

/**
 * The harness the PostgreSQL integration tests run through sets `DATABASE_URL`
 * to the test database. If the guard refused that, `npm run db:test` would stop
 * working — so it is asserted here rather than discovered later.
 */
describe('the PostgreSQL test harness', () => {
  it('is not refused', () => {
    expect(refusal('postgres://postgres@127.0.0.1:5433/eje_test', { NODE_ENV: 'test' })).toBe('');
    expect(refusal('postgres://eje:secret@db.example.com/eje_test', { NODE_ENV: 'test' })).toBe('');
  });
});
