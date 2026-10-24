import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupRefused } from './plan';

/**
 * RUNNING `psql`, `pg_dump` AND `pg_restore` WITHOUT A PASSWORD ON THE COMMAND
 * LINE. BACKUP-2, security audit of 24 October 2026.
 *
 * THE PROBLEM. Every backup tool used to be handed `DATABASE_URL` as an
 * argument — `pg_dump … postgresql://eje_production:<password>@…`. A process's
 * arguments are world-readable on Linux (`ps -ef`, `/proc/<pid>/cmdline`), and
 * the live server mounts `/proc` without `hidepid`, so for the seconds a backup
 * ran, every local account could read the production database password. The
 * nightly timer made that a daily event.
 *
 * WHAT THIS DOES INSTEAD. The URL is taken apart here, in this process, and
 * handed to libpq the two ways libpq documents for exactly this:
 *
 *   - host, port, user, database and the TLS settings as `PG*` environment
 *     variables. `/proc/<pid>/environ` is readable only by the process's own
 *     user and root, unlike `cmdline`.
 *   - the password in a PASSWORD FILE (`PGPASSFILE`), never `PGPASSWORD`, which
 *     the PostgreSQL manual itself advises against. The file is written 0600
 *     inside a fresh 0700 directory, lives exactly as long as one tool runs,
 *     and is removed in `finally`. libpq ignores a password file that group or
 *     others can read, so a mistake in the mode fails closed.
 *
 * AND IT REFUSES THE OLD WAY. `run` throws on any argument that looks like a
 * connection string or a conninfo password, so a future caller cannot
 * reintroduce the exposure by passing a URL "just this once".
 */

export type PostgresTool = 'psql' | 'pg_dump' | 'pg_restore';

export interface ToolResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/** URL query parameters libpq understands, and the variable that carries each. */
const PARAMETERS: Readonly<Record<string, string>> = {
  host: 'PGHOST',
  port: 'PGPORT',
  sslmode: 'PGSSLMODE',
  sslrootcert: 'PGSSLROOTCERT',
  sslcert: 'PGSSLCERT',
  sslkey: 'PGSSLKEY',
  sslcrl: 'PGSSLCRL',
  connect_timeout: 'PGCONNECT_TIMEOUT',
  application_name: 'PGAPPNAME',
  options: 'PGOPTIONS',
  target_session_attrs: 'PGTARGETSESSIONATTRS',
  channel_binding: 'PGCHANNELBINDING',
  gssencmode: 'PGGSSENCMODE',
};

/**
 * Inherited variables that would change WHERE or AS WHOM a tool connects. They
 * are removed from the child's environment so the URL is the only authority —
 * a stray `PGSERVICE` or `PGPASSWORD` in an operator's shell must not quietly
 * redirect a backup or a restore.
 */
const INHERITED = [
  'DATABASE_URL',
  'PGPASSWORD',
  'PGPASSFILE',
  'PGSERVICE',
  'PGSERVICEFILE',
  'PGHOSTADDR',
  'PGUSER',
  'PGDATABASE',
  ...Object.values(PARAMETERS),
];

export interface Connection {
  /** The `PG*` variables, WITHOUT the password. */
  readonly environment: Readonly<Record<string, string>>;
  readonly user: string;
  readonly password: string;
}

/** Takes a `postgres://` or `postgresql://` URL apart. Refuses what it cannot carry. */
export const connectionFrom = (url: string): Connection => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BackupRefused('DATABASE_URL is not a URL this tool can read.');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new BackupRefused('DATABASE_URL must start with postgres:// or postgresql://.');
  }

  const environment: Record<string, string> = {};
  const host = parsed.hostname.replace(/^\[(.*)\]$/u, '$1');
  if (host.length > 0) environment.PGHOST = decodeURIComponent(host);
  if (parsed.port.length > 0) environment.PGPORT = parsed.port;
  const user = decodeURIComponent(parsed.username);
  if (user.length > 0) environment.PGUSER = user;
  const database = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  if (database.length > 0) environment.PGDATABASE = database;

  for (const [name, value] of parsed.searchParams) {
    const variable = PARAMETERS[name];
    if (variable === undefined) {
      /*
       * REFUSED RATHER THAN DROPPED. An unknown parameter is usually one that
       * matters — a TLS setting spelled the way another driver spells it — and
       * silently connecting without it would be a backup over a connection the
       * operator did not ask for.
       */
      throw new BackupRefused(
        `DATABASE_URL carries a parameter the backup tools cannot pass on ("${name}"). ` +
          `Supported: ${Object.keys(PARAMETERS).join(', ')}.`,
      );
    }
    environment[variable] = value;
  }

  return { environment, user, password: decodeURIComponent(parsed.password) };
};

/** One password-file line. `\` and `:` are the two characters the format escapes. */
export const passwordFileLine = (user: string, password: string): string => {
  const escape = (value: string): string => value.replace(/\\/gu, '\\\\').replace(/:/gu, '\\:');
  // Every host, port and database: the file exists for one tool run and one URL.
  return `*:*:*:${escape(user)}:${escape(password)}\n`;
};

/**
 * True when an argument carries a credential the way the old code passed one:
 * a URL, or a conninfo string with a password in it.
 */
export const looksLikeCredential = (argument: string): boolean =>
  /postgres(ql)?:\/\//iu.test(argument) || /(^|\s)password\s*=/iu.test(argument);

/** The child's environment: inherited, minus anything that could redirect it, plus the URL's parts. */
export const childEnvironment = (
  inherited: NodeJS.ProcessEnv,
  connection: Connection,
  passwordFile: string | null,
): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = { ...inherited };
  for (const name of INHERITED) delete environment[name];
  Object.assign(environment, connection.environment);
  if (passwordFile !== null) environment.PGPASSFILE = passwordFile;
  return environment;
};

type Spawn = typeof spawnSync;

/**
 * Runs one PostgreSQL client tool against the server and database in `url`.
 *
 * `--no-password` is always added: with the password in a file there is never
 * a reason to prompt, and a prompt under systemd is a backup that hangs until
 * its timeout instead of failing.
 */
export const runPostgresTool = (
  command: PostgresTool,
  url: string,
  args: readonly string[],
  options: { readonly maxBuffer?: number } = {},
  spawn: Spawn = spawnSync,
): ToolResult => {
  for (const argument of args) {
    if (looksLikeCredential(argument)) {
      throw new BackupRefused(
        `refusing to run ${command} with a connection string on its command line — any ` +
          'local user could read it from the process list. Pass the URL to runPostgresTool instead.',
      );
    }
  }

  const connection = connectionFrom(url);
  const directory = connection.password.length > 0 ? mkdtempSync(join(tmpdir(), 'eje-pg-')) : null;
  try {
    let passwordFile: string | null = null;
    if (directory !== null) {
      passwordFile = join(directory, 'pgpass');
      writeFileSync(passwordFile, passwordFileLine(connection.user, connection.password), {
        mode: 0o600,
        flag: 'wx',
      });
    }
    const result = spawn(command, ['--no-password', ...args], {
      encoding: 'utf8',
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
      env: childEnvironment(process.env, connection, passwordFile),
    });
    if (result.error !== undefined) {
      return { ok: false, stdout: '', stderr: `${command} could not be run: ${result.error.message}` };
    }
    return {
      ok: result.status === 0,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? '').trim(),
    };
  } finally {
    if (directory !== null) rmSync(directory, { recursive: true, force: true });
  }
};
