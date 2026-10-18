import type { IsoDateTime } from './common';

/**
 * Where a message actually got to.
 *
 * The distinction this type exists to enforce: a provider ACCEPTING a send
 * request is not the customer RECEIVING the mail. Microsoft 365 returns 202 the
 * moment it takes the message; the mailbox on the other side may still bounce,
 * be full, or reject it minutes later. Telling a technician "sent successfully"
 * on the strength of that 202 is telling them something nobody knows yet.
 *
 * So acceptance and delivery are different states, and only `delivered` means
 * the customer has it.
 */
export type DeliveryState =
  /** Nothing has been attempted. */
  | 'not_started'
  /** The request is in flight. */
  | 'sending'
  /** The provider accepted it. Nobody has confirmed the customer received it. */
  | 'pending_delivery'
  /** The provider confirmed delivery to the recipient. */
  | 'delivered'
  /** Rejected, bounced, or the transport failed. */
  | 'failed';

/**
 * WHY A CUSTOMER'S COPY DID NOT GO, IN THE TERMS THAT DECIDE WHAT HAPPENS NEXT.
 *
 * The office has one button — *Send again* — and a failure reason written by a
 * mail provider. For four of these kinds that button works. For the rest it
 * cannot possibly work until somebody changes something: a credential, a
 * permission, the customer's address, the size of the document, the
 * deployment's configuration. Pressing it again is then a person losing an
 * afternoon to a problem nobody has told them about.
 *
 * SO THE KIND IS PART OF THE RECORD, in the domain rather than in the adapter,
 * for two reasons. It is a business fact — "can this be sent, and if not, what
 * has to change?" is the office's question, not Microsoft's — and it has to
 * survive being written to the database and read back on a screen, which an
 * adapter's exception class cannot do.
 *
 * `null` is a legitimate value and means nobody classified it: an older row, or
 * a failure from a transport that does not say.
 */
export type DeliveryFailureKind =
  /** No mail transport is configured on this deployment at all. */
  | 'not_configured'
  /** The provider refused the deployment's credential. */
  | 'credentials_rejected'
  /** Authenticated, and not allowed to send as that mailbox. */
  | 'permission_denied'
  /** The provider is asking for fewer requests. */
  | 'throttled'
  /** The provider is unavailable rather than refusing. */
  | 'provider_unavailable'
  /** The address is not one the provider will accept. */
  | 'invalid_recipient'
  /** The attachment is over the provider's limit for one message. */
  | 'attachment_too_large'
  /** The stored document could not be read, so nothing was sent. */
  | 'document_unavailable'
  /** The provider accepted the connection and did not answer in time. */
  | 'timed_out'
  /** The provider could not be reached at all. */
  | 'unreachable'
  /** Anything else the provider refused, in its own words. */
  | 'provider_refused';

export const DELIVERY_FAILURE_KINDS: readonly DeliveryFailureKind[] = [
  'not_configured',
  'credentials_rejected',
  'permission_denied',
  'throttled',
  'provider_unavailable',
  'invalid_recipient',
  'attachment_too_large',
  'document_unavailable',
  'timed_out',
  'unreachable',
  'provider_refused',
];

export const isDeliveryFailureKind = (value: unknown): value is DeliveryFailureKind =>
  typeof value === 'string' && (DELIVERY_FAILURE_KINDS as readonly string[]).includes(value);

/**
 * The four a second attempt can resolve on its own.
 *
 * Everything else needs a person to change something first. Deliberately NOT
 * used to hide the *Send again* button: once the credential is corrected or the
 * address fixed, the same stored failure is exactly the one the office should
 * be able to retry. What the kind changes is what they are TOLD before they
 * press it — see `deliveryRetryAdvice`.
 */
export const isRetryableDeliveryFailure = (kind: DeliveryFailureKind | null): boolean =>
  kind === 'throttled' ||
  kind === 'provider_unavailable' ||
  kind === 'timed_out' ||
  kind === 'unreachable';

/**
 * What to tell the office before they press *Send again*.
 *
 * One function, so no screen invents its own version of "this will not work".
 * An unclassified failure says nothing extra rather than guessing.
 */
export const deliveryRetryAdvice = (kind: DeliveryFailureKind | null): string => {
  switch (kind) {
    case null:
      return '';
    case 'throttled':
      return 'The mail provider asked for fewer requests. Trying again shortly should work.';
    case 'provider_unavailable':
      return 'The mail provider was unavailable rather than refusing. Trying again should work.';
    case 'timed_out':
      return 'The mail provider did not answer in time. Nothing was sent, so trying again is safe.';
    case 'unreachable':
      return 'The mail provider could not be reached. Try again once the connection is back.';
    case 'not_configured':
      return 'This deployment has no customer email configured, so trying again will fail the same way until it is set up.';
    case 'credentials_rejected':
      return 'The mail provider refused this deployment’s credential. Trying again will fail the same way until it is corrected.';
    case 'permission_denied':
      return 'This deployment is not allowed to send as that mailbox. Trying again will fail the same way until the permission is granted.';
    case 'invalid_recipient':
      return 'The mail provider will not accept that address. Correct it on the customer’s record first — a retry sends it to the same place.';
    case 'attachment_too_large':
      return 'The job card is larger than the mail provider accepts on one message. A retry sends the same document, so it will fail the same way.';
    case 'document_unavailable':
      return 'The job card’s file could not be read from storage, which is a storage problem rather than a mail one.';
    case 'provider_refused':
      return 'The mail provider refused the message. Its own words are above.';
  }
};

export interface DeliveryRecord {
  /** The provider's message id, used to ask about it later. */
  readonly messageId: string;
  readonly state: DeliveryState;
  readonly to: string;
  /** When the provider accepted the request, if it ever did. */
  readonly acceptedAt: IsoDateTime | null;
  /** When delivery was CONFIRMED. Null unless `state` is `delivered`. */
  readonly confirmedAt: IsoDateTime | null;
  readonly updatedAt: IsoDateTime;
  /** How many times sending has been attempted, including retries. */
  readonly attempts: number;
  /** Why it failed, for the person who has to do something about it. */
  readonly failureReason: string;
  /**
   * WHICH KIND of failure, where the transport said enough to tell.
   *
   * The reason above is the provider's own sentence and belongs on the screen.
   * This is what the office can act on: whether *Send again* can work, or
   * whether something has to be changed first. Null means unclassified.
   */
  readonly failureKind: DeliveryFailureKind | null;
}

export const emptyDelivery = (to: string, at: IsoDateTime): DeliveryRecord => ({
  messageId: '',
  state: 'not_started',
  to,
  acceptedAt: null,
  confirmedAt: null,
  updatedAt: at,
  attempts: 0,
  failureReason: '',
  failureKind: null,
});

/** Only this means the customer has it. Nothing else may be reported as success. */
export const isDelivered = (delivery: DeliveryRecord | null): boolean =>
  delivery !== null && delivery.state === 'delivered';

/** Accepted by the provider, but not yet confirmed to the recipient. */
export const isAwaitingDelivery = (delivery: DeliveryRecord | null): boolean =>
  delivery !== null && (delivery.state === 'sending' || delivery.state === 'pending_delivery');

export const hasDeliveryFailed = (delivery: DeliveryRecord | null): boolean =>
  delivery !== null && delivery.state === 'failed';

export const deliveryStateLabel = (state: DeliveryState): string => {
  switch (state) {
    case 'not_started':
      return 'Not sent';
    case 'sending':
      return 'Sending';
    case 'pending_delivery':
      return 'Delivery pending';
    case 'delivered':
      return 'Delivered';
    case 'failed':
      return 'Delivery failed';
  }
};

/**
 * What to tell the person who pressed the button.
 *
 * Deliberately one function, so no screen can invent its own wording for
 * "sent successfully" — the phrase only ever appears for `delivered`.
 */
export const deliveryMessage = (delivery: DeliveryRecord | null, reference: string): string => {
  if (delivery === null || delivery.state === 'not_started') {
    return `${reference} has not been sent to the customer yet.`;
  }
  switch (delivery.state) {
    case 'sending':
      return `${reference} is being sent to ${delivery.to}.`;
    case 'pending_delivery':
      return `${reference} was submitted. Delivery to ${delivery.to} is still pending — the job stays open until the customer's copy arrives.`;
    case 'delivered':
      return `${reference} was successfully submitted and delivered to ${delivery.to}.`;
    case 'failed':
      return `${reference} could not be delivered to ${delivery.to}. The job has not been closed.`;
  }
};
