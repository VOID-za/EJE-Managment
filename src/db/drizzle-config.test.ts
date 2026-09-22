import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * What stops `npm run db:migrate` migrating the wrong database, or nothing.
 *
 * THE BUG THIS PINS. `.env.local` is where a developer is told to put
 * `DATABASE_URL`, and it is read by `next dev` and by nothing else.
 * `drizzle-kit` does not read it — so with a fallback of
 * `postgres://localhost:5432/eje_dev` in the config, `db:migrate` went looking
 * for a database on the developer's own machine, reported nothing unusual, and
 * left the database they had actually configured untouched.
 *
 * TWO PROPERTIES FIX IT, and both are easy to undo by accident:
 *
 *  1. The config LOADS THE ENV FILES, or the variable is never seen at all.
 *  2. It reads the connection string LAZILY. `drizzle-kit` evaluates the config
 *     module for every command, and only `migrate`, `push` and `studio`
 *     connect — `generate` and `check` never read the credential. Reading it
 *     eagerly would make a missing `DATABASE_URL` break the generation of a
 *     migration, which needs no database at all.
 *
 * Undoing (2) looks like a simplification and passes on the machine of anybody
 * who has a database configured, which is exactly why it is asserted here
 * rather than left to be discovered by whoever has not.
 */

const { loadEnvFiles } = vi.hoisted(() => ({
  loadEnvFiles: vi.fn((): readonly string[] => []),
}));

/*
 * The loader is mocked out so this test controls the environment rather than
 * inheriting whatever `.env.local` happens to be on the machine running it.
 * That it is CALLED is asserted below; what it reads is not this test's
 * business, and `src/db/seed/env` has its own.
 */
vi.mock('./seed/env', () => ({ loadEnvFiles }));

interface Credentials {
  readonly dbCredentials: { readonly url: string };
}

const importConfig = async (): Promise<Credentials> =>
  (await import('../../drizzle.config')).default as unknown as Credentials;

const original = process.env.DATABASE_URL;

afterEach(() => {
  if (original === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = original;
});

describe('the drizzle-kit configuration', () => {
  it('reads the env files, and does not touch the connection string to do it', async () => {
    delete process.env.DATABASE_URL;

    // Loading the module must not throw. This is the whole of property (2):
    // `drizzle-kit generate` gets this far and no further.
    const config = await importConfig();

    expect(loadEnvFiles).toHaveBeenCalled();
    // And a command that DOES connect is refused, by name, rather than being
    // quietly handed a database on this machine.
    expect(() => config.dbCredentials.url).toThrow(/DATABASE_URL is not set/u);
  });

  it('applies the connection guard, so a migration cannot reach production', async () => {
    const config = await importConfig();
    process.env.DATABASE_URL = 'postgres://eje:secret@db.example.com:5432/eje_production';

    expect(() => config.dbCredentials.url).toThrow(/names itself as production/u);
  });

  it('refuses a remote database whose name says nothing', async () => {
    const config = await importConfig();
    process.env.DATABASE_URL = 'postgres://eje:secret@db.example.com:5432/eje';

    expect(() => config.dbCredentials.url).toThrow(/will not assume it is safe/u);
  });

  it('hands over a development database', async () => {
    // The tunnelled VPS database arrives looking exactly like this: local host,
    // because that is genuinely what the tunnel makes it.
    const url = 'postgres://eje_dev:secret@localhost:5432/eje_dev';
    const config = await importConfig();
    process.env.DATABASE_URL = url;

    expect(config.dbCredentials.url).toBe(url);
  });

  it('reads the variable afresh every time, rather than capturing it once', async () => {
    // A getter that memoised would be a fallback wearing a different hat: the
    // first command in a process would decide the target for the rest of it.
    const config = await importConfig();

    process.env.DATABASE_URL = 'postgres://eje_dev:secret@localhost:5432/eje_dev';
    expect(config.dbCredentials.url).toContain('eje_dev');

    process.env.DATABASE_URL = 'postgres://other:secret@localhost:5432/eje_local';
    expect(config.dbCredentials.url).toContain('eje_local');
  });
});
