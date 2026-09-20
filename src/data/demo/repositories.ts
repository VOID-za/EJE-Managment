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
  RepositoryBundle,
  SettingsRepository,
  UserRepository,
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

  findById(id: JobId): Promise<Job | null> {
    return Promise.resolve(this.context.read().jobs.find((job) => job.id === id) ?? null);
  }

  findByJobNumber(jobNumber: string): Promise<Job | null> {
    const match = this.context
      .read()
      .jobs.find((job) => job.jobNumber.toLowerCase() === jobNumber.toLowerCase());
    return Promise.resolve(match ?? null);
  }

  save(job: Job): Promise<Job> {
    this.context.commit((draft) => {
      const index = draft.jobs.findIndex((candidate) => candidate.id === job.id);
      if (index === -1) {
        draft.jobs = [job, ...draft.jobs];
      } else {
        draft.jobs = draft.jobs.map((candidate) => (candidate.id === job.id ? job : candidate));
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
   * Every job this person has ever been on.
   *
   * The demo store keeps no participation history — it is a fixture, not a
   * system of record — so this answers from the CURRENT assignment, which is
   * the closest true statement it can make. The PostgreSQL repository reads
   * `job_participants`, which is what survives a reassignment, and the
   * visibility tests that matter run against it.
   */
  listParticipatedJobs(userId: UserId): Promise<readonly Job[]> {
    return Promise.resolve(
      this.context
        .read()
        .jobs.filter(
          (job) =>
            job.primaryTechnicianId === userId || job.additionalTechnicianIds.includes(userId),
        ),
    );
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
    });
    return Promise.resolve();
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

export const createDemoRepositories = (context: DemoContext): RepositoryBundle => ({
  jobs: new DemoJobRepository(context),
  customers: new DemoCustomerRepository(context),
  machines: new DemoMachineRepository(context),
  users: new DemoUserRepository(context),
  documents: new DemoDocumentRepository(context),
  checklistTemplates: new DemoChecklistTemplateRepository(context),
  activity: new DemoActivityRepository(context),
  notifications: new DemoNotificationRepository(context),
  settings: new DemoSettingsRepository(context),
  availability: new DemoAvailabilityRepository(context),
  chat: new DemoChatRepository(context),
});
