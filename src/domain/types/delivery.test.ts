import { describe, expect, it } from 'vitest';
import {
  DELIVERY_FAILURE_KINDS,
  deliveryRetryAdvice,
  emptyDelivery,
  isDeliveryFailureKind,
  isRetryableDeliveryFailure,
  type DeliveryFailureKind,
} from './delivery';

/**
 * WHETHER *SEND AGAIN* CAN WORK, AND WHAT TO SAY IF IT CANNOT. MANDATE-3.
 *
 * The office has one button and a sentence written by a mail provider. These
 * are the rules that turn that sentence into an instruction, and they live in
 * the domain because "can this be sent, and if not, what has to change?" is
 * EJE's question rather than Microsoft's.
 *
 * Every kind is covered on purpose: a kind added without an answer here is a
 * kind that reaches a screen with nothing useful beside it.
 */
describe('classifying a delivery failure', () => {
  it('recognises exactly the kinds the domain declares', () => {
    for (const kind of DELIVERY_FAILURE_KINDS) {
      expect(isDeliveryFailureKind(kind), kind).toBe(true);
    }
    // The column holding this is `text`, so an unknown string must read as
    // unclassified rather than arriving as a kind nothing can narrow.
    expect(isDeliveryFailureKind('invented_by_a_later_provider')).toBe(false);
    expect(isDeliveryFailureKind(null)).toBe(false);
    expect(isDeliveryFailureKind(undefined)).toBe(false);
    expect(isDeliveryFailureKind(7)).toBe(false);
  });

  it('says a retry can resolve exactly four of them', () => {
    const retryable = DELIVERY_FAILURE_KINDS.filter((kind) => isRetryableDeliveryFailure(kind));
    expect([...retryable].sort()).toEqual([
      'provider_unavailable',
      'throttled',
      'timed_out',
      'unreachable',
    ]);
    // An unclassified failure is not claimed to be retryable either way.
    expect(isRetryableDeliveryFailure(null)).toBe(false);
  });

  /*
   * THE FIVE THAT NEED A PERSON, each named so a screen cannot blur them: a
   * credential, a permission, an address, a document size, a deployment that
   * was never configured.
   */
  it('tells the office what has to change when a retry cannot help', () => {
    const cases: Readonly<Record<string, RegExp>> = {
      not_configured: /no customer email configured/u,
      credentials_rejected: /credential/u,
      permission_denied: /not allowed to send as that mailbox/u,
      invalid_recipient: /Correct it on the customer/u,
      attachment_too_large: /larger than the mail provider accepts/u,
      document_unavailable: /storage problem/u,
    };
    for (const [kind, expected] of Object.entries(cases)) {
      const advice = deliveryRetryAdvice(kind as DeliveryFailureKind);
      expect(advice, kind).toMatch(expected);
      expect(isRetryableDeliveryFailure(kind as DeliveryFailureKind), kind).toBe(false);
    }
  });

  it('says plainly that the retryable four are worth trying', () => {
    expect(deliveryRetryAdvice('throttled')).toMatch(/Trying again shortly should work/u);
    expect(deliveryRetryAdvice('provider_unavailable')).toMatch(/Trying again should work/u);
    expect(deliveryRetryAdvice('timed_out')).toMatch(/Nothing was sent/u);
    expect(deliveryRetryAdvice('unreachable')).toMatch(/once the connection is back/u);
  });

  it('EVERY kind has advice, because a kind with none reaches a screen bare', () => {
    for (const kind of DELIVERY_FAILURE_KINDS) {
      expect(deliveryRetryAdvice(kind).length, kind).toBeGreaterThan(0);
    }
  });

  it('says nothing at all about an unclassified failure rather than guessing', () => {
    expect(deliveryRetryAdvice(null)).toBe('');
  });

  it('starts a delivery record with no failure to classify', () => {
    const fresh = emptyDelivery('accounts@abc.example', '2026-10-18T08:00:00.000Z');
    expect(fresh.failureKind).toBeNull();
    expect(fresh.failureReason).toBe('');
    expect(fresh.state).toBe('not_started');
  });
});
