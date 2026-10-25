import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THE GUARDED RELEASE SCRIPT, TESTED IN CI. Release readiness, de0d9b6.
 *
 * `deploy/release/deploy-release.sh` switches the live application, so it ships
 * with a shell test that drives it against a sandbox — every gate, every
 * failure path, every rollback. This runs that test wherever there is a POSIX
 * shell with real symlinks (CI's Linux), which is where the atomic switch is
 * proven; on Windows the suite runs with emulated links, by hand.
 *
 * A file of its own rather than a line in `deploy-scripts.test.ts`, which
 * covers the SSH and firewall scripts and is being changed separately.
 */
const posix = process.platform !== 'win32';

describe.skipIf(!posix)('the guarded release script, against a sandbox', () => {
  it('deploy/release/deploy-release.test.sh passes', () => {
    const result = spawnSync('bash', ['deploy/release/deploy-release.test.sh'], {
      encoding: 'utf8',
      timeout: 180_000,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/\d+ passed, 0 failed/u);
  }, 200_000);
});

describe('release scripts are LF-only', () => {
  for (const script of [
    'deploy/release/deploy-release.sh',
    'deploy/release/deploy-release.test.sh',
    'scripts/release/rollback-compat.sh',
  ]) {
    it(`${script} has no carriage returns`, () => {
      expect(readFileSync(script, 'utf8').includes('\r')).toBe(false);
    });
  }
});
