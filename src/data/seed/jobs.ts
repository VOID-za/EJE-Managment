import {
  asAttachmentId,
  asChecklistTemplateId,
  asContactId,
  asCustomerId,
  asJobId,
  asLineItemId,
  asMachineId,
  asSiteId,
  asUserId,
  emptyChecklistResponse,
  emptyCompletionReport,
  PARTS_COLLECTION_DECLARATION,
  SIGNATURE_DECLARATION,
  type Attachment,
  type FinalDocument,
  type IsoDateTime,
  type Job,
  type PricingSnapshot,
} from '@/domain';
import { dateOffset, nextMonday, timeOffset } from './reference';

/**
 * Seeded demo jobs.
 *
 * The set is chosen so every dashboard tile, every workflow state and every
 * empty and overdue edge case has real data behind it. All content is fictional.
 */

const jobPhoto = (
  id: string,
  fileName: string,
  caption: string,
  days: number,
  hours: number,
  uploadedBy: string,
): Attachment => ({
  id: asAttachmentId(id),
  kind: 'photo',
  fileName,
  caption,
  storageKey: `jobs/${fileName}`,
  uploadedAt: timeOffset(days, hours),
  uploadedBy: asUserId(uploadedBy),
  sizeBytes: 2_140_000,
});

/**
 * The final document held on a closed job.
 *
 * Seeded rather than produced on demand, because that is how a closed job
 * really behaves: the copy the customer received was rendered once, when the
 * Master issued it, and opening the record months later must hand back that
 * same document instead of making a new one.
 */
const finalJobCard = (
  jobNumber: string,
  /** The real page count of the rendered file, measured, not estimated. */
  pageCount: number,
  generatedAt: IsoDateTime,
  issuedTo: string,
): FinalDocument => ({
  fileName: `${jobNumber}-Final-Job-Card.pdf`,
  storageKey: `jobcards/final/${jobNumber}.pdf`,
  pageCount,
  generatedAt,
  generatedBy: asUserId('user-master-elmarie'),
  simulated: true,
  issuedTo,
});

const finalPartsNote = (
  jobNumber: string,
  generatedAt: IsoDateTime,
  issuedTo: string,
): FinalDocument => ({
  fileName: `${jobNumber}-Final-Parts-Collection-Note.pdf`,
  storageKey: `partsnotes/final/${jobNumber}.pdf`,
  pageCount: 1,
  generatedAt,
  generatedBy: asUserId('user-master-elmarie'),
  simulated: true,
  issuedTo,
});

/**
 * The rates that applied when the job was signed.
 *
 * Every closed job carries one. Without it a historical job card would be
 * re-priced at today's rates, which would change an invoice that has already
 * been issued.
 */
const ratesAt = (capturedAt: IsoDateTime, normal: number, callout: number): PricingSnapshot => ({
  labourRates: { normal, overtime: Math.round(normal * 1.5), double: normal * 2 },
  calloutRate: callout,
  kilometreRate: 1550,
  vatPercentage: 15,
  capturedAt,
  reason: 'customer_signature',
});

const baseJob = (jobNumber: string): Job => ({
  id: asJobId(`job-${jobNumber.toLowerCase()}`),
  jobNumber,
  customerId: asCustomerId('cust-abc'),
  siteId: asSiteId('site-abc-jhb'),
  contactId: asContactId('contact-abc-jhb'),
  machineId: asMachineId('machine-abc-lv40'),
  jobType: 'breakdown',
  priority: 'normal',
  status: 'open',
  scheduledDate: null,
  scheduledEndDate: null,
  orderNumber: '',
  referenceNumber: '',
  faultDescription: '',
  attachments: [],
  primaryTechnicianId: null,
  additionalTechnicianIds: [],
  labour: [],
  travel: [],
  parts: [],
  photos: [],
  videos: [],
  notes: [],
  completionReport: emptyCompletionReport(),
  checklist: null,
  signature: null,
  awaitingSparesReason: '',
  calloutApplied: false,
  courierCollection: false,
  pricingSnapshot: null,
  finalDocument: null,
  cancellation: null,
  deletedAt: null,
  deletedBy: null,
  deletionReason: '',
  createdAt: timeOffset(-10, 8),
  createdBy: asUserId('user-master-elmarie'),
  acceptedAt: null,
  completedAt: null,
  submittedAt: null,
  closedAt: null,
});

const job = (jobNumber: string, overrides: Partial<Job>): Job => ({
  ...baseJob(jobNumber),
  ...overrides,
});

export const seedJobs: readonly Job[] = [
  // The flagship demonstration job: freshly dispatched and not yet accepted, so a
  // walkthrough can run the entire journey live — accept, capture, write up, sign,
  // submit — on one job without switching between records.
  job('EJE-1048', {
    jobType: 'breakdown',
    priority: 'urgent',
    status: 'open',
    machineId: asMachineId('machine-abc-lv40'),
    siteId: asSiteId('site-abc-jhb'),
    contactId: asContactId('contact-abc-jhb'),
    scheduledDate: dateOffset(0),
    orderNumber: 'PO-88123',
    referenceNumber: 'ABC-BRK-2291',
    faultDescription: 'Machine stopped during operation. Spindle fault reported.',
    primaryTechnicianId: asUserId('user-tech-sipho'),
    additionalTechnicianIds: [asUserId('user-tech-andre')],
    createdAt: timeOffset(0, 6, 40),
    createdBy: asUserId('user-master-elmarie'),
    notes: [
      {
        id: 'note-1048-1',
        body: 'Customer production manager pushing for same-day repair. The last service on this machine recommended replacing the spindle drive cooling fan — a spare is in the Isando stores.',
        authorId: asUserId('user-master-johan'),
        createdAt: timeOffset(0, 6, 55),
        internal: true,
      },
    ],
  }),

  // Keeps the Master dashboard's In Progress tile meaningful while EJE-1048 is
  // still waiting to be accepted.
  job('EJE-1061', {
    jobType: 'breakdown',
    priority: 'high',
    status: 'in_progress',
    customerId: asCustomerId('cust-kruger'),
    siteId: asSiteId('site-kruger-main'),
    contactId: asContactId('contact-kruger-main'),
    machineId: asMachineId('machine-kruger-vf2'),
    scheduledDate: dateOffset(0),
    orderNumber: 'PO-10251',
    referenceNumber: 'KRU-BRK-124',
    faultDescription:
      'Tool changer jamming intermittently on the VF-2. Machine stops mid-cycle.',
    primaryTechnicianId: asUserId('user-tech-riaan'),
    createdAt: timeOffset(0, 7, 20),
    createdBy: asUserId('user-master-elmarie'),
    acceptedAt: timeOffset(0, 7, 45),
    travel: [
      {
        id: asLineItemId('trv-1061-1'),
        technicianId: asUserId('user-tech-riaan'),
        date: dateOffset(0),
        kilometres: 52,
        description: 'Isando to Benoni return',
        capturedAt: timeOffset(0, 8, 30),
      },
    ],
    labour: [
      {
        id: asLineItemId('lab-1061-1'),
        technicianId: asUserId('user-tech-riaan'),
        date: dateOffset(0),
        rateType: 'normal',
        hours: 2,
        description: 'Tool changer fault finding',
        capturedAt: timeOffset(0, 11),
      },
    ],
    completionReport: {
      ...emptyCompletionReport(),
      faultFindings: 'Tool changer carousel proximity switch intermittent.',
    },
  }),

  job('EJE-1049', {
    jobType: 'service',
    priority: 'normal',
    status: 'open',
    customerId: asCustomerId('cust-abc'),
    siteId: asSiteId('site-abc-pta'),
    contactId: asContactId('contact-abc-pta'),
    machineId: asMachineId('machine-abc-st20'),
    // Anchored to a Monday so the booking renders as one continuous bar.
    scheduledDate: nextMonday(),
    scheduledEndDate: nextMonday(2),
    orderNumber: 'PO-88201',
    referenceNumber: 'ABC-SVC-Q3',
    faultDescription:
      'Scheduled 6-monthly preventative service as per the maintenance agreement.',
    primaryTechnicianId: asUserId('user-tech-riaan'),
    createdAt: timeOffset(-6, 9, 10),
  }),

  job('EJE-1050', {
    jobType: 'installation',
    priority: 'high',
    status: 'open',
    customerId: asCustomerId('cust-midrand'),
    siteId: asSiteId('site-midrand-main'),
    contactId: asContactId('contact-midrand-main'),
    machineId: asMachineId('machine-midrand-lathe'),
    scheduledDate: dateOffset(1),
    orderNumber: 'PO-44920',
    referenceNumber: 'MAG-INST-004',
    faultDescription:
      'Installation and commissioning of the new Doosan Puma 2600 on Line 2, including operator familiarisation.',
    primaryTechnicianId: asUserId('user-tech-francois'),
    additionalTechnicianIds: [asUserId('user-tech-thabo')],
    createdAt: timeOffset(-8, 11, 30),
    createdBy: asUserId('user-master-denise'),
  }),

  job('EJE-1051', {
    jobType: 'test_and_repair',
    priority: 'high',
    status: 'awaiting_spares',
    customerId: asCustomerId('cust-kruger'),
    siteId: asSiteId('site-kruger-main'),
    contactId: asContactId('contact-kruger-main'),
    machineId: asMachineId('machine-kruger-vf2'),
    scheduledDate: dateOffset(-4),
    orderNumber: 'PO-10233',
    referenceNumber: 'KRU-TR-118',
    faultDescription:
      'Axis drive removed for workshop testing. Intermittent Z-axis following error under load.',
    primaryTechnicianId: asUserId('user-tech-deon'),
    awaitingSparesReason:
      'Replacement IGBT module on back-order from the supplier. ETA confirmed for next week.',
    createdAt: timeOffset(-9, 8, 15),
    acceptedAt: timeOffset(-4, 8, 40),
    labour: [
      {
        id: asLineItemId('lab-1051-1'),
        technicianId: asUserId('user-tech-deon'),
        date: dateOffset(-4),
        rateType: 'normal',
        hours: 4,
        description: 'Bench testing of Z-axis drive, fault isolated to output stage',
        capturedAt: timeOffset(-4, 15),
      },
    ],
    notes: [
      {
        id: 'note-1051-1',
        body: 'Output stage IGBT module failed under load. Part ordered, supplier ETA next week. Customer informed.',
        authorId: asUserId('user-tech-deon'),
        createdAt: timeOffset(-4, 15, 20),
        internal: false,
      },
    ],
    completionReport: {
      ...emptyCompletionReport(),
      faultFindings: 'Z-axis drive output stage failing under load, confirmed on the test bench.',
      diagnosis: 'IGBT module in the drive output stage has degraded and requires replacement.',
    },
  }),

  job('EJE-1052', {
    jobType: 'breakdown',
    priority: 'urgent',
    status: 'awaiting_spares',
    customerId: asCustomerId('cust-highveld'),
    siteId: asSiteId('site-highveld-centurion'),
    contactId: asContactId('contact-highveld-main'),
    machineId: asMachineId('machine-highveld-dmu50'),
    scheduledDate: dateOffset(-1),
    orderNumber: 'PO-77410',
    referenceNumber: 'HAC-BRK-556',
    faultDescription:
      'Rotary table not indexing. Siemens control reporting axis fault on the B-axis.',
    primaryTechnicianId: asUserId('user-tech-naledi'),
    awaitingSparesReason: 'Encoder assembly quoted to the customer. Awaiting purchase order.',
    createdAt: timeOffset(-2, 7, 5),
    acceptedAt: timeOffset(-2, 7, 40),
    travel: [
      {
        id: asLineItemId('trv-1052-1'),
        technicianId: asUserId('user-tech-naledi'),
        date: dateOffset(-2),
        kilometres: 92,
        description: 'Isando to Centurion return',
        capturedAt: timeOffset(-2, 9),
      },
    ],
    labour: [
      {
        id: asLineItemId('lab-1052-1'),
        technicianId: asUserId('user-tech-naledi'),
        date: dateOffset(-2),
        rateType: 'normal',
        hours: 3,
        description: 'B-axis fault diagnosis',
        capturedAt: timeOffset(-2, 14),
      },
    ],
    completionReport: {
      ...emptyCompletionReport(),
      faultFindings: 'B-axis encoder giving intermittent position feedback loss.',
    },
  }),

  job('EJE-1053', {
    jobType: 'service',
    priority: 'normal',
    status: 'completion',
    customerId: asCustomerId('cust-abc'),
    siteId: asSiteId('site-abc-ger'),
    contactId: asContactId('contact-abc-ger'),
    machineId: asMachineId('machine-abc-mcv760'),
    scheduledDate: dateOffset(-1),
    scheduledEndDate: dateOffset(1),
    orderNumber: 'PO-88190',
    referenceNumber: 'ABC-SVC-GER-08',
    faultDescription: 'Scheduled preventative service on the MCV-760 machining centre.',
    primaryTechnicianId: asUserId('user-tech-thabo'),
    createdAt: timeOffset(-5, 9),
    acceptedAt: timeOffset(0, 7, 50),
    travel: [
      {
        id: asLineItemId('trv-1053-1'),
        technicianId: asUserId('user-tech-thabo'),
        date: dateOffset(0),
        kilometres: 34,
        description: 'Isando to Germiston return',
        capturedAt: timeOffset(0, 8, 30),
      },
    ],
    labour: [
      {
        id: asLineItemId('lab-1053-1'),
        technicianId: asUserId('user-tech-thabo'),
        date: dateOffset(0),
        rateType: 'normal',
        hours: 4,
        description: 'Preventative service as per the service checklist',
        capturedAt: timeOffset(0, 13),
      },
    ],
    parts: [
      {
        id: asLineItemId('prt-1053-1'),
        partNumber: 'FLT-CAB-220',
        description: 'Electrical cabinet filter mat, 220 x 220 mm',
        quantity: 2,
        unitPrice: 18500,
        capturedAt: timeOffset(0, 13, 10),
      },
      {
        id: asLineItemId('prt-1053-2'),
        partNumber: 'BAT-3V-FAN',
        description: 'Fanuc control memory battery, 3V lithium',
        quantity: 1,
        unitPrice: 42000,
        capturedAt: timeOffset(0, 13, 12),
      },
    ],
    completionReport: {
      faultFindings: 'No active faults. Cabinet filters heavily contaminated with machining dust.',
      diagnosis:
        'Machine in serviceable condition. Cabinet cooling compromised by blocked filters.',
      workPerformed:
        'Completed the full preventative service checklist. Replaced both cabinet filter mats and the control memory battery. Checked and topped up way lube, verified coolant concentration and air pressure, tested all safety circuits and completed a machine test run.',
      recommendations:
        'Filter mats are blocking faster than the 6-month interval allows. Recommend a 3-month filter change on this machine, or fitting a pre-filter to the cabinet inlet.',
      generalNotes: 'Machine handed back to production at 14:10.',
    },
    photos: [
      jobPhoto(
        'att-1053-1',
        'eje-1053-filters.jpg',
        'Cabinet filter mats before replacement',
        0,
        11,
        'user-tech-thabo',
      ),
    ],
  }),

  job('EJE-1054', {
    jobType: 'breakdown',
    priority: 'high',
    status: 'review',
    customerId: asCustomerId('cust-vaal'),
    siteId: asSiteId('site-vaal-main'),
    contactId: asContactId('contact-vaal-main'),
    machineId: asMachineId('machine-vaal-tl2'),
    scheduledDate: dateOffset(-1),
    orderNumber: 'PO-30188',
    referenceNumber: 'VTS-BRK-042',
    faultDescription: 'Machine tripping the incoming breaker on start-up.',
    primaryTechnicianId: asUserId('user-tech-lerato'),
    createdAt: timeOffset(-1, 6, 55),
    acceptedAt: timeOffset(-1, 7, 20),
    completedAt: timeOffset(-1, 15, 30),
    travel: [
      {
        id: asLineItemId('trv-1054-1'),
        technicianId: asUserId('user-tech-lerato'),
        date: dateOffset(-1),
        kilometres: 128,
        description: 'Isando to Vereeniging return',
        capturedAt: timeOffset(-1, 8),
      },
    ],
    labour: [
      {
        id: asLineItemId('lab-1054-1'),
        technicianId: asUserId('user-tech-lerato'),
        date: dateOffset(-1),
        rateType: 'normal',
        hours: 5,
        description: 'Fault finding and transformer replacement',
        capturedAt: timeOffset(-1, 15),
      },
    ],
    parts: [
      {
        id: asLineItemId('prt-1054-1'),
        partNumber: 'TRF-400-110',
        description: 'Control transformer 400/110V 500VA',
        quantity: 1,
        unitPrice: 312000,
        capturedAt: timeOffset(-1, 15, 5),
      },
    ],
    completionReport: {
      faultFindings:
        'Control transformer primary winding shorted to the core, tripping the incoming breaker on energisation.',
      diagnosis: 'Control transformer failure caused by long-term moisture ingress in the cabinet.',
      workPerformed:
        'Isolated the machine and confirmed the short with an insulation test. Replaced the control transformer, re-tested insulation resistance, re-energised and ran the machine through a full function test. Sealed the cabinet gland plate where moisture was entering.',
      recommendations:
        'Cabinet is located under a leaking roof sheet. Customer should repair the roof to prevent a repeat failure.',
      generalNotes: 'Machine returned to service and running normally at hand-over.',
    },
    photos: [
      jobPhoto(
        'att-1054-1',
        'eje-1054-transformer.jpg',
        'Failed control transformer removed from the cabinet',
        -1,
        12,
        'user-tech-lerato',
      ),
      jobPhoto(
        'att-1054-2',
        'eje-1054-gland.jpg',
        'Gland plate resealed after moisture ingress',
        -1,
        14,
        'user-tech-lerato',
      ),
    ],
    signature: {
      customerName: 'Sanele',
      customerSurname: 'Zulu',
      strokeData: 'demo-signature-sanele-zulu',
      signedAt: timeOffset(-1, 15, 45),
      declaration: SIGNATURE_DECLARATION,
    },
  }),

  job('EJE-1055', {
    jobType: 'service',
    priority: 'normal',
    status: 'submitted',
    customerId: asCustomerId('cust-highveld'),
    siteId: asSiteId('site-highveld-centurion'),
    contactId: asContactId('contact-highveld-main'),
    machineId: asMachineId('machine-highveld-grinder'),
    scheduledDate: dateOffset(-4),
    scheduledEndDate: dateOffset(-3),
    orderNumber: 'PO-77388',
    referenceNumber: 'HAC-SVC-221',
    faultDescription: 'Annual preventative service on the Okamoto surface grinder.',
    primaryTechnicianId: asUserId('user-tech-riaan'),
    createdAt: timeOffset(-14, 10),
    acceptedAt: timeOffset(-3, 7, 30),
    completedAt: timeOffset(-3, 14),
    submittedAt: timeOffset(-3, 14, 25),
    travel: [
      {
        id: asLineItemId('trv-1055-1'),
        technicianId: asUserId('user-tech-riaan'),
        date: dateOffset(-3),
        kilometres: 88,
        description: 'Isando to Centurion return',
        capturedAt: timeOffset(-3, 8),
      },
    ],
    labour: [
      {
        id: asLineItemId('lab-1055-1'),
        technicianId: asUserId('user-tech-riaan'),
        date: dateOffset(-3),
        rateType: 'normal',
        hours: 3.5,
        description: 'Annual preventative service',
        capturedAt: timeOffset(-3, 14),
      },
    ],
    completionReport: {
      faultFindings: 'No faults found.',
      diagnosis: 'Machine in good condition for its age.',
      workPerformed:
        'Completed the annual service checklist. Cleaned the cabinet, checked all safety circuits, lubricated ways and verified hydraulic pressure.',
      recommendations: 'Replace the way wipers at the next service.',
      generalNotes: '',
    },
    signature: {
      customerName: 'Anita',
      customerSurname: 'Ferreira',
      strokeData: 'demo-signature-anita-ferreira',
      signedAt: timeOffset(-3, 14, 15),
      declaration: SIGNATURE_DECLARATION,
    },
  }),

  job('EJE-1056', {
    jobType: 'breakdown',
    priority: 'urgent',
    status: 'closed',
    customerId: asCustomerId('cust-abc'),
    siteId: asSiteId('site-abc-jhb'),
    contactId: asContactId('contact-abc-jhb'),
    machineId: asMachineId('machine-abc-lv40'),
    scheduledDate: dateOffset(-21),
    orderNumber: 'PO-87740',
    referenceNumber: 'ABC-BRK-2180',
    faultDescription: 'Coolant pump not running. Machine alarming on low coolant flow.',
    primaryTechnicianId: asUserId('user-tech-sipho'),
    createdAt: timeOffset(-21, 7),
    acceptedAt: timeOffset(-21, 7, 25),
    completedAt: timeOffset(-21, 12),
    submittedAt: timeOffset(-21, 12, 20),
    closedAt: timeOffset(-21, 12, 20),
    pricingSnapshot: ratesAt(timeOffset(-21, 12, 10), 84000, 74000),
    finalDocument: finalJobCard('EJE-1056', 1, timeOffset(-21, 12, 20), 'pieter.nel@abc-engineering-demo.co.za'),
    travel: [
      {
        id: asLineItemId('trv-1056-1'),
        technicianId: asUserId('user-tech-sipho'),
        date: dateOffset(-21),
        kilometres: 48,
        description: 'Isando to Johannesburg site and return',
        capturedAt: timeOffset(-21, 8),
      },
    ],
    labour: [
      {
        id: asLineItemId('lab-1056-1'),
        technicianId: asUserId('user-tech-sipho'),
        date: dateOffset(-21),
        rateType: 'normal',
        hours: 3,
        description: 'Coolant pump replacement',
        capturedAt: timeOffset(-21, 12),
      },
    ],
    parts: [
      {
        id: asLineItemId('prt-1056-1'),
        partNumber: 'PMP-CLT-075',
        description: 'Coolant pump 0.75kW, 3-phase',
        quantity: 1,
        unitPrice: 486000,
        capturedAt: timeOffset(-21, 12, 5),
      },
    ],
    completionReport: {
      faultFindings: 'Coolant pump motor windings open circuit.',
      diagnosis: 'Pump motor failed. Non-standard pump previously fitted by others.',
      workPerformed:
        'Replaced the coolant pump with the correct specification unit, re-wired to the machine loom, tested flow and cleared the alarm.',
      recommendations: 'Clean the coolant tank at the next service.',
      generalNotes: '',
    },
    signature: {
      customerName: 'Pieter',
      customerSurname: 'Nel',
      strokeData: 'demo-signature-pieter-nel',
      signedAt: timeOffset(-21, 12, 10),
      declaration: SIGNATURE_DECLARATION,
    },
  }),

  job('EJE-1057', {
    jobType: 'service',
    priority: 'low',
    status: 'closed',
    customerId: asCustomerId('cust-kruger'),
    siteId: asSiteId('site-kruger-main'),
    contactId: asContactId('contact-kruger-main'),
    machineId: asMachineId('machine-kruger-vf2'),
    scheduledDate: dateOffset(-38),
    orderNumber: 'PO-10190',
    referenceNumber: 'KRU-SVC-097',
    faultDescription: 'Six-monthly preventative service.',
    primaryTechnicianId: asUserId('user-tech-deon'),
    createdAt: timeOffset(-45, 9),
    acceptedAt: timeOffset(-38, 8),
    completedAt: timeOffset(-38, 13),
    submittedAt: timeOffset(-38, 13, 15),
    closedAt: timeOffset(-38, 13, 15),
    pricingSnapshot: ratesAt(timeOffset(-38, 13, 5), 83000, 73000),
    finalDocument: finalJobCard('EJE-1057', 1, timeOffset(-38, 13, 15), 'hennie@krugerprecision-demo.co.za'),
    labour: [
      {
        id: asLineItemId('lab-1057-1'),
        technicianId: asUserId('user-tech-deon'),
        date: dateOffset(-38),
        rateType: 'normal',
        hours: 3,
        description: 'Preventative service',
        capturedAt: timeOffset(-38, 13),
      },
    ],
    travel: [
      {
        id: asLineItemId('trv-1057-1'),
        technicianId: asUserId('user-tech-deon'),
        date: dateOffset(-38),
        kilometres: 52,
        description: 'Isando to Benoni return',
        capturedAt: timeOffset(-38, 8),
      },
    ],
    completionReport: {
      faultFindings: 'Way covers showing wear.',
      diagnosis: 'Machine serviceable.',
      workPerformed: 'Completed the service checklist and replaced the way lube filter.',
      recommendations: 'Budget for way cover replacement in the next 12 months.',
      generalNotes: '',
    },
    signature: {
      customerName: 'Hennie',
      customerSurname: 'Kruger',
      strokeData: 'demo-signature-hennie-kruger',
      signedAt: timeOffset(-38, 13, 5),
      declaration: SIGNATURE_DECLARATION,
    },
  }),

  job('EJE-1058', {
    jobType: 'breakdown',
    priority: 'high',
    status: 'open',
    customerId: asCustomerId('cust-midrand'),
    siteId: asSiteId('site-midrand-main'),
    contactId: asContactId('contact-midrand-main'),
    machineId: asMachineId('machine-midrand-press'),
    scheduledDate: dateOffset(-2),
    orderNumber: 'PO-44988',
    referenceNumber: 'MAG-BRK-091',
    faultDescription:
      'Press brake safety light curtain intermittently faulting, stopping production.',
    primaryTechnicianId: asUserId('user-tech-lerato'),
    createdAt: timeOffset(-2, 6, 30),
    createdBy: asUserId('user-master-denise'),
  }),

  job('EJE-1059', {
    jobType: 'test_and_repair',
    priority: 'normal',
    status: 'open',
    customerId: asCustomerId('cust-vaal'),
    siteId: asSiteId('site-vaal-main'),
    contactId: asContactId('contact-vaal-main'),
    machineId: asMachineId('machine-vaal-tl2'),
    scheduledDate: dateOffset(5),
    orderNumber: 'PO-30204',
    referenceNumber: 'VTS-TR-051',
    faultDescription:
      'Customer to deliver a spindle drive to the Isando workshop for testing and quotation.',
    primaryTechnicianId: null,
    createdAt: timeOffset(-1, 15, 20),
    createdBy: asUserId('user-master-elmarie'),
  }),

  job('EJE-1060', {
    jobType: 'installation',
    priority: 'normal',
    status: 'draft',
    customerId: asCustomerId('cust-highveld'),
    siteId: asSiteId('site-highveld-centurion'),
    contactId: asContactId('contact-highveld-main'),
    machineId: asMachineId('machine-highveld-dmu50'),
    scheduledDate: dateOffset(14),
    orderNumber: '',
    referenceNumber: 'HAC-INST-DRAFT',
    faultDescription:
      'Proposed installation of an additional tool pre-setter. Awaiting customer purchase order before release.',
    createdAt: timeOffset(0, 8, 5),
    createdBy: asUserId('user-master-elmarie'),
  }),

  // Ready to DELETE: a duplicate raised by mistake, never accepted. Deleting is
  // the honest action because no work was ever done against it.
  job('EJE-1065', {
    jobType: 'breakdown',
    priority: 'normal',
    status: 'open',
    customerId: asCustomerId('cust-midrand'),
    siteId: asSiteId('site-midrand-main'),
    contactId: asContactId('contact-midrand-main'),
    machineId: asMachineId('machine-midrand-press'),
    scheduledDate: dateOffset(1),
    orderNumber: 'PO-44988',
    referenceNumber: 'MAG-BRK-091-DUP',
    faultDescription:
      'Press brake safety light curtain intermittently faulting. (Raised twice — this duplicates EJE-1058.)',
    primaryTechnicianId: null,
    createdAt: timeOffset(-2, 6, 35),
    createdBy: asUserId('user-master-denise'),
  }),

  // Ready to CANCEL: a real request the customer then resolved themselves.
  job('EJE-1066', {
    jobType: 'breakdown',
    priority: 'normal',
    status: 'open',
    customerId: asCustomerId('cust-highveld'),
    siteId: asSiteId('site-highveld-centurion'),
    contactId: asContactId('contact-highveld-main'),
    machineId: asMachineId('machine-highveld-grinder'),
    scheduledDate: dateOffset(2),
    orderNumber: '',
    referenceNumber: 'HAC-BRK-114',
    faultDescription:
      'Grinder tripping its main breaker on start-up. Customer asked for a technician this week.',
    primaryTechnicianId: null,
    createdAt: timeOffset(-1, 10, 15),
    createdBy: asUserId('user-master-elmarie'),
  }),

  // Already cancelled: shows the CANCELLED state without having to perform it.
  job('EJE-1045', {
    jobType: 'breakdown',
    priority: 'high',
    status: 'cancelled',
    customerId: asCustomerId('cust-kruger'),
    siteId: asSiteId('site-kruger-main'),
    contactId: asContactId('contact-kruger-main'),
    machineId: asMachineId('machine-kruger-vf2'),
    scheduledDate: dateOffset(-30),
    orderNumber: '',
    referenceNumber: 'KRU-BRK-019',
    faultDescription: 'Tool changer alarming intermittently on the DMG MORI.',
    primaryTechnicianId: null,
    createdAt: timeOffset(-32, 14),
    createdBy: asUserId('user-master-johan'),
    cancellation: {
      reason: 'customer_resolved',
      description:
        'Customer found a loose connector on the tool-changer proximity switch and resolved it before dispatch.',
      cancelledBy: asUserId('user-master-johan'),
      cancelledAt: timeOffset(-31, 9, 20),
    },
  }),

  // Ready to TRANSFER: accepted by Sipho with real work already captured, so a
  // hand-over visibly carries the work with it rather than starting again.
  job('EJE-1067', {
    jobType: 'test_and_repair',
    priority: 'high',
    status: 'in_progress',
    customerId: asCustomerId('cust-vaal'),
    siteId: asSiteId('site-vaal-main'),
    contactId: asContactId('contact-vaal-main'),
    machineId: asMachineId('machine-vaal-tl2'),
    scheduledDate: dateOffset(0),
    orderNumber: 'PO-30288',
    referenceNumber: 'VTS-TR-058',
    faultDescription: 'Spindle drive fault on the Takisawa. Intermittent overcurrent trip.',
    primaryTechnicianId: asUserId('user-tech-sipho'),
    createdAt: timeOffset(-1, 8),
    acceptedAt: timeOffset(0, 7, 20),
    labour: [
      {
        id: asLineItemId('lab-1067-1'),
        technicianId: asUserId('user-tech-sipho'),
        date: dateOffset(0),
        rateType: 'normal',
        hours: 2,
        description: 'Fault-finding on the spindle drive',
        capturedAt: timeOffset(0, 9, 30),
      },
    ],
    travel: [
      {
        id: asLineItemId('trv-1067-1'),
        technicianId: asUserId('user-tech-sipho'),
        date: dateOffset(0),
        kilometres: 62,
        description: 'Isando to Vereeniging',
        capturedAt: timeOffset(0, 7, 40),
      },
    ],
    parts: [
      {
        id: asLineItemId('prt-1067-1'),
        partNumber: 'FUS-HRC-32',
        description: 'HRC fuse, 32 A',
        quantity: 3,
        unitPrice: 18_500,
        capturedAt: timeOffset(0, 10),
      },
    ],
    notes: [
      {
        id: asLineItemId('note-1067-1'),
        body: 'Customer needs the machine back before the weekend shift.',
        internal: false,
        authorId: asUserId('user-tech-sipho'),
        createdAt: timeOffset(0, 9, 45),
      },
    ],
    completionReport: {
      faultFindings: 'Drive trips on overcurrent under load. Fuses intact.',
      diagnosis: '',
      workPerformed: '',
      recommendations: '',
      generalNotes: '',
    },
  }),

  // Parts — waiting to be collected. Gives the walkthrough a live parts job to
  // accept, capture and have signed for at the counter.
  job('EJE-1064', {
    jobType: 'parts',
    priority: 'normal',
    status: 'open',
    customerId: asCustomerId('cust-highveld'),
    siteId: asSiteId('site-highveld-centurion'),
    contactId: asContactId('contact-highveld-main'),
    machineId: null,
    scheduledDate: dateOffset(0),
    orderNumber: 'PO-77501',
    referenceNumber: 'HAC-PARTS-042',
    courierCollection: false,
    faultDescription:
      'Way wipers and filters for the Okamoto grinder. Customer collecting from the Isando counter this afternoon.',
    primaryTechnicianId: asUserId('user-tech-sipho'),
    createdAt: timeOffset(-1, 9, 20),
    createdBy: asUserId('user-master-elmarie'),
    parts: [
      {
        id: asLineItemId('prt-1064-1'),
        partNumber: 'OKA-WW-320',
        description: 'Way wiper set, X and Y axis',
        quantity: 1,
        unitPrice: 214_000,
        capturedAt: timeOffset(-1, 9, 25),
      },
      {
        id: asLineItemId('prt-1064-2'),
        partNumber: 'FLT-HYD-25',
        description: 'Hydraulic return filter, 25 micron',
        quantity: 2,
        unitPrice: 67_500,
        capturedAt: timeOffset(-1, 9, 30),
      },
    ],
  }),

  // Parts — customer collection. The customer's own buyer collects, so the
  // collection note carries prices.
  job('EJE-1062', {
    jobType: 'parts',
    priority: 'normal',
    status: 'closed',
    customerId: asCustomerId('cust-abc'),
    siteId: asSiteId('site-abc-jhb'),
    contactId: asContactId('contact-abc-jhb'),
    // A parts collection has no machine: the goods leave the counter.
    machineId: null,
    scheduledDate: dateOffset(-2),
    orderNumber: 'PO-88410',
    referenceNumber: 'ABC-PARTS-114',
    courierCollection: false,
    faultDescription: 'Spares for the Leadwell V-40, collected from the Isando counter.',
    primaryTechnicianId: asUserId('user-tech-sipho'),
    createdAt: timeOffset(-3, 11),
    acceptedAt: timeOffset(-2, 8, 15),
    completedAt: timeOffset(-2, 10, 40),
    submittedAt: timeOffset(-2, 11),
    closedAt: timeOffset(-2, 11, 5),
    finalDocument: finalPartsNote('EJE-1062', timeOffset(-2, 11, 5), 'pieter.nel@abc-engineering-demo.co.za'),
    parts: [
      {
        id: asLineItemId('prt-1062-1'),
        partNumber: 'LW-CLT-220',
        description: 'Coolant pump seal kit',
        quantity: 2,
        unitPrice: 48_500,
        capturedAt: timeOffset(-2, 9),
      },
      {
        id: asLineItemId('prt-1062-2'),
        partNumber: 'FAN-SPN-14',
        description: 'Spindle cooling fan, 24V',
        quantity: 1,
        unitPrice: 132_000,
        capturedAt: timeOffset(-2, 9, 5),
      },
    ],
    pricingSnapshot: {
      labourRates: { normal: 95000, overtime: 142500, double: 190000 },
      calloutRate: 85000,
      kilometreRate: 1850,
      vatPercentage: 15,
      capturedAt: timeOffset(-2, 10, 40),
      reason: 'customer_signature',
    },
    signature: {
      customerName: 'Pieter',
      customerSurname: 'Nel',
      strokeData: 'demo-signature-pieter-nel',
      signedAt: timeOffset(-2, 10, 40),
      declaration: PARTS_COLLECTION_DECLARATION,
    },
  }),

  // Parts — courier collection. The driver signs for the goods but must not see
  // what the customer paid, so the collection note withholds prices. The prices
  // below stay on the job for EJE costing.
  job('EJE-1063', {
    jobType: 'parts',
    priority: 'high',
    status: 'review',
    customerId: asCustomerId('cust-kruger'),
    siteId: asSiteId('site-kruger-main'),
    contactId: asContactId('contact-kruger-main'),
    machineId: null,
    scheduledDate: dateOffset(0),
    orderNumber: 'PO-51207',
    referenceNumber: 'KRU-PARTS-038',
    courierCollection: true,
    faultDescription:
      'Urgent spares dispatched to Nelspruit by courier. Driver collects from the Isando counter.',
    primaryTechnicianId: asUserId('user-tech-lerato'),
    createdAt: timeOffset(-1, 13),
    acceptedAt: timeOffset(0, 7, 45),
    completedAt: timeOffset(0, 9, 30),
    parts: [
      {
        id: asLineItemId('prt-1063-1'),
        partNumber: 'SIE-6SL3-0.75',
        description: 'Siemens Sinamics drive module, 0.75 kW',
        quantity: 1,
        unitPrice: 1_240_000,
        capturedAt: timeOffset(0, 8, 50),
      },
      {
        id: asLineItemId('prt-1063-2'),
        partNumber: 'ENC-INC-1024',
        description: 'Incremental encoder, 1024 ppr',
        quantity: 2,
        unitPrice: 386_000,
        capturedAt: timeOffset(0, 8, 55),
      },
    ],
    notes: [
      {
        id: asLineItemId('note-1063-1'),
        body: 'Courier waybill DSV-4471882. Driver to sign on collection.',
        internal: false,
        authorId: asUserId('user-tech-lerato'),
        createdAt: timeOffset(0, 9),
      },
      {
        id: asLineItemId('note-1063-2'),
        body: 'Margin on the drive module is thin — check the supplier invoice before invoicing.',
        internal: true,
        authorId: asUserId('user-master-elmarie'),
        createdAt: timeOffset(0, 9, 10),
      },
    ],
    pricingSnapshot: {
      labourRates: { normal: 95000, overtime: 142500, double: 190000 },
      calloutRate: 85000,
      kilometreRate: 1850,
      vatPercentage: 15,
      capturedAt: timeOffset(0, 9, 30),
      reason: 'customer_signature',
    },
    signature: {
      customerName: 'Johan',
      customerSurname: 'Mokoena',
      strokeData: 'demo-signature-johan-mokoena',
      signedAt: timeOffset(0, 9, 30),
      declaration: PARTS_COLLECTION_DECLARATION,
    },
  }),

  job('EJE-1044', {
    jobType: 'service',
    priority: 'normal',
    status: 'closed',
    customerId: asCustomerId('cust-abc'),
    siteId: asSiteId('site-abc-jhb'),
    contactId: asContactId('contact-abc-jhb'),
    machineId: asMachineId('machine-abc-lv40'),
    scheduledDate: dateOffset(-180),
    orderNumber: 'PO-86112',
    referenceNumber: 'ABC-SVC-JHB-06',
    faultDescription: 'Six-monthly preventative service on the Leadwell V-40.',
    primaryTechnicianId: asUserId('user-tech-riaan'),
    createdAt: timeOffset(-190, 9),
    acceptedAt: timeOffset(-180, 8),
    completedAt: timeOffset(-180, 12, 30),
    submittedAt: timeOffset(-180, 12, 45),
    closedAt: timeOffset(-180, 12, 45),
    finalDocument: finalJobCard('EJE-1044', 2, timeOffset(-180, 12, 45), 'pieter.nel@abc-engineering-demo.co.za'),
    labour: [
      {
        id: asLineItemId('lab-1044-1'),
        technicianId: asUserId('user-tech-riaan'),
        date: dateOffset(-180),
        rateType: 'normal',
        hours: 3.5,
        description: 'Preventative service',
        capturedAt: timeOffset(-180, 12, 30),
      },
    ],
    checklist: {
      templateId: asChecklistTemplateId('chk-service'),
      // Answered against the wording in force six months ago, not today's 2.0.
      templateVersion: '1.0-DEMO',
      responses: [
        ...(
          [
            'svc-1',
            'svc-2',
            'svc-3',
            'svc-4',
            'svc-6',
            'svc-8',
            'svc-11',
            'svc-13',
            'svc-14',
          ] as const
        ).map((itemId) => ({
          ...emptyChecklistResponse(itemId),
          choice: 'pass' as const,
          answeredAt: timeOffset(-180, 11),
          answeredBy: asUserId('user-tech-riaan'),
        })),
        {
          ...emptyChecklistResponse('svc-5'),
          measurement: 38,
          notes: 'Within the 10-40 °C range permitted by revision 1.0 of this checklist.',
          answeredAt: timeOffset(-180, 11, 10),
          answeredBy: asUserId('user-tech-riaan'),
        },
        {
          ...emptyChecklistResponse('svc-7'),
          measurement: 3.1,
          answeredAt: timeOffset(-180, 11, 15),
          answeredBy: asUserId('user-tech-riaan'),
        },
        {
          ...emptyChecklistResponse('svc-9'),
          measurement: 7,
          answeredAt: timeOffset(-180, 11, 20),
          answeredBy: asUserId('user-tech-riaan'),
        },
        {
          ...emptyChecklistResponse('svc-10'),
          measurement: 6.2,
          answeredAt: timeOffset(-180, 11, 25),
          answeredBy: asUserId('user-tech-riaan'),
        },
        {
          ...emptyChecklistResponse('svc-12'),
          yesNo: true,
          notes: 'Spindle drive cooling fan noticeably noisier than at the last service.',
          answeredAt: timeOffset(-180, 11, 30),
          answeredBy: asUserId('user-tech-riaan'),
        },
        {
          ...emptyChecklistResponse('svc-15'),
          text: 'Spindle drive cooling fan to be replaced before the next service.',
          answeredAt: timeOffset(-180, 12),
          answeredBy: asUserId('user-tech-riaan'),
        },
      ],
      completedAt: timeOffset(-180, 12, 10),
      completedBy: asUserId('user-tech-riaan'),
    },
    // Priced at the rates that applied six months ago, not today's.
    pricingSnapshot: {
      labourRates: { normal: 82000, overtime: 123000, double: 164000 },
      calloutRate: 72000,
      kilometreRate: 1550,
      vatPercentage: 15,
      capturedAt: timeOffset(-180, 12, 35),
      reason: 'customer_signature',
    },
    calloutApplied: true,
    completionReport: {
      faultFindings: 'Spindle drive fan noisy at the previous service, noise now increased.',
      diagnosis: 'Spindle drive cooling fan bearing wear.',
      workPerformed: 'Completed the service checklist. Noted the spindle drive fan noise.',
      recommendations:
        'Replace the spindle drive cooling fan before the next service to avoid a drive over-temperature failure.',
      generalNotes: '',
    },
    signature: {
      customerName: 'Pieter',
      customerSurname: 'Nel',
      strokeData: 'demo-signature-pieter-nel',
      signedAt: timeOffset(-180, 12, 35),
      declaration: SIGNATURE_DECLARATION,
    },
  }),

  job('EJE-1039', {
    jobType: 'installation',
    priority: 'high',
    status: 'closed',
    customerId: asCustomerId('cust-midrand'),
    siteId: asSiteId('site-midrand-main'),
    contactId: asContactId('contact-midrand-main'),
    machineId: asMachineId('machine-midrand-press'),
    scheduledDate: dateOffset(-140),
    orderNumber: 'PO-44120',
    referenceNumber: 'MAG-INST-001',
    faultDescription: 'Installation and commissioning of the Amada HFE-1303 press brake.',
    primaryTechnicianId: asUserId('user-tech-francois'),
    additionalTechnicianIds: [asUserId('user-tech-thabo')],
    createdAt: timeOffset(-160, 9),
    acceptedAt: timeOffset(-142, 7),
    completedAt: timeOffset(-140, 16),
    submittedAt: timeOffset(-140, 16, 30),
    closedAt: timeOffset(-140, 16, 30),
    pricingSnapshot: ratesAt(timeOffset(-140, 16, 10), 80000, 70000),
    finalDocument: finalJobCard('EJE-1039', 1, timeOffset(-140, 16, 30), 'gerhard.smit@midrandautomation-demo.co.za'),
    labour: [
      {
        id: asLineItemId('lab-1039-1'),
        technicianId: asUserId('user-tech-francois'),
        date: dateOffset(-140),
        rateType: 'normal',
        hours: 8,
        description: 'Installation and commissioning',
        capturedAt: timeOffset(-140, 16),
      },
      {
        id: asLineItemId('lab-1039-2'),
        technicianId: asUserId('user-tech-francois'),
        date: dateOffset(-140),
        rateType: 'overtime',
        hours: 2,
        description: 'Operator familiarisation after hours',
        capturedAt: timeOffset(-140, 16, 5),
      },
    ],
    completionReport: {
      faultFindings: 'N/A — new installation.',
      diagnosis: 'N/A — new installation.',
      workPerformed:
        'Positioned, levelled and anchored the machine. Completed electrical connection, commissioning and the full installation checklist. Provided operator familiarisation to three staff members.',
      recommendations: 'Schedule the first preventative service at six months.',
      generalNotes: 'Customer signed off on hand-over with no outstanding items.',
    },
    photos: [
      jobPhoto(
        'att-1039-1',
        'eje-1039-installed.jpg',
        'Installed press brake with light curtain fitted',
        -140,
        15,
        'user-tech-francois',
      ),
    ],
    signature: {
      customerName: 'Gerhard',
      customerSurname: 'Smit',
      strokeData: 'demo-signature-gerhard-smit',
      signedAt: timeOffset(-140, 16, 10),
      declaration: SIGNATURE_DECLARATION,
    },
  }),
];
