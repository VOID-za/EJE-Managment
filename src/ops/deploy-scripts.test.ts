import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THE SERVER SCRIPTS THAT CAN LOCK SOMEBODY OUT, TESTED. Security audit,
 * 24 October 2026.
 *
 * `deploy/ssh/harden-sshd.sh` turns password logins off and
 * `deploy/firewall/ufw-apply.sh` turns a firewall on — the two changes that can
 * cut the only way into the server. Each ships with a shell test that drives it
 * against stub commands (sshd, systemctl, systemd-run, journalctl, ssh, ufw),
 * including the failure that actually happened: the auto-revert firing before
 * the confirmation, and a "confirm" that then reported success on a server that
 * had already gone back. This runs those tests wherever there is a POSIX shell
 * — in CI on Linux — and pins the line endings, because a CRLF in a script piped
 * to the server over SSH is a command the server cannot run.
 */
const posix = process.platform !== 'win32';

describe.skipIf(!posix)('server scripts, against stub commands', () => {
  for (const test of ['deploy/ssh/harden-sshd.test.sh', 'deploy/firewall/ufw-apply.test.sh']) {
    it(`${test} passes`, () => {
      const result = spawnSync('bash', [test], { encoding: 'utf8', timeout: 60_000 });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toMatch(/\d+ passed, 0 failed/u);
    });
  }
});

describe('server scripts are LF-only', () => {
  for (const script of [
    'deploy/ssh/harden-sshd.sh',
    'deploy/ssh/harden-sshd.test.sh',
    'deploy/firewall/ufw-apply.sh',
    'deploy/firewall/ufw-apply.test.sh',
  ]) {
    it(`${script} has no carriage returns`, () => {
      expect(readFileSync(script, 'utf8').includes('\r')).toBe(false);
    });
  }
});
