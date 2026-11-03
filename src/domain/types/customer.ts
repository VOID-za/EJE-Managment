import type { PricingInputs } from './settings';
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

/**
 * DN-SITE-OPT-1: what a job raised WITHOUT a site shows where a site would be.
 * Display only — never stored, never a register entry, never a destination.
 * Its id is not a real site's, so nothing can be raised against or sent to it.
 */
export const NO_SITE_ID = 'no-site';
export const noSitePlaceholder = (customerId: CustomerId): Site => ({
  id: NO_SITE_ID as Site['id'],
  customerId,
  name: 'No site recorded',
  addressLine1: '',
  addressLine2: '',
  city: '',
  province: '',
  postalCode: '',
  accessNotes: '',
  latitude: null,
  longitude: null,
  archivedAt: null,
});

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
  /**
   * WHERE THE PIN CAME FROM, AND HOW FAR TO TRUST IT. INT-MAP-1, migration
   * 0042. Absent on a site written before the automatic pin existed, and
   * read then by `siteLocationOf`: coordinates somebody entered are the
   * office's own (verified, manual), and no coordinates is "not requested".
   */
  readonly geocode?: SiteGeocode;
  /** See `Contact.archivedAt`. A site with job history is archived, not deleted. */
  readonly archivedAt: IsoDateTime | null;
}

/**
 * The state of a site's pin. INT-MAP-1.
 *
 *   not_requested  — nothing asked yet (no address, or a site from before)
 *   pending        — waiting for the geocoder
 *   resolved       — the geocoder found one confident match; the pin is set,
 *                    the office has not checked it
 *   ambiguous      — several or imprecise matches; the best one is only a
 *                    SUGGESTION and the pin is not set from it
 *   not_found      — the geocoder found nothing for this address
 *   failed         — the geocoder refused or kept failing; says why
 *   not_configured — this deployment has no geocoder
 *   verified       — the office checked the pin (or entered it by hand)
 *   stale          — the address changed after the pin was verified; the old
 *                    pin is kept but no longer trusted until re-checked
 */
export type SiteLocationStatus =
  | 'not_requested'
  | 'pending'
  | 'resolved'
  | 'ambiguous'
  | 'not_found'
  | 'failed'
  | 'not_configured'
  | 'verified'
  | 'stale';

export interface SiteGeocode {
  readonly status: SiteLocationStatus;
  /** Who set the CURRENT pin: the office by hand, or the geocoder. */
  readonly source: 'manual' | 'geocoded' | null;
  readonly verifiedAt: IsoDateTime | null;
  readonly verifiedBy: string | null;
  /** The address, as one normalised line, that was last sent to the geocoder. */
  readonly query: string;
  /** What the geocoder said the address is. Never replaces the office's address. */
  readonly formattedAddress: string;
  readonly placeId: string | null;
  /** The provider's precision for the match, e.g. ROOFTOP or APPROXIMATE. */
  readonly precision: string | null;
  readonly provider: string | null;
  readonly geocodedAt: IsoDateTime | null;
  readonly error: string;
  readonly attempts: number;
  readonly nextAttemptAt: IsoDateTime | null;
  /** A geocoder result held back, because the pin is verified or the match unsure. */
  readonly suggestedLatitude: number | null;
  readonly suggestedLongitude: number | null;
}

export interface CustomerNote {
  readonly id: string;
  readonly body: string;
  /** Who wrote it. Unchanged by an edit: an edit does not change who said it. */
  readonly authorId: string;
  /** When it was written. Unchanged by an edit, for the same reason. */
  readonly createdAt: IsoDateTime;
  /**
   * WHO CORRECTED IT, AND WHEN. Both null until somebody does. Customers §2.
   *
   * The office may edit a note, and a screen showing new words under the
   * original author's name with the original date would be a quiet rewrite of
   * somebody's statement. These two fields are what let it say "edited by …"
   * instead. The previous wording lives on the audit trail, not here: a note
   * holds one body, as a note does.
   */
  readonly editedBy: string | null;
  readonly editedAt: IsoDateTime | null;
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

/**
 * WHICH RATES PRICE THIS CUSTOMER'S JOB CARDS. CUST-RATES-1 (2 November 2026).
 *
 * Chosen by the office (a Senior Tech or the Office) when the customer is
 * created — the customer never chooses or changes it. `default`: always the
 * current Rates in Administration. `custom`: always this customer's own Custom
 * Rates, and NEVER the defaults instead — a custom-rate customer whose rates are
 * not set cannot have a job card priced (see `application/customer-rates.ts`).
 */
export type CustomerRateMode = 'default' | 'custom';

export const CUSTOMER_RATE_MODE_LABELS: Readonly<Record<CustomerRateMode, string>> = {
  default: 'Default Rates',
  custom: 'Custom Rates',
};

/** A customer's own rates: every field the Administration rates carry. */
export interface CustomerRates extends PricingInputs {
  readonly customerId: CustomerId;
  readonly updatedBy: string | null;
  readonly updatedAt: IsoDateTime;
}

/** The customer's rate mode; a record from before it existed is on the defaults. */
export const customerRateModeOf = (customer: Pick<Customer, 'rateMode'>): CustomerRateMode => customer.rateMode ?? 'default';

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
  /** CUST-RATES-1. Absent on a record from before it existed: Default Rates. */
  readonly rateMode?: CustomerRateMode;
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
