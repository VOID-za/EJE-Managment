import { describe, expect, it } from 'vitest';
import {
  OFFLINE_ACTIONS,
  ONLINE_ONLY,
  canCaptureOffline,
  classifyRefusal,
  isOfflineAction,
  isReferralApplicable,
  OFFLINE_SIGNATURE_ACTIONS,
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
  it('allows exactly the four append-only captures, the checklist answer and the held signature and refusal', () => {
    /*
     * THE WHOLE LIST, ASSERTED AS A LIST. An action that joins it has to be
     * added here as well, which is the point: widening what a tablet may hold
     * is a decision, not a refactor.
     *
     * `answer_checklist` joined it for OFF-CHK-1, and it is the one entry that
     * is not append-only — see the file's own header, and the expectation the
     * capture has to carry for the server to accept it.
     */
    expect([...OFFLINE_ACTIONS]).toEqual([
      'add_labour',
      'add_travel',
      'add_part',
      'add_note',
      'answer_checklist',
      // BD-23, approved 27 October 2026.
      'capture_signature_offline',
      'record_refusal_offline',
    ]);
    for (const action of OFFLINE_ACTIONS) {
      const status = OFFLINE_SIGNATURE_ACTIONS.includes(action) ? 'customer_signature' : 'in_progress';
      expect(canCaptureOffline(action, context({ status })).allowed, action).toBe(true);
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

  it('allows a checklist ANSWER and still refuses completing it, or its evidence', () => {
    /*
     * OFF-CHK-1. The answer became holdable once the capture could say what it
     * was answering — the instance and the answer it replaces — so a stale one
     * is refused by the server instead of overwriting (`ChecklistExpectation`).
     *
     * The other two did not, and the reasons are different: COMPLETING the
     * checklist is a gate evaluated against the template, which is a decision
     * for the server and not a row to be held; EVIDENCE is bytes, which this
     * queue does not carry (OFF-12).
     */
    expect(canCaptureOffline('answer_checklist', context()).allowed).toBe(true);

    const completing = canCaptureOffline('complete_checklist', context());
    expect(completing.allowed).toBe(false);
    expect(completing.reason).toBe(ONLINE_ONLY['complete_checklist']);

    const evidence = canCaptureOffline('add_checklist_photo', context());
    expect(evidence.allowed).toBe(false);
    expect(evidence.reason).toBe(ONLINE_ONLY['add_checklist_photo']);
  });

  it('still refuses a checklist answer on a job that is not this technician’s, or signed', () => {
    // The capture context narrows the answer exactly as it narrows labour:
    // being holdable is not being holdable on anything.
    expect(canCaptureOffline('answer_checklist', context({ mine: false })).allowed).toBe(false);
    expect(canCaptureOffline('answer_checklist', context({ signed: true })).allowed).toBe(false);
    expect(canCaptureOffline('answer_checklist', context({ status: 'completion' })).allowed).toBe(
      false,
    );
  });

  it('keeps the ONLINE signature and refusal commands online-only. OFF-5', () => {
    // BD-23 added two commands of their own; it did not make these holdable.
    expect(canCaptureOffline('capture_signature', context()).allowed).toBe(false);
    expect(canCaptureOffline('record_refusal', context()).allowed).toBe(false);
    expect(canCaptureOffline('start_signature', context()).allowed).toBe(false);
  });

  it('holds a signature or refusal ONLY at Customer Signature, on the technician’s own unsigned job. BD-23', () => {
    for (const action of OFFLINE_SIGNATURE_ACTIONS) {
      expect(canCaptureOffline(action, context({ status: 'customer_signature' })).allowed, action).toBe(true);
      for (const status of ['in_progress', 'completion', 'review', 'closed', 'open'] as const) {
        const verdict = canCaptureOffline(action, context({ status }));
        expect(verdict.allowed, `${action} at ${status}`).toBe(false);
        expect(verdict.reason).toContain('waiting for the customer');
      }
      expect(canCaptureOffline(action, context({ status: 'customer_signature', signed: true })).allowed).toBe(false);
      expect(canCaptureOffline(action, context({ status: 'customer_signature', mine: false })).allowed).toBe(false);
    }
  });

  it('never lets the office APPLY a referred signature or refusal; ordinary captures still can be. BD-15, BD-23', () => {
    expect(isReferralApplicable('capture_signature_offline')).toBe(false);
    expect(isReferralApplicable('record_refusal_offline')).toBe(false);
    expect(isReferralApplicable('capture_signature')).toBe(false);
    for (const action of ['add_labour', 'add_travel', 'add_part', 'add_note', 'answer_checklist']) {
      expect(isReferralApplicable(action), action).toBe(true);
    }
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
    // visible to them, somebody wrote first, or the details are invalid.
    // Retrying would produce the same answer, so a person decides — and under
    // BD-15 the capture is referred to the office.
    for (const code of [
      'workflow_refused',
      'not_permitted',
      'not_found',
      'version_conflict',
      'validation_failed',
      'conflict',
    ]) {
      expect(classifyRefusal(code), code).toBe('conflict');
    }
  });

  it('treats a REVOKED SESSION as blocked, not as a refusal of the work', () => {
    /*
     * BD-16, and a defect this fixes. A 401 used to be classified as a
     * conflict, so a technician whose session expired mid-flush had their
     * captures marked refused-by-the-server and referred to the office — when
     * the server had said nothing about the work at all. The remedy is signing
     * in again, not an office decision, so the work stays queued untouched.
     */
    expect(classifyRefusal('unauthenticated')).toBe('blocked');
  });
});
