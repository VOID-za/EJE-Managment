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

export interface Attachment {
  readonly id: AttachmentId;
  readonly kind: 'photo' | 'video' | 'document';
  readonly fileName: string;
  readonly caption: string;
  /**
   * In the demo this is a deterministic placeholder reference resolved by the
   * storage service. In production it becomes an object-storage key.
   */
  readonly storageKey: string;
  readonly uploadedAt: IsoDateTime;
  readonly uploadedBy: UserId;
  readonly sizeBytes: number;
}
