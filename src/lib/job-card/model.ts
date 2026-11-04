import {
  repairItemsOf,
  requiresDeliveryNote,
  buildPartsDocument,
  jobDetailLabel,
  calculateJobTotals,
  contactFullName,
  currentRefusal,
  customerFacingNotes,
  evaluateChecklist,
  formatFieldValues,
  getJobTypeDefinition,
  siteAddressLine,
  jobScheduleWindow,
  labourRateLabel,
  machineDisplayName,
  priorityLabel,
  showsPricesOnCollectionDocument,
  signatoryLabelsFor,
  userFullName,
  type ChecklistHeaderSource,
  type ChecklistItem,
  type ChecklistResponse,
  type ChecklistSignatureRole,
  type ChecklistTemplate,
  type Contact,
  type Customer,
  type IsoDateTime,
  type Job,
  type Machine,
  type Site,
  type SystemSettings,
  type User,
} from '@/domain';
import { formatCurrency, formatDate, formatDateTime } from '@/lib/format';
import { courierSignatureReference } from './delivery-note';

/**
 * The EJE job card, as one canonical document.
 *
 * There are two renderers — the on-screen card in `JobCardDocument` and the PDF
 * writer that produces the file a customer keeps — and they were allowed to
 * diverge: the PDF grew its own section order, labels and spacing, and left the
 * signature box empty. This is the single definition both of them consume, so
 * the content, its order, its labels and its structure cannot drift again.
 *
 * It carries *presentation-ready* values: figures already formatted, dates
 * already rendered, "Not recorded" already decided. What a renderer chooses is
 * only how to draw them — typography, rules, page breaks — because HTML and PDF
 * genuinely differ there and nothing else should.
 *
 * Pure: no React, no PDF, no I/O.
 */

export interface LabelValue {
  readonly label: string;
  readonly value: string;
  /** Serial numbers and part numbers are set in a monospaced face. */
  readonly mono?: boolean;
}

export interface ChargeRow {
  readonly description: string;
  /** The muted continuation after an em dash, e.g. "— Preventative service". */
  readonly detail: string;
  readonly quantity: string;
  readonly rate: string;
  readonly amount: string;
  readonly mono?: boolean;
}

export interface ChecklistItemLine {
  /** The source's own number for the row, '' when it prints none. CHK-SRC-1. */
  readonly number: string;
  /** A label the source prints once over a run of rows — shown on the first. */
  readonly groupHeading: string;
  readonly text: string;
  readonly answer: string;
  readonly note: string;
  /** What was typed in the row's printed blanks: "R 400 · S 401 · T 399". */
  readonly readings: string;
  /** e.g. "Handwritten on the supplied source." */
  readonly sourceNote: string;
}

export interface JobCardModel {
  /** "Job Card", "Parts Collection Note", "Delivery Note". */
  readonly documentTitle: string;
  readonly company: {
    readonly name: string;
    readonly address: string;
    readonly contactLine: string;
    readonly registrationLine: string;
  };
  readonly jobNumber: string;

  readonly customer: {
    readonly name: string;
    readonly addressLines: readonly string[];
    readonly contact: {
      readonly name: string;
      readonly position: string;
      readonly contactLine: string;
    } | null;
  };
  readonly machine: { readonly title: string; readonly rows: readonly LabelValue[] } | null;
  readonly jobDetails: readonly LabelValue[];

  /**
   * THE PARTS BOOKED IN. PDF-RECV-2 (the tester, 2 November 2026): their OWN
   * section, "Parts received", directly after Reported fault — no longer inside
   * Labour, travel and parts (PDF-RECV-1, 1 November), nor under Job details.
   * One part reads Part number / Unit / Quantity received; several read one
   * "Part N received" row each, in order. Null when none were booked in.
   */
  readonly partsReceived: { readonly rows: readonly LabelValue[] } | null;

  /**
   * HOW THE GOODS GO BACK: Collection (and Waybill), printed first in Labour,
   * travel and parts (PDF-RECV-1). Null when the job type is not collected.
   */
  readonly received: { readonly rows: readonly LabelValue[] } | null;

  /**
   * What the job was raised about, or NULL when the job type does not collect
   * one — a parts collection, where the goods listed below are the record.
   *
   * Null rather than a placeholder, so the section is omitted entirely: the
   * same rule DOC-1 applies to the write-up. "No fault description recorded."
   * on a collection note read as something forgotten.
   */
  readonly faultDescription: string | null;
  readonly workBlocks: readonly { readonly label: string; readonly value: string }[];
  readonly notes: readonly { readonly body: string; readonly byline: string }[];

  readonly charges: {
    readonly rows: readonly ChargeRow[];
    /**
     * COST-5. The two figures a discount makes necessary.
     *
     * Null when there is no discount, so an ordinary job card prints one
     * subtotal and not three lines saying the same thing. When there IS one,
     * both are printed: the office is asked "what was it before you came
     * down", and the answer belongs on the paper the customer keeps.
     */
    readonly discount: {
      readonly grossSubtotal: string;
      readonly amount: string;
      readonly reason: string;
    } | null;
    readonly subtotal: string;
    readonly vatLabel: string;
    readonly vat: string;
    readonly total: string;
  } | null;

  readonly checklist: {
    readonly title: string;
    readonly summary: string;
    /** The source document's own printed title, or null on earlier wording. CHK-SRC-1. */
    readonly documentTitle: string | null;
    /** "Service checklist: Lathe" — the checklist the technician chose. */
    readonly checklistType: string | null;
    /** The source's header lines, filled from the job. */
    readonly header: readonly LabelValue[];
    readonly sections: readonly {
      readonly title: string;
      readonly items: readonly ChecklistItemLine[];
    }[];
    /** The source's printed instructions, and its closing line if any. */
    readonly notes: readonly string[];
    readonly closing: string;
    /** The source's sign-off lines, with what the job holds for each. */
    readonly signatures: readonly LabelValue[];
  } | null;

  /**
   * What is being handed over, on a document that withholds prices.
   *
   * A courier's copy has no charges block at all — that is the commercial rule
   * — and the PDF therefore used to print NOTHING about the goods on a courier
   * Delivery Note: no part numbers, no quantities, nothing for the driver or
   * the receiving store to check the load against. Meanwhile the on-screen
   * collection note listed them, because it was a second renderer reading the
   * job directly. One document, two answers.
   *
   * So the goods are part of the model, and both renderers read them from here.
   * `buildPartsDocument` already draws exactly the line that matters: a
   * quantity is not a price, and a courier needs it.
   *
   * Null for every document that shows its prices, where the charges block
   * already lists the parts and a second table would simply repeat it.
   */
  readonly collection: {
    readonly heading: string;
    readonly lines: readonly {
      readonly partNumber: string;
      readonly description: string;
      readonly quantity: string;
    }[];
    readonly totalLabel: string;
    readonly totalQuantity: string;
    /** Says, on the document, why there are no prices on it. */
    readonly priceNote: string;
  } | null;

  /** The id is the attachment's, so a renderer can find the photograph's pixels. */
  readonly photos: readonly {
    readonly id: string;
    readonly caption: string;
    readonly fileName: string;
  }[];

  readonly acceptance: {
    readonly declaration: string;
    readonly rows: readonly LabelValue[];
    /** Raw stored signature data; `signatureFacsimile` decides how to draw it. */
    readonly signatureData: string;
    readonly caption: string;
  } | null;

  /**
   * Printed in place of the acceptance when the customer refused to sign.
   *
   * Mutually exclusive with `acceptance`, and the reason this is a block of its
   * own rather than a variation of that one: a refused job card must carry NO
   * signature box and no signature mark of any kind. There is nothing to draw,
   * and a box left empty beside a declaration reads as an oversight rather than
   * as the customer's answer.
   */
  readonly refusal: {
    readonly heading: string;
    readonly reason: string;
    readonly rows: readonly LabelValue[];
  } | null;

  readonly footerLines: readonly string[];
}

export interface JobCardModelInput {
  readonly job: Job;
  readonly customer: Customer;
  readonly site: Site;
  readonly contact: Contact | null;
  readonly machine: Machine | null;
  readonly settings: SystemSettings;
  readonly checklistTemplate: ChecklistTemplate | null;
  readonly users: readonly User[];
  /**
   * When this copy of the document was produced.
   *
   * Explicit, because a closed job's document was produced when it was issued —
   * printing "Generated today" on a job card from six months ago is wrong, and
   * it would also make the stored PDF different on every render.
   */
  readonly generatedAt: IsoDateTime;
}

/**
 * The parts booked in, for their own "Parts received" section (PDF-RECV-2).
 * One part reads exactly as it always has (Part number, Unit, Quantity
 * received); several (TR-PARTS-1) read one row each, in order.
 */
const partsReceivedOf = (job: JobCardModelInput['job']): JobCardModel['partsReceived'] => {
  const definition = getJobTypeDefinition(job.jobType);
  const items = repairItemsOf(job);
  const rows: LabelValue[] = [
    ...(definition.capturesRepairItem && items.length <= 1 && job.repairItem.partNumber.length > 0
      ? [{ label: 'Part number', value: job.repairItem.partNumber }]
      : []),
    ...(definition.capturesRepairItem && items.length <= 1 && job.repairItem.description.length > 0
      ? [{ label: 'Unit', value: job.repairItem.description }]
      : []),
    ...(definition.capturesRepairItem && items.length <= 1 && job.repairItem.quantity !== null
      ? [{ label: 'Quantity received', value: String(job.repairItem.quantity) }]
      : []),
    ...(definition.capturesRepairItem && items.length > 1
      ? items.map((item, index) => ({
          label: `Part ${index + 1} received`,
          value: [item.description, item.partNumber.length > 0 ? `(${item.partNumber})` : '', `× ${item.quantity ?? 1}`]
            .filter((part) => part.length > 0)
            .join(' '),
        }))
      : []),
  ];
  return rows.length === 0 ? null : { rows };
};

/** How the goods go back — Collection and Waybill — for Labour, travel and parts (PDF-RECV-1). */
const receivedOf = (job: JobCardModelInput['job']): JobCardModel['received'] => {
  const definition = getJobTypeDefinition(job.jobType);
  const rows: LabelValue[] = [
    ...(definition.collectedOnCompletion
      ? [
          { label: 'Collection', value: job.courierCollection ? 'Courier collection' : 'Customer collection' },
          ...(job.courierCollection && job.waybillNumber.length > 0 ? [{ label: 'Waybill', value: job.waybillNumber }] : []),
        ]
      : []),
  ];
  return rows.length === 0 ? null : { rows };
};

/**
 * A source header line's value, from the job. CHK-SRC-1. The paper prints a
 * blank; the job already knows the answer, so nothing is retyped — and what the
 * job does not know (no machine, no invoice yet) stays blank, as on paper.
 */
const checklistHeaderValue = (
  source: ChecklistHeaderSource,
  record: {
    readonly job: Job;
    readonly customer: Customer;
    readonly site: Site;
    readonly contact: Contact | null;
    readonly machine: Machine | null;
  },
): string => {
  const { job, customer, site, contact, machine } = record;
  switch (source) {
    case 'quote_number':
      return job.quoteNumber;
    case 'invoice_number':
      return job.invoice?.number ?? '';
    case 'customer':
      return customer.name;
    case 'site_address':
      return siteAddressLine(site);
    case 'contact':
      return contact === null ? '' : `${contact.firstName} ${contact.lastName}`.trim();
    case 'machine_make':
      return machine?.manufacturer ?? '';
    case 'machine_model':
      return machine?.model ?? '';
    case 'machine_control':
      return machine?.controlSystem ?? '';
    case 'serial_number':
      return machine?.serialNumber ?? '';
    case 'date':
      return job.checklist?.completedAt == null ? '' : formatDate(job.checklist.completedAt);
  }
};

/**
 * What a source sign-off line holds on THIS job. EJE takes one signature — the
 * customer's, on the job card that carries the checklist — and records who
 * completed the checklist; it does not capture an engineer's drawn signature,
 * and does not pretend to.
 */
const checklistSignatureValue = (
  role: ChecklistSignatureRole,
  job: Job,
  users: readonly User[],
): string => {
  const completedBy =
    job.checklist?.completedBy == null
      ? null
      : (users.find((user) => user.id === job.checklist?.completedBy) ?? null);
  switch (role) {
    case 'engineer_name':
      return completedBy === null ? '' : userFullName(completedBy);
    case 'engineer_signature':
      return completedBy === null || job.checklist?.completedAt == null
        ? ''
        : `Checklist completed in EJE by ${userFullName(completedBy)}, ${formatDateTime(job.checklist.completedAt)}`;
    case 'customer_name':
      return job.signature === null
        ? ''
        : `${job.signature.customerName} ${job.signature.customerSurname}`.trim();
    case 'customer_signature':
      return job.signature === null
        ? ''
        : `Signed on this job card, ${formatDateTime(job.signature.signedAt)} (see Customer acceptance)`;
  }
};

const answerFor = (item: ChecklistItem, response: ChecklistResponse | undefined): string => {
  if (response === undefined) return '—';
  switch (item.responseType) {
    case 'pass_fail_na':
      return response.choice === null ? '—' : response.choice.toUpperCase();
    case 'yes_no':
      return response.yesNo === null ? '—' : response.yesNo ? 'YES' : 'NO';
    case 'measurement':
      return response.measurement === null
        ? '—'
        : `${response.measurement}${item.unit === null ? '' : ` ${item.unit}`}`;
    case 'text':
      return response.text.length > 0 ? response.text : '—';
  }
};

/**
 * The photographs a customer document carries: the customer-facing ones, in
 * the job's order. One definition, used by the model below and by both loaders
 * of their pixels (the server's for the issued copy, the browser's for the
 * preview), so nothing loads a photograph the document will not print.
 */
export const documentPhotos = (job: Job): Job['photos'] =>
  // TR-REF-PHOTO-1: a delivery-note reference photo is internal anyway; it is excluded by name as well.
  job.photos.filter((photo) => photo.visibility === 'customer_facing' && photo.purpose === undefined);

export const buildJobCardModel = (input: JobCardModelInput): JobCardModel => {
  const { job, customer, site, contact, machine, settings, checklistTemplate, users } = input;
  const totals = calculateJobTotals(job, settings);
  const definition = getJobTypeDefinition(job.jobType);
  const collectionDocument = buildPartsDocument(job);
  const scheduleWindow = jobScheduleWindow(job);
  const showsPrices = showsPricesOnCollectionDocument(job);
  const latestRefusal = currentRefusal(job);
  const technician = users.find((user) => user.id === job.primaryTechnicianId) ?? null;

  const authorName = (authorId: string): string => {
    const author = users.find((candidate) => candidate.id === authorId);
    return author === undefined ? settings.companyName : userFullName(author);
  };

  const responses = new Map<string, ChecklistResponse>(
    (job.checklist?.responses ?? []).map((response) => [response.itemId, response]),
  );

  const chargeRows: ChargeRow[] = [
    ...job.labour.map((entry, index) => ({
      description: labourRateLabel(entry.rateType),
      detail: entry.description,
      quantity: `${entry.hours.toFixed(2)} hrs`,
      rate: formatCurrency(totals.labourLines[index]?.unitPrice ?? 0),
      amount: formatCurrency(totals.labourLines[index]?.total ?? 0),
    })),
    ...(job.calloutApplied
      ? [
          {
            description: 'Call-out',
            detail: 'fixed call-out fee',
            quantity: '1',
            rate: formatCurrency(totals.pricing.calloutRate),
            amount: formatCurrency(totals.calloutTotal),
          },
        ]
      : []),
    // BENCH-1, BENCH-QTY-1: quantity × rate, from the rates in force or the job's snapshot.
    ...(job.testBenchApplied
      ? [
          {
            description: 'Test bench fee',
            detail: 'test bench fee',
            quantity: String(totals.testBenchLines[0]?.quantity ?? 1),
            rate: formatCurrency(totals.pricing.testBenchFee ?? 0),
            amount: formatCurrency(totals.testBenchTotal),
          },
        ]
      : []),
    ...job.travel.map((entry, index) => ({
      description: 'Travel',
      detail: entry.description,
      quantity: `${entry.kilometres.toFixed(1)} km`,
      rate: formatCurrency(totals.pricing.kilometreRate),
      amount: formatCurrency(totals.travelLines[index]?.total ?? 0),
    })),
    ...job.parts.map((entry, index) => ({
      description: entry.partNumber,
      detail: entry.description,
      quantity: String(entry.quantity),
      rate: formatCurrency(entry.unitPrice),
      amount: formatCurrency(totals.partLines[index]?.total ?? 0),
      mono: true,
    })),
    /*
     * COST-5. After the work, because that is the order the money was decided
     * in: what was done, then what else it cost.
     *
     * No quantity and no rate: the cells are blank rather than carrying a "1"
     * and a repeat of the amount, which would be two numbers on a customer's
     * document that say nothing.
     */
    ...job.additionalCharges.map((entry) => ({
      description: 'Additional charge',
      detail: entry.description,
      quantity: '',
      rate: '',
      amount: formatCurrency(entry.amount),
    })),
  ];

  const progress =
    checklistTemplate === null || job.checklist === null
      ? null
      : evaluateChecklist(checklistTemplate, job.checklist);

  return {
    // A courier's copy is the separate Delivery Note now (PARTS-04); this
    // document is the priced one either way.
    documentTitle: job.jobType === 'parts' ? 'Parts Collection Note' : 'Job Card',
    company: {
      name: settings.companyName,
      address: settings.companyAddress,
      contactLine: `Tel ${settings.companyPhone} · ${settings.companyEmail}`,
      registrationLine: `Reg. ${settings.companyRegistration} · VAT ${settings.companyVatNumber}`,
    },
    jobNumber: job.jobNumber,

    customer: {
      name: customer.name,
      addressLines: [
        site.name,
        site.addressLine1,
        ...(site.addressLine2.length > 0 ? [site.addressLine2] : []),
        `${site.city}, ${site.province} ${site.postalCode}`,
      ].filter((line) => line.trim().length > 0),
      contact:
        contact === null
          ? null
          : {
              name: contactFullName(contact),
              position: contact.position,
              contactLine: `${contact.phone} · ${contact.email}`,
            },
    },
    machine:
      machine === null
        ? null
        : {
            title: machineDisplayName(machine),
            rows: [
              { label: 'Serial number', value: machine.serialNumber, mono: true },
              // Only where the customer has one. Most do not, and an empty row
              // on a document the customer keeps is worse than no row.
              ...(machine.machineNumber.trim().length > 0
                ? [{ label: 'Machine number', value: machine.machineNumber.trim() }]
                : []),
              { label: 'Machine type', value: machine.machineType },
              { label: 'Control', value: machine.controlSystem },
              { label: 'Year', value: String(machine.year) },
            ],
          },
    partsReceived: partsReceivedOf(job),
    received: receivedOf(job),

    jobDetails: [
      {
        label: 'Scheduled',
        value:
          scheduleWindow !== null && scheduleWindow.days > 1
            ? `${formatDate(scheduleWindow.start)} – ${formatDate(scheduleWindow.end)} (${scheduleWindow.days} days)`
            : formatDate(job.scheduledDate),
      },
      // Job type and priority belong to the job, so they are printed HERE with
      // the rest of its details. They were in the header until a customer read
      // "Breakdown · Urgent · Status: Review" as something addressed to them —
      // which it never was.
      { label: 'Job type', value: definition.label },
      /*
       * ONLY WHERE SOMEBODY GRADED IT. Create New Job §3B.
       *
       * The row is omitted on an ungraded job rather than printed as "Not
       * graded", because this is the document the CUSTOMER signs: a line
       * reading "Priority: Not graded" tells them about EJE's internal
       * paperwork, which is not what the job card is for. DOC-1 already omits
       * an empty section rather than printing a bare heading; this is the same
       * rule one row down.
       */
      ...(job.priority === null
        ? []
        : [{ label: 'Priority', value: priorityLabel(job.priority) }]),
      { label: 'Order number', value: job.orderNumber.length > 0 ? job.orderNumber : '—' },
      { label: 'Reference', value: job.referenceNumber.length > 0 ? job.referenceNumber : '—' },
      // Only where the customer works by one, and only when they gave us one.
      ...(definition.capturesDeliveryNote && job.deliveryNote.length > 0
        ? [{ label: jobDetailLabel('deliveryNote', job.jobType), value: job.deliveryNote }]
        : []),
      /*
       * THE TEST & REPAIR FIELDS ON THE CUSTOMER'S DOCUMENT. Test & Repair §4.
       *
       * Printed only where the job type captures them AND the office filled
       * them in, which is the rule the delivery note above already follows:
       * an empty row on a signed document is a question, not information.
       *
       * The unit booked in belongs here more than most fields do — it is what
       * the customer handed over, and the document is their receipt for it.
       */
      ...(definition.capturesQuoteNumber && job.quoteNumber.length > 0
        ? [{ label: 'Quote number', value: job.quoteNumber }]
        : []),
      ...(definition.capturesRepairItem && job.dateReceived !== null
        ? [{ label: 'Date received', value: job.dateReceived }]
        : []),
      // The parts booked in and the collection: see `received` (PDF-RECV-1).
      {
        label: 'Technician',
        value: technician === null ? 'Unassigned' : userFullName(technician),
      },
    ],

    /*
     * PRINTED IF IT WAS WRITTEN, AND NOT PRINTED IF IT WAS NOT. CR-13.
     *
     * A field job always has one — `createJob` refuses it without one — so the
     * fallback below only ever applied to a job type that does not collect
     * one at all. A parts collection is now that case by rule, and a heading
     * over "No fault description recorded." is the empty section DOC-1 exists
     * to keep off the customer's document.
     *
     * A collection raised BEFORE this keeps whatever was written on it, and it
     * still prints. That is why this asks the RECORD rather than the job type.
     */
    faultDescription: job.faultDescription.length > 0 ? job.faultDescription : null,
    /*
     * ONLY WHAT WAS ACTUALLY WRITTEN. MASTER SCOPE DOC-1.
     *
     * An empty optional field is not printed at all — no heading, no "Not
     * recorded" line. A job where the technician wrote up the work and had no
     * recommendations to make should not hand the customer a document with a
     * Recommendations heading and nothing under it; a blank heading reads as a
     * section somebody forgot to fill in rather than as one that did not
     * apply.
     *
     * Work performed is the exception, and it is not really an exception: it
     * is mandatory before the customer can sign, so it always has a value by
     * the time any document is produced. It is still listed conditionally
     * rather than forced, because a PREVIEW can legitimately be rendered
     * mid-capture and "Work performed:" with nothing after it would be the
     * same empty heading on a screen.
     *
     * A write-up with nothing in any field carries no section at all.
     *
     * AND A JOB TYPE WITH NO WRITE-UP CARRIES NONE, whatever its fields hold.
     * Issue #73, Batch 2: a parts collection has no completion write-up, so its
     * note never prints "Work carried out" — not even from text typed before
     * the server started refusing it. The text stays on the record; the
     * document follows the job type's rule.
     */
    workBlocks: (definition.capturesCompletionWriteUp ? [
      { label: 'Fault findings', value: job.completionReport.faultFindings },
      { label: 'Diagnosis', value: job.completionReport.diagnosis },
      { label: 'Work performed', value: job.completionReport.workPerformed },
      { label: 'Recommendations', value: job.completionReport.recommendations },
      { label: 'General notes', value: job.completionReport.generalNotes },
    ] : []).filter((block) => block.value.trim().length > 0),
    // Internal notes are EJE-only; the domain decides which reach a customer.
    notes: customerFacingNotes(job.notes).map((note) => ({
      body: note.body,
      byline: `${authorName(note.authorId)} · ${formatDateTime(note.createdAt)}`,
    })),

    /*
     * Withheld from a courier's copy, in full.
     *
     * A driver collecting on the customer's behalf has no business knowing what
     * the customer paid — not the labour rate, not a part price, not the total.
     * The figures stay on the job for EJE costing; the DOCUMENT is what changes.
     * `showsPricesOnCollectionDocument` is the one place that decides.
     */
    charges:
      chargeRows.length === 0 || !showsPrices
        ? null
        : {
            rows: chargeRows,
            /*
             * COST-5. THE REASON IS PRINTED, not only the figure.
             *
             * A discount with no reason on the customer's own copy is the
             * thing their accounts department telephones about, and the reason
             * is required when it is applied precisely so it can be shown
             * here. `discountTotal` rather than the recorded amount, because
             * what the document must say is what was actually taken off.
             */
            discount:
              job.discount === null || totals.discountTotal === 0
                ? null
                : {
                    grossSubtotal: formatCurrency(totals.grossSubtotal),
                    amount: formatCurrency(totals.discountTotal),
                    reason: job.discount.reason,
                  },
            subtotal: formatCurrency(totals.subtotal),
            vatLabel: `VAT @ ${totals.pricing.vatPercentage}%`,
            vat: formatCurrency(totals.vat),
            total: formatCurrency(totals.total),
          },

    checklist:
      checklistTemplate === null || job.checklist === null || progress === null
        ? null
        : {
            title: `${checklistTemplate.name} (version ${job.checklist.templateVersion} — as completed)`,
            documentTitle: checklistTemplate.layout?.title ?? null,
            checklistType:
              (checklistTemplate.selectionLabel ?? '').length > 0
                ? `${definition.label} checklist: ${checklistTemplate.selectionLabel}`
                : null,
            header: (checklistTemplate.layout?.headerFields ?? []).map((field) => ({
              label: field.label,
              value: checklistHeaderValue(field.source, {
                job,
                customer,
                site,
                contact,
                machine,
              }),
            })),
            notes: checklistTemplate.layout?.notes ?? [],
            closing: checklistTemplate.layout?.closing ?? '',
            signatures: (checklistTemplate.layout?.signatures ?? []).map((line) => ({
              label: line.label,
              value: checklistSignatureValue(line.role, job, users),
            })),
            summary: [
              `${progress.answered} of ${progress.total} items answered`,
              ...(progress.failedItems > 0 ? [`${progress.failedItems} failed`] : []),
              ...(job.checklist.completedAt !== null
                ? [`completed ${formatDateTime(job.checklist.completedAt)}`]
                : []),
            ].join(' · '),
            sections: checklistTemplate.sections.map((section) => ({
              title: section.title,
              items: section.items.map((item, index) => {
                const response = responses.get(item.id);
                const group = item.group ?? '';
                const firstOfGroup =
                  group.length > 0 && (section.items[index - 1]?.group ?? '') !== group;
                return {
                  number: group.length > 0 ? '' : (item.number ?? ''),
                  groupHeading: firstOfGroup ? `${item.number ?? ''} ${group}`.trim() : '',
                  text: item.text,
                  answer: answerFor(item, response),
                  note: response?.notes.trim() ?? '',
                  readings: formatFieldValues(item, response),
                  sourceNote: item.sourceNote ?? '',
                };
              }),
            })),
          },

    collection:
      definition.collectedOnCompletion && !showsPrices
        ? {
            heading: 'Goods collected',
            lines: collectionDocument.lines.map((line) => ({
              partNumber: line.partNumber,
              description: line.description,
              quantity: String(line.quantity),
            })),
            totalLabel: 'Items',
            totalQuantity: String(collectionDocument.totalQuantity),
            priceNote:
              'Prices are withheld from a courier collection. They remain on the job for EJE costing.',
          }
        : null,

    /*
     * ONLY WHAT THE CUSTOMER IS MEANT TO SEE. MEDIA-1, MEDIA-2.
     *
     * This mapped EVERY photograph, so a technician's note to the workshop — a
     * damaged part being claimed for, an unsafe installation — had its caption
     * printed on the document the customer signed. There was no way to say
     * otherwise until `visibility` existed, which is what MEDIA-2 was blocked on.
     *
     * The filter is here, in the MODEL, rather than in the renderer: this object
     * is what every output shares — the on-screen preview, the PDF and the stored
     * document — so filtering once is what makes them agree. A renderer that
     * filtered for itself would leave the others printing the internal ones.
     */
    photos: documentPhotos(job).map((photo) => ({ id: photo.id, caption: photo.caption, fileName: photo.fileName })),

    acceptance:
      job.signature === null
        ? null
        : {
            declaration: job.signature.declaration,
            rows: [
              {
                label: 'Name',
                value: `${job.signature.customerName} ${job.signature.customerSurname}`,
              },
              { label: 'Signed', value: formatDateTime(job.signature.signedAt) },
            ],
            signatureData: job.signature.strokeData,
            caption: job.jobType === 'parts' ? 'Collector signature' : 'Customer signature',
            /*
             * A COURIER COLLECTION: THE ONE SIGNATURE, GIVEN ON THE DELIVERY NOTE.
             * PARTS-03/04. The courier signed once, on the Delivery Note they were
             * shown; this priced card carries that same signature and says so,
             * with the reference both documents print — it never implies the
             * courier signed the job card separately.
             */
            ...(requiresDeliveryNote(job)
              ? {
                  caption: 'Courier signature — given once, on the Delivery Note',
                  rows: [
                    { label: 'Name', value: `${job.signature.customerName} ${job.signature.customerSurname}` },
                    { label: 'Signed', value: formatDateTime(job.signature.signedAt) },
                    { label: 'Signed on', value: 'The Delivery Note for this courier collection (one signature for both documents)' },
                    { label: 'Signature reference', value: courierSignatureReference(job) ?? '' },
                  ],
                }
              : {}),
          },

    // The customer's refusal, frozen onto the document exactly as a signature
    // would be. Drawn from the job's own stored record, so the issued PDF says
    // what was true when it was issued.
    /*
     * The LATEST refusal, and only when the customer never went on to sign.
     *
     * A job card the customer eventually signed carries their signature and
     * nothing about the attempts before it: the earlier refusals are EJE's
     * record of how the job went, not something to hand back to the customer
     * on the document they just signed.
     */
    refusal:
      job.signature !== null || latestRefusal === null
        ? null
        : {
            heading: signatoryLabelsFor(job.jobType).refusedLabel,
            reason: latestRefusal.reason,
            rows: [
              { label: 'Recorded by', value: authorName(latestRefusal.recordedBy) },
              { label: 'Date', value: formatDateTime(latestRefusal.recordedAt) },
            ],
          },

    footerLines: [
      `${settings.companyName} · ${job.jobNumber} · Generated ${formatDateTime(input.generatedAt)} · Demonstration document, fictional data`,
      // Says WHY the rates were frozen when they were. A refused job card must
      // not claim the customer signed — the rest of the document exists to say
      // they did not.
      ...(job.pricingSnapshot !== null
        ? [
            `Priced at the rates in force on ${formatDateTime(job.pricingSnapshot.capturedAt)}, ` +
              (job.signature !== null || latestRefusal === null
                ? 'when the customer signed.'
                : 'when the work was completed.'),
          ]
        : []),
    ],
  };
};
