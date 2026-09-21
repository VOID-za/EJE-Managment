'use client';

import type {
  ActivityEvent,
  AppNotification,
  AvailabilityRecord,
  ChatMessage,
  ChecklistTemplate,
  Contact,
  Customer,
  Job,
  Machine,
  Site,
  SystemSettings,
  TechnicalDocument,
  TemplateUsage,
  User,
} from '@/domain';
import type { ActivityFeed } from '@/application/activity-read';
import type { CalendarData } from '@/application/calendar';
import type { ClosedJobFilters, ClosedJobsPage } from '@/application/closed-jobs';
import type { ConversationSummary } from '@/application/chat-operations';
import type { SubmitResult } from '@/application/job-operations';
import type { JobListRow, JobView } from '@/application/job-view';
import type { SearchResult } from '@/application/search';
import type { GeneratedPdf, OutboxEntry } from '@/services/ports';
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
const query = <T>(path: string) => apiGet<T>(path);
const command = <T>(path: string, body: unknown = {}) =>
  apiPost<T>(path, body, newIdempotencyKey());

const search = (params: Record<string, string | undefined>): string => {
  const usable = Object.entries(params).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== '',
  );
  return usable.length === 0 ? '' : `?${new URLSearchParams(usable).toString()}`;
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
}

export interface MachineScreen {
  readonly machine: Machine;
  readonly customer: Customer | null;
  readonly site: Site | null;
  readonly jobRows: readonly JobListRow[];
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
  shell: () => query<{ unreadNotifications: number; unreadMessages: number }>('/api/shell'),
  dashboard: () => query<DashboardScreen>('/api/dashboard'),
  jobs: () => query<{ rows: readonly JobListRow[] }>('/api/jobs'),
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
    }>('/api/library'),
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
    }>('/api/notifications'),
  messages: (conversationId: string | null) =>
    query<MessagesScreen>(
      `/api/conversations${search({ conversationId: conversationId ?? undefined })}`,
    ),
  outbox: () => query<{ entries: readonly OutboxEntry[] }>('/api/outbox'),
};

/* ---- commands ---------------------------------------------------------- */

const jobAction = (jobId: string, action: string, body: unknown = {}) =>
  command<Job>(`/api/jobs/${segment(jobId)}/${action}`, body);

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
  accept: (jobId: string) => jobAction(jobId, 'accept'),
  sendSiteLocation: (jobId: string, recipientMobile?: string) =>
    command<{ sent: boolean; navigationUrl: string; failureReason: string | null }>(
      `/api/jobs/${segment(jobId)}/send_site_location`,
      recipientMobile === undefined ? {} : { recipientMobile },
    ),
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
  removeLine: (jobId: string, kind: 'labour' | 'travel' | 'part', lineId: string) =>
    jobAction(jobId, 'remove_line', { kind, lineId }),
  setCallout: (jobId: string, applied: boolean) => jobAction(jobId, 'set_callout', { applied }),
  addNote: (jobId: string, body: string, internal: boolean) =>
    jobAction(jobId, 'add_note', { body, internal }),
  addMedia: (jobId: string, input: unknown) => jobAction(jobId, 'add_media', input),
  removeMedia: (jobId: string, kind: 'photo' | 'video', attachmentId: string) =>
    jobAction(jobId, 'remove_media', { kind, attachmentId }),
  awaitingSpares: (jobId: string, reason: string) =>
    jobAction(jobId, 'awaiting_spares', { reason }),
  returnToProgress: (jobId: string) => jobAction(jobId, 'return_to_progress'),
  startCompletion: (jobId: string) => jobAction(jobId, 'start_completion'),
  saveReport: (jobId: string, report: unknown) => jobAction(jobId, 'save_report', report),
  startChecklist: (jobId: string) => jobAction(jobId, 'start_checklist'),
  answerChecklist: (jobId: string, input: unknown) => jobAction(jobId, 'answer_checklist', input),
  addChecklistPhoto: (jobId: string, itemId: string, fileName: string) =>
    jobAction(jobId, 'add_checklist_photo', { itemId, fileName }),
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
};

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
};

export const machines = {
  create: (input: unknown) => command<Machine>('/api/machines', input),
  update: (machineId: string, input: unknown) =>
    command<Machine>(`/api/machines/${segment(machineId)}/update`, input),
  approve: (machineId: string) => command<Machine>(`/api/machines/${segment(machineId)}/approve`),
  remove: (machineId: string) =>
    command<RemovalOutcome>(`/api/machines/${segment(machineId)}/remove`),
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
