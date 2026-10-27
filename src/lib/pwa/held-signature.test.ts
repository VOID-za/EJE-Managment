import { describe, expect, it } from 'vitest';
import { checkSignatureHoldable, referredOutcome } from './held-signature';

/**
 * BD-23 ON THE TABLET. Whether a signature may be HELD is about honesty — the
 * customer was shown the complete, current document — and these cases are the
 * ways that can fail. Whether it is ACCEPTED is the server's, tested in
 * `offline-signature.test.ts` and `offline-signature-api.test.ts`.
 */
const IDENTITY = `jcm1:${'a'.repeat(64)}`;
const shown = { identity: IDENTITY, pdfSha256: 'b'.repeat(64), photosMissing: 0 };

describe('whether a signature may be held with no signal', () => {
  it('is allowed when the complete, current document was shown and nothing else is held', () => {
    expect(checkSignatureHoldable({ presented: shown, currentIdentity: IDENTITY, heldForJob: 0 })).toEqual({
      allowed: true,
      reason: null,
    });
  });

  it('is refused when no document was drawn, or this browser cannot fingerprint one', () => {
    expect(checkSignatureHoldable({ presented: null, currentIdentity: IDENTITY, heldForJob: 0 }).allowed).toBe(false);
    expect(
      checkSignatureHoldable({ presented: { ...shown, identity: null }, currentIdentity: null, heldForJob: 0 })
        .allowed,
    ).toBe(false);
  });

  it('is refused when the document on screen is older than the job the screen now holds', () => {
    const verdict = checkSignatureHoldable({
      presented: shown,
      currentIdentity: `jcm1:${'c'.repeat(64)}`,
      heldForJob: 0,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('not the latest copy');
  });

  it('is refused when a photograph on the document could not be shown', () => {
    const verdict = checkSignatureHoldable({
      presented: { ...shown, photosMissing: 2 },
      currentIdentity: IDENTITY,
      heldForJob: 0,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('2 photographs');
  });

  it('is refused while unsent work for the job is held — the card shown is not the one EJE will issue', () => {
    const verdict = checkSignatureHoldable({ presented: shown, currentIdentity: IDENTITY, heldForJob: 1 });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('still holding work');
  });
});

describe('reading the server’s answer to a held signature', () => {
  it('recognises a referral, with its id and the server’s reason', () => {
    expect(
      referredOutcome({
        outcome: 'referred',
        reason: 'document_changed',
        message: 'The job card changed.',
        referral: { id: 'ref-1' },
      }),
    ).toEqual({ referralId: 'ref-1', reason: 'document_changed', message: 'The job card changed.' });
  });

  it('never mistakes an acceptance, a bare job, or nothing for a referral', () => {
    expect(referredOutcome({ outcome: 'accepted', job: { jobNumber: 'EJE-1' } })).toBeNull();
    expect(referredOutcome({ jobNumber: 'EJE-1', status: 'review' })).toBeNull();
    expect(referredOutcome(null)).toBeNull();
    expect(referredOutcome({ outcome: 'referred' })).toBeNull();
  });
});
