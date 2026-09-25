import {
  asJobId,
  asLineItemId,
  emptyChecklistResponse,
  emptyCompletionReport,
  PARTS_COLLECTION_DECLARATION,
  SIGNATURE_DECLARATION,
  type ChecklistResponse,
  type ChecklistTemplate,
  type FinalDocument,
  type IsoDateTime,
  type Job,
  type PricingSnapshot,
  type UserId,
} from '@/domain';
import { demoId } from './ids';
import { dayOffset, nextMonday, timeAgo } from './calendar';
import { COORDINATOR, MASTER, TECH1, TECH2, TECH3 } from './people';
import { REGISTER } from './register';
import {
  INSTALLATION_TEMPLATE_VERSION,
  SERVICE_TEMPLATE_VERSION,
  installationTemplate,
  itemId,
  serviceTemplate,
  templateId,
} from './checklists';

/**
 * The demonstration jobs.
 *
 * Twenty-four, chosen so every dashboard tile, every workflow stage, every job
 * type and every visibility rule has real data behind it — and so that nothing
 * here is a duplicate of anything else. The numbers run EJE-2001 to EJE-2024,
 * deliberately clear of the browser demonstration's own range (EJE-1039 to
 * EJE-1067) and of the production sequence, which the seed then advances past.
 *
 * ALL CONTENT IS FICTIONAL.
 */
export const jobId = (jobNumber: string) => asJobId(demoId(`job:${jobNumber}`));
const lineId = (key: string) => asLineItemId(demoId(`line:${key}`));

/**
 * The rates that applied when a job was signed.
 *
 * Every closed job carries one, and they are deliberately LOWER than the
 * current settings — which is what lets EJE see for themselves that a rate
 * change does not re-price an invoice that has already gone out.
 */
const ratesAt = (capturedAt: IsoDateTime): PricingSnapshot => ({
  labourRates: { normal: 82_000, overtime: 123_000, double: 164_000 },
  calloutRate: 72_000,
  kilometreRate: 1_450,
  vatPercentage: 15,
  capturedAt,
  reason: 'customer_signature',
});

const finalJobCard = (
  jobNumber: string,
  generatedAt: IsoDateTime,
  issuedTo: string,
  pageCount = 2,
): FinalDocument => ({
  fileName: `${jobNumber}-Final-Job-Card.pdf`,
  storageKey: `jobcards/final/${jobNumber}.pdf`,
  pageCount,
  generatedAt,
  generatedBy: MASTER,
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
  generatedBy: MASTER,
  simulated: true,
  issuedTo,
});

const delivered = (to: string, at: IsoDateTime) => ({
  messageId: `demo-${to}-${at}`,
  state: 'delivered' as const,
  to,
  acceptedAt: at,
  confirmedAt: at,
  updatedAt: at,
  attempts: 1,
  failureReason: '',
});

/** Every item answered `pass`, with the measurements filled in sensibly. */
const completedResponses = (
  template: ChecklistTemplate,
  by: UserId,
  at: IsoDateTime,
  measurements: Readonly<Record<string, number>>,
): readonly ChecklistResponse[] =>
  template.sections.flatMap((section) =>
    section.items.map((item) => {
      const base = emptyChecklistResponse(item.id);
      if (item.responseType === 'measurement') {
        return { ...base, measurement: measurements[item.id] ?? 0, answeredAt: at, answeredBy: by };
      }
      if (item.responseType === 'yes_no') {
        return { ...base, yesNo: true, answeredAt: at, answeredBy: by };
      }
      return { ...base, choice: 'pass' as const, answeredAt: at, answeredBy: by };
    }),
  );

const base = (jobNumber: string): Job => ({
  id: jobId(jobNumber),
  jobNumber,
  customerId: REGISTER.acme.id,
  siteId: REGISTER.acme.factory,
  contactId: REGISTER.acme.maintenance,
  machineId: REGISTER.acme.stm1,
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
  signatureRefusals: [],
  awaitingSparesReason: '',
  calloutApplied: false,
  courierCollection: false,
  waybillNumber: '',
  deliveryNote: '',
  pricingSnapshot: null,
  finalDocument: null,
  delivery: null,
  cancellation: null,
  createdAt: timeAgo(6, 8),
  createdBy: MASTER,
  acceptedAt: null,
  completedAt: null,
  submittedAt: null,
  closedAt: null,
});

const job = (jobNumber: string, overrides: Partial<Job>): Job => ({
  ...base(jobNumber),
  ...overrides,
});

export const seedJobs: readonly Job[] = [
  /* ---------------------------------------------------------------- */
  /* Open and unassigned — the pool a technician takes work from.      */
  /* ---------------------------------------------------------------- */

  // Breakdown WITHOUT an order number: the customer called it in.
  job('EJE-2001', {
    jobType: 'breakdown',
    priority: 'urgent',
    status: 'open',
    customerId: REGISTER.jia.id,
    siteId: REGISTER.jia.plant,
    contactId: REGISTER.jia.planner,
    machineId: REGISTER.jia.cnc01,
    scheduledDate: dayOffset(0),
    referenceNumber: 'JIA-BRK-1180',
    faultDescription:
      'Robodrill alarming SV0401 on the X axis and stopping mid-cycle. The cell is down.',
    createdAt: timeAgo(0, 6, 40),
  }),

  job('EJE-2002', {
    jobType: 'installation',
    priority: 'normal',
    status: 'open',
    customerId: REGISTER.ams.id,
    siteId: REGISTER.ams.workshop,
    contactId: REGISTER.ams.controller,
    machineId: REGISTER.ams.cnc01,
    scheduledDate: nextMonday(0),
    orderNumber: 'PO-AMS-4471',
    referenceNumber: 'AMS-INST-006',
    faultDescription:
      'Install and commission the new bar feeder on the ST-20Y, including the interface to the control.',
    createdAt: timeAgo(2, 9),
  }),

  job('EJE-2003', {
    jobType: 'service',
    priority: 'normal',
    status: 'open',
    customerId: REGISTER.acme.id,
    siteId: REGISTER.acme.head,
    contactId: REGISTER.acme.procurement,
    machineId: REGISTER.acme.stm3,
    scheduledDate: dayOffset(3),
    orderNumber: 'PO-ACM-7781',
    referenceNumber: 'ACM-SVC-330',
    faultDescription: 'Six-monthly preventative service on the Okuma M560-V under the agreement.',
    createdAt: timeAgo(3, 10),
  }),

  // Test & Repair WITHOUT an order number.
  job('EJE-2004', {
    jobType: 'test_and_repair',
    priority: 'high',
    status: 'open',
    customerId: REGISTER.pmg.id,
    siteId: REGISTER.pmg.head,
    contactId: REGISTER.pmg.engineer,
    machineId: REGISTER.pmg.grinder,
    referenceNumber: 'PMG-TR-084',
    faultDescription:
      'Digital readout on the surface grinder is intermittent. Unit sent in for test and repair.',
    createdAt: timeAgo(1, 11),
  }),

  // A collection waiting at the counter: `completion`, unassigned, unscheduled
  // — the state CR-12 creates a parts job in. It was seeded `open`, which is
  // the accept-then-process sequence that no longer exists.
  job('EJE-2005', {
    jobType: 'parts',
    priority: 'normal',
    status: 'completion',
    customerId: REGISTER.sic.id,
    siteId: REGISTER.sic.factory,
    contactId: REGISTER.sic.buyer,
    machineId: REGISTER.sic.press,
    orderNumber: 'PO-SIC-2205',
    referenceNumber: 'SIC-PRT-118',
    faultDescription: 'Light curtain transmitter and receiver pair for the press brake.',
    createdAt: timeAgo(1, 14),
  }),

  /* ---------------------------------------------------------------- */
  /* Assigned and active.                                              */
  /* ---------------------------------------------------------------- */

  // Assigned but not yet accepted: Mike's dashboard shows it waiting for him.
  job('EJE-2006', {
    jobType: 'breakdown',
    priority: 'high',
    status: 'open',
    customerId: REGISTER.acme.id,
    siteId: REGISTER.acme.factory,
    contactId: REGISTER.acme.maintenance,
    machineId: REGISTER.acme.stm2,
    scheduledDate: dayOffset(0),
    orderNumber: 'PO-ACM-7802',
    referenceNumber: 'ACM-BRK-411',
    faultDescription: 'Haas VF-2SS tripping on a spindle overload after about twenty minutes.',
    primaryTechnicianId: TECH1,
    createdAt: timeAgo(0, 7, 15),
  }),

  job('EJE-2007', {
    jobType: 'installation',
    priority: 'normal',
    status: 'in_progress',
    customerId: REGISTER.jia.id,
    siteId: REGISTER.jia.workshop,
    contactId: REGISTER.jia.foreman,
    machineId: REGISTER.jia.lathe01,
    scheduledDate: dayOffset(0),
    orderNumber: 'PO-JIA-9920',
    referenceNumber: 'JIA-INST-014',
    faultDescription: 'Install the new tool presetter and interface it to the LB3000.',
    primaryTechnicianId: TECH2,
    acceptedAt: timeAgo(0, 7, 40),
    createdAt: timeAgo(2, 8),
    // Started, deliberately NOT finished: the installation checklist is the gate.
    checklist: {
      templateId: templateId('installation'),
      templateVersion: INSTALLATION_TEMPLATE_VERSION,
      responses: [
        {
          ...emptyChecklistResponse(itemId('inst-1')),
          choice: 'pass',
          answeredAt: timeAgo(0, 9),
          answeredBy: TECH2,
        },
        {
          ...emptyChecklistResponse(itemId('inst-2')),
          choice: 'pass',
          answeredAt: timeAgo(0, 9, 5),
          answeredBy: TECH2,
        },
      ],
      completedAt: null,
      completedBy: null,
    },
    labour: [
      {
        id: lineId('2007-lab-1'),
        technicianId: TECH2,
        date: dayOffset(0),
        rateType: 'normal',
        hours: 3,
        description: 'Presetter mounted and aligned',
        capturedAt: timeAgo(0, 11),
        capturedBy: TECH2,
      },
    ],
  }),

  // Single-day service, in progress, checklist not yet started.
  job('EJE-2008', {
    jobType: 'service',
    priority: 'normal',
    status: 'in_progress',
    customerId: REGISTER.acme.id,
    siteId: REGISTER.acme.factory,
    contactId: REGISTER.acme.maintenance,
    machineId: REGISTER.acme.stm1,
    scheduledDate: dayOffset(0),
    orderNumber: 'PO-ACM-7788',
    referenceNumber: 'ACM-SVC-331',
    faultDescription: 'Six-monthly preventative service on the Mazak QT-250.',
    primaryTechnicianId: TECH1,
    acceptedAt: timeAgo(0, 8, 5),
    createdAt: timeAgo(4, 9),
    travel: [
      {
        id: lineId('2008-trv-1'),
        technicianId: TECH1,
        date: dayOffset(0),
        kilometres: 22,
        description: 'Isando to Isando Industrial Park return',
        capturedAt: timeAgo(0, 8, 30),
        capturedBy: TECH1,
      },
    ],
  }),

  job('EJE-2009', {
    jobType: 'test_and_repair',
    priority: 'normal',
    status: 'awaiting_spares',
    customerId: REGISTER.jia.id,
    siteId: REGISTER.jia.workshop,
    contactId: REGISTER.jia.foreman,
    machineId: REGISTER.jia.cnc02,
    referenceNumber: 'JIA-TR-221',
    faultDescription: 'SINUMERIK drive module returned for test and repair.',
    primaryTechnicianId: TECH2,
    acceptedAt: timeAgo(5, 8),
    awaitingSparesReason:
      'IGBT module on back order with the supplier. Expected in seven working days.',
    createdAt: timeAgo(6, 8),
    labour: [
      {
        id: lineId('2009-lab-1'),
        technicianId: TECH2,
        date: dayOffset(-5),
        rateType: 'normal',
        hours: 2.5,
        description: 'Bench test and fault diagnosis on the drive module',
        capturedAt: timeAgo(5, 12),
        capturedBy: TECH2,
      },
    ],
  }),

  job('EJE-2010', {
    jobType: 'breakdown',
    priority: 'urgent',
    status: 'in_progress',
    customerId: REGISTER.sic.id,
    siteId: REGISTER.sic.factory,
    contactId: REGISTER.sic.buyer,
    machineId: REGISTER.sic.press,
    scheduledDate: dayOffset(0),
    orderNumber: 'PO-SIC-2210',
    referenceNumber: 'SIC-BRK-077',
    faultDescription: 'Press brake will not go into run. Light curtain fault suspected.',
    primaryTechnicianId: TECH1,
    additionalTechnicianIds: [TECH3],
    acceptedAt: timeAgo(0, 9, 10),
    calloutApplied: true,
    createdAt: timeAgo(0, 8, 50),
  }),

  job('EJE-2011', {
    jobType: 'service',
    priority: 'normal',
    status: 'awaiting_spares',
    customerId: REGISTER.pmg.id,
    siteId: REGISTER.pmg.plant,
    contactId: REGISTER.pmg.engineer,
    machineId: REGISTER.pmg.cnc01,
    scheduledDate: dayOffset(-2),
    orderNumber: 'PO-PMG-5510',
    referenceNumber: 'PMG-SVC-140',
    faultDescription: 'Annual service on the VCN-530C.',
    primaryTechnicianId: TECH1,
    acceptedAt: timeAgo(2, 8),
    awaitingSparesReason: 'Spindle drive belt not in stock. Courier delivery expected tomorrow.',
    createdAt: timeAgo(3, 9),
  }),

  // Multi-day service, anchored to a Monday so the month view shows one bar.
  job('EJE-2012', {
    jobType: 'service',
    priority: 'normal',
    status: 'in_progress',
    customerId: REGISTER.jia.id,
    siteId: REGISTER.jia.plant,
    contactId: REGISTER.jia.planner,
    machineId: REGISTER.jia.cnc02,
    scheduledDate: nextMonday(0),
    scheduledEndDate: nextMonday(2),
    orderNumber: 'PO-JIA-9931',
    referenceNumber: 'JIA-SVC-208',
    faultDescription:
      'Three-day major service on the retrofitted Deckel, including drive calibration.',
    primaryTechnicianId: TECH2,
    acceptedAt: timeAgo(1, 8),
    createdAt: timeAgo(8, 9),
  }),

  /* ---------------------------------------------------------------- */
  /* Completion stage, with checklists finished.                       */
  /* ---------------------------------------------------------------- */

  job('EJE-2013', {
    jobType: 'installation',
    priority: 'normal',
    status: 'completion',
    customerId: REGISTER.ams.id,
    siteId: REGISTER.ams.workshop,
    contactId: REGISTER.ams.controller,
    machineId: REGISTER.ams.cnc01,
    scheduledDate: dayOffset(-1),
    orderNumber: 'PO-AMS-4460',
    referenceNumber: 'AMS-INST-005',
    faultDescription: 'Install and commission the Haas ST-20Y in the workshop.',
    primaryTechnicianId: TECH1,
    acceptedAt: timeAgo(1, 7, 30),
    createdAt: timeAgo(9, 9),
    checklist: {
      templateId: templateId('installation'),
      templateVersion: INSTALLATION_TEMPLATE_VERSION,
      responses: completedResponses(installationTemplate, TECH1, timeAgo(1, 13), {
        [itemId('inst-3')]: 18,
        [itemId('inst-5')]: 402,
      }),
      completedAt: timeAgo(1, 13, 30),
      completedBy: TECH1,
    },
    labour: [
      {
        id: lineId('2013-lab-1'),
        technicianId: TECH1,
        date: dayOffset(-1),
        rateType: 'normal',
        hours: 8,
        description: 'Installation, levelling and commissioning',
        capturedAt: timeAgo(1, 16),
        capturedBy: TECH1,
      },
    ],
    travel: [
      {
        id: lineId('2013-trv-1'),
        technicianId: TECH1,
        date: dayOffset(-1),
        kilometres: 64,
        description: 'Isando to Midrand return',
        capturedAt: timeAgo(1, 16, 5),
        capturedBy: TECH1,
      },
    ],
    completionReport: {
      faultFindings: 'New installation. No faults found on commissioning.',
      diagnosis: 'Machine installed and commissioned to specification.',
      workPerformed:
        'Positioned and levelled the machine, connected and torqued the supply, proved earth continuity, fitted and interlocked the guards, tested every emergency stop, ran a full commissioning cycle and instructed the operator.',
      recommendations: 'First service due at 500 running hours.',
      generalNotes: 'Manuals and certificates handed to the workshop controller.',
    },
  }),

  job('EJE-2014', {
    jobType: 'service',
    priority: 'normal',
    status: 'customer_signature',
    customerId: REGISTER.acme.id,
    siteId: REGISTER.acme.head,
    contactId: REGISTER.acme.procurement,
    machineId: REGISTER.acme.stm3,
    scheduledDate: dayOffset(-1),
    orderNumber: 'PO-ACM-7770',
    referenceNumber: 'ACM-SVC-329',
    faultDescription: 'Six-monthly preventative service on the Okuma M560-V.',
    primaryTechnicianId: TECH2,
    acceptedAt: timeAgo(1, 8),
    completedAt: timeAgo(1, 14),
    createdAt: timeAgo(10, 9),
    checklist: {
      templateId: templateId('service'),
      templateVersion: SERVICE_TEMPLATE_VERSION,
      responses: completedResponses(serviceTemplate, TECH2, timeAgo(1, 13), {
        [itemId('svc-5')]: 34,
      }),
      completedAt: timeAgo(1, 13, 20),
      completedBy: TECH2,
    },
    labour: [
      {
        id: lineId('2014-lab-1'),
        technicianId: TECH2,
        date: dayOffset(-1),
        rateType: 'normal',
        hours: 4,
        description: 'Preventative service as per the service checklist',
        capturedAt: timeAgo(1, 14),
        capturedBy: TECH2,
      },
    ],
    parts: [
      {
        id: lineId('2014-prt-1'),
        partNumber: 'FLT-CAB-220',
        description: 'Electrical cabinet filter mat, 220 x 220 mm',
        quantity: 2,
        unitPrice: 18_500,
        capturedAt: timeAgo(1, 14, 5),
        capturedBy: TECH2,
      },
    ],
    completionReport: {
      faultFindings: 'No active faults. Cabinet filters contaminated with machining dust.',
      diagnosis: 'Machine serviceable. Cabinet cooling compromised by blocked filters.',
      workPerformed:
        'Completed the full preventative service checklist, replaced both cabinet filter mats, checked way lube, coolant concentration and air pressure, proved the safety circuits and completed a test run.',
      recommendations: 'Filters are blocking faster than six months. Recommend a three-month interval.',
      generalNotes: 'Machine handed back to production at 14:10.',
    },
  }),

  /* ---------------------------------------------------------------- */
  /* Signed and closed, with frozen pricing.                           */
  /* ---------------------------------------------------------------- */

  job('EJE-2015', {
    jobType: 'breakdown',
    priority: 'urgent',
    status: 'closed',
    customerId: REGISTER.acme.id,
    siteId: REGISTER.acme.factory,
    contactId: REGISTER.acme.maintenance,
    machineId: REGISTER.acme.stm1,
    scheduledDate: dayOffset(-21),
    orderNumber: 'PO-ACM-7601',
    referenceNumber: 'ACM-BRK-398',
    faultDescription: 'Coolant pump not running. Machine alarming on low coolant flow.',
    primaryTechnicianId: TECH1,
    acceptedAt: timeAgo(21, 7, 25),
    completedAt: timeAgo(21, 12),
    submittedAt: timeAgo(21, 12, 20),
    closedAt: timeAgo(21, 12, 25),
    createdAt: timeAgo(21, 7),
    calloutApplied: true,
    labour: [
      {
        id: lineId('2015-lab-1'),
        technicianId: TECH1,
        date: dayOffset(-21),
        rateType: 'normal',
        hours: 3,
        description: 'Coolant pump replacement',
        capturedAt: timeAgo(21, 12),
        capturedBy: TECH1,
      },
    ],
    travel: [
      {
        id: lineId('2015-trv-1'),
        technicianId: TECH1,
        date: dayOffset(-21),
        kilometres: 24,
        description: 'Isando to Isando Industrial Park return',
        capturedAt: timeAgo(21, 8),
        capturedBy: TECH1,
      },
    ],
    parts: [
      {
        id: lineId('2015-prt-1'),
        partNumber: 'PMP-CLT-075',
        description: 'Coolant pump 0.75kW, three phase',
        quantity: 1,
        unitPrice: 486_000,
        capturedAt: timeAgo(21, 12, 5),
        capturedBy: TECH1,
      },
    ],
    completionReport: {
      faultFindings: 'Coolant pump motor windings open circuit.',
      diagnosis: 'Pump motor failed. A non-standard pump had been fitted by others.',
      workPerformed:
        'Replaced the coolant pump with the correct specification unit, re-wired to the machine loom, tested flow and cleared the alarm.',
      recommendations: 'Clean the coolant tank at the next service.',
      generalNotes: '',
    },
    signature: {
      customerName: 'Pieter',
      customerSurname: 'Nel',
      strokeData: 'demo-signature-pieter-nel',
      signedAt: timeAgo(21, 12, 10),
      declaration: SIGNATURE_DECLARATION,
    },
    pricingSnapshot: ratesAt(timeAgo(21, 12, 10)),
    finalDocument: finalJobCard('EJE-2015', timeAgo(21, 12, 20), 'pieter.nel@acme-demo.local'),
    delivery: delivered('pieter.nel@acme-demo.local', timeAgo(21, 12, 25)),
  }),

  job('EJE-2016', {
    jobType: 'service',
    priority: 'normal',
    status: 'closed',
    customerId: REGISTER.jia.id,
    siteId: REGISTER.jia.plant,
    contactId: REGISTER.jia.planner,
    machineId: REGISTER.jia.cnc01,
    scheduledDate: dayOffset(-35),
    orderNumber: 'PO-JIA-9850',
    referenceNumber: 'JIA-SVC-199',
    faultDescription: 'Six-monthly preventative service on the Robodrill.',
    primaryTechnicianId: TECH2,
    acceptedAt: timeAgo(35, 8),
    completedAt: timeAgo(35, 13),
    submittedAt: timeAgo(35, 13, 30),
    closedAt: timeAgo(35, 13, 40),
    createdAt: timeAgo(38, 9),
    checklist: {
      templateId: templateId('service'),
      templateVersion: SERVICE_TEMPLATE_VERSION,
      responses: completedResponses(serviceTemplate, TECH2, timeAgo(35, 12), {
        [itemId('svc-5')]: 31,
      }),
      completedAt: timeAgo(35, 12, 30),
      completedBy: TECH2,
    },
    labour: [
      {
        id: lineId('2016-lab-1'),
        technicianId: TECH2,
        date: dayOffset(-35),
        rateType: 'normal',
        hours: 5,
        description: 'Preventative service and axis calibration check',
        capturedAt: timeAgo(35, 13),
        capturedBy: TECH2,
      },
    ],
    parts: [
      {
        id: lineId('2016-prt-1'),
        partNumber: 'BAT-3V-FAN',
        description: 'Fanuc control memory battery, 3V lithium',
        quantity: 1,
        unitPrice: 42_000,
        capturedAt: timeAgo(35, 13, 5),
        capturedBy: TECH2,
      },
    ],
    completionReport: {
      faultFindings: 'No faults found. Control battery below replacement threshold.',
      diagnosis: 'Machine in good condition.',
      workPerformed:
        'Completed the preventative service checklist, replaced the control memory battery and verified axis positioning against the last calibration record.',
      recommendations: 'Next service due in six months.',
      generalNotes: '',
    },
    signature: {
      customerName: 'Ravi',
      customerSurname: 'Naidoo',
      strokeData: 'demo-signature-ravi-naidoo',
      signedAt: timeAgo(35, 13, 15),
      declaration: SIGNATURE_DECLARATION,
    },
    pricingSnapshot: ratesAt(timeAgo(35, 13, 15)),
    finalDocument: finalJobCard('EJE-2016', timeAgo(35, 13, 30), 'ravi.naidoo@jia-demo.local', 3),
    delivery: delivered('ravi.naidoo@jia-demo.local', timeAgo(35, 13, 40)),
  }),

  job('EJE-2017', {
    jobType: 'installation',
    priority: 'normal',
    status: 'closed',
    customerId: REGISTER.acme.id,
    siteId: REGISTER.acme.factory,
    contactId: REGISTER.acme.maintenance,
    machineId: REGISTER.acme.stm2,
    scheduledDate: dayOffset(-60),
    orderNumber: 'PO-ACM-7410',
    referenceNumber: 'ACM-INST-021',
    faultDescription: 'Install and commission the Haas VF-2SS in the machine hall.',
    primaryTechnicianId: TECH1,
    acceptedAt: timeAgo(60, 7),
    completedAt: timeAgo(60, 16),
    submittedAt: timeAgo(60, 16, 20),
    closedAt: timeAgo(60, 16, 30),
    createdAt: timeAgo(70, 9),
    checklist: {
      templateId: templateId('installation'),
      templateVersion: INSTALLATION_TEMPLATE_VERSION,
      responses: completedResponses(installationTemplate, TECH1, timeAgo(60, 15), {
        [itemId('inst-3')]: 22,
        [itemId('inst-5')]: 398,
      }),
      completedAt: timeAgo(60, 15, 30),
      completedBy: TECH1,
    },
    labour: [
      {
        id: lineId('2017-lab-1'),
        technicianId: TECH1,
        date: dayOffset(-60),
        rateType: 'normal',
        hours: 9,
        description: 'Installation and commissioning',
        capturedAt: timeAgo(60, 16),
        capturedBy: TECH1,
      },
    ],
    completionReport: {
      faultFindings: 'New installation.',
      diagnosis: 'Commissioned to specification.',
      workPerformed:
        'Positioned, levelled and commissioned the machine, proved the safety circuits and instructed the operators.',
      recommendations: '',
      generalNotes: '',
    },
    signature: {
      customerName: 'Pieter',
      customerSurname: 'Nel',
      strokeData: 'demo-signature-pieter-nel-2',
      signedAt: timeAgo(60, 16, 10),
      declaration: SIGNATURE_DECLARATION,
    },
    pricingSnapshot: ratesAt(timeAgo(60, 16, 10)),
    finalDocument: finalJobCard('EJE-2017', timeAgo(60, 16, 20), 'pieter.nel@acme-demo.local', 3),
    delivery: delivered('pieter.nel@acme-demo.local', timeAgo(60, 16, 30)),
  }),

  /* ---------------------------------------------------------------- */
  /* The refusal workflow, in both of its states.                      */
  /* ---------------------------------------------------------------- */

  /*
   * Outstanding: the office has to deal with this one.
   *
   * AT `review`, WHICH IS WHERE A REFUSAL ACTUALLY LANDS. This was seeded at
   * `customer_signature`, a state `recordSignatureRefusal` never produces — it
   * records the refusal AND moves the job to office review. The fixture was
   * therefore a job that could not exist, and acceptance testing found exactly
   * the failure that implies: returning it for signature asked the state
   * machine to move it from `customer_signature` to `customer_signature`.
   *
   * A seed that cannot be reached by the application is not a demonstration of
   * the application.
   */
  job('EJE-2018', {
    jobType: 'breakdown',
    priority: 'high',
    status: 'review',
    customerId: REGISTER.pmg.id,
    siteId: REGISTER.pmg.plant,
    contactId: REGISTER.pmg.engineer,
    machineId: REGISTER.pmg.cnc01,
    scheduledDate: dayOffset(-1),
    orderNumber: 'PO-PMG-5498',
    referenceNumber: 'PMG-BRK-133',
    faultDescription: 'VCN-530C stopping on a tool changer alarm.',
    primaryTechnicianId: TECH1,
    acceptedAt: timeAgo(1, 7, 40),
    completedAt: timeAgo(1, 15),
    createdAt: timeAgo(2, 8),
    labour: [
      {
        id: lineId('2018-lab-1'),
        technicianId: TECH1,
        date: dayOffset(-1),
        rateType: 'normal',
        hours: 6,
        description: 'Tool changer fault finding and repair',
        capturedAt: timeAgo(1, 15),
        capturedBy: TECH1,
      },
    ],
    completionReport: {
      faultFindings: 'Tool changer arm proximity switch out of adjustment.',
      diagnosis: 'Switch had drifted, so the arm never confirmed its home position.',
      workPerformed:
        'Re-adjusted and locked the proximity switch, proved the tool change cycle twenty times and cleared the alarm history.',
      recommendations: 'Check the switch mounting at the next service.',
      generalNotes: '',
    },
    signatureRefusals: [
      {
        refused: true,
        reason:
          'Production engineer would not sign without the hours being confirmed by their planner, who had already left for the day.',
        recordedBy: TECH1,
        recordedAt: timeAgo(1, 15, 30),
        resolvedBy: null,
        resolvedAt: null,
        resolution: null,
        resolutionNote: '',
      },
    ],
  }),

  // Resolved: refused once, corrected by the office, signed afterwards. The
  // refusal STAYS on the record — that history is the point.
  job('EJE-2019', {
    jobType: 'breakdown',
    priority: 'normal',
    status: 'closed',
    customerId: REGISTER.jia.id,
    siteId: REGISTER.jia.plant,
    contactId: REGISTER.jia.planner,
    machineId: REGISTER.jia.cnc02,
    scheduledDate: dayOffset(-14),
    orderNumber: 'PO-JIA-9902',
    referenceNumber: 'JIA-BRK-1166',
    faultDescription: 'Deckel retrofit tripping the incoming breaker on start-up.',
    primaryTechnicianId: TECH2,
    acceptedAt: timeAgo(14, 7, 20),
    completedAt: timeAgo(14, 15, 30),
    submittedAt: timeAgo(13, 10),
    closedAt: timeAgo(13, 10, 15),
    createdAt: timeAgo(14, 6, 55),
    labour: [
      {
        id: lineId('2019-lab-1'),
        technicianId: TECH2,
        date: dayOffset(-14),
        rateType: 'normal',
        hours: 5,
        description: 'Fault finding and transformer replacement',
        capturedAt: timeAgo(14, 15),
        capturedBy: TECH2,
      },
    ],
    parts: [
      {
        id: lineId('2019-prt-1'),
        partNumber: 'TRF-400-110',
        description: 'Control transformer 400/110V 500VA',
        quantity: 1,
        unitPrice: 312_000,
        capturedAt: timeAgo(14, 15, 5),
        capturedBy: TECH2,
      },
    ],
    completionReport: {
      faultFindings: 'Control transformer primary winding shorted to the core.',
      diagnosis: 'Transformer failure caused by long-term moisture ingress in the cabinet.',
      workPerformed:
        'Isolated the machine, confirmed the short with an insulation test, replaced the control transformer, re-tested insulation resistance and ran a full function test. Sealed the gland plate where moisture was entering.',
      recommendations: 'Repair the roof sheet above the cabinet to prevent a repeat failure.',
      generalNotes: 'Corrected hours confirmed with the planner before re-signature.',
    },
    signatureRefusals: [
      {
        refused: true,
        reason: 'Planner disputed the travel time recorded on the job card.',
        recordedBy: TECH2,
        recordedAt: timeAgo(14, 15, 45),
        resolvedBy: MASTER,
        resolvedAt: timeAgo(13, 9, 30),
        resolution: 'resubmitted',
        resolutionNote:
          'Travel line corrected to the agreed 45 minutes and the job card returned for signature.',
      },
    ],
    signature: {
      customerName: 'Ravi',
      customerSurname: 'Naidoo',
      strokeData: 'demo-signature-ravi-naidoo-2',
      signedAt: timeAgo(13, 9, 55),
      declaration: SIGNATURE_DECLARATION,
    },
    pricingSnapshot: ratesAt(timeAgo(13, 9, 55)),
    finalDocument: finalJobCard('EJE-2019', timeAgo(13, 10), 'ravi.naidoo@jia-demo.local'),
    delivery: delivered('ravi.naidoo@jia-demo.local', timeAgo(13, 10, 15)),
  }),

  /* ---------------------------------------------------------------- */
  /* Parts: collected by the customer, and collected by a courier.     */
  /* ---------------------------------------------------------------- */

  job('EJE-2020', {
    jobType: 'parts',
    priority: 'normal',
    status: 'closed',
    customerId: REGISTER.acme.id,
    siteId: REGISTER.acme.factory,
    contactId: REGISTER.acme.maintenance,
    machineId: REGISTER.acme.stm2,
    orderNumber: 'PO-ACM-7655',
    referenceNumber: 'ACM-PRT-091',
    faultDescription: 'Spindle drive belt and filter set collected from the EJE counter.',
    primaryTechnicianId: TECH1,
    acceptedAt: timeAgo(7, 9),
    completedAt: timeAgo(7, 10),
    submittedAt: timeAgo(7, 10, 10),
    closedAt: timeAgo(7, 10, 15),
    createdAt: timeAgo(8, 9),
    courierCollection: false,
    parts: [
      {
        id: lineId('2020-prt-1'),
        partNumber: 'BLT-SPN-1250',
        description: 'Spindle drive belt, 1250 mm',
        quantity: 1,
        unitPrice: 128_000,
        capturedAt: timeAgo(7, 9, 30),
        capturedBy: TECH1,
      },
      {
        id: lineId('2020-prt-2'),
        partNumber: 'FLT-CAB-220',
        description: 'Electrical cabinet filter mat, 220 x 220 mm',
        quantity: 4,
        unitPrice: 18_500,
        capturedAt: timeAgo(7, 9, 35),
        capturedBy: TECH1,
      },
    ],
    signature: {
      customerName: 'Sipho',
      customerSurname: 'Radebe',
      strokeData: 'demo-signature-sipho-radebe',
      signedAt: timeAgo(7, 10),
      declaration: PARTS_COLLECTION_DECLARATION,
    },
    pricingSnapshot: ratesAt(timeAgo(7, 10)),
    finalDocument: finalPartsNote('EJE-2020', timeAgo(7, 10, 10), 'pieter.nel@acme-demo.local'),
    delivery: delivered('pieter.nel@acme-demo.local', timeAgo(7, 10, 15)),
  }),

  job('EJE-2021', {
    jobType: 'parts',
    priority: 'normal',
    status: 'closed',
    customerId: REGISTER.sic.id,
    siteId: REGISTER.sic.factory,
    contactId: REGISTER.sic.buyer,
    machineId: REGISTER.sic.press,
    orderNumber: 'PO-SIC-2188',
    referenceNumber: 'SIC-PRT-112',
    faultDescription: 'Light curtain pair despatched by courier to Vereeniging.',
    primaryTechnicianId: TECH2,
    acceptedAt: timeAgo(10, 9),
    completedAt: timeAgo(10, 11),
    submittedAt: timeAgo(10, 11, 10),
    closedAt: timeAgo(10, 11, 15),
    createdAt: timeAgo(11, 9),
    courierCollection: true,
    waybillNumber: 'DEMO-WB-4471820',
    parts: [
      {
        id: lineId('2021-prt-1'),
        partNumber: 'LC-TX-1200',
        description: 'Safety light curtain transmitter, 1200 mm',
        quantity: 1,
        unitPrice: 742_000,
        capturedAt: timeAgo(10, 9, 30),
        capturedBy: TECH2,
      },
      {
        id: lineId('2021-prt-2'),
        partNumber: 'LC-RX-1200',
        description: 'Safety light curtain receiver, 1200 mm',
        quantity: 1,
        unitPrice: 698_000,
        capturedAt: timeAgo(10, 9, 32),
        capturedBy: TECH2,
      },
    ],
    signature: {
      customerName: 'Thabo',
      customerSurname: 'Mahlangu',
      strokeData: 'demo-signature-courier-thabo',
      signedAt: timeAgo(10, 11),
      declaration: PARTS_COLLECTION_DECLARATION,
    },
    pricingSnapshot: ratesAt(timeAgo(10, 11)),
    finalDocument: finalPartsNote('EJE-2021', timeAgo(10, 11, 10), 'johan.vanzyl@sic-demo.local'),
    delivery: delivered('johan.vanzyl@sic-demo.local', timeAgo(10, 11, 15)),
  }),

  /* ---------------------------------------------------------------- */
  /* Test & Repair going back by courier.                              */
  /* ---------------------------------------------------------------- */

  job('EJE-2022', {
    jobType: 'test_and_repair',
    priority: 'normal',
    status: 'in_progress',
    customerId: REGISTER.ams.id,
    siteId: REGISTER.ams.head,
    contactId: REGISTER.ams.manager,
    machineId: REGISTER.ams.cnc01,
    orderNumber: 'PO-AMS-4455',
    referenceNumber: 'AMS-TR-018',
    faultDescription:
      'Haas control keypad returned for test and repair. Going back to site by courier.',
    primaryTechnicianId: TECH2,
    acceptedAt: timeAgo(3, 8),
    createdAt: timeAgo(4, 9),
    courierCollection: true,
    waybillNumber: 'DEMO-WB-4472119',
    labour: [
      {
        id: lineId('2022-lab-1'),
        technicianId: TECH2,
        date: dayOffset(-3),
        rateType: 'normal',
        hours: 2,
        description: 'Keypad membrane test and replacement',
        capturedAt: timeAgo(3, 12),
        capturedBy: TECH2,
      },
    ],
    parts: [
      {
        id: lineId('2022-prt-1'),
        partNumber: 'KPD-HAAS-NGC',
        description: 'Haas NGC keypad membrane',
        quantity: 1,
        unitPrice: 384_000,
        capturedAt: timeAgo(3, 12, 5),
        capturedBy: TECH2,
      },
    ],
  }),

  /* ---------------------------------------------------------------- */
  /* Transferred: Mike started it, David finished it.                  */
  /* ---------------------------------------------------------------- */

  job('EJE-2023', {
    jobType: 'breakdown',
    priority: 'high',
    status: 'in_progress',
    customerId: REGISTER.pmg.id,
    siteId: REGISTER.pmg.head,
    contactId: REGISTER.pmg.engineer,
    machineId: REGISTER.pmg.grinder,
    scheduledDate: dayOffset(0),
    orderNumber: 'PO-PMG-5522',
    referenceNumber: 'PMG-BRK-136',
    faultDescription: 'Surface grinder tripping its incomer intermittently.',
    /*
     * David holds it now; Mike captured the first two hours and was taken off it
     * when his vehicle broke down. Mike keeps access to HIS OWN WORK, David has
     * current access, and Peter — who was never on it — has neither.
     */
    primaryTechnicianId: TECH2,
    acceptedAt: timeAgo(0, 10, 30),
    createdAt: timeAgo(1, 7),
    labour: [
      {
        id: lineId('2023-lab-1'),
        technicianId: TECH1,
        date: dayOffset(-1),
        rateType: 'normal',
        hours: 2,
        description: 'Initial fault finding on the incomer',
        capturedAt: timeAgo(1, 11),
        capturedBy: TECH1,
      },
      {
        id: lineId('2023-lab-2'),
        technicianId: TECH2,
        date: dayOffset(0),
        rateType: 'normal',
        hours: 1.5,
        description: 'Continued fault finding after hand-over',
        capturedAt: timeAgo(0, 12),
        capturedBy: TECH2,
      },
    ],
    notes: [
      {
        id: lineId('2023-note-1'),
        body: 'Handed over to David after the vehicle breakdown. Findings so far are on the labour lines.',
        internal: true,
        authorId: TECH1,
        createdAt: timeAgo(1, 12),
      },
    ],
  }),

  /* ---------------------------------------------------------------- */
  /* Somebody else's job entirely — the negative visibility case.      */
  /* ---------------------------------------------------------------- */

  job('EJE-2024', {
    jobType: 'service',
    priority: 'normal',
    status: 'in_progress',
    customerId: REGISTER.sic.id,
    siteId: REGISTER.sic.factory,
    contactId: REGISTER.sic.buyer,
    machineId: REGISTER.sic.press,
    scheduledDate: dayOffset(1),
    orderNumber: 'PO-SIC-2219',
    referenceNumber: 'SIC-SVC-054',
    faultDescription: 'Annual service on the press brake control retrofit.',
    primaryTechnicianId: TECH3,
    acceptedAt: timeAgo(0, 9),
    createdAt: timeAgo(5, 9),
  }),

  /* ---------------------------------------------------------------- */
  /* THE OFFICE REVIEW QUEUE — the two jobs that sit at Review, and    */
  /* the whole of MASTER SCOPE CR-01 in two records.                   */
  /*                                                                   */
  /* Both are at `review`. They are told apart by ONE field, which is  */
  /* the entire business rule: EJE-2025 carries a signature and is     */
  /* therefore final and untouchable; EJE-2026 does not, and is the    */
  /* office's to correct and resubmit. Without these two the seed      */
  /* could not demonstrate immutability, the refusal correction loop,  */
  /* or the Master's final submission at all — the register held NO    */
  /* job at Review.                                                    */
  /* ---------------------------------------------------------------- */

  // SIGNED. Waiting on a Master's final submission, and immutable to everyone.
  job('EJE-2025', {
    jobType: 'breakdown',
    priority: 'high',
    status: 'review',
    customerId: REGISTER.acme.id,
    siteId: REGISTER.acme.factory,
    contactId: REGISTER.acme.maintenance,
    machineId: REGISTER.acme.stm1,
    scheduledDate: dayOffset(-1),
    orderNumber: 'PO-ACME-7781',
    referenceNumber: 'ACME-BRK-207',
    faultDescription: 'Spindle drive tripping under load on the STM-1.',
    primaryTechnicianId: TECH1,
    acceptedAt: timeAgo(1, 7, 15),
    completedAt: timeAgo(1, 14, 40),
    createdAt: timeAgo(2, 8),
    calloutApplied: true,
    labour: [
      {
        id: lineId('2025-lab-1'),
        technicianId: TECH1,
        date: dayOffset(-1),
        rateType: 'normal',
        hours: 4,
        description: 'Spindle drive fault finding and cooling fan replacement',
        capturedAt: timeAgo(1, 14),
        capturedBy: TECH1,
      },
    ],
    travel: [
      {
        id: lineId('2025-trv-1'),
        technicianId: TECH1,
        date: dayOffset(-1),
        kilometres: 48,
        description: 'Workshop to site and back',
        capturedAt: timeAgo(1, 14),
        capturedBy: TECH1,
      },
    ],
    parts: [
      {
        id: lineId('2025-prt-1'),
        partNumber: 'FAN-24V-80',
        description: 'Spindle drive cooling fan, 24V 80mm',
        quantity: 1,
        unitPrice: 48500,
        capturedAt: timeAgo(1, 14),
        capturedBy: TECH1,
      },
    ],
    completionReport: {
      faultFindings: 'Spindle drive cooling fan seized; drive tripping on over-temperature.',
      diagnosis: 'Bearing failure in the cooling fan after roughly nine years in service.',
      workPerformed:
        'Replaced the spindle drive cooling fan, cleaned the heatsink and ran the spindle to full speed for twenty minutes without a trip.',
      recommendations: 'Replace the second drive fan at the next service; it is the same age.',
      generalNotes: '',
    },
    // THE FIELD THAT MAKES IT FINAL.
    signature: {
      customerName: 'Pieter',
      customerSurname: 'Nel',
      strokeData: 'M0.10,0.60 L0.30,0.20 L0.50,0.70 L0.80,0.30',
      signedAt: timeAgo(1, 15),
      declaration: 'I confirm that the work described above has been completed.',
    },
    pricingSnapshot: ratesAt(timeAgo(1, 15)),
  }),

  // REFUSED. Same status, no signature — the office's to correct and resubmit
  // under one of the two outcomes.
  job('EJE-2026', {
    jobType: 'service',
    priority: 'normal',
    status: 'review',
    customerId: REGISTER.jia.id,
    siteId: REGISTER.jia.plant,
    contactId: REGISTER.jia.planner,
    machineId: REGISTER.jia.cnc02,
    scheduledDate: dayOffset(-2),
    orderNumber: 'PO-JIA-9971',
    referenceNumber: 'JIA-SVC-118',
    faultDescription: 'Six-monthly service on the CNC-02 machining centre.',
    primaryTechnicianId: TECH2,
    acceptedAt: timeAgo(2, 7, 30),
    completedAt: timeAgo(2, 15, 10),
    createdAt: timeAgo(4, 9),
    labour: [
      {
        id: lineId('2026-lab-1'),
        technicianId: TECH2,
        date: dayOffset(-2),
        rateType: 'normal',
        hours: 5,
        description: 'Six-monthly service',
        capturedAt: timeAgo(2, 15),
        capturedBy: TECH2,
      },
      {
        id: lineId('2026-lab-2'),
        technicianId: TECH2,
        date: dayOffset(-2),
        rateType: 'overtime',
        hours: 2,
        description: 'Overtime to finish the same day',
        capturedAt: timeAgo(2, 15),
        capturedBy: TECH2,
      },
    ],
    completionReport: {
      faultFindings: 'Service intervals reached; no faults found.',
      diagnosis: 'Routine service.',
      workPerformed:
        'Completed the six-monthly service schedule, replaced the way-lube filter and re-tensioned the spindle belt.',
      recommendations: 'Book the twelve-monthly service in six months.',
      generalNotes: '',
    },
    signatureRefusals: [
      {
        refused: true,
        reason:
          'The planner disputes the two overtime hours and will not sign until the office confirms them against the order.',
        recordedBy: TECH2,
        recordedAt: timeAgo(2, 15, 25),
        resolvedBy: null,
        resolvedAt: null,
        resolution: null,
        resolutionNote: '',
      },
    ],
    pricingSnapshot: ratesAt(timeAgo(2, 15, 25)),
  }),
];

/** The handover on EJE-2023, written as the structured record the schema keeps. */
export const seedTransfers = [
  {
    jobId: jobId('EJE-2023'),
    fromUserId: TECH1,
    toUserId: TECH2,
    reason: 'vehicle_problem' as const,
    description: 'Bakkie broke down on the N1. David picked the job up from Rosslyn.',
    transferredBy: COORDINATOR,
    transferredAt: timeAgo(0, 10, 15),
  },
];

/**
 * Participation the workflow would have recorded, had it happened live.
 *
 * A job carries who is on it NOW; who was on it BEFORE is a separate record,
 * written as each assignment opens and closes. EJE-2023 arrives in this seed
 * already handed over, so the row for Mike's own two hours was never opened —
 * and without it he loses access to work he actually did, which is precisely
 * the rule the transfer example exists to demonstrate.
 *
 * So the seed writes the history the application would have written. Nothing
 * here invents a rule: it reconstructs the rows a live transfer produces.
 */
export const seedParticipation = [
  {
    jobId: jobId('EJE-2023'),
    userId: TECH1,
    role: 'primary_technician' as const,
    since: timeAgo(1, 8),
    until: timeAgo(0, 10, 15),
    endedReason: 'transferred to another technician',
  },
];

/** The highest sequence number the seed uses, so allocation continues past it. */
export const HIGHEST_JOB_SEQUENCE = 2026;
