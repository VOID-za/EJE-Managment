'use client';

import type {
  CustomerDocument,
  ActivityEvent,
  AppNotification,
  AvailabilityRecord,
  ChatMessage,
  ChecklistTemplate,
  Contact,
  Customer,
  Job,
  CaptureReferral,
  CorrectedArea,
  DeliveryRecord,
  JobCorrection,
  Machine,
  MachineDocument,
  MediaVisibility,
  OcrJob,
  Site,
  SystemSettings,
  DocumentTextIndex,
  TechnicalDocument,
  SubmissionCover,
  TemplateUsage,
  User,
  ChangeRequest,
} from '@/domain';

/**
 * One attachment as the media route describes it back.
 *
 * Named because photographs and videos are described identically — only which
 * list they land in differs — and two copies of the same shape would drift.
 * NO STORAGE KEY: a screen addresses an attachment by its id through the
 * authenticated route, and a key is not a way in.
 */
/**
 * WHETHER A DEPLOYMENT ACTUALLY TRANSMITS. MANDATE-3.
 *
 * `simulated` means the message is kept in a visible outbox and nothing leaves
 * the building; `refuse` means the deployment will not even pretend, which is
 * what a PostgreSQL deployment with no credentials does — so EJE are never left
 * believing a customer was sent their job card.
 *
 * OPTIONAL ON EVERY VIEW THAT CARRIES IT, so a client newer than the server it
 * is talking to shows nothing rather than guessing.
 */
export interface DeliveryTransports {
  readonly email: 'graph' | 'smtp' | 'simulated' | 'refuse';
  readonly whatsapp: 'cloud_api' | 'simulated' | 'refuse';
}

interface MediaDescription {
  readonly id: string;
  readonly fileName: string;
  readonly caption: string;
  readonly visibility: MediaVisibility;
  readonly sizeBytes: number;
  readonly uploadedAt: string;
}
import type { ActivityFeed } from '@/application/activity-read';
import type { CaptureReferralRow } from '@/application/capture-referral-view';
import type { CalendarData } from '@/application/calendar';
import type { ClosedJobFilters, ClosedJobsPage } from '@/application/closed-jobs';
import type { ConversationSummary } from '@/application/chat-operations';
import type { SubmitResult } from '@/application/job-operations';
import type { JobListRow, JobView } from '@/application/job-view';
import type { LibrarySearchPage } from '@/application/library-search';
import type { SearchResult } from '@/application/search';
import type { GeneratedPdf, OutboxEntry } from '@/services/ports';

/** What an upload answers with: the record, and the honest state of its text. */
export interface LibraryUploadResult {
  readonly document: {
    readonly id: string;
    readonly name: string;
    readonly status: string;
    readonly version: string;
    readonly fileName: string;
    readonly fileSizeBytes: number;
    readonly pageCount: number;
  };
  readonly index: {
    readonly state: 'indexed' | 'needs_ocr' | 'failed';
    readonly characters: number;
    readonly pages: number;
    readonly truncated: boolean;
    readonly failureReason: string;
  };
}
import { apiGet, apiPatch, apiPost, apiUpload, newIdempotencyKey, segment } from './client';

/**
 * Every call the browser makes, named.
 *
 * One module, so the set of things the application can ask for is a list
 * somebody can read — and so no component builds a URL. There is no business
 * logic here: each function is a name, a path and a shape.
 *
 * `command` is used for anything that changes something. It sends an
 * idempotency key automatically, because the field device this is for is a
 * tablet on an industrial estate and a retry is normal.
 */
/**
 * Every read in this file goes through here.
 *
 * CONCURRENT IDENTICAL READS SHARE ONE REQUEST. React's strict mode runs each
 * effect twice in development, so the bootstrap asked `/api/auth/me` twice and
 * every screen asked for its data twice — two round-trips for an answer that
 * cannot differ between them. On a database reached over an SSH tunnel that is
 * seconds of waiting rather than milliseconds, and the same doubling reaches
 * any build where two components mount asking for the same thing.
 *
 * NOTHING IS CACHED. The entry is dropped the moment the request settles, so a
 * read issued after one finishes is a fresh question — which is exactly what
 * `invalidate()` relies on after a write, and what identity relies on after
 * signing in, switching user, or a session being revoked. Sharing an answer
 * that is still in flight is not the same as remembering one.
 */
const inFlight = new Map<string, Promise<unknown>>();

const query = <T>(path: string): Promise<T> => {
  const existing = inFlight.get(path);
  if (existing !== undefined) return existing as Promise<T>;

  const started = apiGet<T>(path).finally(() => {
    inFlight.delete(path);
  });
  inFlight.set(path, started);
  return started;
};
const command = <T>(path: string, body: unknown = {}) =>
  apiPost<T>(path, body, newIdempotencyKey());

const search = (params: Record<string, string | undefined>): string => {
  const usable = Object.entries(params).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== '',
  );
  return usable.length === 0 ? '' : `?${new URLSearchParams(usable).toString()}`;
};

/* ---- register change requests ------------------------------------------ */

/**
 * A report that the register is wrong, raised by somebody who may not edit it.
 * CUST-CR.
 *
 * `mine()` is how a technician sees what became of their own report; `list()`
 * is the office's screen and needs `customers.manage`. The server decides
 * which, from the session — see `/api/change-requests`.
 */
export const changeRequests = {
  list: (state?: 'open' | 'applied' | 'declined') =>
    apiGet<{ rows: readonly ChangeRequest[] }>(
      `/api/change-requests${search({ state })}`,
    ),
  mine: () => apiGet<{ rows: readonly ChangeRequest[] }>('/api/change-requests?mine=1'),
  raise: (input: {
    readonly subject: 'customer' | 'site' | 'machine';
    readonly customerId: string;
    readonly siteId?: string | null;
    readonly machineId?: string | null;
    readonly details: string;
  }) => command<ChangeRequest>('/api/change-requests', input),
  resolve: (requestId: string, input: { readonly outcome: 'applied' | 'declined'; readonly note: string }) =>
    command<ChangeRequest>(`/api/change-requests/${segment(requestId)}/resolve`, input),
};

/* ---- identity ---------------------------------------------------------- */

export interface SafeUser {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly initials: string;
  readonly email: string;
  readonly mobile: string;
  readonly role: User['role'];
  readonly jobTitle: string;
  readonly active: boolean;
  readonly createdAt: string;
}

export const auth = {
  signIn: (email: string, password: string) =>
    apiPost<{ user: SafeUser }>('/api/auth/login', { email, password }),
  signOut: () => apiPost<{ signedOut: boolean }>('/api/auth/logout'),
  me: () => query<{ user: SafeUser; backend: 'postgres' | 'demo' }>('/api/auth/me'),
};

/* ---- reads ------------------------------------------------------------- */

export interface JobScreen {
  readonly view: JobView;
  readonly users: readonly User[];
  readonly activity: readonly ActivityEvent[];
  /**
   * Who on this job could submit it today, decided on the SERVER. CR-08.
   *
   * The screen renders this; it never works it out. The operation asks the
   * same question again from the same data before it acts, so this cannot be
   * used to unlock anything.
   */
  readonly submissionCover: SubmissionCover;
}

export interface JobFormData {
  readonly customers: readonly Customer[];
  readonly sites: readonly Site[];
  readonly contacts: readonly Contact[];
  readonly machines: readonly Machine[];
  readonly users: readonly User[];
  readonly settings: SystemSettings;
}

export interface CustomerRow {
  readonly id: string;
  readonly name: string;
  readonly accountNumber: string;
  readonly industry: string;
  readonly siteCount: number;
  readonly machineCount: number;
  readonly openJobs: number;
  readonly active: boolean;
}

export interface MachineRow {
  readonly id: string;
  readonly label: string;
  readonly serialNumber: string;
  readonly machineNumber: string;
  readonly machineType: Machine['machineType'];
  readonly manufacturer: string;
  readonly customerName: string;
  readonly siteName: string;
  readonly year: number;
  readonly installationDate: string;
  readonly openJobs: number;
}

export interface CustomerScreen {
  readonly customer: Customer;
  readonly sites: readonly Site[];
  readonly contacts: readonly Contact[];
  readonly machines: readonly Machine[];
  readonly jobRows: readonly JobListRow[];
  readonly users: readonly User[];
  /**
   * Reports that this record is wrong. CUST-CR.
   *
   * Empty for anybody but the office, and empty on the SERVER rather than
   * hidden here: the fact that somebody complained about a record is not a
   * technician's to read. Their own reports come from `changeRequests.mine()`.
   */
  readonly changeRequests: readonly ChangeRequest[];
  /**
   * The customer's filed paperwork. October mandate §4.
   *
   * Empty for anybody but the office, and empty on the SERVER: a technician's
   * response does not carry the customer's credit application at all. The
   * storage keys are stripped by the view — the download route resolves one
   * after deciding who is asking.
   */
  readonly documents: readonly Omit<CustomerDocument, 'storageKey'>[];
}

/**
 * A machine document as it leaves the server: never its storage key.
 *
 * The download route resolves the key after deciding who is asking, and a key
 * is not a way in.
 */
export type MachineDocumentRow = Omit<MachineDocument, 'storageKey'>;

export interface MachineScreen {
  readonly machine: Machine;
  readonly customer: Customer | null;
  readonly site: Site | null;
  readonly jobRows: readonly JobListRow[];
  /**
   * The paper filed against this machine, as THIS actor may see it. Mandate §4.
   *
   * Filtered on the SERVER by each document's audience, so a technician's
   * response does not carry an office-only document at all — a screen that
   * hides a row still received it.
   */
  readonly documents: readonly MachineDocumentRow[];
  /** So the screen can name whoever filed a document. */
  readonly users: readonly User[];
}

export interface TechnicianScreen {
  readonly technician: User;
  readonly records: readonly AvailabilityRecord[];
  readonly jobRows: readonly JobListRow[];
  readonly messages: readonly ChatMessage[];
  readonly users: readonly User[];
}

export interface AdminScreen {
  readonly users: readonly User[];
  readonly settings: SystemSettings;
  readonly templates: readonly ChecklistTemplate[];
  readonly documents: readonly TechnicalDocument[];
  readonly customers: readonly Customer[];
  readonly machines: readonly Machine[];
  readonly usage: readonly TemplateUsage[];
}

export interface DashboardScreen {
  readonly kind: 'office' | 'field';
  readonly office?: {
    readonly rows: readonly JobListRow[];
    readonly users: readonly User[];
    readonly activity: readonly ActivityEvent[];
    readonly notifications: readonly AppNotification[];
  };
  readonly field?: {
    readonly mineRows: readonly JobListRow[];
    readonly allRows: readonly JobListRow[];
    readonly notifications: readonly AppNotification[];
  };
}

export interface MessagesScreen {
  readonly summaries: readonly ConversationSummary[];
  readonly users: readonly User[];
  readonly availability: readonly AvailabilityRecord[];
  readonly thread: readonly ChatMessage[];
  /** Which conversation the thread belongs to. The server chooses when the URL names none. */
  readonly selectedId: string | null;
  readonly jobs: readonly Job[];
}

export const reads = {
  shell: () =>
    query<{
      unreadNotifications: number;
      unreadMessages: number;
      /**
       * WHETHER THIS DEPLOYMENT ACTUALLY TRANSMITS. MANDATE-3.
       *
       * The transport name and nothing else. `simulated` means the message is
       * kept in the visible outbox and nothing leaves the building; `refuse`
       * means the deployment will not even pretend. A screen that says
       * "(simulated)" over a message that genuinely reached a customer is a
       * screen somebody uses to decide whether to telephone them instead.
       */
      delivery?: DeliveryTransports;
    }>('/api/shell'),
  dashboard: () => query<DashboardScreen>('/api/dashboard'),
  jobs: () => query<{ rows: readonly JobListRow[]; closedCount: number }>('/api/jobs'),
  job: (jobNumber: string) => query<JobScreen>(`/api/jobs/${segment(jobNumber)}`),
  jobForm: () => query<JobFormData>('/api/jobs/form'),
  closedJobs: (filters: ClosedJobFilters) =>
    query<ClosedJobsPage>(
      `/api/jobs/closed${search({
        term: filters.term,
        customerId: filters.customerId,
        siteId: filters.siteId,
        jobType: filters.jobType,
        technicianId: filters.technicianId,
        closedFrom: filters.closedFrom,
        closedTo: filters.closedTo,
      })}`,
    ),
  customers: () => query<readonly CustomerRow[]>('/api/customers'),
  customer: (customerId: string) => query<CustomerScreen>(`/api/customers/${segment(customerId)}`),
  machines: () => query<readonly MachineRow[]>('/api/machines'),
  machine: (machineId: string) => query<MachineScreen>(`/api/machines/${segment(machineId)}`),
  technician: (userId: string) => query<TechnicianScreen>(`/api/users/${segment(userId)}`),
  admin: () => query<AdminScreen>('/api/admin'),
  library: () =>
    query<{
      documents: readonly TechnicalDocument[];
      favourites: readonly string[];
      recent: readonly string[];
      /** Which documents hold searchable text, and which do not. LIB-5. */
      indexes: readonly DocumentTextIndex[];
      /**
       * Which of the unsearchable ones anybody is going to try to read. LIB-5.
       *
       * Travels WITH the indexes rather than being fetched separately: the
       * answer a screen needs is made of both, and two requests would let the
       * badge and the reason disagree. See `describeSearchability`.
       */
      ocr: readonly OcrJob[];
    }>('/api/library'),
  /** The words INSIDE the documents, paged. LIB-5. */
  librarySearch: (term: string, page = 1) =>
    query<LibrarySearchPage>(`/api/library/search${search({ q: term, page: String(page) })}`),
  activity: () =>
    query<{
      events: ActivityFeed['events'];
      users: ActivityFeed['users'];
      jobNumbers: readonly (readonly [string, string])[];
    }>('/api/activity'),
  search: (term: string) => query<readonly SearchResult[]>(`/api/search${search({ q: term })}`),
  calendar: (from: string, to: string) =>
    query<CalendarData>(`/api/calendar${search({ from, to })}`),
  notifications: () =>
    query<{
      notifications: readonly AppNotification[];
      jobNumbers: readonly (readonly [string, string])[];
      /** What this deployment really does with a message. MANDATE-3. */
      delivery?: DeliveryTransports;
    }>('/api/notifications'),
  messages: (conversationId: string | null) =>
    query<MessagesScreen>(
      `/api/conversations${search({ conversationId: conversationId ?? undefined })}`,
    ),
  outbox: () => query<{ entries: readonly OutboxEntry[] }>('/api/outbox'),
};

/* ---- commands ---------------------------------------------------------- */

/**
 * A job action, which answers with the job itself unless it says otherwise.
 *
 * Generic over the answer because not every action returns a `Job`: a
 * correction returns the correction, and an authorised delivery returns what
 * the provider said. The default keeps every existing call site unchanged.
 */
const jobAction = <T = Job>(jobId: string, action: string, body: unknown = {}) =>
  command<T>(`/api/jobs/${segment(jobId)}/${action}`, body);

export const jobs = {
  create: (input: unknown) => command<Job>('/api/jobs', input),
  /** Attaches a document to an existing job. The bytes go up; the server stores them. */
  attach: (jobId: string, file: File, caption = '') =>
    apiUpload<{ attachments: readonly { id: string; fileName: string }[] }>(
      `/api/jobs/${segment(jobId)}/attachments`,
      file,
      caption,
    ),
  /** Where a job's attachment is downloaded from. Authorised on every request. */
  attachmentUrl: (jobId: string, attachmentId: string) =>
    `/api/jobs/${segment(jobId)}/attachments/${segment(attachmentId)}`,
  /**
   * SENDS A CAPTURE THIS DEVICE HAS BEEN HOLDING. OFF-6.
   *
   * The same route the online call uses — there is no special offline endpoint
   * and no relaxed validation — with ONE difference that is the whole point:
   * the idempotency key comes from the queued row rather than being minted
   * here. So a flush interrupted after the server committed, but before the
   * answer arrived, re-sends the same request and is answered from the first
   * one instead of adding the hours twice.
   *
   * The action is restricted to the offline allowlist by the queue
   * (`offline-rules.ts`), not by this function; this is the transport.
   */
  sendCaptured: (jobId: string, action: string, payload: unknown, idempotencyKey: string) =>
    apiPost<Job>(`/api/jobs/${segment(jobId)}/${action}`, payload, idempotencyKey, {
      // This is the CAPTURE transport, and it says so. The server holds a
      // checklist answer that arrived this way to a stricter rule — see
      // `answer_checklist` — because it may have been written hours ago.
      captureTransport: true,
    }),
  accept: (jobId: string) => jobAction(jobId, 'accept'),
  /**
   * Asks for the site location. NO DESTINATION — see the command.
   *
   * It goes to the signed-in technician's own mobile, from their account. The
   * answer says `queued`, because at the moment it is given nothing has left
   * the building: the outbox is drained after the response is decided.
   */
  sendSiteLocation: (jobId: string) =>
    command<{
      queued: boolean;
      navigationUrl: string;
      configured: boolean;
      failureReason: string | null;
    }>(`/api/jobs/${segment(jobId)}/send_site_location`, {}),
  declineSiteLocation: (jobId: string) => jobAction(jobId, 'decline_site_location'),
  assignPrimary: (jobId: string, technicianId: string) =>
    jobAction(jobId, 'assign_primary', { technicianId }),
  addTechnician: (jobId: string, technicianId: string) =>
    jobAction(jobId, 'add_technician', { technicianId }),
  removeTechnician: (jobId: string, technicianId: string) =>
    jobAction(jobId, 'remove_technician', { technicianId }),
  addLabour: (jobId: string, input: unknown) => jobAction(jobId, 'add_labour', input),
  updateLabour: (jobId: string, input: unknown) => jobAction(jobId, 'update_labour', input),
  addTravel: (jobId: string, input: unknown) => jobAction(jobId, 'add_travel', input),
  updateTravel: (jobId: string, input: unknown) => jobAction(jobId, 'update_travel', input),
  addPart: (jobId: string, input: unknown) => jobAction(jobId, 'add_part', input),
  updatePart: (jobId: string, input: unknown) => jobAction(jobId, 'update_part', input),
  // COST-5. A charge that is neither labour, travel nor a part.
  addAdditionalCharge: (jobId: string, input: unknown) =>
    jobAction(jobId, 'add_additional_charge', input),
  updateAdditionalCharge: (jobId: string, input: unknown) =>
    jobAction(jobId, 'update_additional_charge', input),
  // COST-5. Money off the whole job. The server refuses anybody but a Master.
  applyDiscount: (jobId: string, amount: number, reason: string) =>
    jobAction(jobId, 'apply_discount', { amount, reason }),
  clearDiscount: (jobId: string) => jobAction(jobId, 'clear_discount'),
  removeLine: (
    jobId: string,
    kind: 'labour' | 'travel' | 'part' | 'additional_charge',
    lineId: string,
  ) => jobAction(jobId, 'remove_line', { kind, lineId }),
  setCallout: (jobId: string, applied: boolean) => jobAction(jobId, 'set_callout', { applied }),
  addNote: (jobId: string, body: string, internal: boolean) =>
    jobAction(jobId, 'add_note', { body, internal }),
  /**
   * ATTACHES A PHOTOGRAPH OR A VIDEO, BYTES AND ALL. PWA-3, MEDIA-5.
   *
   * It used to be `jobAction(jobId, 'add_media', …)`: a JSON body carrying a
   * made-up file name and size, with no file anywhere in it. The bytes now go
   * up through the same multipart path a document takes, and the server sniffs,
   * stores and only then records them.
   */
  uploadMedia: (
    jobId: string,
    file: File,
    options: {
      readonly caption?: string;
      readonly visibility?: MediaVisibility;
      /** `video` chooses the video validator and its larger limit. MEDIA-5. */
      readonly kind?: 'photo' | 'video';
      /** Minted once per capture, so a retry replays instead of duplicating. */
      readonly idempotencyKey?: string;
    } = {},
  ) =>
    apiUpload<{
      photos: readonly MediaDescription[];
      /** Present since MEDIA-5. Absent on a server older than this client. */
      videos?: readonly MediaDescription[];
    }>(
      `/api/jobs/${segment(jobId)}/media`,
      file,
      options.caption ?? '',
      {
        ...(options.visibility === undefined ? {} : { visibility: options.visibility }),
        ...(options.kind === undefined ? {} : { kind: options.kind }),
      },
      options.idempotencyKey,
    ),
  /** Where one photograph is read back from. Authorised on every request. */
  mediaUrl: (jobId: string, attachmentId: string) =>
    `/api/jobs/${segment(jobId)}/media/${segment(attachmentId)}`,
  /** Reclassifies a photograph as the customer's or as EJE's own. MEDIA-1. */
  setMediaVisibility: (jobId: string, attachmentId: string, visibility: string) =>
    jobAction(jobId, 'set_media_visibility', { attachmentId, visibility }),
  removeMedia: (jobId: string, kind: 'photo' | 'video', attachmentId: string) =>
    jobAction(jobId, 'remove_media', { kind, attachmentId }),
  awaitingSpares: (
    jobId: string,
    request: { description: string; notes?: string; photoId?: string | null },
  ) => jobAction(jobId, 'awaiting_spares', request),
  returnToProgress: (jobId: string) => jobAction(jobId, 'return_to_progress'),
  startCompletion: (jobId: string) => jobAction(jobId, 'start_completion'),
  saveReport: (jobId: string, report: unknown) => jobAction(jobId, 'save_report', report),
  startChecklist: (jobId: string) => jobAction(jobId, 'start_checklist'),
  answerChecklist: (jobId: string, input: unknown) => jobAction(jobId, 'answer_checklist', input),
  /**
   * ATTACHES CHECKLIST EVIDENCE, BYTES AND ALL. CHK-EVIDENCE-1.
   *
   * It used to post an item id and a file name the client invented, and store
   * nothing — against the very questions that gate a checklist's completion.
   */
  addChecklistPhoto: (
    jobId: string,
    itemId: string,
    file: File,
    options: { readonly caption?: string; readonly idempotencyKey?: string } = {},
  ) =>
    apiUpload<{
      itemId: string;
      photos: readonly {
        id: string;
        fileName: string;
        caption: string;
        sizeBytes: number;
        uploadedAt: string;
      }[];
    }>(
      `/api/jobs/${segment(jobId)}/checklist/${segment(itemId)}/photo`,
      file,
      options.caption ?? '',
      {},
      options.idempotencyKey,
    ),
  completeChecklist: (jobId: string) => jobAction(jobId, 'complete_checklist'),
  setCollection: (jobId: string, courier: boolean, waybillNumber: string) =>
    jobAction(jobId, 'set_collection', { courier, waybillNumber }),
  startSignature: (jobId: string) => jobAction(jobId, 'start_signature'),
  captureSignature: (jobId: string, input: unknown) =>
    jobAction(jobId, 'capture_signature', input),
  recordRefusal: (jobId: string, reason: string) => jobAction(jobId, 'record_refusal', { reason }),
  resolveRefusal: (jobId: string, note: string) => jobAction(jobId, 'resolve_refusal', { note }),
  returnForSignature: (jobId: string, note: string) =>
    jobAction(jobId, 'return_for_signature', { note }),
  generateDocument: (jobId: string) =>
    command<GeneratedPdf>(`/api/jobs/${segment(jobId)}/generate_document`),
  issue: (jobId: string) => command<SubmitResult>(`/api/jobs/${segment(jobId)}/issue`),
  confirmDelivery: (jobId: string) => jobAction(jobId, 'confirm_delivery'),
  /** CR-08: the office submits a signed job card its technician cannot. */
  takeOverSubmission: (jobId: string) =>
    command<SubmitResult>(`/api/jobs/${segment(jobId)}/take_over_submission`),

  retryDelivery: (jobId: string) =>
    command<SubmitResult>(`/api/jobs/${segment(jobId)}/retry_delivery`),
  transferToOpen: (jobId: string, input: unknown) => jobAction(jobId, 'transfer_to_open', input),
  transferToTechnician: (jobId: string, input: unknown) =>
    jobAction(jobId, 'transfer_to_technician', input),
  cancel: (jobId: string, input: unknown) => jobAction(jobId, 'cancel', input),
  remove: (jobId: string, reason: string) =>
    command<{ deleted: true }>(`/api/jobs/${segment(jobId)}/delete`, { reason }),
  reschedule: (jobId: string, scheduledDate: string | null, scheduledEndDate: string | null) =>
    jobAction(jobId, 'reschedule', { scheduledDate, scheduledEndDate }),
  /**
   * The issued job card's bytes.
   *
   * A POST although it reads: opening the document is AUDITED, and an audited
   * read is a write. The bytes arrive base64-encoded and are decoded here, so
   * the download helper gets the `Uint8Array` it has always taken.
   */
  finalDocument: async (jobNumber: string) => {
    const file = await apiPost<{ fileName: string; contentType: string; base64: string }>(
      `/api/documents/${segment(jobNumber)}`,
    );
    const binary = atob(file.base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return { fileName: file.fileName, contentType: file.contentType, bytes };
  },

  /* -- correcting a job card EJE have already issued. BD-02, IMMUT-9. ----- */

  /**
   * A Master raises a correction. The original is untouched; the server
   * refuses anybody else and refuses a job that has issued nothing.
   */
  raiseCorrection: (
    jobId: string,
    input: {
      readonly reason: string;
      readonly narrative: string;
      readonly areas: readonly CorrectedArea[];
      readonly acknowledgementRequired: boolean;
    },
  ) => jobAction<JobCorrectionRow>(jobId, 'raise_correction', input),

  /** The office records that the customer acknowledged one. Write-once. */
  acknowledgeCorrection: (
    jobId: string,
    input: {
      readonly correctionId: string;
      readonly acknowledgedBy: string;
      readonly method: string;
      readonly note: string;
    },
  ) => jobAction<JobCorrectionRow>(jobId, 'acknowledge_correction', input),

  /**
   * The addendum's bytes. A POST although it reads, for the reason
   * `finalDocument` is: opening a document is audited.
   */
  correctionDocument: async (jobNumber: string, correctionId: string) => {
    const file = await apiPost<{
      fileName: string;
      contentType: string;
      base64: string;
      sequence: number;
    }>(`/api/documents/${segment(jobNumber)}/corrections/${segment(correctionId)}`);
    const binary = atob(file.base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return { fileName: file.fileName, contentType: file.contentType, bytes };
  },

  /* -- sending a job card the customer did not sign. BD-06, DELIV-7. ------ */

  /** A Master authorises it, with a reason, and it is sent. */
  authoriseUnsignedDelivery: (jobId: string, reason: string) =>
    jobAction<{ readonly delivery: DeliveryRecord }>(jobId, 'authorise_unsigned_delivery', {
      reason,
    }),

  /** A retry of a failed send. No second authorisation; the decision stands. */
  retryUnsignedDelivery: (jobId: string) =>
    jobAction<{ readonly delivery: DeliveryRecord }>(jobId, 'retry_unsigned_delivery', {}),
};

/** A correction as it leaves the server: never a storage key. */
export type JobCorrectionRow = Omit<JobCorrection, 'documentStorageKey'>;

export interface RemovalOutcome {
  readonly removed: 'deleted' | 'archived';
  readonly message: string;
}

export const customers = {
  create: (input: unknown) => command<unknown>('/api/customers', input),
  update: (customerId: string, input: unknown) =>
    command<Customer>(`/api/customers/${segment(customerId)}/update`, input),
  addSite: (customerId: string, input: unknown) =>
    command<Site>(`/api/customers/${segment(customerId)}/add_site`, input),
  addContact: (customerId: string, input: unknown) =>
    command<Contact>(`/api/customers/${segment(customerId)}/add_contact`, input),
  updateSite: (siteId: string, input: unknown) =>
    command<Site>(`/api/sites/${segment(siteId)}/update`, input),
  removeSite: (siteId: string) =>
    command<RemovalOutcome>(`/api/sites/${segment(siteId)}/remove`),
  updateContact: (contactId: string, input: unknown) =>
    command<Contact>(`/api/contacts/${segment(contactId)}/update`, input),
  removeContact: (contactId: string) =>
    command<RemovalOutcome>(`/api/contacts/${segment(contactId)}/remove`),

  /**
   * THE CUSTOMER'S OWN FILED PAPERWORK. October mandate §4.
   *
   * A service agreement, a credit application, a site induction certificate —
   * documents that belong to the customer rather than to any one job. The
   * server decides who may read or attach one (the office); these only ask.
   *
   * `documentUrl` is a URL rather than a fetch on purpose, for the same reason
   * `library.fileUrl` is: the browser's own download handles a file better
   * than JSON can, and the route authorises the request before it reads a byte.
   */
  documents: (customerId: string) =>
    apiGet<{ readonly documents: readonly CustomerDocument[] }>(
      `/api/customers/${segment(customerId)}/documents`,
    ),
  documentUrl: (customerId: string, documentId: string) =>
    `/api/customers/${segment(customerId)}/documents/${segment(documentId)}`,
  withdrawDocument: (customerId: string, documentId: string) =>
    command<{ readonly document: Omit<CustomerDocument, 'storageKey'> }>(
      `/api/customers/${segment(customerId)}/documents/${segment(documentId)}/withdraw`,
    ),
  attachDocument: (customerId: string, file: File, caption = '') =>
    apiUpload<{ readonly document: CustomerDocument }>(
      `/api/customers/${segment(customerId)}/documents`,
      file,
      caption,
    ),
};

/**
 * WORK A TABLET COULD NOT GET ONTO A JOB. BD-15.
 *
 * Three calls: a tablet hands over a capture the server refused, anybody reads
 * the referrals they are entitled to (their own, or all of them for the
 * office), and the office records a decision. The server decides which of those
 * the caller may do; these only ask.
 */
export const captures = {
  refer: (input: {
    readonly jobId: string;
    readonly action: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly summary: string;
    readonly capturedAt: string;
    readonly idempotencyKey: string;
    readonly refusalCode: string;
    readonly refusalMessage: string;
  }) => command<{ referral: CaptureReferral }>('/api/captures/referrals', input),
  /** `mine` for a technician's own; omitted for the office's whole list. */
  referrals: (options: { readonly mine?: boolean; readonly state?: string } = {}) =>
    query<{ rows: readonly CaptureReferralRow[] }>(
      `/api/captures/referrals${search({
        mine: options.mine === true ? '1' : undefined,
        state: options.state,
      })}`,
    ),
  resolve: (referralId: string, decision: { resolution: string; note?: string }) =>
    command<{ referral: CaptureReferral }>(
      `/api/captures/referrals/${segment(referralId)}/resolve`,
      decision,
    ),
};

export const machines = {
  create: (input: unknown) => command<Machine>('/api/machines', input),
  update: (machineId: string, input: unknown) =>
    command<Machine>(`/api/machines/${segment(machineId)}/update`, input),
  /**
   * A PHOTOGRAPH OF THE MACHINE, BYTES AND ALL. MACH-PHOTO-1.
   *
   * The create call used to carry `photos: [{ fileName, caption, sizeBytes }]`
   * — metadata with no file behind it. A machine is raised first and
   * photographed afterwards, and the server's register rules decide who may.
   */
  addPhoto: (
    machineId: string,
    file: File,
    options: {
      readonly caption?: string;
      readonly idempotencyKey?: string;
      /** The job that authorises a technician's photograph. BD-14. */
      readonly jobId?: string;
    } = {},
  ) =>
    apiUpload<{
      approval: Machine['approval'];
      photos: readonly {
        id: string;
        fileName: string;
        caption: string;
        sizeBytes: number;
        uploadedAt: string;
      }[];
    }>(
      `/api/machines/${segment(machineId)}/photos`,
      file,
      options.caption ?? '',
      { ...(options.jobId === undefined ? {} : { jobId: options.jobId }) },
      options.idempotencyKey,
    ),
  /** Where one machine photograph is read back from. Authorised per request. */
  photoUrl: (machineId: string, attachmentId: string) =>
    `/api/machines/${segment(machineId)}/photos/${segment(attachmentId)}`,
  approve: (machineId: string) => command<Machine>(`/api/machines/${segment(machineId)}/approve`),
  remove: (machineId: string) =>
    command<RemovalOutcome>(`/api/machines/${segment(machineId)}/remove`),

  /**
   * PAPER ABOUT ONE MACHINE. October mandate §4.
   *
   * A commissioning report, a compliance certificate, the calibration results
   * for that serial number — not a photograph, which renders inline, and not a
   * library document, which is filed by MODEL and answers for every machine of
   * it.
   *
   * `audience` is who may read it afterwards: `field` or `office_only`. The
   * server decides who may attach one (the office) and who may read which;
   * these only ask.
   */
  documents: (machineId: string) =>
    apiGet<{ readonly documents: readonly MachineDocumentRow[] }>(
      `/api/machines/${segment(machineId)}/documents`,
    ),
  documentUrl: (machineId: string, documentId: string) =>
    `/api/machines/${segment(machineId)}/documents/${segment(documentId)}`,
  attachDocument: (
    machineId: string,
    file: File,
    options: {
      readonly caption?: string;
      readonly audience?: MachineDocument['audience'];
    } = {},
  ) =>
    apiUpload<{ readonly document: MachineDocumentRow }>(
      `/api/machines/${segment(machineId)}/documents`,
      file,
      options.caption ?? '',
      { audience: options.audience ?? 'office_only' },
    ),
  withdrawDocument: (machineId: string, documentId: string) =>
    command<{ readonly document: MachineDocumentRow }>(
      `/api/machines/${segment(machineId)}/documents/${segment(documentId)}/withdraw`,
    ),
};

export const users = {
  create: (input: unknown) => command<User>('/api/users', input),
  update: (userId: string, input: unknown) =>
    command<User>(`/api/users/${segment(userId)}/update`, input),
  setActive: (userId: string, active: boolean) =>
    command<User>(`/api/users/${segment(userId)}/set_active`, { active }),
  sendPasswordReset: (userId: string) =>
    command<{ sentTo: string; simulated: boolean }>(
      `/api/users/${segment(userId)}/send_password_reset`,
    ),
};

/**
 * Recording an absence also reports the work it clashes with.
 *
 * Never resolved automatically: the office decides what happens to a job
 * already booked inside the period, which is why the jobs come back rather
 * than being moved.
 */
export interface AvailabilityResult {
  readonly record: AvailabilityRecord;
  readonly affectedJobs: readonly Job[];
}

export const availability = {
  create: (input: unknown) => command<AvailabilityResult>('/api/availability', input),
  update: (recordId: string, input: unknown) =>
    command<AvailabilityResult>(`/api/availability/${segment(recordId)}/update`, input),
  cancel: (recordId: string) =>
    command<AvailabilityRecord>(`/api/availability/${segment(recordId)}/cancel`),
};

export const notifications = {
  read: (notificationId: string) =>
    command<{ read: boolean }>(`/api/notifications/${segment(notificationId)}/read`),
  handled: (notificationId: string) =>
    command<{ handled: boolean }>(`/api/notifications/${segment(notificationId)}/handled`),
  readAll: () => command<{ read: boolean }>('/api/notifications/read-all'),
};

export const conversations = {
  start: (input: unknown) => command<unknown>('/api/conversations', input),
  send: (conversationId: string, body: string) =>
    command<ChatMessage>(`/api/conversations/${segment(conversationId)}/send`, { body }),
  markRead: (conversationId: string) =>
    command<{ read: boolean }>(`/api/conversations/${segment(conversationId)}/mark_read`),
  attachAvailability: (conversationId: string, messageId: string, availabilityId: string) =>
    command<ChatMessage>(`/api/conversations/${segment(conversationId)}/attach_availability`, {
      messageId,
      availabilityId,
    }),
};

export const library = {
  create: (input: unknown) => command<TechnicalDocument>('/api/library', input),
  /**
   * Uploads a document WITH ITS FILE, and indexes the text in it. LIB-5.
   *
   * The fields travel with the bytes: a document's type and model are decided
   * at the moment somebody chooses the file, and sending them separately would
   * leave the library holding a file nothing describes.
   */
  upload: (file: File, fields: Readonly<Record<string, string>>) =>
    apiUpload<LibraryUploadResult>('/api/library/upload', file, '', fields),
  /**
   * Where a stored document is downloaded from. LIB-5.
   *
   * Authorised on every request by `canOpenDocumentFile`, and a refusal is the
   * same 404 a missing document gets — so the response cannot be used to ask
   * which documents are waiting for approval.
   */
  fileUrl: (documentId: string) => `/api/library/${segment(documentId)}/file`,
  /** Index this revision's text again, from the bytes already stored. LIB-5. */
  reindex: (documentId: string) =>
    command<DocumentTextIndex>(`/api/library/${segment(documentId)}/reindex`),
  update: (documentId: string, input: unknown) =>
    command<TechnicalDocument>(`/api/library/${segment(documentId)}/update`, input),
  approve: (documentId: string) =>
    command<TechnicalDocument>(`/api/library/${segment(documentId)}/approve`),
  archive: (documentId: string) =>
    command<TechnicalDocument>(`/api/library/${segment(documentId)}/archive`),
  addVersion: (documentId: string, input: unknown) =>
    command<TechnicalDocument>(`/api/library/${segment(documentId)}/add_version`, input),
  toggleFavourite: (documentId: string) =>
    command<{ favourites: readonly string[] }>(
      `/api/library/${segment(documentId)}/toggle_favourite`,
    ),
  recordView: (documentId: string) =>
    command<{ viewed: boolean }>(`/api/library/${segment(documentId)}/record_view`),
};

export const checklists = {
  create: (input: unknown) => command<ChecklistTemplate>('/api/checklists', input),
  saveDraft: (templateId: string, input: unknown) =>
    command<ChecklistTemplate>(`/api/checklists/${segment(templateId)}/save_draft`, input),
  publish: (templateId: string, version: string) =>
    command<ChecklistTemplate>(`/api/checklists/${segment(templateId)}/publish`, { version }),
  startVersion: (templateId: string, version: string) =>
    command<ChecklistTemplate>(`/api/checklists/${segment(templateId)}/start_version`, { version }),
  archive: (templateId: string, version: string) =>
    command<ChecklistTemplate>(`/api/checklists/${segment(templateId)}/archive`, { version }),
};

export const settings = {
  update: (input: unknown) => apiPatch<SystemSettings>('/api/settings', input),
};

/**
 * Demonstration-only. Answers 404 when a real database is behind the API,
 * because the capability does not exist there at all.
 */
export const demo = {
  reset: () => command<{ reset: boolean }>('/api/demo/reset'),
};

/** One of the seeded development accounts, as the switcher lists them. */
export interface DemoAccount {
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly role: User['role'];
}

/**
 * The development user switcher.
 *
 * Both calls answer 404 in production, where the endpoint does not exist — so
 * `list` failing is the signal that the control must not be drawn at all.
 */
export const demoUsers = {
  list: () => query<{ users: readonly DemoAccount[] }>('/api/dev/demo-users'),
  switchTo: (email: string) => apiPost<{ user: SafeUser }>('/api/dev/demo-users', { email }),
};

export const outbox = {
  reportDelivery: (messageId: string, state: string, failureReason?: string) =>
    command<{ reported: boolean; closed: number }>(`/api/outbox/${segment(messageId)}/delivery`, {
      state,
      ...(failureReason === undefined ? {} : { failureReason }),
    }),
};
