import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSafeMembers,
  extractArchiveSafely,
  parseArchiveListing,
  type ArchiveLimits,
} from './archive';

/**
 * WHAT A RESTORE TEST MAY UNPACK. BACKUP-2.
 *
 * Two halves, deliberately. The listing parser and the rules are PURE, so the
 * refusals can be proved against listings written by hand — including ones this
 * machine cannot easily produce. And then the whole thing is proved against
 * REAL archives built with the real `tar`, because a rule that only holds
 * against a fixture somebody typed is a rule about the fixture.
 *
 * Every refusal is asserted to leave the target directory EMPTY. That is the
 * claim that matters: the archive was judged before anything was written, not
 * cleaned up afterwards.
 */

const workspaces: string[] = [];

const workspace = (): string => {
  const path = mkdtempSync(join(tmpdir(), 'eje-archive-test-'));
  workspaces.push(path);
  return path;
};

const tar = (args: readonly string[]): void => {
  const result = spawnSync('tar', [...args], { encoding: 'utf8' });
  expect(result.status, result.stderr ?? '').toBe(0);
};

afterEach(() => {
  while (workspaces.length > 0) {
    rmSync(workspaces.pop() as string, { recursive: true, force: true });
  }
});

/** The ceilings, small enough to prove without building a 64 GB archive. */
const TINY: ArchiveLimits = { maxMembers: 10, maxMemberBytes: 100, maxTotalBytes: 150 };

describe('reading a tar listing', () => {
  it('reads an ordinary file, directory and the archive root', () => {
    const members = parseArchiveListing(
      [
        'drwxr-xr-x 0/0               0 2026-10-18 11:59 ./',
        'drwx------ 0/0               0 2026-10-18 11:59 ./jobs/',
        '-rw------- 0/0             391 2026-10-18 11:59 ./jobs/EJE-1049.pdf',
      ].join('\n'),
    );

    expect(members).toEqual([
      { path: '', kind: 'directory', bytes: 0 },
      { path: 'jobs', kind: 'directory', bytes: 0 },
      { path: 'jobs/EJE-1049.pdf', kind: 'file', bytes: 391 },
    ]);
  });

  it('sees a symlink by its arrow and keeps only the member name', () => {
    const [member] = parseArchiveListing(
      'lrwxrwxrwx 0/0               0 2026-10-18 11:59 ./docs -> /home/user',
    );
    expect(member).toEqual({ path: 'docs', kind: 'symlink', bytes: 0 });
  });

  it('sees a hardlink by its wording', () => {
    const [member] = parseArchiveListing(
      'hrw-r--r-- 0/0               0 2026-10-18 11:59 a.txt link to b.txt',
    );
    expect(member).toEqual({ path: 'a.txt', kind: 'hardlink', bytes: 0 });
  });

  it("does not read a device's major,minor as a size", () => {
    const [member] = parseArchiveListing(
      'crw-rw-rw- 0/0             1,3 2026-10-18 11:59 ./null',
    );
    expect(member).toEqual({ path: 'null', kind: 'special', bytes: 0 });
  });

  /*
   * THE LINE IT CANNOT READ IS THE IMPORTANT ONE. A member whose name carries
   * a newline arrives here as two lines, one of which is whatever the attacker
   * wanted it to look like. Skipping it would hand that member to `tar -x`
   * unexamined.
   */
  it('REFUSES a line it cannot account for, rather than skipping it', () => {
    expect(() => parseArchiveListing('this is not a tar listing at all')).toThrow(
      /cannot read/u,
    );
  });
});

describe('what may be unpacked', () => {
  const file = (path: string, bytes = 10) => ({ path, kind: 'file' as const, bytes });

  it('accepts an ordinary archive of documents', () => {
    expect(() =>
      assertSafeMembers([
        { path: '', kind: 'directory', bytes: 0 },
        { path: 'jobs', kind: 'directory', bytes: 0 },
        file('jobs/EJE-1049.pdf', 50),
        file('machines/MZ-1.jpg', 50),
      ], TINY),
    ).not.toThrow();
  });

  it('REFUSES an absolute path', () => {
    expect(() => assertSafeMembers([file('/etc/cron.d/eje')])).toThrow(/ABSOLUTE path/u);
  });

  it('REFUSES a Windows drive path', () => {
    expect(() => assertSafeMembers([file('C:\\windows\\system32\\x')])).toThrow(/ABSOLUTE path/u);
  });

  it('REFUSES a path that climbs out, wherever the .. sits', () => {
    expect(() => assertSafeMembers([file('../outside.pdf')])).toThrow(/climbs out/u);
    expect(() => assertSafeMembers([file('jobs/../../outside.pdf')])).toThrow(/climbs out/u);
  });

  it('REFUSES a symlink, because the escape is the member AFTER it', () => {
    expect(() =>
      assertSafeMembers([
        { path: 'docs', kind: 'symlink', bytes: 0 },
        file('docs/authorized_keys'),
      ]),
    ).toThrow(/symlink/u);
  });

  it('REFUSES a hardlink', () => {
    expect(() => assertSafeMembers([{ path: 'a.pdf', kind: 'hardlink', bytes: 0 }])).toThrow(
      /hardlink/u,
    );
  });

  it('REFUSES a device, FIFO or socket', () => {
    expect(() => assertSafeMembers([{ path: 'null', kind: 'special', bytes: 0 }])).toThrow(
      /device, FIFO or socket/u,
    );
  });

  /*
   * The file count would still match the manifest, which is why this is
   * refused here rather than left to the cross-check in `restore-test`.
   */
  it('REFUSES the same document twice', () => {
    expect(() => assertSafeMembers([file('jobs/a.pdf'), file('jobs/a.pdf')])).toThrow(/twice/u);
  });

  it('allows a directory to appear beside its contents', () => {
    expect(() =>
      assertSafeMembers([
        { path: 'jobs', kind: 'directory', bytes: 0 },
        file('jobs/a.pdf'),
      ], TINY),
    ).not.toThrow();
  });

  it('REFUSES one member over the ceiling', () => {
    expect(() => assertSafeMembers([file('jobs/big.pdf', 101)], TINY)).toThrow(/claims 101 bytes/u);
  });

  it('REFUSES an archive whose members together claim too much — before extraction', () => {
    expect(() =>
      assertSafeMembers([file('a', 80), file('b', 80)], TINY),
    ).toThrow(/BEFORE extraction/u);
  });

  it('REFUSES more members than it will unpack', () => {
    expect(() =>
      assertSafeMembers([file('a'), file('b'), file('c'), file('d')], { ...TINY, maxMembers: 3 }),
    ).toThrow(/over the 3/u);
  });
});

describe('unpacking a real archive', () => {
  it('unpacks an ordinary document archive and reports what landed', async () => {
    const root = workspace();
    const storage = join(root, 'storage');
    mkdirSync(join(storage, 'jobs'), { recursive: true });
    writeFileSync(join(storage, 'jobs', 'EJE-1049.pdf'), '%PDF-1.4 signed');
    writeFileSync(join(storage, 'top.txt'), 'top');
    const archive = join(root, 'storage.tar.gz');
    tar(['-czf', archive, '-C', storage, '.']);

    const target = join(root, 'out');
    mkdirSync(target);
    const { files } = await extractArchiveSafely(archive, target);

    expect([...files].sort()).toEqual(['jobs/EJE-1049.pdf', 'top.txt']);
    expect(existsSync(join(target, 'jobs', 'EJE-1049.pdf'))).toBe(true);
  });

  it('REFUSES a real archive containing a symlink, and writes nothing', async () => {
    const root = workspace();
    const storage = join(root, 'storage');
    mkdirSync(storage, { recursive: true });
    writeFileSync(join(storage, 'a.pdf'), 'pdf');
    symlinkSync('/etc', join(storage, 'escape'));
    const archive = join(root, 'storage.tar.gz');
    tar(['-czf', archive, '-C', storage, '.']);

    const target = join(root, 'out');
    mkdirSync(target);
    await expect(extractArchiveSafely(archive, target)).rejects.toThrow(/symlink/u);
    expect(readdirSync(target)).toEqual([]);
  });

  it('REFUSES a real archive whose member climbs out, and writes nothing', async () => {
    const root = workspace();
    const storage = join(root, 'storage');
    mkdirSync(storage, { recursive: true });
    writeFileSync(join(root, 'sibling.txt'), 'outside');
    const archive = join(root, 'storage.tar.gz');
    // -P is what makes tar keep the `../`, which is how such an archive exists.
    tar(['-czPf', archive, '-C', storage, '../sibling.txt']);

    const target = join(root, 'out');
    mkdirSync(target);
    await expect(extractArchiveSafely(archive, target)).rejects.toThrow(/climbs out/u);
    expect(readdirSync(target)).toEqual([]);
  });

  it('REFUSES a real archive with an absolute member, and writes nothing', async () => {
    const root = workspace();
    const storage = join(root, 'storage');
    mkdirSync(storage, { recursive: true });
    const victim = join(storage, 'a.pdf');
    writeFileSync(victim, 'pdf');
    const archive = join(root, 'storage.tar.gz');
    tar(['-czPf', archive, victim]);

    const target = join(root, 'out');
    mkdirSync(target);
    await expect(extractArchiveSafely(archive, target)).rejects.toThrow(/ABSOLUTE path/u);
    expect(readdirSync(target)).toEqual([]);
  });

  it('REFUSES a real archive holding one document twice, and writes nothing', async () => {
    const root = workspace();
    const storage = join(root, 'storage');
    mkdirSync(storage, { recursive: true });
    writeFileSync(join(storage, 'a.pdf'), 'pdf');
    const archive = join(root, 'storage.tar.gz');
    tar(['-czf', archive, '--hard-dereference', '-C', storage, 'a.pdf', 'a.pdf']);

    const target = join(root, 'out');
    mkdirSync(target);
    await expect(extractArchiveSafely(archive, target)).rejects.toThrow(/twice/u);
    expect(readdirSync(target)).toEqual([]);
  });

  it('REFUSES a real archive carrying a FIFO, and writes nothing', async () => {
    const root = workspace();
    const storage = join(root, 'storage');
    mkdirSync(storage, { recursive: true });
    const made = spawnSync('mkfifo', [join(storage, 'pipe')], { encoding: 'utf8' });
    if (made.status !== 0) return; // No mkfifo on this host; the pure rule above still holds.
    const archive = join(root, 'storage.tar.gz');
    tar(['-czf', archive, '-C', storage, 'pipe']);

    const target = join(root, 'out');
    mkdirSync(target);
    await expect(extractArchiveSafely(archive, target)).rejects.toThrow(
      /device, FIFO or socket/u,
    );
    expect(readdirSync(target)).toEqual([]);
  });

  it('REFUSES a real archive that claims more than the ceiling', async () => {
    const root = workspace();
    const storage = join(root, 'storage');
    mkdirSync(storage, { recursive: true });
    writeFileSync(join(storage, 'a.pdf'), 'x'.repeat(500));
    const archive = join(root, 'storage.tar.gz');
    tar(['-czf', archive, '-C', storage, '.']);

    const target = join(root, 'out');
    mkdirSync(target);
    await expect(extractArchiveSafely(archive, target, TINY)).rejects.toThrow(
      /claims 500 bytes/u,
    );
    expect(readdirSync(target)).toEqual([]);
  });

  it('is not fooled by a file the listing did not declare', async () => {
    const root = workspace();
    const storage = join(root, 'storage');
    mkdirSync(storage, { recursive: true });
    writeFileSync(join(storage, 'a.pdf'), 'pdf');
    const archive = join(root, 'storage.tar.gz');
    tar(['-czf', archive, '-C', storage, '.']);

    const target = join(root, 'out');
    mkdirSync(target);
    // Something else is already in the target — the check is of the FILESYSTEM,
    // not of tar's own account of itself, so it must notice.
    writeFileSync(join(target, 'planted.txt'), 'not from the archive');

    await expect(extractArchiveSafely(archive, target)).rejects.toThrow(/did not declare/u);
  });
});
