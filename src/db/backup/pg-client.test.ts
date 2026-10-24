import { existsSync, readFileSync, statSync } from 'node:fs';
import type { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  childEnvironment,
  connectionFrom,
  looksLikeCredential,
  passwordFileLine,
  runPostgresTool,
} from './pg-client';
import { BackupRefused } from './plan';

/**
 * NO PASSWORD ON A COMMAND LINE. BACKUP-2, security audit of 24 October 2026.
 *
 * The backup tools used to receive `DATABASE_URL` as an argument, readable by
 * every local account through `ps`. These tests pin the replacement: what the
 * child process is actually handed — its arguments, its environment and the
 * password file while it exists — captured by a fake spawn, so the property
 * is proved here on a machine with no PostgreSQL. The real tools against a real
 * server are exercised by `backup.db.test.ts` in CI.
 */

const URL_WITH_SECRET = 'postgresql://eje_production:s3cr%3At\\pw@127.0.0.1:5432/eje_production';
const SECRET = 's3cr:t\\pw';

interface Captured {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly passwordFile: string | undefined;
  readonly passwordFileText: string | null;
  readonly passwordFileMode: number | null;
}

/** A spawn that records what it was given, and reads the password file while it exists. */
const capturingSpawn = (captured: Captured[], status = 0) =>
  ((command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => {
    const passwordFile = options.env.PGPASSFILE;
    captured.push({
      command,
      args,
      env: options.env,
      passwordFile,
      passwordFileText: passwordFile !== undefined ? readFileSync(passwordFile, 'utf8') : null,
      passwordFileMode: passwordFile !== undefined ? statSync(passwordFile).mode & 0o777 : null,
    });
    return { status, stdout: 'out\n', stderr: ' err \n', pid: 1, output: [], signal: null };
  }) as unknown as typeof spawnSync;

describe('connectionFrom', () => {
  it('takes the URL apart into PG* variables, decoding what the URL encoded', () => {
    const connection = connectionFrom(URL_WITH_SECRET);
    expect(connection.environment).toEqual({
      PGHOST: '127.0.0.1',
      PGPORT: '5432',
      PGUSER: 'eje_production',
      PGDATABASE: 'eje_production',
    });
    expect(connection.user).toBe('eje_production');
    expect(connection.password).toBe(SECRET);
  });

  it('keeps the password OUT of the environment it returns', () => {
    const { environment } = connectionFrom(URL_WITH_SECRET);
    expect(JSON.stringify(environment)).not.toContain('s3cr');
  });

  it('carries the TLS and socket parameters libpq understands', () => {
    const { environment } = connectionFrom(
      'postgres://u:p@db.internal/eje?sslmode=verify-full&sslrootcert=/etc/ssl/ca.pem&application_name=eje-backup',
    );
    expect(environment.PGSSLMODE).toBe('verify-full');
    expect(environment.PGSSLROOTCERT).toBe('/etc/ssl/ca.pem');
    expect(environment.PGAPPNAME).toBe('eje-backup');
    expect(environment.PGPORT).toBeUndefined();
  });

  it('strips the brackets from an IPv6 host', () => {
    expect(connectionFrom('postgresql://u:p@[::1]:5432/db').environment.PGHOST).toBe('::1');
  });

  it('REFUSES a parameter it cannot pass on, rather than connecting without it', () => {
    expect(() => connectionFrom('postgres://u:p@h/db?ssl=true')).toThrow(BackupRefused);
  });

  it('REFUSES what is not a PostgreSQL URL', () => {
    expect(() => connectionFrom('mysql://u:p@h/db')).toThrow(BackupRefused);
    expect(() => connectionFrom('not a url')).toThrow(BackupRefused);
  });
});

describe('passwordFileLine', () => {
  it('matches every host, port and database, and escapes : and \\', () => {
    expect(passwordFileLine('eje', SECRET)).toBe('*:*:*:eje:s3cr\\:t\\\\pw\n');
  });
});

describe('looksLikeCredential', () => {
  it('recognises the URL and conninfo forms the old code passed', () => {
    expect(looksLikeCredential('postgresql://u:p@h/db')).toBe(true);
    expect(looksLikeCredential('POSTGRES://u@h/db')).toBe(true);
    expect(looksLikeCredential('host=h password=p dbname=d')).toBe(true);
  });

  it('does not mistake ordinary arguments for one', () => {
    for (const argument of ['-At', '--dbname', 'eje_restore_test_x', '/var/backups/eje/database.dump', 'SELECT 1']) {
      expect(looksLikeCredential(argument)).toBe(false);
    }
  });
});

describe('childEnvironment', () => {
  it('removes inherited variables that could redirect the connection', () => {
    const environment = childEnvironment(
      {
        NODE_ENV: 'test',
        PATH: '/usr/bin',
        DATABASE_URL: URL_WITH_SECRET,
        PGPASSWORD: 'stale',
        PGSERVICE: 'elsewhere',
        PGHOST: 'other-host',
      },
      connectionFrom(URL_WITH_SECRET),
      '/tmp/x/pgpass',
    );
    expect(environment.PATH).toBe('/usr/bin');
    expect(environment.DATABASE_URL).toBeUndefined();
    expect(environment.PGPASSWORD).toBeUndefined();
    expect(environment.PGSERVICE).toBeUndefined();
    expect(environment.PGHOST).toBe('127.0.0.1');
    expect(environment.PGPASSFILE).toBe('/tmp/x/pgpass');
  });
});

describe('runPostgresTool', () => {
  it('puts NOTHING secret on the command line', () => {
    const captured: Captured[] = [];
    runPostgresTool('pg_dump', URL_WITH_SECRET, ['-Fc', '-f', '/tmp/d.dump'], {}, capturingSpawn(captured));
    const [call] = captured;
    expect(call?.command).toBe('pg_dump');
    expect(call?.args).toEqual(['--no-password', '-Fc', '-f', '/tmp/d.dump']);
    for (const argument of call?.args ?? []) {
      expect(argument).not.toContain('s3cr');
      expect(argument).not.toMatch(/postgres(ql)?:\/\//u);
    }
  });

  it('hands the password over in a password file, and nowhere in the environment', () => {
    const captured: Captured[] = [];
    runPostgresTool('psql', URL_WITH_SECRET, ['-At', '-c', 'select 1'], {}, capturingSpawn(captured));
    const [call] = captured;
    expect(call?.passwordFileText).toBe(passwordFileLine('eje_production', SECRET));
    expect(call?.env.PGPASSWORD).toBeUndefined();
    expect(call?.env.DATABASE_URL).toBeUndefined();
    const environmentWithoutFile = { ...call?.env, PGPASSFILE: undefined };
    expect(JSON.stringify(environmentWithoutFile)).not.toContain('s3cr');
    if (process.platform !== 'win32') {
      // libpq ignores a password file group or others can read; the mode is the contract.
      expect(call?.passwordFileMode).toBe(0o600);
    }
  });

  it('removes the password file as soon as the tool has finished, success or not', () => {
    for (const status of [0, 1]) {
      const captured: Captured[] = [];
      runPostgresTool('psql', URL_WITH_SECRET, ['-c', 'select 1'], {}, capturingSpawn(captured, status));
      const file = captured[0]?.passwordFile ?? '';
      expect(file.length).toBeGreaterThan(0);
      expect(existsSync(file)).toBe(false);
    }
  });

  it('removes the password file even when the spawn itself throws', () => {
    let file = '';
    const throwing = ((_command: string, _args: readonly string[], options: { env: NodeJS.ProcessEnv }) => {
      file = options.env.PGPASSFILE ?? '';
      throw new Error('spawn exploded');
    }) as unknown as typeof spawnSync;
    expect(() => runPostgresTool('psql', URL_WITH_SECRET, ['-c', 'select 1'], {}, throwing)).toThrow('spawn exploded');
    expect(file.length).toBeGreaterThan(0);
    expect(existsSync(file)).toBe(false);
  });

  it('writes no password file when the URL has no password', () => {
    const captured: Captured[] = [];
    runPostgresTool('psql', 'postgresql://eje@localhost/eje', ['-c', 'select 1'], {}, capturingSpawn(captured));
    expect(captured[0]?.passwordFile).toBeUndefined();
  });

  it('REFUSES a connection string passed as an argument — the old exposure cannot come back', () => {
    const captured: Captured[] = [];
    expect(() =>
      runPostgresTool('pg_restore', URL_WITH_SECRET, ['--dbname', URL_WITH_SECRET, 'x.dump'], {}, capturingSpawn(captured)),
    ).toThrow(BackupRefused);
    expect(captured).toHaveLength(0);
  });

  it('reports the tool’s own result', () => {
    const result = runPostgresTool('psql', URL_WITH_SECRET, ['-c', 'x'], {}, capturingSpawn([], 2));
    expect(result).toEqual({ ok: false, stdout: 'out\n', stderr: 'err' });
  });
});
