import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { BackupRefused } from './plan';

/**
 * UNPACKING A DOCUMENT ARCHIVE WITHOUT TRUSTING IT. BACKUP-2.
 *
 * `backup:restore-test` used to unpack the document archive with a bare
 * `tar -xzf archive -C workspace`, which trusts the archive to describe only
 * ordinary files under its own root. That trust is misplaced for the same
 * reason the archive is encrypted at all: a backup exists in order to be
 * COPIED, so by the time somebody restores one it has been rsynced, carried on
 * a disk and handled by people who are not EJE. The GCM tag proves the bytes
 * are the bytes that were written — it says nothing about an archive that was
 * MADE wrong, and nothing at all about the day an operator restore-tests a file
 * somebody else handed them.
 *
 * SO THE MEMBERS ARE READ AND JUDGED BEFORE A SINGLE BYTE IS WRITTEN. Four
 * things are refused outright, because none of them can occur in an archive of
 * EJE's storage directory and every one of them escapes the directory the
 * caller chose:
 *
 *   - an ABSOLUTE path — `/etc/cron.d/x` is not under the workspace;
 *   - any `..` COMPONENT — the classic traversal, and it does not need to be at
 *     the start to work;
 *   - a SYMLINK or HARDLINK — the dangerous one, because it is two steps: a
 *     member `docs -> /home/user` followed by `docs/authorized_keys` writes
 *     outside the workspace while every path in the archive looks relative;
 *   - a DEVICE, FIFO or socket — a backup of signed job cards contains none,
 *     and `mknod` during a restore test is never what was wanted.
 *
 * AND TWO THINGS ARE BOUNDED, because `tar -xz` will otherwise fill the disk
 * for whoever asks it to: how many members an archive may hold, and how many
 * bytes they claim to be. The claim is the decompression bomb's own number, so
 * a 40 KB archive that unpacks to 60 GB is refused before extraction rather
 * than after the partition is full.
 *
 * DUPLICATES ARE REFUSED TOO. `tar` happily extracts `a/b.pdf` twice, the
 * second overwriting the first, so an archive holding one storage key twice
 * would restore bytes nobody can identify — and the file count would still
 * match the manifest, which is precisely the check that would otherwise catch
 * it.
 *
 * WHAT THIS IS NOT. It is not a tar implementation: GNU tar still does the
 * reading and the writing, because the whole point of `tar.gz` is that a person
 * at a terminal can unpack it without this repository (BACKUP-1). This decides
 * WHETHER to let it, and then checks what it did.
 */

/** What a member of the archive is. Anything but `file`/`directory` is refused. */
export type MemberKind = 'file' | 'directory' | 'symlink' | 'hardlink' | 'special';

export interface ArchiveMember {
  /** The path as the archive gives it, with any `./` prefix removed. */
  readonly path: string;
  readonly kind: MemberKind;
  /** The size the archive CLAIMS. Directories and links claim nothing. */
  readonly bytes: number;
}

export interface ArchiveLimits {
  /** How many members the archive may hold. */
  readonly maxMembers: number;
  /** How many bytes one member may claim. */
  readonly maxMemberBytes: number;
  /** How many bytes the whole archive may claim once unpacked. */
  readonly maxTotalBytes: number;
}

/**
 * Deliberately generous, and deliberately finite.
 *
 * EJE's storage is signed job cards, machine photographs and manuals: tens of
 * thousands of files of a few megabytes each. These ceilings are an order of
 * magnitude above that and still small enough that hitting one is a bug or an
 * attack rather than a busy year. They are overridable per call so the tests
 * can prove the refusals without building a 64 GB archive.
 */
export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxMembers: 500_000,
  maxMemberBytes: 2 * 1024 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024 * 1024,
};

const kindOf = (mode: string, name: string): MemberKind => {
  if (name.includes(' -> ')) return 'symlink';
  if (name.includes(' link to ')) return 'hardlink';
  switch (mode.charAt(0)) {
    case 'd':
      return 'directory';
    case 'l':
      return 'symlink';
    case 'h':
      return 'hardlink';
    case '-':
      return 'file';
    default:
      // b, c, p, s — block, character, FIFO, socket.
      return 'special';
  }
};

/** Strips the `./` GNU tar writes for an archive made with `-C root .`. */
const tidy = (path: string): string => path.replace(/^\.\/+/u, '').replace(/\/+$/u, '');

/**
 * Reads `tar -tvzf` output into members.
 *
 * PURE, so every refusal below can be proved against a listing written by hand
 * — including listings this system could not easily produce, like a device node
 * or a member whose name contains a newline. The real listing is taken under
 * `LC_ALL=C` so the date column cannot change shape underneath this.
 *
 * A line it cannot read is NOT skipped. A member nobody can account for is the
 * one most worth refusing: a name carrying a newline would otherwise be read as
 * two members, one of which could be anything at all.
 */
export const parseArchiveListing = (listing: string): readonly ArchiveMember[] => {
  const lines = listing.split('\n').filter((line) => line.trim().length > 0);
  return lines.map((line) => {
    const match = /^(\S+)\s+(\S+)\s+(\S+)\s+(\d{4}-\d{2}-\d{2})\s+(\S+)\s+(.*)$/u.exec(line);
    if (match === null) {
      throw new BackupRefused(
        `the document archive lists a member this system cannot read: "${line.slice(0, 120)}". ` +
          'It is refused rather than skipped — a member nobody can account for is exactly the ' +
          'one that should not be unpacked.',
      );
    }
    const mode = match[1] ?? '';
    const size = match[3] ?? '';
    const rawName = match[6] ?? '';
    const kind = kindOf(mode, rawName);
    const name = (rawName.split(' -> ')[0] ?? '').split(' link to ')[0] ?? '';
    /*
     * A device's size column is `major,minor`, not a number. It is refused
     * below for being a device; the size is recorded as 0 rather than NaN so
     * the total cannot be poisoned by a member that is going to be refused
     * anyway.
     */
    const bytes = /^\d+$/u.test(size) ? Number(size) : 0;
    return { path: tidy(name), kind, bytes };
  });
};

/** Refuses a listing that would escape its directory, or flood the disk. */
export const assertSafeMembers = (
  members: readonly ArchiveMember[],
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): void => {
  if (members.length > limits.maxMembers) {
    throw new BackupRefused(
      `the document archive holds ${members.length} members, over the ${limits.maxMembers} ` +
        'this restore test will unpack. Nothing was extracted.',
    );
  }

  const seen = new Set<string>();
  let total = 0;

  for (const member of members) {
    if (member.path.length === 0) continue; // The `./` root of the archive itself.

    if (member.path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(member.path)) {
      throw new BackupRefused(
        `the document archive contains an ABSOLUTE path, "${member.path}". A backup of EJE's ` +
          'storage directory holds relative paths only, so this archive is not one — nothing ' +
          'was extracted.',
      );
    }

    if (normalize(member.path).split('/').includes('..')) {
      throw new BackupRefused(
        `the document archive contains "${member.path}", which climbs out of the directory it ` +
          'would be unpacked into. Nothing was extracted.',
      );
    }

    if (member.kind === 'symlink' || member.kind === 'hardlink') {
      throw new BackupRefused(
        `the document archive contains a ${member.kind}, "${member.path}". Links are refused: a ` +
          'link to a directory elsewhere turns every later member under it into a write ' +
          'outside this workspace, while every path in the archive still looks relative. ' +
          'Nothing was extracted.',
      );
    }

    if (member.kind === 'special') {
      throw new BackupRefused(
        `the document archive contains "${member.path}", which is a device, FIFO or socket. ` +
          "EJE's storage holds signed job cards and photographs; nothing was extracted.",
      );
    }

    if (member.bytes > limits.maxMemberBytes) {
      throw new BackupRefused(
        `"${member.path}" claims ${member.bytes} bytes, over the ${limits.maxMemberBytes} one ` +
          'document may be. Nothing was extracted.',
      );
    }

    total += member.bytes;
    if (total > limits.maxTotalBytes) {
      throw new BackupRefused(
        `the document archive claims more than ${limits.maxTotalBytes} bytes once unpacked. ` +
          'It is refused BEFORE extraction rather than after the disk is full.',
      );
    }

    if (member.kind === 'file') {
      if (seen.has(member.path)) {
        throw new BackupRefused(
          `the document archive holds "${member.path}" twice. The second would overwrite the ` +
            'first, so the restored bytes for that storage key could not be identified — and ' +
            'the file count would still match the manifest. Nothing was extracted.',
        );
      }
      seen.add(member.path);
    }
  }
};

const tar = (args: readonly string[]): { ok: boolean; stdout: string; stderr: string } => {
  const result = spawnSync('tar', [...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    // So the listing's date column has one shape, whatever the host's locale is.
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
  if (result.error !== undefined) {
    return { ok: false, stdout: '', stderr: `tar could not be run: ${result.error.message}` };
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: (result.stderr ?? '').trim(),
  };
};

/** Every file under a directory, relative to it, following no links. */
export const filesUnder = async (root: string): Promise<readonly string[]> => {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1));
};

export interface ExtractedArchive {
  /** The members the archive declared, after they were accepted. */
  readonly members: readonly ArchiveMember[];
  /** The regular files actually on disk afterwards, relative to the target. */
  readonly files: readonly string[];
}

/**
 * Lists, judges, unpacks, and then checks what was unpacked.
 *
 * The last step is not belt-and-braces: the listing is the archive's own
 * account of itself, and this is the filesystem's. If they disagree — a symlink
 * on disk that the listing did not mention, more files than members — the
 * archive did something other than what it said, and that is reported as a
 * failure of the backup rather than smoothed over.
 */
export const extractArchiveSafely = async (
  archive: string,
  target: string,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): Promise<ExtractedArchive> => {
  const listed = tar(['-tvzf', archive, '--numeric-owner']);
  if (!listed.ok) {
    throw new BackupRefused(`the document archive could not be listed: ${listed.stderr}`);
  }

  const members = parseArchiveListing(listed.stdout);
  assertSafeMembers(members, limits);

  const extracted = tar([
    '-xzf',
    archive,
    '-C',
    target,
    /*
     * The archive's ownership and permissions are the SOURCE machine's, and
     * this is a scratch directory on somebody else's. Taking them would, at
     * best, create files the running user cannot read.
     */
    '--no-same-owner',
    '--no-same-permissions',
    '--no-overwrite-dir',
  ]);
  if (!extracted.ok) {
    throw new BackupRefused(`the document archive would not unpack: ${extracted.stderr}`);
  }

  const files = await filesUnder(target);

  const declared = new Set(members.filter((member) => member.kind === 'file').map((m) => m.path));
  const surprises = files.filter((file) => !declared.has(file));
  if (surprises.length > 0) {
    throw new BackupRefused(
      `unpacking produced ${surprises.length} file(s) the listing did not declare — for ` +
        `example "${surprises[0]}". The archive is not what it said it was.`,
    );
  }

  /*
   * AND NO LINKS ON DISK. The listing was checked for them, so this can only
   * fail if tar wrote something the listing did not describe. It is a cheap
   * check at the one place where being wrong means a later step followed a link
   * out of the workspace.
   */
  for (const file of files) {
    if (lstatSync(join(target, file)).isSymbolicLink()) {
      throw new BackupRefused(
        `"${file}" was unpacked as a symbolic link, which the listing did not declare. ` +
          'Treat this archive as untrustworthy.',
      );
    }
  }

  return { members, files };
};
