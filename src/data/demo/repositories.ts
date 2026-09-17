import type {
  ActivityEvent,
  AppNotification,
  ChecklistTemplate,
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
import { seedChecklistTemplates, seedDocuments, seedUsers } from '../seed';
import type {
  ActivityRepository,
  ChecklistTemplateRepository,
  CustomerRepository,
  DocumentRepository,
  JobFilter,
  JobRepository,
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

  listSites(customerId?: CustomerId): Promise<readonly Site[]> {
    const sites = this.context.read().sites;
    return Promise.resolve(
      customerId === undefined ? sites : sites.filter((site) => site.customerId === customerId),
    );
  }

  listContacts(customerId?: CustomerId): Promise<readonly Contact[]> {
    const contacts = this.context.read().contacts;
    return Promise.resolve(
      customerId === undefined
        ? contacts
        : contacts.filter((contact) => contact.customerId === customerId),
    );
  }

  save(customer: Customer): Promise<Customer> {
    this.context.commit((draft) => {
      draft.customers = draft.customers.map((candidate) =>
        candidate.id === customer.id ? customer : candidate,
      );
    });
    return Promise.resolve(customer);
  }
}

class DemoMachineRepository implements MachineRepository {
  constructor(private readonly context: DemoContext) {}

  list(): Promise<readonly Machine[]> {
    return Promise.resolve(this.context.read().machines);
  }

  findById(id: MachineId): Promise<Machine | null> {
    return Promise.resolve(
      this.context.read().machines.find((machine) => machine.id === id) ?? null,
    );
  }

  save(machine: Machine): Promise<Machine> {
    this.context.commit((draft) => {
      draft.machines = draft.machines.map((candidate) =>
        candidate.id === machine.id ? machine : candidate,
      );
    });
    return Promise.resolve(machine);
  }
}

class DemoUserRepository implements UserRepository {
  list(): Promise<readonly User[]> {
    return Promise.resolve(seedUsers);
  }

  findById(id: UserId): Promise<User | null> {
    return Promise.resolve(seedUsers.find((user) => user.id === id) ?? null);
  }
}

class DemoDocumentRepository implements DocumentRepository {
  constructor(private readonly context: DemoContext) {}

  list(): Promise<readonly TechnicalDocument[]> {
    return Promise.resolve(seedDocuments);
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
  list(): Promise<readonly ChecklistTemplate[]> {
    return Promise.resolve(seedChecklistTemplates);
  }

  findForJobType(jobTypeCode: string): Promise<ChecklistTemplate | null> {
    const match = seedChecklistTemplates.find(
      (template) => template.jobTypeCode === jobTypeCode && template.status === 'current',
    );
    return Promise.resolve(match ?? null);
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
  users: new DemoUserRepository(),
  documents: new DemoDocumentRepository(context),
  checklistTemplates: new DemoChecklistTemplateRepository(),
  activity: new DemoActivityRepository(context),
  notifications: new DemoNotificationRepository(context),
  settings: new DemoSettingsRepository(context),
});
