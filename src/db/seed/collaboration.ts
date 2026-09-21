import {
  asDocumentId,
  asNotificationId,
  type AppNotification,
  type AvailabilityRecord,
  type ChatMessage,
  type Conversation,
  type SystemSettings,
  type TechnicalDocument,
} from '@/domain';
import { demoId } from './ids';
import { dayOffset, minutesAgo, timeAgo } from './calendar';
import { COORDINATOR, MASTER, TECH1, TECH2, TECH3 } from './people';
import { jobId } from './jobs';

/**
 * Everything the office and the field share: the library, the calendar, the
 * chat, the notification bell — and the rates the whole thing is priced from.
 *
 * ALL CONTENT IS FICTIONAL.
 */

/* -------------------------------------------------------------------------- */
/* Rates                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The CURRENT rates, deliberately higher than the snapshot frozen on every
 * closed job. That gap is the point: EJE can open a signed job card, see it
 * priced at the old rate, change these, and watch the signed card refuse to
 * move.
 */
export const seedSettings: SystemSettings = {
  companyName: 'EJE Industrial Electronics',
  companyRegistration: '2004/018273/07',
  companyVatNumber: '4180276351',
  companyPhone: '+27 11 555 0100',
  companyEmail: 'service@eje-demo.local',
  companyAddress: '14 Anvil Road, Isando, Kempton Park, 1600',
  labourRates: { normal: 95_000, overtime: 142_500, double: 190_000 },
  calloutRate: 85_000,
  kilometreRate: 1_850,
  vatPercentage: 15,
  jobNumberPrefix: 'EJE-',
  /* The PostgreSQL sequence allocates job numbers; this is kept for the shape. */
  nextJobSequence: 2025,
  quietHoursStart: '18:00',
  quietHoursEnd: '07:00',
};

/* -------------------------------------------------------------------------- */
/* Technical library                                                          */
/* -------------------------------------------------------------------------- */

interface DocumentInput {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly type: TechnicalDocument['documentType'];
  readonly manufacturer: string;
  readonly model: string;
  readonly version: string;
  readonly status: TechnicalDocument['status'];
  readonly pages: number;
  readonly tags: readonly string[];
  readonly uploadedBy?: typeof MASTER;
  readonly daysAgo?: number;
}

const fileNameFor = (name: string, version: string): string =>
  `${name.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '')}-${version
    .toLowerCase()
    .replace(/\s+/gu, '')}.pdf`;

const document = (input: DocumentInput): TechnicalDocument => ({
  id: asDocumentId(demoId(`document:${input.key}`)),
  name: input.name,
  description: input.description,
  documentType: input.type,
  manufacturer: input.manufacturer,
  machineModel: input.model,
  version: input.version,
  status: input.status,
  fileName: fileNameFor(input.name, input.version),
  fileSizeBytes: 4_180_000 + input.pages * 12_000,
  pageCount: input.pages,
  storageKey: `library/${fileNameFor(input.name, input.version)}`,
  uploadedAt: timeAgo(input.daysAgo ?? 300, 9),
  uploadedBy: input.uploadedBy ?? MASTER,
  tags: input.tags,
});

export const seedDocuments: readonly TechnicalDocument[] = [
  document({
    key: 'cnc-safety',
    name: 'CNC Safety Procedure (DEMO)',
    description:
      'How a technician makes a CNC machine safe before working on it: isolation, lock-out, stored energy and proving dead.',
    type: 'safety_procedure',
    manufacturer: '',
    model: '',
    version: 'Rev 3',
    status: 'current',
    pages: 12,
    tags: ['Safety', 'Isolation', 'Lock-out'],
  }),
  document({
    key: 'installation-procedure',
    name: 'Machine Installation Procedure (DEMO)',
    description:
      'The sequence every installation follows, from site preparation to customer hand-over.',
    type: 'work_procedure',
    manufacturer: '',
    model: '',
    version: 'Rev 2',
    status: 'current',
    pages: 24,
    tags: ['Installation', 'Commissioning'],
  }),
  document({
    key: 'preventative-maintenance',
    name: 'Preventative Maintenance Checklist (DEMO)',
    description: 'The reference document behind the service checklist in the application.',
    type: 'work_procedure',
    manufacturer: '',
    model: '',
    version: 'Rev 5',
    status: 'current',
    pages: 8,
    tags: ['Service', 'Maintenance'],
  }),
  document({
    key: 'electrical-safety',
    name: 'Electrical Safety Procedure (DEMO)',
    description:
      'Working on live and isolated industrial control panels, including test instrument requirements.',
    type: 'safety_procedure',
    manufacturer: '',
    model: '',
    version: 'Rev 4',
    status: 'current',
    pages: 16,
    tags: ['Safety', 'Electrical'],
  }),
  document({
    key: 'estop-testing',
    name: 'Emergency Stop Testing Procedure (DEMO)',
    description: 'How each emergency stop station is proven, and what is recorded when it is.',
    type: 'work_procedure',
    manufacturer: '',
    model: '',
    version: 'Rev 1',
    status: 'current',
    pages: 6,
    tags: ['Safety', 'Testing'],
  }),
  /*
   * Uploaded by a technician and waiting on a Master, so the approval queue on
   * the Administration screen has something in it.
   */
  document({
    key: 'training-guide',
    name: 'Technician Training Guide (DEMO)',
    description:
      'Induction material for a new field technician. Submitted for approval before it goes into the library.',
    type: 'work_procedure',
    manufacturer: '',
    model: '',
    version: 'Draft 1',
    status: 'pending_approval',
    pages: 32,
    tags: ['Training'],
    uploadedBy: TECH1,
    daysAgo: 2,
  }),
  /* A superseded revision, kept so the library shows its own history. */
  document({
    key: 'cnc-safety-old',
    name: 'CNC Safety Procedure (DEMO)',
    description: 'Superseded by Rev 3. Kept so a historical reference still resolves.',
    type: 'safety_procedure',
    manufacturer: '',
    model: '',
    version: 'Rev 2',
    status: 'archived',
    pages: 11,
    tags: ['Safety', 'Superseded'],
    daysAgo: 600,
  }),
];

/* -------------------------------------------------------------------------- */
/* Technician availability                                                    */
/* -------------------------------------------------------------------------- */

const availability = (
  key: string,
  userId: typeof TECH1,
  type: AvailabilityRecord['type'],
  startDate: string,
  endDate: string,
  description: string,
  window: { readonly from: string; readonly to: string } | null = null,
): AvailabilityRecord => ({
  id: demoId(`availability:${key}`),
  userId,
  type,
  startDate,
  endDate,
  allDay: window === null,
  startTime: window?.from ?? null,
  endTime: window?.to ?? null,
  description,
  status: 'active',
  createdBy: MASTER,
  createdAt: timeAgo(5, 9),
  cancelledBy: null,
  cancelledAt: null,
});

export const seedAvailability: readonly AvailabilityRecord[] = [
  /*
   * Today, and deliberately overlapping EJE-2008 — which Mike is on — so the
   * calendar's clash panel and the assignment warning both have something real
   * to show.
   */
  availability(
    'tech1:appointment',
    TECH1,
    'appointment',
    dayOffset(0),
    dayOffset(0),
    'Doctor’s appointment. Back on the road by 11:00.',
    { from: '09:00', to: '11:00' },
  ),
  availability(
    'tech2:annual',
    TECH2,
    'annual_leave',
    dayOffset(9),
    dayOffset(16),
    'Annual leave. Cover arranged with the workshop.',
  ),
  availability(
    'tech3:sick',
    TECH3,
    'sick_leave',
    dayOffset(-1),
    dayOffset(1),
    'Medical certificate received.',
  ),
  availability(
    'tech1:training',
    TECH1,
    'training',
    dayOffset(5),
    dayOffset(6),
    'Fanuc servo diagnostics course at the supplier.',
  ),
  availability(
    'tech2:personal',
    TECH2,
    'personal_leave',
    dayOffset(2),
    dayOffset(2),
    'Family responsibility leave.',
  ),
];

/* -------------------------------------------------------------------------- */
/* Chat                                                                       */
/* -------------------------------------------------------------------------- */

const conversationId = (key: string) => demoId(`conversation:${key}`);
const messageId = (key: string) => demoId(`message:${key}`);

export const seedConversations: readonly Conversation[] = [
  {
    id: conversationId('master-tech1'),
    participantIds: [MASTER, TECH1],
    jobId: null,
    jobNumber: null,
    createdBy: TECH1,
    createdAt: timeAgo(1, 7),
    lastMessageAt: minutesAgo(35),
  },
  {
    id: conversationId('coordinator-tech2'),
    participantIds: [COORDINATOR, TECH2],
    jobId: jobId('EJE-2012'),
    jobNumber: 'EJE-2012',
    createdBy: COORDINATOR,
    createdAt: timeAgo(1, 9),
    lastMessageAt: minutesAgo(95),
  },
  {
    id: conversationId('master-coordinator'),
    participantIds: [MASTER, COORDINATOR],
    jobId: null,
    jobNumber: null,
    createdBy: MASTER,
    createdAt: timeAgo(2, 10),
    lastMessageAt: minutesAgo(240),
  },
];

const message = (
  key: string,
  conversation: string,
  senderId: typeof MASTER,
  body: string,
  sentAt: string,
  readBy: readonly (typeof MASTER)[],
): ChatMessage => ({
  id: messageId(key),
  conversationId: conversationId(conversation),
  senderId,
  body,
  sentAt,
  readBy,
  availabilityRecordId: null,
  actionedBy: null,
  actionedAt: null,
});

export const seedMessages: readonly ChatMessage[] = [
  message(
    'm1',
    'master-tech1',
    TECH1,
    'Morning John. The ACME spindle overload on EJE-2006 looks like the drive fan again. I will confirm on site.',
    timeAgo(1, 7, 5),
    [MASTER],
  ),
  message(
    'm2',
    'master-tech1',
    MASTER,
    'Thanks Mike. If it is the fan, take a spare with you rather than coming back for it.',
    timeAgo(1, 7, 20),
    [TECH1],
  ),
  /* Unread by the Master, so the bell and the message badge both have a count. */
  message(
    'm3',
    'master-tech1',
    TECH1,
    'Will do. I also need to be off the road from 09:00 to 11:00 tomorrow for a doctor’s appointment.',
    minutesAgo(35),
    [],
  ),
  message(
    'm4',
    'coordinator-tech2',
    COORDINATOR,
    'David, EJE-2012 is the three-day service at Johannesburg Industrial Automation. Their planner wants a daily update.',
    timeAgo(1, 9, 10),
    [TECH2],
  ),
  /* Unread by the Coordinator. */
  message(
    'm5',
    'coordinator-tech2',
    TECH2,
    'Understood. Day one is done — drive calibration tomorrow morning.',
    minutesAgo(95),
    [],
  ),
  message(
    'm6',
    'master-coordinator',
    MASTER,
    'Sarah, please chase the purchase order for EJE-2004. We cannot invoice the test and repair without it.',
    timeAgo(2, 10, 15),
    [COORDINATOR],
  ),
  message(
    'm7',
    'master-coordinator',
    COORDINATOR,
    'Requested this morning. Their buyer is back on Thursday.',
    minutesAgo(240),
    [MASTER],
  ),
];

/* -------------------------------------------------------------------------- */
/* Notifications                                                              */
/* -------------------------------------------------------------------------- */

const notification = (
  key: string,
  recipientId: typeof MASTER,
  type: AppNotification['type'],
  title: string,
  body: string,
  options: {
    readonly job?: string;
    readonly link?: string;
    readonly readMinutesAgo?: number;
    readonly sentMinutesAgo: number;
  },
): AppNotification => ({
  id: asNotificationId(demoId(`notification:${key}`)),
  recipientId,
  type,
  title,
  body,
  jobId: options.job === undefined ? null : jobId(options.job),
  link: options.link ?? null,
  createdAt: minutesAgo(options.sentMinutesAgo),
  readAt: options.readMinutesAgo === undefined ? null : minutesAgo(options.readMinutesAgo),
  handledAt: null,
  channels: ['in_app'],
});

export const seedNotifications: readonly AppNotification[] = [
  // Unread, and the reason the Master has to act: a customer would not sign.
  notification(
    'master-refusal',
    MASTER,
    'signature_refused',
    'Customer refused to sign EJE-2018',
    'Mike Technician recorded a refusal at Precision Manufacturing Gauteng (DEMO). The job card is held until the office resolves it.',
    { job: 'EJE-2018', sentMinutesAgo: 900 },
  ),
  notification(
    'master-machine',
    MASTER,
    'machine_approval_request',
    'New machine awaiting confirmation',
    'David Technician added a Fanuc Robocut a-C400iB at Southern Industrial Components (DEMO).',
    { sentMinutesAgo: 2_600 },
  ),
  notification(
    'master-document',
    MASTER,
    'document_approval_request',
    'Document awaiting approval',
    'Technician Training Guide (DEMO) was uploaded by Mike Technician and needs approval.',
    { sentMinutesAgo: 2_800 },
  ),
  notification(
    'master-chat',
    MASTER,
    'chat_message',
    'New message from Mike Technician',
    'Will do. I also need to be off the road from 09:00 to 11:00 tomorrow…',
    { link: `/messages?conversation=${conversationId('master-tech1')}`, sentMinutesAgo: 35 },
  ),
  // Read, so the screen shows both states.
  notification(
    'master-submitted',
    MASTER,
    'job_submitted',
    'EJE-2016 was submitted',
    'David Technician submitted the job card for Johannesburg Industrial Automation (DEMO).',
    { job: 'EJE-2016', sentMinutesAgo: 50_400, readMinutesAgo: 50_000 },
  ),
  notification(
    'tech1-assigned',
    TECH1,
    'job_assigned',
    'EJE-2006 has been assigned to you',
    'ACME Engineering Solutions (DEMO) — Haas VF-2SS tripping on a spindle overload.',
    { job: 'EJE-2006', sentMinutesAgo: 300 },
  ),
  notification(
    'tech1-transferred',
    TECH1,
    'job_transferred',
    'EJE-2023 was handed to David Technician',
    'Sarah Coordinator moved the job after your vehicle broke down. Your captured work stays on the job.',
    { job: 'EJE-2023', sentMinutesAgo: 200 },
  ),
  notification(
    'tech2-assigned',
    TECH2,
    'job_assigned',
    'EJE-2023 has been assigned to you',
    'Precision Manufacturing Gauteng (DEMO) — surface grinder tripping its incomer.',
    { job: 'EJE-2023', sentMinutesAgo: 195, readMinutesAgo: 150 },
  ),
  notification(
    'tech2-chat',
    TECH2,
    'chat_message',
    'New message from Sarah Coordinator',
    'David, EJE-2012 is the three-day service at Johannesburg Industrial Automation…',
    {
      link: `/messages?conversation=${conversationId('coordinator-tech2')}`,
      sentMinutesAgo: 1_400,
      readMinutesAgo: 1_300,
    },
  ),
  notification(
    'coordinator-chat',
    COORDINATOR,
    'chat_message',
    'New message from David Technician',
    'Understood. Day one is done — drive calibration tomorrow morning.',
    { link: `/messages?conversation=${conversationId('coordinator-tech2')}`, sentMinutesAgo: 95 },
  ),
];
