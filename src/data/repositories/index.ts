import type {
  ActivityEvent,
  AppNotification,
  CaptureReferral,
  CaptureReferralState,
  ChangeRequest,
  ChangeRequestState,
  ChecklistTemplate,
  ChecklistTemplateId,
  Contact,
  ContactId,
  Customer,
  CustomerId,
  DocumentId,
  DocumentTextIndex,
  OutboxMessage,
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
  JobSummary,
  PricingSnapshot,
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
  /**
   * The same jobs, as a LIST ROW needs them.
   *
   * A list screen renders a job number, a customer, a status — never a part, a
   * labour line or a pricing snapshot. `list` assembles complete aggregates,
   * which is right for a detail screen and ruinous for a table: it reads every
   * child collection of every matching job. `listSummaries` reads the columns a
   * row draws and the crew Decision 5 needs, and stops.
   *
   * A summary carries no price, so the price half of Decision 5 is satisfied by
   * construction rather than by remembering to call `withoutPrices`.
   */
  listSummaries(filter?: JobFilter): Promise<readonly JobSummary[]>;
  /**
   * The immutable pricing snapshots for these jobs.
   *
   * SEPARATE FROM `listSummaries` ON PURPOSE. A summary is structurally
   * price-free, which is what makes it safe to hand to any list without
   * remembering to suppress anything. The closed-job archive is an office
   * screen and legitimately shows what a job was priced at when it was issued,
   * so it asks for the snapshots explicitly — by a call the authorization
   * check upstream has already gated.
   */
  listPricingSnapshots(
    jobIds: readonly JobId[],
  ): Promise<ReadonlyMap<JobId, PricingSnapshot | null>>;
  /**
   * How many jobs match, without reading any of them.
   *
   * The Jobs screen tells the office how much sits in the closed archive. It
   * used to arrive at that number by hydrating every closed job in the
   * business and calling `.length` on the result.
   */
  count(filter?: JobFilter): Promise<number>;
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

  /*
   * THE FULL-TEXT INDEX. MASTER SCOPE LIB-5.
   *
   * Five methods rather than one, because the three things a caller wants are
   * genuinely different reads: what state a revision's text is in (cheap, shown
   * on every library row), which revisions match a query (the search itself,
   * which an index serves), and the text of ONE revision (expensive, read only
   * for the snippets of the rows actually being shown).
   *
   * The state and the text are written together — `saveTextIndex` takes both —
   * because a state that says `indexed` with no text behind it, or text with no
   * state in front of it, is exactly the inconsistency the library must never
   * show. Writing a revision's index REPLACES whatever was there, so a
   * re-extraction cannot leave the old text searchable.
   */
  saveTextIndex(index: DocumentTextIndex, content: string): Promise<DocumentTextIndex>;
  findTextIndex(documentId: DocumentId): Promise<DocumentTextIndex | null>;
  /** Every revision's index state, or just the ones asked for. */
  listTextIndexes(documentIds?: readonly DocumentId[]): Promise<readonly DocumentTextIndex[]>;
  /** The extracted text of one revision, for building snippets. */
  findTextContent(documentId: DocumentId): Promise<string | null>;
  /**
   * The revisions whose text matches EVERY term, most relevant first.
   *
   * `documentIds` is the set the actor may search, decided by the application
   * before this is called: the index is never consulted for a document the
   * caller has not already established this person may see.
   */
  searchTextIds(
    terms: readonly string[],
    documentIds: readonly DocumentId[],
    limit: number,
  ): Promise<readonly DocumentId[]>;
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

/**
 * Messages that must leave the building, and what became of them.
 *
 * THE POINT OF THE INTERFACE is `enqueue` and `claimSendable` being separate
 * calls: the first runs inside the business transaction, the second runs after
 * it has committed. A repository that offered "enqueue and send" would put the
 * network call back where this exists to take it out of.
 */
export interface OutboxRepository {
  /** Records the obligation. Called INSIDE the business transaction. */
  enqueue(message: OutboxMessage): Promise<OutboxMessage>;
  /**
   * The messages still outstanding, oldest first.
   *
   * Reserves them by counting the attempt, so two requests draining at once do
   * not both hand Meta the same message. On PostgreSQL that is a locking
   * update; in memory there is no concurrency to protect against.
   */
  claimSendable(limit: number, now: IsoDateTime): Promise<readonly OutboxMessage[]>;
  /** The provider accepted it, and gave this id. NOT a delivery confirmation. */
  markSent(id: string, providerMessageId: string, now: IsoDateTime): Promise<void>;
  /**
   * An attempt failed.
   *
   * Stays `pending` while attempts remain, so the next drain picks it up; goes
   * `failed` once there is no point trying again.
   */
  markFailed(id: string, reason: string, now: IsoDateTime): Promise<void>;
  /** For the outbox screen and for tests. */
  list(limit?: number): Promise<readonly OutboxMessage[]>;
}

/**
 * Captures a tablet held that the server refused, waiting for the office.
 * BD-15.
 *
 * A small interface on purpose. Nothing here applies a capture or decides
 * anything about a job: the referral is a RECORD that work could not be
 * applied, and applying it later goes through the ordinary job operations with
 * the ordinary rules. This stores, finds and updates that record.
 */
export interface CaptureReferralRepository {
  /** Open referrals first, newest first within each state. For the office. */
  list(filter?: { readonly state?: CaptureReferralState }): Promise<readonly CaptureReferral[]>;
  /** One technician's own referrals, newest first. Their own work. */
  listForTechnician(technicianId: UserId): Promise<readonly CaptureReferral[]>;
  findById(id: string): Promise<CaptureReferral | null>;
  /**
   * The referral for a capture this technician already handed over.
   *
   * What makes referring idempotent: a tablet that refers the same capture
   * twice gets back the referral that already exists rather than creating a
   * second copy of one problem.
   */
  findByCapture(technicianId: UserId, idempotencyKey: string): Promise<CaptureReferral | null>;
  save(referral: CaptureReferral): Promise<CaptureReferral>;
  /**
   * Records the office's decision, and only on a referral still OPEN.
   *
   * Returns null when the referral was already resolved, which is how two
   * office users resolving the same one at once is settled: the second is told
   * it has been dealt with rather than overwriting the first decision. The
   * condition is in the WRITE — a read-then-write check would be a race.
   */
  resolve(referral: CaptureReferral): Promise<CaptureReferral | null>;
}

/** The full set of repositories the application is wired against. */
/**
 * A technician's report that the register is wrong. CUST-CR.
 *
 * Shaped like `CaptureReferralRepository` on purpose: the two are the same
 * workflow — somebody who may not change a thing says it is wrong, and the
 * office decides — so they read the same way, and `resolve` carries the same
 * guarantee.
 */
export interface ChangeRequestRepository {
  /** For the office: open first, oldest first within a state. */
  list(filter?: { readonly state?: ChangeRequestState }): Promise<readonly ChangeRequest[]>;
  /** Everything raised about one customer, including its sites and machines. */
  listForCustomer(customerId: CustomerId): Promise<readonly ChangeRequest[]>;
  /** One person's own reports, newest first. */
  listForRaiser(raisedBy: UserId): Promise<readonly ChangeRequest[]>;
  findById(id: string): Promise<ChangeRequest | null>;
  save(request: ChangeRequest): Promise<ChangeRequest>;
  /**
   * Records the office's decision, and only on a request still OPEN.
   *
   * Returns null when it had already been resolved, which is how two office
   * users resolving the same report at once is settled: the second is told it
   * has been dealt with rather than overwriting the first decision. The
   * condition is in the WRITE, because a read-then-write check is a race.
   */
  resolve(request: ChangeRequest): Promise<ChangeRequest | null>;
}

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
  readonly outbox: OutboxRepository;
  /** Work a tablet held that the server refused. BD-15. */
  readonly captureReferrals: CaptureReferralRepository;
  /** Reports that the register is wrong, raised by people who cannot edit it. */
  readonly changeRequests: ChangeRequestRepository;
}
