import type {
  CustomerDocument,
  CaptureReferral,
  CaptureReferralState,
  ActivityEvent,
  AppNotification,
  AvailabilityRecord,
  ChatMessage,
  ChecklistTemplate,
  ChecklistTemplateId,
  Contact,
  ContactId,
  Conversation,
  Customer,
  CustomerId,
  DocumentId,
  DocumentTextIndex,
  IsoDateTime,
  Job,
  JobId,
  JobSummary,
  PricingSnapshot,
  JobCorrection,
  Machine,
  MachineDocument,
  MachineId,
  NotificationId,
  OutboxMessage,
  Site,
  SiteId,
  SystemSettings,
  TechnicalDocument,
  UnsignedDeliveryAuthorisation,
  User,
  UserId,
  ChangeRequest,
  ChangeRequestState,
} from '@/domain';
import { isOutboxSendable, MAX_OUTBOX_ATTEMPTS } from '@/domain';
import { matchesAllTerms, tokenize } from '@/lib/text-search';
import type {
  ActivityRepository,
  ChecklistTemplateRepository,
  CustomerRepository,
  DocumentRepository,
  JobFilter,
  JobRepository,
  RegisterFilter,
  AvailabilityRepository,
  ChatRepository,
  MachineRepository,
  NotificationRepository,
  OutboxRepository,
  RepositoryBundle,
  SettingsRepository,
  UserRepository,
  CaptureReferralRepository,
  ChangeRequestRepository,
} from '../repositories';
import type { DemoDatabase } from './store';

/**
 * Demo repository implementations.
 *
 * Each one satisfies the same interface the production HTTP client will
 * satisfy. Mutations go through the injected `commit` callback so the React
 * layer can persist and re-render without the repositories knowing about React.
 */

const RECENT_DOCUMENT_LIMIT = 8;

export interface DemoContext {
  read(): DemoDatabase;
  commit(mutate: (draft: DemoDatabase) => void): void;
}

class DemoJobRepository implements JobRepository {
  constructor(private readonly context: DemoContext) {}

  list(filter?: JobFilter): Promise<readonly Job[]> {
    let jobs = this.context.read().jobs;

    if (filter?.statuses !== undefined) {
      const statuses = filter.statuses;
      jobs = jobs.filter((job) => statuses.includes(job.status));
    }
    if (filter?.technicianId !== undefined) {
      const technicianId = filter.technicianId;
      jobs = jobs.filter(
        (job) =>
          job.primaryTechnicianId === technicianId ||
          job.additionalTechnicianIds.includes(technicianId),
      );
    }
    if (filter?.customerId !== undefined) {
      jobs = jobs.filter((job) => job.customerId === filter.customerId);
    }
    if (filter?.machineId !== undefined) {
      jobs = jobs.filter((job) => job.machineId === filter.machineId);
    }

    return Promise.resolve(jobs);
  }

  /** The archive's snapshots, read from the jobs this store already holds. */
  async listPricingSnapshots(
    jobIds: readonly JobId[],
  ): Promise<ReadonlyMap<JobId, PricingSnapshot | null>> {
    const wanted = new Set<string>(jobIds as readonly string[]);
    const found = new Map<JobId, PricingSnapshot | null>();
    for (const job of this.context.read().jobs) {
      if (wanted.has(job.id as string)) found.set(job.id, job.pricingSnapshot);
    }
    return Promise.resolve(found);
  }

  async count(filter?: JobFilter): Promise<number> {
    return (await this.list(filter)).length;
  }

  /**
   * The same jobs, narrowed to what a list row needs.
   *
   * This store already holds whole jobs in memory, so nothing is saved by not
   * reading them — but the narrowing is still done explicitly. A `Job`
   * structurally satisfies `JobSummary`, and returning one unchanged would hand
   * a list screen the parts and the pricing snapshot that the PostgreSQL path
   * deliberately never selects.
   */
  async listSummaries(filter?: JobFilter): Promise<readonly JobSummary[]> {
    const jobs = await this.list(filter);
    return jobs.map((job) => ({
      id: job.id,
      jobNumber: job.jobNumber,
      status: job.status,
      jobType: job.jobType,
      priority: job.priority,
      scheduledDate: job.scheduledDate,
      closedAt: job.closedAt,
      submittedAt: job.submittedAt,
      referenceNumber: job.referenceNumber,
      orderNumber: job.orderNumber,
      faultDescription: job.faultDescription,
      customerId: job.customerId,
      siteId: job.siteId,
      machineId: job.machineId,
      primaryTechnicianId: job.primaryTechnicianId,
      additionalTechnicianIds: job.additionalTechnicianIds,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      scheduledEndDate: job.scheduledEndDate,
      signatureRefusals: job.signatureRefusals,
      finalDocument: job.finalDocument,
    }));
  }

  findById(id: JobId): Promise<Job | null> {
    return Promise.resolve(this.context.read().jobs.find((job) => job.id === id) ?? null);
  }

  findByJobNumber(jobNumber: string): Promise<Job | null> {
    const match = this.context
      .read()
      .jobs.find((job) => job.jobNumber.toLowerCase() === jobNumber.toLowerCase());
    return Promise.resolve(match ?? null);
  }

  /**
   * Stores the job, and records who is on it.
   *
   * The participation is written HERE, with the job, for the same reason the
   * PostgreSQL repository writes it in `recordParticipation`: who is on a job
   * is a fact the operations have already established, and this only makes sure
   * the record of it survives the next reassignment. Append-only — a crew
   * member removed from the job keeps the pair, because the pair is the
   * history.
   */
  save(job: Job): Promise<Job> {
    this.context.commit((draft) => {
      const index = draft.jobs.findIndex((candidate) => candidate.id === job.id);
      if (index === -1) {
        draft.jobs = [job, ...draft.jobs];
      } else {
        draft.jobs = draft.jobs.map((candidate) => (candidate.id === job.id ? job : candidate));
      }

      const crew = [
        ...(job.primaryTechnicianId === null ? [] : [job.primaryTechnicianId as string]),
        ...job.additionalTechnicianIds.map((userId) => userId as string),
      ];
      const added = crew.filter(
        (userId) =>
          !draft.jobParticipation.some(
            (entry) => entry.jobId === (job.id as string) && entry.userId === userId,
          ),
      );
      if (added.length > 0) {
        draft.jobParticipation = [
          ...draft.jobParticipation,
          ...added.map((userId) => ({ jobId: job.id as string, userId })),
        ];
      }
    });
    return Promise.resolve(job);
  }

  /**
   * Removes the job outright.
   *
   * The same contract the PostgreSQL repository satisfies: there is no soft
   * deletion, and the audit event that records the deletion is written by the
   * caller BEFORE this runs, so it outlives the job.
   */
  delete(id: JobId): Promise<void> {
    this.context.commit((draft) => {
      draft.jobs = draft.jobs.filter((candidate) => candidate.id !== id);
    });
    return Promise.resolve();
  }

  /**
   * Every job this person has ever been on, whether or not they still are.
   *
   * Read from the participation history rather than the current assignment,
   * which is the same contract the PostgreSQL repository satisfies from
   * `job_participants`. It used to answer from the crew the job carries NOW,
   * and the difference is not academic: a technician whose job was reassigned
   * lost access to the work they had captured on it, and — once BD-15 gave
   * them somewhere to send a refused capture — could no longer hand the office
   * the hours the reassignment itself had caused the server to refuse.
   */
  listParticipatedJobs(userId: UserId): Promise<readonly Job[]> {
    const data = this.context.read();
    const everOn = new Set(
      data.jobParticipation.filter((entry) => entry.userId === userId).map((entry) => entry.jobId),
    );
    return Promise.resolve(
      data.jobs.filter(
        (job) =>
          everOn.has(job.id as string) ||
          job.primaryTechnicianId === userId ||
          job.additionalTechnicianIds.includes(userId),
      ),
    );
  }

  /* -- corrections to an issued job card. BD-02, IMMUT-9, AUD-3. ---------- */

  listCorrections(jobId: JobId): Promise<readonly JobCorrection[]> {
    const corrections = this.context
      .read()
      .jobCorrections.filter((correction) => correction.jobId === jobId);
    // Oldest first: correction 1, then 2, as the customer holds them.
    return Promise.resolve([...corrections].sort((left, right) => left.sequence - right.sequence));
  }

  findCorrectionById(id: string): Promise<JobCorrection | null> {
    return Promise.resolve(
      this.context.read().jobCorrections.find((correction) => correction.id === id) ?? null,
    );
  }

  /**
   * Inserts, or replaces in place.
   *
   * The demonstration store has no triggers, so the append-only rule lives
   * here only as a convention — the rule itself is `job_corrections_guard` on
   * PostgreSQL, which is why `job-corrections.db.test.ts` exists. The
   * operation never asks for anything else.
   */
  saveCorrection(correction: JobCorrection): Promise<JobCorrection> {
    this.context.commit((draft) => {
      const index = draft.jobCorrections.findIndex((entry) => entry.id === correction.id);
      if (index === -1) draft.jobCorrections.push(correction);
      else draft.jobCorrections[index] = correction;
    });
    return Promise.resolve(correction);
  }

  /* -- the Master's authorisation to send an unsigned job card. BD-06. ---- */

  findUnsignedDeliveryAuthorisation(
    jobId: JobId,
  ): Promise<UnsignedDeliveryAuthorisation | null> {
    return Promise.resolve(
      this.context
        .read()
        .unsignedDeliveryAuthorisations.find((entry) => entry.jobId === jobId) ?? null,
    );
  }

  /** Inserts, and keeps the FIRST one: the table is append-only on PostgreSQL. */
  saveUnsignedDeliveryAuthorisation(
    authorisation: UnsignedDeliveryAuthorisation,
  ): Promise<UnsignedDeliveryAuthorisation> {
    let kept = authorisation;
    this.context.commit((draft) => {
      const existing = draft.unsignedDeliveryAuthorisations.find(
        (entry) => entry.jobId === authorisation.jobId,
      );
      if (existing === undefined) draft.unsignedDeliveryAuthorisations.push(authorisation);
      else kept = existing;
    });
    return Promise.resolve(kept);
  }
}

class DemoCustomerRepository implements CustomerRepository {
  constructor(private readonly context: DemoContext) {}

  list(): Promise<readonly Customer[]> {
    return Promise.resolve(this.context.read().customers);
  }

  findById(id: CustomerId): Promise<Customer | null> {
    return Promise.resolve(
      this.context.read().customers.find((customer) => customer.id === id) ?? null,
    );
  }

  listSites(customerId?: CustomerId, filter?: RegisterFilter): Promise<readonly Site[]> {
    let sites = this.context.read().sites;
    if (filter?.includeArchived !== true) {
      sites = sites.filter((site) => site.archivedAt === null);
    }
    return Promise.resolve(
      customerId === undefined ? sites : sites.filter((site) => site.customerId === customerId),
    );
  }

  listContacts(customerId?: CustomerId, filter?: RegisterFilter): Promise<readonly Contact[]> {
    let contacts = this.context.read().contacts;
    if (filter?.includeArchived !== true) {
      contacts = contacts.filter((contact) => contact.archivedAt === null);
    }
    return Promise.resolve(
      customerId === undefined
        ? contacts
        : contacts.filter((contact) => contact.customerId === customerId),
    );
  }

  deleteSite(id: SiteId): Promise<void> {
    this.context.commit((draft) => {
      draft.sites = draft.sites.filter((site) => site.id !== id);
    });
    return Promise.resolve();
  }

  deleteContact(id: ContactId): Promise<void> {
    this.context.commit((draft) => {
      draft.contacts = draft.contacts.filter((contact) => contact.id !== id);
    });
    return Promise.resolve();
  }

  findSiteById(id: SiteId): Promise<Site | null> {
    return Promise.resolve(this.context.read().sites.find((site) => site.id === id) ?? null);
  }

  /* -- the customer's own files. October mandate §4 ----------------------- */

  listDocuments(
    customerId: CustomerId,
    filter?: { readonly includeArchived?: boolean },
  ): Promise<readonly CustomerDocument[]> {
    const documents = this.context
      .read()
      .customerDocuments.filter((document) => document.customerId === customerId)
      .filter((document) => filter?.includeArchived === true || document.archivedAt === null);
    // Newest first: the office is looking for what was added recently.
    return Promise.resolve(
      [...documents].sort((left, right) => right.uploadedAt.localeCompare(left.uploadedAt)),
    );
  }

  findDocumentById(id: string): Promise<CustomerDocument | null> {
    return Promise.resolve(
      this.context.read().customerDocuments.find((document) => document.id === id) ?? null,
    );
  }

  saveDocument(document: CustomerDocument): Promise<CustomerDocument> {
    this.context.commit((draft) => {
      const index = draft.customerDocuments.findIndex((entry) => entry.id === document.id);
      if (index === -1) draft.customerDocuments.push(document);
      else draft.customerDocuments[index] = document;
    });
    return Promise.resolve(document);
  }

  findContactById(id: ContactId): Promise<Contact | null> {
    return Promise.resolve(
      this.context.read().contacts.find((contact) => contact.id === id) ?? null,
    );
  }

  save(customer: Customer): Promise<Customer> {
    this.context.commit((draft) => {
      const index = draft.customers.findIndex((candidate) => candidate.id === customer.id);
      draft.customers =
        index === -1
          ? [...draft.customers, customer]
          : draft.customers.map((candidate) =>
              candidate.id === customer.id ? customer : candidate,
            );
    });
    return Promise.resolve(customer);
  }

  saveSite(site: Site): Promise<Site> {
    this.context.commit((draft) => {
      const index = draft.sites.findIndex((candidate) => candidate.id === site.id);
      draft.sites =
        index === -1
          ? [...draft.sites, site]
          : draft.sites.map((candidate) => (candidate.id === site.id ? site : candidate));
    });
    return Promise.resolve(site);
  }

  saveContact(contact: Contact): Promise<Contact> {
    this.context.commit((draft) => {
      const index = draft.contacts.findIndex((candidate) => candidate.id === contact.id);
      draft.contacts =
        index === -1
          ? [...draft.contacts, contact]
          : draft.contacts.map((candidate) =>
              candidate.id === contact.id ? contact : candidate,
            );
    });
    return Promise.resolve(contact);
  }
}

class DemoMachineRepository implements MachineRepository {
  constructor(private readonly context: DemoContext) {}

  list(filter?: RegisterFilter): Promise<readonly Machine[]> {
    const machines = this.context.read().machines;
    return Promise.resolve(
      filter?.includeArchived === true
        ? machines
        : machines.filter((machine) => machine.archivedAt === null),
    );
  }

  findById(id: MachineId): Promise<Machine | null> {
    return Promise.resolve(
      this.context.read().machines.find((machine) => machine.id === id) ?? null,
    );
  }

  save(machine: Machine): Promise<Machine> {
    this.context.commit((draft) => {
      const index = draft.machines.findIndex((candidate) => candidate.id === machine.id);
      draft.machines =
        index === -1
          ? [...draft.machines, machine]
          : draft.machines.map((candidate) => (candidate.id === machine.id ? machine : candidate));
    });
    return Promise.resolve(machine);
  }

  delete(id: MachineId): Promise<void> {
    this.context.commit((draft) => {
      draft.machines = draft.machines.filter((machine) => machine.id !== id);
      // Its paperwork goes with it, which is what the PostgreSQL cascade does.
      draft.machineDocuments = draft.machineDocuments.filter(
        (document) => document.machineId !== id,
      );
    });
    return Promise.resolve();
  }

  /* -- paper about one machine. October mandate §4. ----------------------- */

  listDocuments(
    machineId: MachineId,
    filter?: { readonly includeArchived?: boolean },
  ): Promise<readonly MachineDocument[]> {
    const documents = this.context
      .read()
      .machineDocuments.filter((document) => document.machineId === machineId)
      .filter((document) => filter?.includeArchived === true || document.archivedAt === null);
    // Newest first: the office is looking for what was added recently.
    return Promise.resolve(
      [...documents].sort((left, right) => right.uploadedAt.localeCompare(left.uploadedAt)),
    );
  }

  findDocumentById(id: string): Promise<MachineDocument | null> {
    return Promise.resolve(
      this.context.read().machineDocuments.find((document) => document.id === id) ?? null,
    );
  }

  saveDocument(document: MachineDocument): Promise<MachineDocument> {
    this.context.commit((draft) => {
      const index = draft.machineDocuments.findIndex((entry) => entry.id === document.id);
      if (index === -1) draft.machineDocuments.push(document);
      else draft.machineDocuments[index] = document;
    });
    return Promise.resolve(document);
  }
}

class DemoUserRepository implements UserRepository {
  constructor(private readonly context: DemoContext) {}

  list(): Promise<readonly User[]> {
    return Promise.resolve(this.context.read().users);
  }

  findById(id: UserId): Promise<User | null> {
    return Promise.resolve(this.context.read().users.find((user) => user.id === id) ?? null);
  }

  save(user: User): Promise<User> {
    this.context.commit((draft) => {
      const index = draft.users.findIndex((candidate) => candidate.id === user.id);
      // Disabling is an update, never a delete: historical jobs and the audit
      // trail keep naming the person who did the work.
      draft.users =
        index === -1
          ? [...draft.users, user]
          : draft.users.map((candidate) => (candidate.id === user.id ? user : candidate));
    });
    return Promise.resolve(user);
  }
}

class DemoDocumentRepository implements DocumentRepository {
  constructor(private readonly context: DemoContext) {}

  list(): Promise<readonly TechnicalDocument[]> {
    return Promise.resolve(this.context.read().documents);
  }

  findById(id: DocumentId): Promise<TechnicalDocument | null> {
    return Promise.resolve(
      this.context.read().documents.find((document) => document.id === id) ?? null,
    );
  }

  save(document: TechnicalDocument): Promise<TechnicalDocument> {
    this.context.commit((draft) => {
      const index = draft.documents.findIndex((candidate) => candidate.id === document.id);
      draft.documents =
        index === -1
          ? [document, ...draft.documents]
          : draft.documents.map((candidate) =>
              candidate.id === document.id ? document : candidate,
            );
    });
    return Promise.resolve(document);
  }

  listFavourites(userId: UserId): Promise<readonly string[]> {
    return Promise.resolve(this.context.read().favouriteDocuments[userId] ?? []);
  }

  toggleFavourite(userId: UserId, documentId: string): Promise<readonly string[]> {
    let next: string[] = [];
    this.context.commit((draft) => {
      const current = draft.favouriteDocuments[userId] ?? [];
      next = current.includes(documentId)
        ? current.filter((id) => id !== documentId)
        : [documentId, ...current];
      draft.favouriteDocuments = { ...draft.favouriteDocuments, [userId]: next };
    });
    return Promise.resolve(next);
  }

  listRecentlyViewed(userId: UserId): Promise<readonly string[]> {
    return Promise.resolve(this.context.read().recentDocuments[userId] ?? []);
  }

  recordView(userId: UserId, documentId: string): Promise<void> {
    this.context.commit((draft) => {
      const current = draft.recentDocuments[userId] ?? [];
      const next = [documentId, ...current.filter((id) => id !== documentId)].slice(
        0,
        RECENT_DOCUMENT_LIMIT,
      );
      draft.recentDocuments = { ...draft.recentDocuments, [userId]: next };
    });
    return Promise.resolve();
  }

  /* ---------------------------------------------------------------------- */
  /* The full-text index. MASTER SCOPE LIB-5.                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Writes a revision's index, REPLACING whatever was there.
   *
   * Replacing rather than appending is the whole protection against stale
   * searchable text: a document re-extracted after a better copy was uploaded
   * must not still match on the words of the copy it replaced.
   */
  saveTextIndex(index: DocumentTextIndex, content: string): Promise<DocumentTextIndex> {
    this.context.commit((draft) => {
      const kept = draft.documentText.filter((entry) => entry.index.documentId !== index.documentId);
      // The text is kept only where the state says there IS text.
      draft.documentText = [
        { index, content: index.state === 'indexed' ? content : '' },
        ...kept,
      ];
    });
    return Promise.resolve(index);
  }

  findTextIndex(documentId: DocumentId): Promise<DocumentTextIndex | null> {
    const entry = this.context
      .read()
      .documentText.find((candidate) => candidate.index.documentId === documentId);
    return Promise.resolve(entry?.index ?? null);
  }

  listTextIndexes(documentIds?: readonly DocumentId[]): Promise<readonly DocumentTextIndex[]> {
    const wanted = documentIds === undefined ? null : new Set(documentIds);
    return Promise.resolve(
      this.context
        .read()
        .documentText.filter((entry) => wanted === null || wanted.has(entry.index.documentId))
        .map((entry) => entry.index),
    );
  }

  findTextContent(documentId: DocumentId): Promise<string | null> {
    const entry = this.context
      .read()
      .documentText.find((candidate) => candidate.index.documentId === documentId);
    return Promise.resolve(entry === undefined ? null : entry.content);
  }

  /**
   * The matching revisions, by the rule in `text-search.ts`.
   *
   * The same rule the PostgreSQL adapter's `tsvector` applies — whole words,
   * no stemming — so a search finds the same manuals on a sales laptop as it
   * does in production. Ordered by how many times the terms occur, which is as
   * much ranking as a demonstration store can honestly offer.
   */
  searchTextIds(
    terms: readonly string[],
    documentIds: readonly DocumentId[],
    limit: number,
  ): Promise<readonly DocumentId[]> {
    if (terms.length === 0 || documentIds.length === 0) return Promise.resolve([]);
    const allowed = new Set(documentIds);

    const scored = this.context
      .read()
      .documentText.filter(
        (entry) =>
          allowed.has(entry.index.documentId) &&
          entry.index.state === 'indexed' &&
          matchesAllTerms(entry.content, terms),
      )
      .map((entry) => {
        const words = tokenize(entry.content);
        const hits = words.filter((word) => terms.includes(word)).length;
        return { documentId: entry.index.documentId, hits };
      })
      .sort((a, b) => b.hits - a.hits);

    return Promise.resolve(scored.slice(0, limit).map((entry) => entry.documentId));
  }
}

class DemoChecklistTemplateRepository implements ChecklistTemplateRepository {
  constructor(private readonly context: DemoContext) {}

  list(): Promise<readonly ChecklistTemplate[]> {
    return Promise.resolve(this.context.read().checklistTemplates);
  }

  findForJobType(jobTypeCode: string): Promise<ChecklistTemplate | null> {
    const match = this.context
      .read()
      .checklistTemplates.find(
        (template) => template.jobTypeCode === jobTypeCode && template.status === 'current',
      );
    return Promise.resolve(match ?? null);
  }

  findByVersion(
    templateId: ChecklistTemplateId,
    version: string,
  ): Promise<ChecklistTemplate | null> {
    // Resolves by stored version, so a job completed against v1.0 keeps
    // rendering v1.0 even after v2.0 becomes current.
    const match = this.context
      .read()
      .checklistTemplates.find(
        (template) => template.id === templateId && template.version === version,
      );
    return Promise.resolve(match ?? null);
  }

  save(template: ChecklistTemplate): Promise<ChecklistTemplate> {
    this.context.commit((draft) => {
      const index = draft.checklistTemplates.findIndex(
        (candidate) => candidate.id === template.id && candidate.version === template.version,
      );
      draft.checklistTemplates =
        index === -1
          ? [...draft.checklistTemplates, template]
          : draft.checklistTemplates.map((candidate, position) =>
              position === index ? template : candidate,
            );
    });
    return Promise.resolve(template);
  }
}

class DemoActivityRepository implements ActivityRepository {
  constructor(private readonly context: DemoContext) {}

  list(jobId?: JobId): Promise<readonly ActivityEvent[]> {
    const events = this.context.read().activity;
    const filtered = jobId === undefined ? events : events.filter((event) => event.jobId === jobId);
    return Promise.resolve(
      [...filtered].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)),
    );
  }

  append(event: ActivityEvent): Promise<ActivityEvent> {
    this.context.commit((draft) => {
      draft.activity = [event, ...draft.activity];
    });
    return Promise.resolve(event);
  }
}

/**
 * The outbox, in the demonstration snapshot.
 *
 * Same contract as PostgreSQL's, same two-phase shape: `enqueue` during the
 * business change, `claimSendable` after it. There is no transaction here and
 * no concurrency to protect against, so claiming is just a read that counts the
 * attempt — but the SEQUENCE the callers follow is identical, which is what
 * keeps the demonstration an honest rehearsal of the real thing.
 */
class DemoOutboxRepository implements OutboxRepository {
  constructor(private readonly context: DemoContext) {}

  enqueue(message: OutboxMessage): Promise<OutboxMessage> {
    this.context.commit((draft) => {
      draft.outbox = [...draft.outbox, message];
    });
    return Promise.resolve(message);
  }

  claimSendable(limit: number, now: IsoDateTime): Promise<readonly OutboxMessage[]> {
    const claimed = this.context
      .read()
      .outbox.filter(isOutboxSendable)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit)
      .map((message) => ({ ...message, attempts: message.attempts + 1, lastAttemptAt: now }));

    const ids = new Set(claimed.map((message) => message.id));
    this.context.commit((draft) => {
      draft.outbox = draft.outbox.map(
        (message) => claimed.find((entry) => entry.id === message.id) ?? message,
      );
    });
    return Promise.resolve(claimed.filter((message) => ids.has(message.id)));
  }

  markSent(id: string, providerMessageId: string, now: IsoDateTime): Promise<void> {
    this.context.commit((draft) => {
      draft.outbox = draft.outbox.map((message) =>
        message.id === id
          ? { ...message, state: 'sent', providerMessageId, failureReason: '', lastAttemptAt: now }
          : message,
      );
    });
    return Promise.resolve();
  }

  markFailed(id: string, reason: string, now: IsoDateTime): Promise<void> {
    this.context.commit((draft) => {
      draft.outbox = draft.outbox.map((message) =>
        message.id === id
          ? {
              ...message,
              // Still pending while there are attempts left: a failure is not
              // the end of an obligation, only of one try at it.
              state: message.attempts >= MAX_OUTBOX_ATTEMPTS ? 'failed' : 'pending',
              failureReason: reason,
              lastAttemptAt: now,
            }
          : message,
      );
    });
    return Promise.resolve();
  }

  list(limit = 100): Promise<readonly OutboxMessage[]> {
    return Promise.resolve(
      [...this.context.read().outbox]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit),
    );
  }
}

class DemoNotificationRepository implements NotificationRepository {
  constructor(private readonly context: DemoContext) {}

  list(recipientId: UserId): Promise<readonly AppNotification[]> {
    const notifications = this.context
      .read()
      .notifications.filter((notification) => notification.recipientId === recipientId);
    return Promise.resolve(
      [...notifications].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    );
  }

  create(notification: AppNotification): Promise<AppNotification> {
    this.context.commit((draft) => {
      draft.notifications = [notification, ...draft.notifications];
    });
    return Promise.resolve(notification);
  }

  markRead(id: NotificationId): Promise<void> {
    const now = new Date().toISOString();
    this.context.commit((draft) => {
      draft.notifications = draft.notifications.map((notification) =>
        notification.id === id && notification.readAt === null
          ? { ...notification, readAt: now }
          : notification,
      );
    });
    return Promise.resolve();
  }

  markAllRead(recipientId: UserId): Promise<void> {
    const now = new Date().toISOString();
    this.context.commit((draft) => {
      draft.notifications = draft.notifications.map((notification) =>
        notification.recipientId === recipientId && notification.readAt === null
          ? { ...notification, readAt: now }
          : notification,
      );
    });
    return Promise.resolve();
  }

  markHandled(id: NotificationId): Promise<void> {
    const now = new Date().toISOString();
    this.context.commit((draft) => {
      draft.notifications = draft.notifications.map((notification) =>
        notification.id === id
          ? { ...notification, handledAt: now, readAt: notification.readAt ?? now }
          : notification,
      );
    });
    return Promise.resolve();
  }
}

class DemoAvailabilityRepository implements AvailabilityRepository {
  constructor(private readonly context: DemoContext) {}

  list(from?: string, to?: string): Promise<readonly AvailabilityRecord[]> {
    const records = this.context.read().availability;
    // Overlap, not containment: a block that starts before the window and ends
    // inside it still affects the window.
    const filtered =
      from === undefined || to === undefined
        ? records
        : records.filter((record) => record.startDate <= to && record.endDate >= from);

    return Promise.resolve(
      [...filtered].sort((a, b) => a.startDate.localeCompare(b.startDate)),
    );
  }

  listForUser(userId: UserId): Promise<readonly AvailabilityRecord[]> {
    return Promise.resolve(
      [...this.context.read().availability.filter((record) => record.userId === userId)].sort(
        (a, b) => a.startDate.localeCompare(b.startDate),
      ),
    );
  }

  findById(id: string): Promise<AvailabilityRecord | null> {
    return Promise.resolve(
      this.context.read().availability.find((record) => record.id === id) ?? null,
    );
  }

  save(record: AvailabilityRecord): Promise<AvailabilityRecord> {
    this.context.commit((draft) => {
      const index = draft.availability.findIndex((candidate) => candidate.id === record.id);
      // Cancelling goes through here too, as a status change: a removed record
      // could not be audited or shown as history.
      draft.availability =
        index === -1
          ? [...draft.availability, record]
          : draft.availability.map((candidate) =>
              candidate.id === record.id ? record : candidate,
            );
    });
    return Promise.resolve(record);
  }
}

class DemoChatRepository implements ChatRepository {
  constructor(private readonly context: DemoContext) {}

  listConversations(userId: UserId): Promise<readonly Conversation[]> {
    const mine = this.context
      .read()
      .conversations.filter((conversation) => conversation.participantIds.includes(userId));
    return Promise.resolve(
      [...mine].sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt)),
    );
  }

  findConversation(id: string): Promise<Conversation | null> {
    return Promise.resolve(
      this.context.read().conversations.find((conversation) => conversation.id === id) ?? null,
    );
  }

  saveConversation(conversation: Conversation): Promise<Conversation> {
    this.context.commit((draft) => {
      const index = draft.conversations.findIndex(
        (candidate) => candidate.id === conversation.id,
      );
      draft.conversations =
        index === -1
          ? [conversation, ...draft.conversations]
          : draft.conversations.map((candidate) =>
              candidate.id === conversation.id ? conversation : candidate,
            );
    });
    return Promise.resolve(conversation);
  }

  listMessages(conversationId: string): Promise<readonly ChatMessage[]> {
    const messages = this.context
      .read()
      .chatMessages.filter((message) => message.conversationId === conversationId);
    // Oldest first: a conversation reads downwards.
    return Promise.resolve([...messages].sort((a, b) => a.sentAt.localeCompare(b.sentAt)));
  }

  listMessagesFor(userId: UserId): Promise<readonly ChatMessage[]> {
    const database = this.context.read();
    const mine = new Set(
      database.conversations
        .filter((conversation) => conversation.participantIds.includes(userId))
        .map((conversation) => conversation.id),
    );
    return Promise.resolve(
      database.chatMessages.filter((message) => mine.has(message.conversationId)),
    );
  }

  findMessage(id: string): Promise<ChatMessage | null> {
    return Promise.resolve(
      this.context.read().chatMessages.find((message) => message.id === id) ?? null,
    );
  }

  saveMessage(message: ChatMessage): Promise<ChatMessage> {
    this.context.commit((draft) => {
      const index = draft.chatMessages.findIndex((candidate) => candidate.id === message.id);
      draft.chatMessages =
        index === -1
          ? [...draft.chatMessages, message]
          : draft.chatMessages.map((candidate) =>
              candidate.id === message.id ? message : candidate,
            );
    });
    return Promise.resolve(message);
  }
}

class DemoSettingsRepository implements SettingsRepository {
  constructor(private readonly context: DemoContext) {}

  get(): Promise<SystemSettings> {
    return Promise.resolve(this.context.read().settings);
  }

  save(settings: SystemSettings): Promise<SystemSettings> {
    this.context.commit((draft) => {
      draft.settings = settings;
    });
    return Promise.resolve(settings);
  }
}

/**
 * Referred captures, in the demonstration snapshot. BD-15.
 *
 * Same contract as PostgreSQL's, including the two rules that matter: a second
 * referral of the same capture updates the one that exists rather than adding
 * another, and `resolve` only ever acts on a referral that is still open — so a
 * demonstration behaves the way the real thing does when two people reach for
 * the same one.
 */
class DemoCaptureReferralRepository implements CaptureReferralRepository {
  constructor(private readonly context: DemoContext) {}

  list(filter: { readonly state?: CaptureReferralState } = {}): Promise<
    readonly CaptureReferral[]
  > {
    const all = this.context.read().captureReferrals;
    const matching =
      filter.state === undefined ? all : all.filter((entry) => entry.state === filter.state);
    // Open first — that is what the office acts on — then newest first.
    return Promise.resolve(
      [...matching].sort((left, right) =>
        left.state === right.state
          ? right.referredAt.localeCompare(left.referredAt)
          : left.state === 'open'
            ? -1
            : 1,
      ),
    );
  }

  listForTechnician(technicianId: UserId): Promise<readonly CaptureReferral[]> {
    return Promise.resolve(
      this.context
        .read()
        .captureReferrals.filter((entry) => entry.technicianId === technicianId)
        .sort((left, right) => right.referredAt.localeCompare(left.referredAt)),
    );
  }

  findById(id: string): Promise<CaptureReferral | null> {
    return Promise.resolve(
      this.context.read().captureReferrals.find((entry) => entry.id === id) ?? null,
    );
  }

  findByCapture(technicianId: UserId, idempotencyKey: string): Promise<CaptureReferral | null> {
    return Promise.resolve(
      this.context
        .read()
        .captureReferrals.find(
          (entry) =>
            entry.technicianId === technicianId && entry.idempotencyKey === idempotencyKey,
        ) ?? null,
    );
  }

  save(referral: CaptureReferral): Promise<CaptureReferral> {
    const existing = this.context
      .read()
      .captureReferrals.find(
        (entry) =>
          entry.technicianId === referral.technicianId &&
          entry.idempotencyKey === referral.idempotencyKey,
      );

    // Already dealt with: the office's decision stands, and a tablet that never
    // heard the answer cannot rewrite it.
    if (existing !== undefined && existing.state === 'resolved') return Promise.resolve(existing);

    if (existing !== undefined) {
      const updated: CaptureReferral = {
        ...existing,
        refusalCode: referral.refusalCode,
        refusalMessage: referral.refusalMessage,
        summary: referral.summary,
      };
      this.context.commit((draft) => {
        draft.captureReferrals = draft.captureReferrals.map((entry) =>
          entry.id === existing.id ? updated : entry,
        );
      });
      return Promise.resolve(updated);
    }

    this.context.commit((draft) => {
      draft.captureReferrals = [...draft.captureReferrals, referral];
    });
    return Promise.resolve(referral);
  }

  resolve(referral: CaptureReferral): Promise<CaptureReferral | null> {
    const stored = this.context.read().captureReferrals.find((entry) => entry.id === referral.id);
    if (stored === undefined || stored.state !== 'open') return Promise.resolve(null);

    const resolved: CaptureReferral = {
      ...stored,
      state: 'resolved',
      resolvedBy: referral.resolvedBy,
      resolvedAt: referral.resolvedAt,
      resolution: referral.resolution,
      resolutionNote: referral.resolutionNote,
    };
    this.context.commit((draft) => {
      draft.captureReferrals = draft.captureReferrals.map((entry) =>
        entry.id === resolved.id ? resolved : entry,
      );
    });
    return Promise.resolve(resolved);
  }
}

/**
 * Reports that the register is wrong. CUST-CR.
 *
 * The same shape as the referral repository above, because it is the same
 * workflow: somebody who may not change a record says it is wrong, and the
 * office decides. `resolve` carries the same guarantee — only an OPEN request
 * can be resolved, so two office users deciding at once cannot overwrite each
 * other's note.
 */
class DemoChangeRequestRepository implements ChangeRequestRepository {
  constructor(private readonly context: DemoContext) {}

  private all(): readonly ChangeRequest[] {
    return this.context.read().changeRequests;
  }

  list(filter: { readonly state?: ChangeRequestState } = {}): Promise<readonly ChangeRequest[]> {
    const matching =
      filter.state === undefined
        ? this.all()
        : this.all().filter((entry) => entry.state === filter.state);
    // Open first — that is what the office acts on — then oldest first, because
    // the longest-waiting report is the one somebody should look at next.
    return Promise.resolve(
      [...matching].sort((left, right) =>
        left.state === right.state
          ? left.raisedAt.localeCompare(right.raisedAt)
          : left.state === 'open'
            ? -1
            : 1,
      ),
    );
  }

  listForCustomer(customerId: CustomerId): Promise<readonly ChangeRequest[]> {
    return Promise.resolve(
      this.all()
        .filter((entry) => entry.customerId === customerId)
        .sort((left, right) => right.raisedAt.localeCompare(left.raisedAt)),
    );
  }

  listForRaiser(raisedBy: UserId): Promise<readonly ChangeRequest[]> {
    return Promise.resolve(
      this.all()
        .filter((entry) => entry.raisedBy === raisedBy)
        .sort((left, right) => right.raisedAt.localeCompare(left.raisedAt)),
    );
  }

  findById(id: string): Promise<ChangeRequest | null> {
    return Promise.resolve(this.all().find((entry) => entry.id === id) ?? null);
  }

  save(request: ChangeRequest): Promise<ChangeRequest> {
    this.context.commit((draft) => {
      draft.changeRequests = [...draft.changeRequests, request];
    });
    return Promise.resolve(request);
  }

  resolve(request: ChangeRequest): Promise<ChangeRequest | null> {
    const stored = this.all().find((entry) => entry.id === request.id);
    if (stored === undefined || stored.state !== 'open') return Promise.resolve(null);

    const resolved: ChangeRequest = {
      ...stored,
      state: request.state,
      resolvedBy: request.resolvedBy,
      resolvedAt: request.resolvedAt,
      resolutionNote: request.resolutionNote,
    };
    this.context.commit((draft) => {
      draft.changeRequests = draft.changeRequests.map((entry) =>
        entry.id === resolved.id ? resolved : entry,
      );
    });
    return Promise.resolve(resolved);
  }
}

export const createDemoRepositories = (context: DemoContext): RepositoryBundle => ({
  jobs: new DemoJobRepository(context),
  customers: new DemoCustomerRepository(context),
  machines: new DemoMachineRepository(context),
  users: new DemoUserRepository(context),
  documents: new DemoDocumentRepository(context),
  checklistTemplates: new DemoChecklistTemplateRepository(context),
  activity: new DemoActivityRepository(context),
  outbox: new DemoOutboxRepository(context),
  captureReferrals: new DemoCaptureReferralRepository(context),
  changeRequests: new DemoChangeRequestRepository(context),
  notifications: new DemoNotificationRepository(context),
  settings: new DemoSettingsRepository(context),
  availability: new DemoAvailabilityRepository(context),
  chat: new DemoChatRepository(context),
});
