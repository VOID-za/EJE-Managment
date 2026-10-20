import { describe, expect, it } from 'vitest';
import { planOffsite, rcloneCommands, sameMediaWarning } from './offsite';

/**
 * A BACKUP THAT NEVER LEAVES THE SERVER. BACKUP-2.
 *
 * The thing being tested is mostly honesty: that an unconfigured deployment is
 * told it has no off-site copy, that a "destination" inside the backup
 * directory is refused rather than counted, and that a second copy on the same
 * disk is not described as off-site.
 */
describe('planning the copy off this machine', () => {
  it('says plainly when there is nowhere configured', () => {
    const plan = planOffsite({}, '/var/backups/eje');

    expect(plan.destinations).toEqual([]);
    expect(plan.refusal).toBeNull();
    expect(plan.notes.join(' ')).toMatch(/NO OFF-SERVER DESTINATION IS CONFIGURED/u);
    // And why it matters, not merely that it is unset.
    expect(plan.notes.join(' ')).toMatch(/does not survive that machine/u);
  });

  it('takes a mounted directory', () => {
    const plan = planOffsite({ EJE_BACKUP_OFFSITE_DIR: '/mnt/offsite/eje' }, '/var/backups/eje');
    expect(plan.destinations).toEqual([{ kind: 'directory', target: '/mnt/offsite/eje' }]);
    expect(plan.notes).toEqual([]);
  });

  it('REFUSES a destination inside the backup directory', () => {
    // Two copies in one directory is not a second copy of anything, and the
    // retention run would remove both.
    const plan = planOffsite(
      { EJE_BACKUP_OFFSITE_DIR: '/var/backups/eje/copies' },
      '/var/backups/eje',
    );
    expect(plan.destinations).toEqual([]);
    expect(plan.refusal).toMatch(/is inside EJE_BACKUP_DIR/u);
  });

  it('REFUSES the backup directory itself', () => {
    expect(
      planOffsite({ EJE_BACKUP_OFFSITE_DIR: '/var/backups/eje' }, '/var/backups/eje').refusal,
    ).toMatch(/is inside EJE_BACKUP_DIR/u);
  });

  it('takes an rclone remote, and refuses something that is not one', () => {
    expect(planOffsite({ EJE_BACKUP_OFFSITE_RCLONE: 'eje-b2:eje-backups' }, '/var/backups/eje')
      .destinations).toEqual([{ kind: 'rclone', target: 'eje-b2:eje-backups' }]);

    expect(
      planOffsite({ EJE_BACKUP_OFFSITE_RCLONE: '/mnt/not-a-remote' }, '/var/backups/eje').refusal,
    ).toMatch(/is not an rclone target/u);
  });

  it('takes both at once', () => {
    const plan = planOffsite(
      { EJE_BACKUP_OFFSITE_DIR: '/mnt/offsite', EJE_BACKUP_OFFSITE_RCLONE: 'eje-b2:backups' },
      '/var/backups/eje',
    );
    expect(plan.destinations.map((entry) => entry.kind)).toEqual(['directory', 'rclone']);
  });
});

describe('a copy on the same disk', () => {
  it('is not called off-site', () => {
    const warning = sameMediaWarning('/srv/second-copy', 2049, 2049);
    expect(warning).toMatch(/SAME filesystem/u);
    expect(warning).toMatch(/must not be counted as off-site/u);
  });

  it('says nothing when the media really are different', () => {
    expect(sameMediaWarning('/mnt/offsite', 2049, 2080)).toBeNull();
  });
});

describe('what rclone is asked to do', () => {
  it('copies and then CHECKS, because a copy nobody compared is a hope', () => {
    expect(rcloneCommands('/var/backups/eje/eje-x-2026', 'eje-b2:backups', 'eje-x-2026')).toEqual([
      {
        command: 'rclone',
        args: ['copy', '/var/backups/eje/eje-x-2026', 'eje-b2:backups/eje-x-2026'],
      },
      {
        command: 'rclone',
        args: ['check', '/var/backups/eje/eje-x-2026', 'eje-b2:backups/eje-x-2026'],
      },
    ]);
  });
});
