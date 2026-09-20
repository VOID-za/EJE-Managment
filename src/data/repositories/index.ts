import type {
  ActivityEvent,
  AppNotification,
  ChecklistTemplate,
  ChecklistTemplateId,
  Contact,
  ContactId,
  Customer,
  CustomerId,
  DocumentId,
  IsoDateTime,
  Job,
  JobId,
  AvailabilityRecord,
  Machine,
  MachineId,
  NotificationId,
  Site,
  SiteId,
  SystemSettings,
  TechnicalDocument,
  TransferReason,
  ChatMessage,
  Conversation,
  User,
  UserId,
} from '@/domain';

/**
 * Repository interfaces.
 *
 * Every method is asynchronous and speaks only in domain types. The demo binds
 * these to a browser-persisted store; Phase 2 binds them to HTTP clients
 * calling the Node/Drizzle REST API. Nothing above this layer knows which.
 */

export interface JobFilter {
  readonly statuses?: readonly Job['status'][];
  readonly technicianId?: UserId;
  readonly customerId?: CustomerId;
  readonly machineId?: MachineId;
}

/**
 * A handover, as a record rather than as prose.
 *
 * The reason and the description are captured by `returnJobToOpen` and
 * `transferJobToTechnician` and would otherwise survive only inside an audit
 * event's sentence. "How often does a job move because the vehicle broke down?"
 * is a question the business will ask, and it cannot be answered by reading
 * paragraphs.
 *
 * APPEND-ONLY. Nothing amends or removes a transfer; a handover that turned out
 * to be a mistake is corrected by transferring the job back, which is another
 * record.
 */
export interface JobTransferRecord {
  readonly jobId: JobId;
  /** Null when the job was in the office's hands rather than a technician's. */
  readonly fromUserId: UserId | null;
  /** Null when the job went back to the open pool rather than to a person. */
  readonly toUserId: UserId | null;
  readonly reason: TransferReason;
  readonly description: string;
  readonly transferredBy: UserId;
  readonly transferredAt: IsoDateTime;
}

export interface JobRepository {
  list(filter?: JobFilter): Promise<readonly Job[]>;
  findById(id: JobId): Promise<Job | null>;
  findByJobNumber(jobNumber: string): Promise<Job | null>;
  save(job: Job): Promise<Job>;
  /**
   * Allocates the next job number.
   *
   * Optional because the browser demo has no concurrency to protect against and
   * allocates from its settings snapshot. A production implementation MUST make
   * this atomic — a PostgreSQL sequence — because two people raising a job in
   * the same moment must not be handed the same number, and
   * `max(job_number) + 1` cannot promise that.
   *
   * Returns the display number and the numeric value behind it.
   */
  allocateJobNumber?(): Promise<{ readonly jobNumber: string; readonly sequence: number }>;
  /**
   * Removes a job and its children outright.
   *
   * There is no soft deletion. The caller must already have written the audit
   * event that records who deleted it and why — that event outlives the job,
   * which is why `audit_events.job_id` is deliberately not a foreign key.
   *
   * NOT a general-purpose method: the workflow permits deletion only for a job
   * nobody has accepted, and that rule stays in the application layer
   * (`deleteJobRefusal`), never here.
   */
  delete(id: JobId): Promise<void>;
  /**
   * Every job this person has ever been on, whether or not they still are.
   *
   * What the technician visibility rule is read from. It cannot be derived from
   * the current assignment, because a reassignment is exactly what destroys
   * that — a technician who captured half a job on Tuesday must not lose access
   * to their own work on Wednesday.
   */
  listParticipatedJobs(userId: UserId): Promise<readonly Job[]>;
  /**
   * Records a handover.
   *
   * Optional for the same reason `allocateJobNumber` is: the browser demo keeps
   * the handover as the audit event it writes alongside, which is all its store
   * has. A production implementation writes the structured record, and the
   * operations call this in addition to — never instead of — auditing it.
   */
  recordTransfer?(entry: JobTransferRecord): Promise<void>;
}

/**
 * Whether a list should include records removed from the live register.
 *
 * Archived sites, contacts and machines are still referenced by the jobs that
 * were done against them, so they are never gone — they are simply not offered
 * again. Lists leave them out by default so an archived record cannot reappear
 * in a picker because a caller forgot to filter; the `findById` methods always
 * resolve them, which is what keeps a historical job card readable.
 */
export interface RegisterFilter {
  readonly includeArchived?: boolean;
}

export interface CustomerRepository {
  list(): Promise<readonly Customer[]>;
  findById(id: CustomerId): Promise<Customer | null>;
  listSites(customerId?: CustomerId, filter?: RegisterFilter): Promise<readonly Site[]>;
  listContacts(customerId?: CustomerId, filter?: RegisterFilter): Promise<readonly Contact[]>;
  findSiteById(id: SiteId): Promise<Site | null>;
  findContactById(id: ContactId): Promise<Contact | null>;
  save(customer: Customer): Promise<Customer>;
  saveSite(site: Site): Promise<Site>;
  saveContact(contact: Contact): Promise<Contact>;
  /**
   * Removes the record outright.
   *
   * Only ever called for a record nothing refers to — the application layer
   * establishes that first and archives instead when anything does. Production
   * gets the same treatment: a hard DELETE, guarded by the same check, so a
   * foreign key can never be left dangling.
   */
  deleteSite(id: SiteId): Promise<void>;
  deleteContact(id: ContactId): Promise<void>;
}

export interface MachineRepository {
  list(filter?: RegisterFilter): Promise<readonly Machine[]>;
  findById(id: MachineId): Promise<Machine | null>;
  save(machine: Machine): Promise<Machine>;
  /** See `CustomerRepository.deleteSite`. */
  delete(id: MachineId): Promise<void>;
}

export interface UserRepository {
  /**
   * Every user, disabled ones included. Callers that want only the people
   * currently working at EJE filter with `activeUsers`; a disabled user is
   * never removed, so historical jobs keep naming the technician who did them.
   */
  list(): Promise<readonly User[]>;
  findById(id: UserId): Promise<User | null>;
  save(user: User): Promise<User>;
}

export interface DocumentRepository {
  list(): Promise<readonly TechnicalDocument[]>;
  findById(id: DocumentId): Promise<TechnicalDocument | null>;
  save(document: TechnicalDocument): Promise<TechnicalDocument>;
  listFavourites(userId: UserId): Promise<readonly string[]>;
  toggleFavourite(userId: UserId, documentId: string): Promise<readonly string[]>;
  listRecentlyViewed(userId: UserId): Promise<readonly string[]>;
  recordView(userId: UserId, documentId: string): Promise<void>;
}

export interface ChecklistTemplateRepository {
  list(): Promise<readonly ChecklistTemplate[]>;
  /** The template a NEW job of this type must complete: the current version. */
  findForJobType(jobTypeCode: string): Promise<ChecklistTemplate | null>;
  /**
   * The exact version recorded against a completed checklist.
   *
   * A historical job card must render the wording the customer actually saw, so
   * the read path resolves by stored version rather than by job type. Returns
   * null when that version is no longer held, which callers must handle rather
   * than silently falling back to the current wording.
   */
  findByVersion(
    templateId: ChecklistTemplateId,
    version: string,
  ): Promise<ChecklistTemplate | null>;
  /**
   * Adds or replaces a template version.
   *
   * Callers must never rewrite a version a job has already completed against —
   * `checklist-admin` enforces that, and the demo store keeps every version so a
   * historical job card still renders the wording the customer actually saw.
   */
  save(template: ChecklistTemplate): Promise<ChecklistTemplate>;
}

export interface ActivityRepository {
  list(jobId?: JobId): Promise<readonly ActivityEvent[]>;
  append(event: ActivityEvent): Promise<ActivityEvent>;
}

export interface NotificationRepository {
  list(recipientId: UserId): Promise<readonly AppNotification[]>;
  create(notification: AppNotification): Promise<AppNotification>;
  markRead(id: NotificationId): Promise<void>;
  markAllRead(recipientId: UserId): Promise<void>;
  markHandled(id: NotificationId): Promise<void>;
}

export interface AvailabilityRepository {
  /** Every availability record overlapping the given inclusive range. */
  list(from?: string, to?: string): Promise<readonly AvailabilityRecord[]>;
  listForUser(userId: UserId): Promise<readonly AvailabilityRecord[]>;
  findById(id: string): Promise<AvailabilityRecord | null>;
  /**
   * Adds or replaces a record.
   *
   * Cancelling is a status change through this method, never a removal: the
   * audit trail has to be able to say what was cancelled, by whom and when.
   */
  save(record: AvailabilityRecord): Promise<AvailabilityRecord>;
}

export interface ChatRepository {
  /** Conversations this user participates in, most recent activity first. */
  listConversations(userId: UserId): Promise<readonly Conversation[]>;
  findConversation(id: string): Promise<Conversation | null>;
  saveConversation(conversation: Conversation): Promise<Conversation>;
  /** Messages in one thread, oldest first — a conversation reads downwards. */
  listMessages(conversationId: string): Promise<readonly ChatMessage[]>;
  /**
   * Every message in every thread this user participates in.
   *
   * Backs the unread count, which has to span conversations. Unpaginated, like
   * the rest of the demo repositories; Phase 2 serves the count from the API.
   */
  listMessagesFor(userId: UserId): Promise<readonly ChatMessage[]>;
  findMessage(id: string): Promise<ChatMessage | null>;
  saveMessage(message: ChatMessage): Promise<ChatMessage>;
}

export interface SettingsRepository {
  get(): Promise<SystemSettings>;
  save(settings: SystemSettings): Promise<SystemSettings>;
}

/** The full set of repositories the application is wired against. */
export interface RepositoryBundle {
  readonly jobs: JobRepository;
  readonly customers: CustomerRepository;
  readonly machines: MachineRepository;
  readonly users: UserRepository;
  readonly documents: DocumentRepository;
  readonly checklistTemplates: ChecklistTemplateRepository;
  readonly activity: ActivityRepository;
  readonly notifications: NotificationRepository;
  readonly settings: SettingsRepository;
  readonly availability: AvailabilityRepository;
  readonly chat: ChatRepository;
}
