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
  /**
   * A MACHINE HAS TO BE NAMED ON THIS JOB TYPE. Create New Job §3A / §4.
   *
   * Explicit, because it used to be inferred from `capturesLabourAndTravel` —
   * "this job type charges hours, so it must be work on a machine" — and the
   * owner has since separated the two. A BREAKDOWN is called in before anybody
   * knows which machine it is ("the line is down"), and a TEST & REPAIR
   * arrives as a unit on the counter that may not be on the register at all.
   * An INSTALLATION or a SERVICE is booked against a known machine and still
   * requires one.
   *
   * Where it is false, the machine is OPTIONAL and not defaulted: nothing
   * invents one, and nothing attaches the job to an arbitrary machine to
   * satisfy a column.
   */
  readonly requiresMachine: boolean;
  /**
   * THE JOB HAS TO SAY WHAT THE WORK IS, BEFORE IT CAN BE RAISED.
   * Test & Repair §4.
   *
   * It used to be `!officeProcessed` — every job type except a parts
   * collection. The owner has made it optional on TEST & REPAIR, and the
   * reason is the workflow: a unit arrives on the counter and is booked in
   * before anybody has diagnosed it. What IS recorded at that moment is the
   * unit itself (`capturesRepairItem`), and the fault is written up once the
   * workshop has looked at it.
   *
   * Still required on a breakdown, an installation and a service: each is a
   * technician being sent somewhere, and "what am I going for" is the one
   * thing they cannot be sent without.
   */
  readonly requiresFaultDescription: boolean;
  /**
   * A PRIORITY HAS TO BE CHOSEN ON THIS JOB TYPE. Create New Job §3B / §4.
   *
   * False on the two types the owner asked for, where the office raises the
   * job before the urgency is known, and on a parts collection, which has no
   * priority at all (`officeProcessed` already turns the field off). Where it
   * is false the job carries NO priority — not a quietly defaulted one, which
   * would put "Urgent" on a breakdown nobody had graded.
   */
  readonly requiresPriority: boolean;
  /**
   * THE REPAIR ITEM: part number, description and quantity. Test & Repair §4.
   *
   * What was booked IN for test and repair — the unit on the counter — which
   * is a different thing from the parts CONSUMED in repairing it. Those are
   * priced lines (`job_parts`) and already exist.
   */
  readonly capturesRepairItem: boolean;
  /** A customer's quote number may be recorded. Test & Repair §4. */
  readonly capturesQuoteNumber: boolean;
  /**
   * WHAT MAY BE ATTACHED TO THE JOB: PHOTOGRAPHS, AND VIDEOS WHERE THIS IS TRUE.
   *
   * Every job type takes photographs. A field job also takes a video — a clip
   * of the noise the machine is making is evidence a photograph cannot carry.
   * A parts collection takes photographs ONLY: what is worth recording at the
   * counter is what the goods looked like when they left, and nothing about a
   * counter transaction needs a recording. No job type takes a document — a
   * PDF belongs in the Technical Library or the customer's or machine's own
   * register. The SERVER enforces this (`validateJobMediaUpload`), on the
   * bytes; the screen only narrows the picker.
   */
  readonly acceptsVideoAttachments: boolean;
  /**
   * THE TECHNICIAN'S COMPLETION WRITE-UP is part of this job card. Issue #73,
   * Batch 2.
   *
   * False on a parts collection: goods handed over at the counter have no
   * findings, diagnosis or work performed to write up — the part lines ARE the
   * record. Enforced on the server (`saveCompletionReport` refuses it), on the
   * screens (no Completion tab, no write-up step) and on the document.
   */
  readonly capturesCompletionWriteUp: boolean;
  /**
   * A SIGNATURE REFUSAL can be recorded on this job card. Issue #73, Batch 2.
   *
   * False on a parts collection: the collector signs for the goods or the goods
   * do not leave — there is no refusal-and-correction loop for a counter
   * hand-over. `recordSignatureRefusal` refuses it on the server. A refusal
   * recorded on a parts job BEFORE this rule stays readable and can still be
   * resolved, so no historical job is stranded at Review.
   */
  readonly allowsSignatureRefusal: boolean;
  /**
   * The priority a screen OFFERS first where one is required.
   *
   * Not a value anything writes on the job's behalf: where `requiresPriority`
   * is false the job's priority stays null until somebody chooses one.
   */
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
    requiresFaultDescription: true,
    requiresMachine: false,
    requiresPriority: false,
    capturesRepairItem: false,
    capturesQuoteNumber: false,
    acceptsVideoAttachments: true,
    capturesCompletionWriteUp: true,
    allowsSignatureRefusal: true,
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
    requiresFaultDescription: true,
    requiresMachine: true,
    requiresPriority: true,
    capturesRepairItem: false,
    capturesQuoteNumber: false,
    acceptsVideoAttachments: true,
    capturesCompletionWriteUp: true,
    allowsSignatureRefusal: true,
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
    requiresFaultDescription: true,
    requiresMachine: true,
    requiresPriority: true,
    capturesRepairItem: false,
    capturesQuoteNumber: false,
    acceptsVideoAttachments: true,
    capturesCompletionWriteUp: true,
    allowsSignatureRefusal: true,
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
    requiresFaultDescription: false,
    requiresMachine: false,
    requiresPriority: false,
    capturesRepairItem: false,
    capturesQuoteNumber: false,
    acceptsVideoAttachments: false,
    capturesCompletionWriteUp: false,
    allowsSignatureRefusal: false,
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
    requiresFaultDescription: false,
    requiresMachine: false,
    requiresPriority: false,
    capturesRepairItem: true,
    capturesQuoteNumber: true,
    acceptsVideoAttachments: true,
    capturesCompletionWriteUp: true,
    allowsSignatureRefusal: true,
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

/**
 * Where a priority sorts, most urgent first.
 *
 * AN UNGRADED JOB SORTS LAST, after "Low", rather than first. A job nobody has
 * graded is not thereby the most urgent thing on the list — and putting it at
 * the top is how an ungraded breakdown would outrank a genuine Urgent one.
 * `PRIORITY_ORDER.length` is one past Low, which is exactly "after everything
 * that was graded".
 */
export const priorityRank = (priority: JobPriority | null): number =>
  priority === null ? PRIORITY_ORDER.length : PRIORITY_ORDER.indexOf(priority);

/**
 * What a screen or a document calls a priority, including its absence.
 *
 * `priorityLabel` takes a real priority and stays that way, because most
 * callers have one. This is the one for a field that may be null, and it says
 * "Not graded" rather than returning an empty string: a blank cell in a
 * spreadsheet column headed "Priority" reads as data loss.
 */
export const priorityLabelOrUngraded = (priority: JobPriority | null): string =>
  priority === null ? 'Not graded' : priorityLabel(priority);
