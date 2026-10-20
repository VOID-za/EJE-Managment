/**
 * THE CLIENT TOOLS AND THE SERVER HAVE TO AGREE. BACKUP-1, BACKUP-2.
 *
 * WHAT THIS EXISTS FOR, found by CI on 20 October 2026. The runner's image
 * started shipping PostgreSQL 17 client tools while the service container is
 * the 16 that production runs. `pg_dump 17` writes `SET transaction_timeout`
 * into its output; PostgreSQL 16 has no such parameter, so every restore of
 * every one of those dumps died with
 *
 *     pg_restore: error: could not execute query: ERROR:
 *       unrecognized configuration parameter "transaction_timeout"
 *
 * THE REASON THAT IS WORTH CODE RATHER THAN A CI PIN. The same thing happens on
 * a VPS the day `apt upgrade` pulls in a newer `postgresql-client` beside an
 * unchanged server: `npm run backup` keeps reporting success, the dumps keep
 * being written, they are encrypted and checksummed and copied off-site — and
 * NONE OF THEM CAN BE RESTORED onto the machine they came from. Nobody finds
 * out until the morning somebody needs one. It is exactly the shape of failure
 * this whole requirement exists to prevent, so it is refused at backup time,
 * where it is cheap, rather than diagnosed at restore time, where it is not.
 *
 * A dump is restorable into a server of ITS OWN VERSION OR NEWER. So the rule
 * is not "they must be identical" — it is that the client must not be newer
 * than the server it is dumping, because that server is where the restore will
 * be attempted.
 */

/** `pg_dump (PostgreSQL) 17.2 (Debian …)` → 17. Also reads a bare `16.15`. */
export const majorFromToolVersion = (text: string): number | null => {
  const match = /(\d+)(?:\.\d+)*/u.exec(text.replace(/^[^0-9]*/u, ''));
  const major = Number(match?.[1] ?? '');
  return Number.isInteger(major) && major > 0 ? major : null;
};

/**
 * `server_version_num` → 17 (`170002`), and `server_version` → 16 (`16.15`).
 *
 * Both shapes, because the number is what a query returns and the string is
 * what an operator pastes.
 */
export const majorFromServerVersion = (text: string): number | null => {
  const trimmed = text.trim();
  if (/^\d{6}$/u.test(trimmed)) return Math.floor(Number(trimmed) / 10_000);
  return majorFromToolVersion(trimmed);
};

export type VersionSkew = 'match' | 'client_newer' | 'client_older' | 'unknown';

export const compareMajors = (
  clientMajor: number | null,
  serverMajor: number | null,
): VersionSkew => {
  if (clientMajor === null || serverMajor === null) return 'unknown';
  if (clientMajor === serverMajor) return 'match';
  return clientMajor > serverMajor ? 'client_newer' : 'client_older';
};

/**
 * The refusal, or null when there is nothing to refuse.
 *
 * `client_older` is refused too, and for a different reason: `pg_dump` is not
 * guaranteed to understand the catalogue of a server newer than itself, and
 * where it does not it can silently omit objects. A backup missing a table is
 * worse than no backup.
 *
 * `unknown` is NOT refused. The version could not be read — an unusual build,
 * a wrapper script, a locale — and refusing every backup on a machine whose
 * `pg_dump --version` cannot be parsed would turn a cosmetic problem into no
 * backups at all. It is reported instead.
 */
export const skewRefusal = (
  skew: VersionSkew,
  clientMajor: number | null,
  serverMajor: number | null,
): string | null => {
  switch (skew) {
    case 'client_newer':
      return (
        `pg_dump is version ${clientMajor} and the server is ${serverMajor}. The dump it would ` +
        `write CANNOT BE RESTORED onto this server — pg_dump ${clientMajor} emits settings that ` +
        `PostgreSQL ${serverMajor} does not recognise, and the restore dies partway through. ` +
        'Install the client tools that match the server (`postgresql-client-' +
        `${serverMajor}`.concat(
          '`) and run this again. If you know the restore target is a NEWER server than this ' +
            'one, set EJE_BACKUP_ALLOW_VERSION_SKEW=yes — and write down which server that is, ' +
            'because this dump will not go back where it came from.',
        )
      );
    case 'client_older':
      return (
        `pg_dump is version ${clientMajor} and the server is ${serverMajor}. A pg_dump older ` +
        'than its server is not guaranteed to understand the catalogue and can omit objects ' +
        'without saying so. Install `postgresql-client-' +
        `${serverMajor}` +
        '` and run this again; EJE_BACKUP_ALLOW_VERSION_SKEW=yes overrides it, and a backup ' +
        'missing a table is worse than no backup.'
      );
    case 'match':
    case 'unknown':
      return null;
  }
};

/** What to say when the versions could not be read at all. */
export const skewNote = (
  skew: VersionSkew,
  clientMajor: number | null,
  serverMajor: number | null,
): string | null =>
  skew === 'unknown'
    ? 'WARNING: the PostgreSQL client or server version could not be read ' +
      `(client ${clientMajor ?? '?'}, server ${serverMajor ?? '?'}), so the two were not ` +
      'compared. A dump written by a NEWER pg_dump than the server cannot be restored onto it.'
    : null;

/**
 * Whether a `pg_restore` failure is this mismatch wearing a confusing hat.
 *
 * The message names a configuration parameter, which reads like a server
 * misconfiguration and sends an operator to `postgresql.conf`. It is not that:
 * it is a dump from a newer PostgreSQL than the server being restored into.
 */
export const looksLikeVersionSkew = (stderr: string): boolean =>
  /unrecognized configuration parameter/iu.test(stderr);

export const skewDiagnosis = (stderr: string): string =>
  looksLikeVersionSkew(stderr)
    ? ' THIS IS A VERSION MISMATCH, not a server setting: the dump was written by a NEWER ' +
      'pg_dump than the PostgreSQL this is restoring into, so it carries settings that server ' +
      'does not recognise. Restore it into a server of at least the version that produced it, ' +
      'or re-take the backup with client tools that match this server.'
    : '';
