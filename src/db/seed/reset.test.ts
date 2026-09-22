import { describe, expect, it } from 'vitest';
import { resolveResetTarget, SeedRefused } from './guards';

/**
 * The only destructive command in this repository that a person runs by hand.
 *
 * `db:reset` empties a database and rebuilds it. Everything below is a case
 * where it must refuse, and the one case where it proceeds — because the cost
 * of getting this wrong is somebody's data, and "be careful" is not a control.
 */
const refusal = (env: Record<string, string | undefined>): string => {
  try {
    resolveResetTarget(env);
  } catch (cause) {
    if (cause instanceof SeedRefused) return cause.message;
    throw cause;
  }
  return '';
};

const devUrl = 'postgres://eje:secret@db.example.com:5432/eje_dev';

describe('what db:reset refuses to empty', () => {
  it('refuses production outright, with no override', () => {
    const message = refusal({
      NODE_ENV: 'production',
      DATABASE_URL: devUrl,
      EJE_RESET_CONFIRM: 'eje_dev',
    });
    expect(message).toContain('NODE_ENV is "production"');
    expect(message).toContain('no override');
  });

  it('refuses a database that names itself production', () => {
    const message = refusal({
      DATABASE_URL: 'postgres://eje:secret@db.example.com/eje_production',
      EJE_RESET_CONFIRM: 'eje_production',
    });
    // Naming it correctly is NOT enough. There is no path to emptying a
    // database that says it is production.
    expect(message).toContain('names itself as production');
  });

  it('refuses a remote database whose name says nothing', () => {
    const message = refusal({
      DATABASE_URL: 'postgres://eje:secret@db.example.com/eje',
      EJE_RESET_CONFIRM: 'eje',
    });
    expect(message).toContain('will not assume that is safe');
  });

  it('refuses a TEST database, which db:test owns', () => {
    // Two things tearing down the same database on their own schedules is a
    // race. Running the tests already resets it, so there is nothing to do here.
    const message = refusal({
      DATABASE_URL: 'postgres://postgres@127.0.0.1:5433/eje_test',
      EJE_RESET_CONFIRM: 'eje_test',
    });
    expect(message).toContain('is a TEST database');
    expect(message).toContain('db:test');
  });

  it('refuses when there is no DATABASE_URL at all', () => {
    expect(refusal({})).toContain('DATABASE_URL is not set');
  });

  it('refuses without the confirmation, and says exactly what to type', () => {
    const message = refusal({ DATABASE_URL: devUrl });
    expect(message).toContain('PERMANENTLY DELETE');
    expect(message).toContain('EJE_RESET_CONFIRM=eje_dev');
  });

  it('is not satisfied by a confirmation naming a different database', () => {
    // The whole failure mode is not knowing what you are pointed at, so the
    // confirmation has to prove you do.
    expect(refusal({ DATABASE_URL: devUrl, EJE_RESET_CONFIRM: 'eje_other' })).toContain(
      'PERMANENTLY DELETE',
    );
  });

  it('is not satisfied by a vague confirmation', () => {
    for (const vague of ['yes', 'true', '1', 'i-understand']) {
      expect(refusal({ DATABASE_URL: devUrl, EJE_RESET_CONFIRM: vague })).not.toBe('');
    }
  });

  it('never repeats the password back in a refusal', () => {
    // These messages are read in a terminal and pasted into chat.
    for (const message of [
      refusal({ DATABASE_URL: devUrl }),
      refusal({ DATABASE_URL: devUrl, EJE_RESET_CONFIRM: 'wrong' }),
    ]) {
      expect(message).not.toContain('secret');
    }
  });
});

describe('what it will empty', () => {
  it('accepts a development database, named correctly', () => {
    const target = resolveResetTarget({ DATABASE_URL: devUrl, EJE_RESET_CONFIRM: 'eje_dev' });
    expect(target.databaseName).toBe('eje_dev');
    expect(target.host).toBe('db.example.com');
  });

  it('accepts a local database, named correctly', () => {
    const target = resolveResetTarget({
      DATABASE_URL: 'postgres://postgres@127.0.0.1:5432/eje_local_work',
      EJE_RESET_CONFIRM: 'eje_local_work',
    });
    expect(target.databaseName).toBe('eje_local_work');
  });
});
