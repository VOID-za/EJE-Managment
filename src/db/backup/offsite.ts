import { resolve } from 'node:path';

/**
 * GETTING THE BACKUP OFF THIS MACHINE. BACKUP-2.
 *
 * A backup on the server it is a backup OF protects against a mistaken DELETE
 * and nothing else. It does not survive the disk, the provider, the
 * ransomware, or the invoice nobody paid — and `/var/backups/eje` is on the
 * same machine as `/var/lib/eje/storage`.
 *
 * WHAT THIS DOES AND DOES NOT DECIDE. It plans the copy from the environment
 * and says plainly when what it has been given is not actually off the server.
 * It does not invent a destination, hold a credential, or sign up to anything:
 * there are two shapes, both of which the operator configures outside this
 * repository.
 *
 *   EJE_BACKUP_OFFSITE_DIR=/mnt/offsite/eje
 *       A path. Useful when something is MOUNTED there — an NFS share, an
 *       object-store FUSE mount, a USB disk that is taken away. The plan says
 *       so out loud when the path turns out to be on the same filesystem as
 *       the backups themselves, because then it is a second copy on one disk
 *       and calling it off-site would be a lie.
 *
 *   EJE_BACKUP_OFFSITE_RCLONE=eje-b2:eje-backups
 *       An rclone remote. rclone is configured by the operator, with its own
 *       config file and its own credentials, and this repository never sees
 *       them: it runs `rclone copy` and then `rclone check`, which compares
 *       checksums at both ends. That is deliberately somebody else's secret
 *       store — a cloud key in `/etc/eje/eje.env` would be one `cat` away from
 *       every backup EJE has.
 *
 * NEITHER IS SET BY DEFAULT, and a backup with no off-site destination says so
 * on every run rather than passing quietly. Silence is how a business
 * discovers, during an incident, that nothing was ever copied anywhere.
 */

export type OffsiteKind = 'directory' | 'rclone';

export interface OffsiteDestination {
  readonly kind: OffsiteKind;
  /** A path, or an rclone `remote:path`. Never a credential. */
  readonly target: string;
}

export interface OffsitePlan {
  readonly destinations: readonly OffsiteDestination[];
  /** Said on every run, whatever the outcome. */
  readonly notes: readonly string[];
  /** Set when what was configured cannot be used at all. */
  readonly refusal: string | null;
}

export const planOffsite = (
  env: Readonly<Record<string, string | undefined>>,
  backupDirectory: string,
): OffsitePlan => {
  const directory = (env.EJE_BACKUP_OFFSITE_DIR ?? '').trim();
  const remote = (env.EJE_BACKUP_OFFSITE_RCLONE ?? '').trim();
  const destinations: OffsiteDestination[] = [];
  const notes: string[] = [];

  if (directory.length > 0) {
    const absolute = resolve(directory);
    const backups = resolve(backupDirectory);
    if (absolute === backups || absolute.startsWith(`${backups}/`)) {
      return {
        destinations: [],
        notes,
        refusal:
          `EJE_BACKUP_OFFSITE_DIR (${absolute}) is inside EJE_BACKUP_DIR (${backups}). ` +
          'Copying a backup into the directory it already lives in is not a second copy of ' +
          'anything, and a retention run would then delete both.',
      };
    }
    destinations.push({ kind: 'directory', target: absolute });
  }

  if (remote.length > 0) {
    if (!/^[A-Za-z0-9_-]+:/u.test(remote)) {
      return {
        destinations: [],
        notes,
        refusal:
          `EJE_BACKUP_OFFSITE_RCLONE ("${remote}") is not an rclone target. It must be ` +
          '`remote:path`, where `remote` is a remote the operator has configured with ' +
          '`rclone config` on this machine.',
      };
    }
    destinations.push({ kind: 'rclone', target: remote });
  }

  if (destinations.length === 0) {
    notes.push(
      'NO OFF-SERVER DESTINATION IS CONFIGURED. This backup exists only on the machine it is a ' +
        'backup of, so it does not survive that machine. Set EJE_BACKUP_OFFSITE_DIR to a mounted ' +
        'volume, or EJE_BACKUP_OFFSITE_RCLONE to an rclone remote — see docs/vps-backups.md.',
    );
  }

  return { destinations, notes, refusal: null };
};

/**
 * Whether a directory destination is really on different media.
 *
 * The caller supplies the two device ids from `stat`; this exists so the
 * judgement is testable and so the sentence is written once. Same device means
 * the copy shares the disk, the controller and the filesystem with the
 * original, which is most of what an off-site copy is supposed to survive.
 */
export const sameMediaWarning = (
  target: string,
  backupDevice: number,
  targetDevice: number,
): string | null =>
  backupDevice === targetDevice
    ? `${target} is on the SAME filesystem as the backups themselves, so this is a second copy ` +
      'on one disk rather than an off-site one. It is still written — a copy is better than no ' +
      'copy — but it must not be counted as off-site in any statement to EJE.'
    : null;

/** The rclone commands a run performs, in order. Named so a test can read them. */
export const rcloneCommands = (
  source: string,
  target: string,
  directoryName: string,
): readonly { readonly command: string; readonly args: readonly string[] }[] => [
  { command: 'rclone', args: ['copy', source, `${target}/${directoryName}`] },
  /*
   * AND THEN CHECK, which is the half that makes the copy worth anything.
   * `rclone copy` reporting success means it transferred what it decided to
   * transfer; `rclone check` compares both ends and is what catches a
   * truncated upload, a skipped file or a quota that ran out mid-way.
   */
  { command: 'rclone', args: ['check', source, `${target}/${directoryName}`] },
];
