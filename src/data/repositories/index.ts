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
  /**
   * Include soft-deleted jobs. Off by default, so every existing caller keeps
   * getting live jobs only and a deleted job cannot leak into a list by
   * someone forgetting to filter. Search and audit pass it explicitly.
   */
  readonly includeDeleted?: boolean;
}

export interface JobRepository {
  list(filter?: JobFilter): Promise<readonly Job[]>;
  findById(id: JobId): Promise<Job | null>;
  findByJobNumber(jobNumber: string): Promise<Job | null>;
  save(job: Job): Promise<Job>;
}

export interface CustomerRepository {
  list(): Promise<readonly Customer[]>;
  findById(id: CustomerId): Promise<Customer | null>;
  listSites(customerId?: CustomerId): Promise<readonly Site[]>;
  listContacts(customerId?: CustomerId): Promise<readonly Contact[]>;
  findSiteById(id: SiteId): Promise<Site | null>;
  findContactById(id: ContactId): Promise<Contact | null>;
  save(customer: Customer): Promise<Customer>;
  saveSite(site: Site): Promise<Site>;
  saveContact(contact: Contact): Promise<Contact>;
}

export interface MachineRepository {
  list(): Promise<readonly Machine[]>;
  findById(id: MachineId): Promise<Machine | null>;
  save(machine: Machine): Promise<Machine>;
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
