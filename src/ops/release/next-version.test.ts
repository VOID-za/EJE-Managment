import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  FIRST_VERSION,
  bumpOfCommit,
  bumpOfCommits,
  compareVersions,
  highestVersion,
  nextVersion,
  withOverride,
} from '../../../scripts/release/next-version.mjs';

/**
 * VERSION-1 (3 November 2026): every release gets the next semantic version,
 * worked out by the release itself — from the highest version ever recorded
 * and the commits since what is live — never typed by a person.
 */
describe('the next semantic version', () => {
  it('the first versioned release is 1.0.0', () => {
    expect(FIRST_VERSION).toBe('1.0.0');
    expect(nextVersion('', 'minor')).toBe('1.0.0');
    expect(nextVersion(null, 'major')).toBe('1.0.0');
  });

  it('PATCH, MINOR and MAJOR step as Semantic Versioning says', () => {
    expect(nextVersion('1.0.0', 'patch')).toBe('1.0.1');
    expect(nextVersion('1.0.9', 'minor')).toBe('1.1.0');
    expect(nextVersion('1.4.2', 'major')).toBe('2.0.0');
    expect(nextVersion('1.9.9', 'patch')).toBe('1.9.10');
  });

  it('reads the step from Conventional Commits: feat → minor, a breaking change → major, anything else → patch', () => {
    expect(bumpOfCommit('fix(STANDBY-DAY-2): trade both places')).toBe('patch');
    expect(bumpOfCommit('style(STANDBY-DASH-3): two colour groups')).toBe('patch');
    expect(bumpOfCommit('docs: record the release')).toBe('patch');
    expect(bumpOfCommit('feat(DELIVERY-NOTE-1): the Delivery Note job type')).toBe('minor');
    expect(bumpOfCommit('feat!: a new data model')).toBe('major');
    expect(bumpOfCommit('refactor(api)!: remove the v1 routes')).toBe('major');
    expect(bumpOfCommit('feat: x\n\nBREAKING CHANGE: the old API is gone')).toBe('major');
    expect(bumpOfCommits(['docs: a', 'fix: b', 'feat(x): c'])).toBe('minor');
    expect(bumpOfCommits([])).toBe('patch');
  });

  it('an override may raise the step, never lower it', () => {
    expect(withOverride('patch', 'minor')).toBe('minor');
    expect(withOverride('minor', 'patch')).toBe('minor');
    expect(withOverride('minor', '')).toBe('minor');
    expect(withOverride('patch', 'nonsense')).toBe('patch');
  });

  it('starts from the HIGHEST version ever recorded, so none is reused after a rollback or a failed release', () => {
    expect(highestVersion(['1.0.0', '1.2.0', '1.1.3', 'unknown', ''])).toBe('1.2.0');
    expect(highestVersion([])).toBeNull();
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(nextVersion(highestVersion(['1.0.0', '1.1.0']), 'patch')).toBe('1.1.1');
  });

  it('the command prints the next version (a re-release with no new commit is still a new PATCH)', () => {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const run = (args: string[], env: Record<string, string> = {}) =>
      spawnSync(process.execPath, ['scripts/release/next-version.mjs', ...args], { encoding: 'utf8', env: { ...process.env, ...env } }).stdout.trim();
    expect(run(['--previous', '', '--from', head, '--to', head])).toBe('1.0.0');
    expect(run(['--previous', '2.3.4', '--from', head, '--to', head])).toBe('2.3.5');
    expect(run(['--previous', '2.3.4', '--from', head, '--to', head], { EJE_RELEASE_BUMP: 'minor' })).toBe('2.4.0');
  });
});
