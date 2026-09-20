import {
  PARTS_COLLECTION_DECLARATION,
  SIGNATURE_DECLARATION,
  TEST_REPAIR_COLLECTION_DECLARATION,
  type JobTypeCode,
} from '../types/job';
import { getJobTypeDefinition } from './job-types';

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
  /** The exception recorded when this signatory would not sign. */
  readonly refusedLabel: string;
  /** What the technician is asked for instead of a signature. */
  readonly refusalTitle: string;
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
  refusedLabel: 'Customer refused to sign',
  refusalTitle: 'Customer refusal reason',
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
  refusedLabel: 'Collector refused to sign',
  refusalTitle: 'Collector refusal reason',
};

const REPAIR_COLLECTOR: SignatoryLabels = {
  declaration: TEST_REPAIR_COLLECTION_DECLARATION,
  sectionTitle: 'Collection acknowledgement',
  sectionDescription:
    'Hand the tablet to the person collecting the repaired items. For a courier collection this is the driver, not the customer.',
  nameLabel: 'Collector name',
  surnameLabel: 'Collector surname',
  signatureLabel: 'Collector signature',
  confirmLabel: 'Confirm collection',
  pageTitle: 'Collector signature',
  refusedLabel: 'Collector refused to sign',
  refusalTitle: 'Collector refusal reason',
};

/**
 * Who signs, by job type.
 *
 * Anything collected from the counter is signed for by whoever collects it —
 * often a driver — and what they acknowledge is receipt. Everything else is
 * signed by the customer, acknowledging that the work was done.
 */
export const signatoryLabelsFor = (jobType: JobTypeCode): SignatoryLabels => {
  if (jobType === 'parts') return COLLECTOR;
  if (getJobTypeDefinition(jobType).collectedOnCompletion) return REPAIR_COLLECTOR;
  return CUSTOMER;
};

/** The declaration text stored against the signature for this job type. */
export const signatureDeclarationFor = (jobType: JobTypeCode): string =>
  signatoryLabelsFor(jobType).declaration;
