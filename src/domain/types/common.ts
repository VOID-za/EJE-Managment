import type { Provenance } from './provenance';
/**
 * Shared primitive types for the EJE domain model.
 *
 * Branded id types keep entity identifiers from being accidentally swapped.
 * They cost nothing at runtime and survive the move to a real database, where
 * they will simply wrap UUIDs instead of seeded string ids.
 */

declare const brand: unique symbol;

type Brand<T, B extends string> = T & { readonly [brand]: B };

export type CustomerId = Brand<string, 'CustomerId'>;
export type SiteId = Brand<string, 'SiteId'>;
export type ContactId = Brand<string, 'ContactId'>;
export type MachineId = Brand<string, 'MachineId'>;
export type JobId = Brand<string, 'JobId'>;
export type UserId = Brand<string, 'UserId'>;
export type DocumentId = Brand<string, 'DocumentId'>;
export type NotificationId = Brand<string, 'NotificationId'>;
export type ActivityId = Brand<string, 'ActivityId'>;
export type ChecklistTemplateId = Brand<string, 'ChecklistTemplateId'>;
export type AttachmentId = Brand<string, 'AttachmentId'>;
export type LineItemId = Brand<string, 'LineItemId'>;

export const asCustomerId = (value: string): CustomerId => value as CustomerId;
export const asSiteId = (value: string): SiteId => value as SiteId;
export const asContactId = (value: string): ContactId => value as ContactId;
export const asMachineId = (value: string): MachineId => value as MachineId;
export const asJobId = (value: string): JobId => value as JobId;
export const asUserId = (value: string): UserId => value as UserId;
export const asDocumentId = (value: string): DocumentId => value as DocumentId;
export const asNotificationId = (value: string): NotificationId => value as NotificationId;
export const asActivityId = (value: string): ActivityId => value as ActivityId;
export const asChecklistTemplateId = (value: string): ChecklistTemplateId =>
  value as ChecklistTemplateId;
export const asAttachmentId = (value: string): AttachmentId => value as AttachmentId;
export const asLineItemId = (value: string): LineItemId => value as LineItemId;

/** ISO-8601 timestamp string. Stored as text in the demo, `timestamptz` in Phase 2. */
export type IsoDateTime = string;

/** ISO-8601 calendar date (YYYY-MM-DD). */
export type IsoDate = string;

/**
 * Money is held in South African cents as an integer. Floating point currency
 * arithmetic is a production bug waiting to happen, so the demo avoids it from
 * the start.
 */
export type Cents = number;

/**
 * Who a piece of media is FOR. MEDIA-1.
 *
 * `customer_facing` is evidence the customer is entitled to see on their job
 * card. `internal` is what a technician captures for EJE alone — a damaged part
 * being claimed for, an unsafe installation, a note to the workshop — and it is
 * kept OFF the customer's document (MEDIA-2).
 *
 * Named for the audience, not for what is hidden: `internal: true` would read as
 * a double negative at every call site that asks whether to show something.
 */
export type MediaVisibility = 'customer_facing' | 'internal';

export interface Attachment {
  readonly id: AttachmentId;
  readonly kind: 'photo' | 'video' | 'document';
  /**
   * Who this is for. MEDIA-1.
   *
   * `customer_facing` unless somebody said otherwise, which is what every
   * attachment captured before this field existed was in effect — the customer
   * document printed them all.
   */
  readonly visibility: MediaVisibility;
  readonly fileName: string;
  readonly caption: string;
  /**
   * In the demo this is a deterministic placeholder reference resolved by the
   * storage service. In production it becomes an object-storage key.
   */
  readonly storageKey: string;
  readonly uploadedAt: IsoDateTime;
  readonly uploadedBy: UserId;
  /** Measured off the stored bytes. Zero means nothing is stored. */
  readonly sizeBytes: number;
  /**
   * SHA-256 of those bytes, lower-case hex. Null when nothing measured them.
   *
   * WHY IT WAS MISSING, because it is the kind of gap that hides in plain
   * sight: `job_media` has carried a `checksum_sha256` column since the table
   * existed and no code ever wrote to it. A customer's filed document and a
   * machine manual both recorded one; the photographs a customer SIGNS FOR did
   * not. So the store could refuse bytes that had changed since they were
   * written, and nothing could say whether a photograph that reads back
   * cleanly is the photograph the technician took.
   *
   * NULL MEANS NOBODY MEASURED IT and is the truth for every row written
   * before this field existed, and for the seeded demonstration photographs,
   * which have no bytes at all. A zero-length string would claim a
   * measurement; null says there is none.
   */
  readonly checksumSha256: string | null;
  /**
   * A real attachment, or demonstration data. October mandate §1.
   *
   * Defaulted nowhere: every path that records an attachment says which it is,
   * so a screen never has to guess from a file name. The seeded machine
   * photographs are the only `simulated` ones, and they carry no bytes.
   */
  readonly provenance: Provenance;
}
