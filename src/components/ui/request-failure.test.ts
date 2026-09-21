import { describe, expect, it } from 'vitest';
import type { ApiErrorCode } from '@/api/client';
import { describeFailure, isDenied } from './request-failure';

/**
 * What a failed read is allowed to tell somebody.
 *
 * Every screen used to render one panel for every outcome — "Something went
 * wrong. Try again." — which was wrong twice over. It told a technician who had
 * been correctly refused that the system was broken, and it made a genuine
 * server fault indistinguishable from a refusal for anybody trying to report
 * one.
 *
 * These hold the mapping itself, which is the part that can be got wrong. The
 * component only draws what this returns.
 */
describe('a refusal', () => {
  const denied = describeFailure('forbidden', 'The customer register is an office screen.');

  it('is presented as a refusal, not as a fault', () => {
    expect(denied.kind).toBe('denied');
    expect(denied.title).not.toContain('went wrong');
  });

  it('offers no retry, because it would be refused again', () => {
    expect(denied.retryable).toBe(false);
  });

  it('says what to do about it without naming what is missing', () => {
    const text = `${denied.title} ${denied.message}`.toLowerCase();

    // Nothing about the authorization model reaches the screen: not the
    // capability, not the role that would have been enough, not the rule.
    for (const leak of [
      'capability',
      'customers.',
      'jobs.',
      'admin.',
      'master',
      'coordinator',
      'technician',
      'permission denied',
      'forbidden',
      '403',
    ]) {
      expect(text).not.toContain(leak);
    }
  });

  it('does not repeat the server’s own sentence back to the person', () => {
    // The server writes for the API and names the screen. What the person is
    // told is written here, so a future server message cannot leak through it.
    expect(denied.message).not.toContain('customer register');
  });
});

describe('a genuine server fault', () => {
  const fault = describeFailure('internal_error', 'Something went wrong. Please try again.');

  it('stays distinguishable from a refusal', () => {
    expect(fault.kind).toBe('fault');
    expect(fault.kind).not.toBe(describeFailure('forbidden', null).kind);
  });

  it('is the case where trying again is honest', () => {
    expect(fault.retryable).toBe(true);
  });

  it('is what an unrecognised code falls back to, rather than a refusal', () => {
    // A code this build has never heard of is a fault, never an access answer:
    // the safe reading of an unknown failure is that something broke.
    const unknown = describeFailure('something-new' as ApiErrorCode, null);
    expect(unknown.kind).toBe('fault');
  });

  it('is what a loader that threw on its own becomes', () => {
    // `useQuery` has no code for a non-API failure and passes `internal_error`.
    expect(describeFailure('internal_error', null).kind).toBe('fault');
  });
});

describe('the other answers a screen can get', () => {
  it('treats not found as neither a refusal nor a fault', () => {
    const missing = describeFailure('not_found', 'That customer does not exist.');
    expect(missing.kind).toBe('missing');
    expect(missing.retryable).toBe(false);
  });

  it('says plainly when the session has ended', () => {
    expect(describeFailure('unauthenticated', null).kind).toBe('signed_out');
  });

  it('separates the network from the server', () => {
    const offline = describeFailure('network', 'No connection to the EJE server.');
    expect(offline.kind).toBe('offline');
    // Worth trying again: the server was never asked.
    expect(offline.retryable).toBe(true);
  });

  it('keeps a business refusal’s own sentence, which is the point of it', () => {
    const refused = describeFailure(
      'workflow_refused',
      'The checklist has 3 outstanding items.',
    );
    expect(refused.message).toBe('The checklist has 3 outstanding items.');
    expect(refused.retryable).toBe(false);
  });

  it('tells somebody their copy is out of date rather than that it broke', () => {
    expect(describeFailure('version_conflict', null).kind).toBe('stale');
  });
});

describe('every code a response can carry', () => {
  const ALL: readonly ApiErrorCode[] = [
    'validation_failed',
    'unauthenticated',
    'forbidden',
    'not_found',
    'conflict',
    'version_conflict',
    'rate_limited',
    'workflow_refused',
    'internal_error',
    'network',
  ];

  it('produces a sentence for all of them, with no code left unhandled', () => {
    for (const code of ALL) {
      const failure = describeFailure(code, null);
      expect(failure.title.length).toBeGreaterThan(0);
      expect(failure.message.length).toBeGreaterThan(0);
    }
  });

  it('calls exactly one of them a refusal', () => {
    expect(ALL.filter((code) => describeFailure(code, null).kind === 'denied')).toEqual([
      'forbidden',
    ]);
    expect(ALL.filter((code) => isDenied(code))).toEqual(['forbidden']);
    expect(isDenied(null)).toBe(false);
  });
});
