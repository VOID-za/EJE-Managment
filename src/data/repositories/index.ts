import type {
  ActivityEvent,
  AppNotification,
  ChecklistTemplate,
  ChecklistTemplateId,
  Contact,
  Customer,
  CustomerId,
  Job,
  JobId,
  Machine,
  MachineId,
  NotificationId,
  Site,
  SystemSettings,
  TechnicalDocument,
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
  save(customer: Customer): Promise<Customer>;
}

export interface MachineRepository {
  list(): Promise<readonly Machine[]>;
  findById(id: MachineId): Promise<Machine | null>;
  save(machine: Machine): Promise<Machine>;
}

export interface UserRepository {
  list(): Promise<readonly User[]>;
  findById(id: UserId): Promise<User | null>;
}

export interface DocumentRepository {
  list(): Promise<readonly TechnicalDocument[]>;
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
}

export interface ActivityRepository {
  list(jobId?: JobId): Promise<readonly ActivityEvent[]>;
  append(event: ActivityEvent): Promise<ActivityEvent>;
}

export interface NotificationRepository {
  list(recipientId: UserId): Promise<readonly AppNotification[]>;
  markRead(id: NotificationId): Promise<void>;
  markAllRead(recipientId: UserId): Promise<void>;
  markHandled(id: NotificationId): Promise<void>;
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
}
