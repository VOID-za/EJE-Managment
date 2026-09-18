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
