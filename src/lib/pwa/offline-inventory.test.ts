import { describe, expect, it } from 'vitest';
import { JOB_COMMANDS } from '@/server/api/commands/jobs';
import {
  NON_COMMAND_FIELD_ACTIONS,
  OFFLINE_ACTIONS,
  ONLINE_ONLY,
  canCaptureOffline,
} from './offline-rules';

/**
 * EVERY JOB COMMAND HAS AN OFFLINE ANSWER, AND IT IS WRITTEN DOWN. OFF-6.
 *
 * `offline-rules.test.ts` asserts the allowlist as a literal list, which makes
 * WIDENING it a decision. It cannot see the other direction, and that is where
 * this system actually drifts: a new job command is added to the server, a
 * screen calls it, and `canCaptureOffline` — which answers by looking the
 * action up — falls through to "This needs a connection to the EJE server",
 * the generic sentence that is true of everything and useful for nothing. The
 * technician standing at a machine with no signal is told the same thing about
 * a part they could have captured as about a signature they could not.
 *
 * So the two sides are compared here, against the REAL command registry rather
 * than a list copied beside it. Adding a command to the server without deciding
 * what it means on a tablet fails this test, by name.
 *
 * It does not decide the answer for anybody: a command may be offline-capturable
 * or online-only, and this only insists that somebody said which, in words a
 * technician can read.
 */
describe('the offline inventory and the server agree', () => {
  const commands = Object.keys(JOB_COMMANDS).sort();

  it('has a server command registry worth comparing against', () => {
    // A registry this test could not read would make every assertion below
    // vacuously true.
    expect(commands.length).toBeGreaterThan(10);
    expect(commands).toContain('add_labour');
  });

  it('accounts for EVERY job command, either holdable or refused with a reason', () => {
    const accounted = new Set<string>([...OFFLINE_ACTIONS, ...Object.keys(ONLINE_ONLY)]);
    const unaccounted = commands.filter((command) => !accounted.has(command));

    expect(
      unaccounted,
      `these job commands have no offline decision: ${unaccounted.join(', ')}. Add each one to ` +
        'OFFLINE_ACTIONS (and to the list in offline-rules.test.ts), or to ONLINE_ONLY with the ' +
        'reason a technician should be shown.',
    ).toEqual([]);
  });

  it('carries no refusal for a command that no longer exists', () => {
    /*
     * A photograph is not a JSON command — it arrives as multipart bytes at its
     * own route — so those two are declared beside the map rather than being
     * mistaken for entries somebody forgot to delete.
     */
    const known = new Set([...commands, ...NON_COMMAND_FIELD_ACTIONS]);
    const stale = Object.keys(ONLINE_ONLY).filter((action) => !known.has(action));
    expect(
      stale,
      `ONLINE_ONLY explains these, and the server has no such command: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it('gives each online-only command its OWN reason, not the generic one', () => {
    const context = {
      status: 'in_progress' as const,
      mine: true,
      signed: false,
      observedAt: '2026-10-18T08:00:00.000Z',
    };
    for (const action of commands.filter((name) => !OFFLINE_ACTIONS.includes(name as never))) {
      const verdict = canCaptureOffline(action, context);
      expect(verdict.allowed, action).toBe(false);
      expect(verdict.reason, action).toBe(ONLINE_ONLY[action]);
      expect(verdict.reason, action).not.toMatch(/^This needs a connection to the EJE server/u);
    }
  });
});
