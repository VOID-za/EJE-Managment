import {
  PARTS_COLLECTION_DECLARATION,
  SIGNATURE_DECLARATION,
  type JobTypeCode,
} from '../types/job';

/**
 * Who signs, and what they are signing for.
 *
 * A parts collection is acknowledged by whoever physically collects the goods —
 * often a driver, not the customer — and what they acknowledge is receipt, not
 * that work was completed. Keeping the wording here means the signature screen
 * and the stored declaration on the job can never drift apart.
 */
export interface SignatoryLabels {
  /** The wording shown above the signature and stored on the job. */
  readonly declaration: string;
  readonly sectionTitle: string;
  readonly sectionDescription: string;
  readonly nameLabel: string;
  readonly surnameLabel: string;
  readonly signatureLabel: string;
  readonly confirmLabel: string;
  readonly pageTitle: string;
}

const CUSTOMER: SignatoryLabels = {
  declaration: SIGNATURE_DECLARATION,
  sectionTitle: 'Customer acceptance',
  sectionDescription: 'Hand the tablet to the customer to complete this section.',
  nameLabel: 'Customer name',
  surnameLabel: 'Customer surname',
  signatureLabel: 'Signature',
  confirmLabel: 'Confirm signature',
  pageTitle: 'Customer signature',
};

const COLLECTOR: SignatoryLabels = {
  declaration: PARTS_COLLECTION_DECLARATION,
  sectionTitle: 'Collector acknowledgement',
  sectionDescription:
    'Hand the tablet to the person collecting the parts. For a courier collection this is the driver, not the customer.',
  nameLabel: 'Collector name',
  surnameLabel: 'Collector surname',
  signatureLabel: 'Collector signature',
  confirmLabel: 'Confirm collection',
  pageTitle: 'Collector signature',
};

export const signatoryLabelsFor = (jobType: JobTypeCode): SignatoryLabels =>
  jobType === 'parts' ? COLLECTOR : CUSTOMER;

/** The declaration text stored against the signature for this job type. */
export const signatureDeclarationFor = (jobType: JobTypeCode): string =>
  signatoryLabelsFor(jobType).declaration;
