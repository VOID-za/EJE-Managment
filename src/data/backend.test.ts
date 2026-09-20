import { describe, expect, it } from 'vitest';
import { selectPersistenceBackend } from './backend';

/**
 * Which persistence the application runs against.
 *
 * The property under test is negative and it is the important one: NOTHING A
 * BROWSER CAN SET decides this. The demo chooses its data source from
 * localStorage because it is a demonstration; production must be able to rule
 * that out with certainty, so the choice is made once, from the server's
 * environment, in one module.
 */
describe('choosing the persistence backend', () => {
  it('uses PostgreSQL when a database is configured', () => {
    expect(selectPersistenceBackend({ DATABASE_URL: 'postgres://localhost/eje' })).toBe(
      'postgres',
    );
  });

  it('falls back to the demonstration store when there is no database', () => {
    expect(selectPersistenceBackend({})).toBe('demo');
    expect(selectPersistenceBackend({ DATABASE_URL: '' })).toBe('demo');
    expect(selectPersistenceBackend({ DATABASE_URL: '   ' })).toBe('demo');
  });

  it('lets a sales laptop force the demonstration store over a real database', () => {
    expect(
      selectPersistenceBackend({
        DATABASE_URL: 'postgres://localhost/eje',
        EJE_PERSISTENCE: 'demo',
      }),
    ).toBe('demo');
  });

  it('lets PostgreSQL be demanded explicitly, so a missing URL fails loudly', () => {
    // `getDatabase` then raises a readable error about DATABASE_URL rather than
    // quietly serving demonstration data to a business.
    expect(selectPersistenceBackend({ EJE_PERSISTENCE: 'postgres' })).toBe('postgres');
  });

  it('ignores a value it does not recognise rather than guessing', () => {
    expect(
      selectPersistenceBackend({ EJE_PERSISTENCE: 'sqlite', DATABASE_URL: 'postgres://x/y' }),
    ).toBe('postgres');
    expect(selectPersistenceBackend({ EJE_PERSISTENCE: 'sqlite' })).toBe('demo');
  });
});
