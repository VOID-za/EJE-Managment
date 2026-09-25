import type { JobPriority, JobTypeCode } from '../types/job';

/** DECISION 2. See `JobTypeDefinition.orderNumberExpectation`. */
export type OrderNumberExpectation = 'required' | 'expected' | 'optional';

/**
 * Behavioural definition of a job type.
 *
 * Business rules live here, not in components. Phase 2 replaces the constant
 * below with rows loaded from a `job_types` table; every consumer reads the
 * definition through `getJobTypeDefinition`, so nothing else changes.
 */
export interface JobTypeDefinition {
  readonly code: JobTypeCode;
  readonly label: string;
  readonly description: string;
  /** A checklist must be completed before the job can leave `completion`. */
  readonly checklistRequired: boolean;
  /** At least one job photo is required before completion. */
  readonly photosRequired: boolean;
  /**
   * The job is booked across a date range rather than a single day, because the
   * work is quoted for a number of days.
   */
  readonly schedulesDateRange: boolean;
  /** Labour and travel do not apply to this job type. */
  readonly capturesLabourAndTravel: boolean;
  /**
   * The technician travels to the customer's site. Parts are collected from the
   * EJE counter instead, so there is no site address worth sending them.
   */
  readonly visitsSite: boolean;
  /**
   * A customer order number must be recorded. Required on a parts collection,
   * where the order number is what ties the goods to what the customer ordered
   * and is how the collection note is reconciled against their purchase order.
   */
  readonly requiresOrderNumber: boolean;
  /**
   * How the business treats the customer's order number on this job type.
   * DECISION 2.
   *
   * Three values rather than a boolean, because EJE distinguish three cases:
   * Parts cannot be handed over without one; an Installation or a Service is
   * expected to carry one and may proceed past an explicit, recorded
   * acknowledgement; a breakdown call-out has none and never will at the time
   * of the visit. `requiresOrderNumber` is the hard half of this and stays as
   * it is — the readiness gate reads it and its meaning has not changed.
   */
  readonly orderNumberExpectation: OrderNumberExpectation;
  /**
   * The customer's own delivery note number may be recorded on this job type.
   *
   * Optional wherever it is offered. True for the job types whose customers
   * actually reconcile by one — parts and workshop repairs — rather than
   * everywhere, because a field nobody fills in is a field everybody learns to
   * skip.
   */
  readonly capturesDeliveryNote: boolean;
  /**
   * THE OFFICE PROCESSES THIS JOB FROM START TO FINISH. NO TECHNICIAN. CR-12.
   *
   * A parts collection is a counter transaction: somebody arrives, the office
   * hands over goods and takes a signature for them. There is no site to
   * travel to, no machine to work on, nobody to assign it to and nothing for a
   * technician to accept — so the job is raised and processed in one sitting
   * by whoever raised it, and it never passes through the open pool.
   *
   * What this flag turns off, everywhere and on the server:
   *
   *  - assignment, at creation and afterwards;
   *  - acceptance — there is no acceptance step to offer or to refuse;
   *  - a scheduled date and a priority, which describe when a technician is
   *    sent somewhere;
   *  - labour, travel and the call-out fee, which price a visit that did not
   *    happen (`capturesLabourAndTravel` already says this and now bites).
   *
   * It does NOT change the document, the signature, the submission, the
   * delivery handshake or the closing rule: a collection note is issued,
   * emailed and closed on a confirmed delivery exactly as a job card is.
   */
  readonly officeProcessed: boolean;
  /**
   * The job ends with somebody collecting goods from the EJE counter, rather
   * than with the customer signing on their own site.
   *
   * That changes the close-out: the technician is asked WHO is collecting, and
   * a courier gets a document with no prices on it. See
   * `showsPricesOnCollectionDocument`.
   */
  readonly collectedOnCompletion: boolean;
  readonly defaultPriority: JobPriority;
  /** Tailwind-safe token name used by the design system for this job type. */
  readonly accent: 'red' | 'blue' | 'green' | 'violet' | 'amber';
}

const DEFINITIONS: Readonly<Record<JobTypeCode, JobTypeDefinition>> = {
  breakdown: {
    code: 'breakdown',
    officeProcessed: false,
    label: 'Breakdown',
    description: 'Unplanned machine failure requiring a reactive site visit.',
    checklistRequired: false,
    photosRequired: false,
    schedulesDateRange: false,
    capturesLabourAndTravel: true,
    visitsSite: true,
    requiresOrderNumber: false,
    orderNumberExpectation: 'optional',
    capturesDeliveryNote: false,
    collectedOnCompletion: false,
    defaultPriority: 'urgent',
    accent: 'red',
  },
  installation: {
    code: 'installation',
    officeProcessed: false,
    label: 'Installation',
    description: 'Commissioning and hand-over of a machine at a customer site.',
    checklistRequired: true,
    photosRequired: true,
    schedulesDateRange: false,
    capturesLabourAndTravel: true,
    visitsSite: true,
    requiresOrderNumber: false,
    orderNumberExpectation: 'expected',
    capturesDeliveryNote: false,
    collectedOnCompletion: false,
    defaultPriority: 'normal',
    accent: 'blue',
  },
  service: {
    code: 'service',
    officeProcessed: false,
    label: 'Service',
    description: 'Planned preventative maintenance against the service schedule.',
    checklistRequired: true,
    photosRequired: false,
    schedulesDateRange: true,
    capturesLabourAndTravel: true,
    visitsSite: true,
    requiresOrderNumber: false,
    orderNumberExpectation: 'expected',
    capturesDeliveryNote: false,
    collectedOnCompletion: false,
    defaultPriority: 'normal',
    accent: 'green',
  },
  parts: {
    code: 'parts',
    officeProcessed: true,
    label: 'Parts',
    description:
      'Parts collection or delivery note. The customer or a courier collects parts from the office.',
    checklistRequired: false,
    photosRequired: false,
    schedulesDateRange: false,
    // No site visit, so nothing to charge for hours or distance.
    capturesLabourAndTravel: false,
    visitsSite: false,
    requiresOrderNumber: true,
    orderNumberExpectation: 'required',
    capturesDeliveryNote: true,
    collectedOnCompletion: true,
    defaultPriority: 'normal',
    accent: 'amber',
  },

  test_and_repair: {
    code: 'test_and_repair',
    officeProcessed: false,
    label: 'Test & Repair',
    description: 'Workshop or on-site testing and repair of a unit or assembly.',
    checklistRequired: false,
    photosRequired: false,
    schedulesDateRange: false,
    capturesLabourAndTravel: true,
    visitsSite: true,
    requiresOrderNumber: false,
    orderNumberExpectation: 'optional',
    capturesDeliveryNote: true,
    collectedOnCompletion: true,
    defaultPriority: 'normal',
    accent: 'violet',
  },
};

export const JOB_TYPE_CODES: readonly JobTypeCode[] = [
  'breakdown',
  'installation',
  'service',
  'test_and_repair',
  'parts',
];

export const getJobTypeDefinition = (code: JobTypeCode): JobTypeDefinition => DEFINITIONS[code];

export const listJobTypeDefinitions = (): readonly JobTypeDefinition[] =>
  JOB_TYPE_CODES.map(getJobTypeDefinition);

export const jobTypeLabel = (code: JobTypeCode): string => DEFINITIONS[code].label;

export const PRIORITY_ORDER: readonly JobPriority[] = ['urgent', 'high', 'normal', 'low'];

export const priorityLabel = (priority: JobPriority): string => {
  switch (priority) {
    case 'low':
      return 'Low';
    case 'normal':
      return 'Normal';
    case 'high':
      return 'High';
    case 'urgent':
      return 'Urgent';
  }
};

export const priorityRank = (priority: JobPriority): number => PRIORITY_ORDER.indexOf(priority);
