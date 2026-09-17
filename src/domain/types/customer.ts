import type {
  Attachment,
  ContactId,
  CustomerId,
  IsoDateTime,
  SiteId,
} from './common';

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
}

export interface CustomerNote {
  readonly id: string;
  readonly body: string;
  readonly authorId: string;
  readonly createdAt: IsoDateTime;
}

export interface Customer {
  readonly id: CustomerId;
  readonly name: string;
  readonly accountNumber: string;
  readonly registrationNumber: string;
  readonly vatNumber: string;
  readonly phone: string;
  readonly email: string;
  readonly industry: string;
  readonly paymentTerms: string;
  readonly active: boolean;
  readonly notes: readonly CustomerNote[];
  readonly documents: readonly Attachment[];
  readonly createdAt: IsoDateTime;
}

export const contactFullName = (contact: Pick<Contact, 'firstName' | 'lastName'>): string =>
  `${contact.firstName} ${contact.lastName}`;
