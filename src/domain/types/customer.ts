import type { Provenance } from './provenance';
import type {
  Attachment,
  ContactId,
  CustomerId,
  IsoDateTime,
  SiteId,
  UserId,
} from './common';

/**
 * A South African postal address, structured rather than a single blob so it
 * can be printed on a document and searched on a city.
 */
export interface PostalAddress {
  readonly line1: string;
  readonly line2: string;
  readonly city: string;
  readonly province: string;
  readonly postalCode: string;
}

export const emptyAddress = (): PostalAddress => ({
  line1: '',
  line2: '',
  city: '',
  province: '',
  postalCode: '',
});

/** True when nothing has been captured, so screens can say so rather than print blanks. */
export const isAddressEmpty = (address: PostalAddress): boolean =>
  [address.line1, address.line2, address.city, address.province, address.postalCode].every(
    (part) => part.trim().length === 0,
  );

/** The address on one line, for a table cell or a search result. */
export const formatAddress = (address: PostalAddress): string =>
  [address.line1, address.line2, address.city, address.province, address.postalCode]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(', ');

export interface Contact {
  readonly id: ContactId;
  readonly customerId: CustomerId;
  /** Null for a customer-level (head office) contact. */
  readonly siteId: SiteId | null;
  readonly firstName: string;
  readonly lastName: string;
  readonly position: string;
  readonly email: string;
  readonly phone: string;
  readonly isPrimary: boolean;
  /**
   * When this contact was removed from the customer's active list.
   *
   * A contact named on a historical job card cannot simply be deleted — the job
   * card would then name somebody the system no longer knows. Removing such a
   * contact archives it instead: it disappears from the customer record and
   * from every picker, and the closed jobs that reference it still resolve.
   * Null for a live contact, which is all of them until one is removed.
   */
  readonly archivedAt: IsoDateTime | null;
}

export interface Site {
  readonly id: SiteId;
  readonly customerId: CustomerId;
  readonly name: string;
  readonly addressLine1: string;
  readonly addressLine2: string;
  readonly city: string;
  readonly province: string;
  readonly postalCode: string;
  readonly accessNotes: string;
  /**
   * Saved site location, used to build a navigation link for the technician.
   * Null where a site has not been pinned yet; the address is then used
   * instead, which is less precise on an industrial estate but still useful.
   */
  readonly latitude: number | null;
  readonly longitude: number | null;
  /** See `Contact.archivedAt`. A site with job history is archived, not deleted. */
  readonly archivedAt: IsoDateTime | null;
}

export interface CustomerNote {
  readonly id: string;
  readonly body: string;
  readonly authorId: string;
  readonly createdAt: IsoDateTime;
}

/**
 * A FILE ATTACHED TO A CUSTOMER. October mandate §4.
 *
 * Shaped like `Attachment` and deliberately NOT the same type: an attachment
 * belongs to a job and carries `visibility`, which decides whether it is
 * printed on the customer's job card. A customer's own document is never
 * printed on a job card, so a visibility field here would be a field with no
 * meaning that somebody would eventually read as one.
 *
 * `sizeBytes` and `checksumSha256` are MEASURED by the server off the bytes it
 * stored — never supplied by a client, and never invented when no file exists.
 */
export interface CustomerDocument {
  readonly id: string;
  readonly customerId: CustomerId;
  readonly fileName: string;
  readonly caption: string;
  /** The server's sniffed type, not the browser's claim. */
  readonly contentType: string;
  readonly storageKey: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string | null;
  readonly uploadedAt: IsoDateTime;
  readonly uploadedBy: UserId;
  readonly provenance: Provenance;
  /** Withdrawn by the office, and kept: the register's own rule. */
  readonly archivedAt: IsoDateTime | null;
}

export interface Customer {
  readonly id: CustomerId;
  readonly name: string;
  readonly accountNumber: string;
  readonly registrationNumber: string;
  readonly vatNumber: string;
  readonly phone: string;
  /**
   * LEGACY. A company-level email address, retained but no longer used.
   *
   * Email belongs to a named contact person: a job card goes to the person who
   * asked for the work and signed for it, never to a shared company mailbox
   * that nobody in particular reads. Nothing captures, displays or sends to
   * this field any more — see `Contact.email`.
   *
   * It is kept rather than dropped so that an address captured before that rule
   * existed is not destroyed; a customer whose only address was this one is
   * corrected by capturing it on a contact.
   */
  readonly email: string;
  /**
   * Head office, which is not necessarily anywhere a machine stands.
   *
   * Sites are where the work happens; this is where the company is. They are
   * often the same address for a single-site customer, which is why a customer
   * migrated from the earlier shape takes its first site's address.
   */
  readonly officeAddress: PostalAddress;
  readonly industry: string;
  readonly paymentTerms: string;
  readonly active: boolean;
  readonly notes: readonly CustomerNote[];
  readonly documents: readonly Attachment[];
  readonly createdAt: IsoDateTime;
}

export const contactFullName = (contact: Pick<Contact, 'firstName' | 'lastName'>): string =>
  `${contact.firstName} ${contact.lastName}`;

/** Whether a record is still part of the customer's live register. */
export const isArchived = (record: { readonly archivedAt: IsoDateTime | null }): boolean =>
  record.archivedAt !== null;

/**
 * Job roles offered when capturing a contact.
 *
 * Suggestions rather than a closed list: the field stays free text because the
 * next customer will have a title nobody anticipated, and refusing it would
 * push the office into picking a wrong one.
 */
export const CONTACT_ROLE_SUGGESTIONS: readonly string[] = [
  'Owner',
  'Finance',
  'Maintenance Manager',
  'Purchasing',
  'Operations',
  'General Manager',
  'Accounts',
];
