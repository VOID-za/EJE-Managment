import {
  calculateJobTotals,
  contactFullName,
  customerFacingNotes,
  evaluateChecklist,
  getJobTypeDefinition,
  jobScheduleWindow,
  jobStatusLabel,
  labourRateLabel,
  machineDisplayName,
  priorityLabel,
  userFullName,
  type ChecklistItem,
  type ChecklistResponse,
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
  readonly text: string;
  readonly answer: string;
  readonly note: string;
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
  readonly jobMeta: string;
  readonly statusLine: string;

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

  readonly faultDescription: string;
  readonly workBlocks: readonly { readonly label: string; readonly value: string }[];
  readonly notes: readonly { readonly body: string; readonly byline: string }[];

  readonly charges: {
    readonly rows: readonly ChargeRow[];
    readonly subtotal: string;
    readonly vatLabel: string;
    readonly vat: string;
    readonly total: string;
  } | null;

  readonly checklist: {
    readonly title: string;
    readonly summary: string;
    readonly sections: readonly {
      readonly title: string;
      readonly items: readonly ChecklistItemLine[];
    }[];
  } | null;

  readonly photos: readonly { readonly caption: string }[];

  readonly acceptance: {
    readonly declaration: string;
    readonly rows: readonly LabelValue[];
    /** Raw stored signature data; `signatureFacsimile` decides how to draw it. */
    readonly signatureData: string;
    readonly caption: string;
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

const NOT_RECORDED = 'Not recorded';

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

export const buildJobCardModel = (input: JobCardModelInput): JobCardModel => {
  const { job, customer, site, contact, machine, settings, checklistTemplate, users } = input;
  const totals = calculateJobTotals(job, settings);
  const definition = getJobTypeDefinition(job.jobType);
  const scheduleWindow = jobScheduleWindow(job);
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
  ];

  const progress =
    checklistTemplate === null || job.checklist === null
      ? null
      : evaluateChecklist(checklistTemplate, job.checklist);

  const hasWriteUp = [
    job.completionReport.faultFindings,
    job.completionReport.diagnosis,
    job.completionReport.workPerformed,
    job.completionReport.recommendations,
    job.completionReport.generalNotes,
  ].some((value) => value.trim().length > 0);

  return {
    documentTitle:
      job.jobType === 'parts'
        ? job.courierCollection
          ? 'Delivery Note'
          : 'Parts Collection Note'
        : 'Job Card',
    company: {
      name: settings.companyName,
      address: settings.companyAddress,
      contactLine: `Tel ${settings.companyPhone} · ${settings.companyEmail}`,
      registrationLine: `Reg. ${settings.companyRegistration} · VAT ${settings.companyVatNumber}`,
    },
    jobNumber: job.jobNumber,
    jobMeta: `${definition.label} · ${priorityLabel(job.priority)}`,
    statusLine: `Status: ${jobStatusLabel(job.status)}`,

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
              { label: 'Machine type', value: machine.machineType },
              { label: 'Control', value: machine.controlSystem },
              { label: 'Year', value: String(machine.year) },
            ],
          },
    jobDetails: [
      {
        label: 'Scheduled',
        value:
          scheduleWindow !== null && scheduleWindow.days > 1
            ? `${formatDate(scheduleWindow.start)} – ${formatDate(scheduleWindow.end)} (${scheduleWindow.days} days)`
            : formatDate(job.scheduledDate),
      },
      { label: 'Order number', value: job.orderNumber.length > 0 ? job.orderNumber : '—' },
      { label: 'Reference', value: job.referenceNumber.length > 0 ? job.referenceNumber : '—' },
      {
        label: 'Technician',
        value: technician === null ? 'Unassigned' : userFullName(technician),
      },
    ],

    faultDescription:
      job.faultDescription.length > 0 ? job.faultDescription : 'No fault description recorded.',
    // A write-up with nothing in any field is not worth a section: a parts
    // collection has no work to describe, and four "Not recorded" lines are
    // noise on the document rather than information.
    workBlocks: hasWriteUp
      ? [
          { label: 'Fault findings', value: job.completionReport.faultFindings },
          { label: 'Diagnosis', value: job.completionReport.diagnosis },
          { label: 'Work performed', value: job.completionReport.workPerformed },
          { label: 'Recommendations', value: job.completionReport.recommendations },
          ...(job.completionReport.generalNotes.trim().length > 0
            ? [{ label: 'General notes', value: job.completionReport.generalNotes }]
            : []),
        ].map((block) => ({
          label: block.label,
          value: block.value.trim().length > 0 ? block.value : NOT_RECORDED,
        }))
      : [],
    // Internal notes are EJE-only; the domain decides which reach a customer.
    notes: customerFacingNotes(job.notes).map((note) => ({
      body: note.body,
      byline: `${authorName(note.authorId)} · ${formatDateTime(note.createdAt)}`,
    })),

    charges:
      chargeRows.length === 0
        ? null
        : {
            rows: chargeRows,
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
            summary: [
              `${progress.answered} of ${progress.total} items answered`,
              ...(progress.failedItems > 0 ? [`${progress.failedItems} failed`] : []),
              ...(job.checklist.completedAt !== null
                ? [`completed ${formatDateTime(job.checklist.completedAt)}`]
                : []),
            ].join(' · '),
            sections: checklistTemplate.sections.map((section) => ({
              title: section.title,
              items: section.items.map((item) => {
                const response = responses.get(item.id);
                return {
                  text: item.text,
                  answer: answerFor(item, response),
                  note: response?.notes.trim() ?? '',
                };
              }),
            })),
          },

    photos: job.photos.map((photo) => ({ caption: photo.caption })),

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
          },

    footerLines: [
      `${settings.companyName} · ${job.jobNumber} · Generated ${formatDateTime(input.generatedAt)} · Demonstration document, fictional data`,
      ...(job.pricingSnapshot !== null
        ? [
            `Priced at the rates in force on ${formatDateTime(job.pricingSnapshot.capturedAt)}, when the customer signed.`,
          ]
        : []),
    ],
  };
};
