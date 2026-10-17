import { describe, expect, it } from 'vitest';
import {
  OFFLINE_ACTIONS,
  ONLINE_ONLY,
  canCaptureOffline,
  classifyRefusal,
  isOfflineAction,
  type CaptureContext,
} from './offline-rules';

/**
 * WHAT A TABLET MAY DO WITH NO SIGNAL. OFF-2, OFF-9.
 *
 * These tests are the contract, not a description of the code: the allowed set
 * is four append-only captures, and the thing most likely to go wrong in six
 * months is somebody adding a fifth that overwrites server data. So the
 * refusals are asserted one by one, by name.
 */
const context = (overrides: Partial<CaptureContext> = {}): CaptureContext => ({
  status: 'in_progress',
  mine: true,
  signed: false,
  observedAt: '2026-10-17T09:00:00.000Z',
  ...overrides,
});

describe('what may be captured offline', () => {
  it('allows exactly the four append-only captures', () => {
    expect([...OFFLINE_ACTIONS]).toEqual(['add_labour', 'add_travel', 'add_part', 'add_note']);
    for (const action of OFFLINE_ACTIONS) {
      expect(canCaptureOffline(action, context()).allowed).toBe(true);
    }
  });

  it('refuses everything that REPLACES a value on the server', () => {
    // The silent overwrite CR-02 forbids. Each of these would replace
    // whatever the office put there while the tablet was away.
    for (const action of [
      'save_report',
      'set_callout',
      'set_collection',
      'set_media_visibility',
      'update_labour',
      'update_travel',
      'update_part',
    ]) {
      const verdict = canCaptureOffline(action, context());
      expect(verdict.allowed, action).toBe(false);
      expect(verdict.reason, action).toBe(ONLINE_ONLY[action]);
    }
  });

  it('refuses the checklist, which needs a conflict rule that does not exist', () => {
    expect(canCaptureOffline('answer_checklist', context()).allowed).toBe(false);
    expect(canCaptureOffline('complete_checklist', context()).allowed).toBe(false);
    expect(canCaptureOffline('add_checklist_photo', context()).allowed).toBe(false);
  });

  it('refuses a signature and a refusal outright. OFF-5', () => {
    expect(canCaptureOffline('capture_signature', context()).allowed).toBe(false);
    expect(canCaptureOffline('record_signature_refusal', context()).allowed).toBe(false);
  });

  it('refuses every workflow transition', () => {
    for (const action of ['accept', 'start_completion', 'issue', 'awaiting_spares']) {
      expect(canCaptureOffline(action, context()).allowed, action).toBe(false);
    }
  });

  it('refuses media, which is bytes rather than a field. OFF-12', () => {
    expect(canCaptureOffline('add_media', context()).allowed).toBe(false);
    expect(canCaptureOffline('remove_media', context()).allowed).toBe(false);
  });

  it('refuses an action it has never heard of, rather than allowing it', () => {
    const verdict = canCaptureOffline('do_something_new', context());
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('needs a connection');
    expect(isOfflineAction('do_something_new')).toBe(false);
  });
});

describe('the state of the job on this device', () => {
  it('refuses capture against a signed job card, whatever else is true', () => {
    // CR-01 / IMMUT-1…7. Asked first, because a signed job is final.
    const verdict = canCaptureOffline('add_labour', context({ signed: true }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('signed');
  });

  it('refuses capture against a job that is not this technician’s', () => {
    const verdict = canCaptureOffline('add_labour', context({ mine: false }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('not assigned to you');
  });

  it('allows capture only while the job is in progress', () => {
    expect(canCaptureOffline('add_labour', context({ status: 'in_progress' })).allowed).toBe(true);
    for (const status of [
      'open',
      'awaiting_spares',
      'completion',
      'customer_signature',
      'review',
      'submitted',
      'closed',
      'cancelled',
    ] as const) {
      expect(canCaptureOffline('add_labour', context({ status })).allowed, status).toBe(false);
    }
  });

  it('puts the signature check ahead of the status check', () => {
    // A signed job sits at `review` or beyond, so the wording has to come from
    // the signature rather than from the status — it is the more useful fact.
    const verdict = canCaptureOffline('add_labour', context({ signed: true, status: 'review' }));
    expect(verdict.reason).toContain('signed');
  });
});

describe('classifying what the server said', () => {
  it('treats a transport failure as "try again", so the work stays queued', () => {
    expect(classifyRefusal('network')).toBe('retry');
    expect(classifyRefusal('internal_error')).toBe('retry');
    expect(classifyRefusal('rate_limited')).toBe('retry');
    expect(classifyRefusal(null)).toBe('retry');
  });

  it('treats a DECISION as a conflict a person has to resolve', () => {
    // Each of these means the server considered the request and refused it:
    // the job was signed or closed, it is not this actor's, it is no longer
    // visible to them, somebody wrote first, or the session is over. Retrying
    // would produce the same answer.
    for (const code of [
      'workflow_refused',
      'not_permitted',
      'not_found',
      'version_conflict',
      'unauthenticated',
      'validation_failed',
      'conflict',
    ]) {
      expect(classifyRefusal(code), code).toBe('conflict');
    }
  });
});
