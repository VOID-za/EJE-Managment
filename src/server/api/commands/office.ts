import 'server-only';
import { z } from 'zod';
import {
  asChecklistTemplateId,
  asDocumentId,
  asJobId,
  asNotificationId,
  asUserId,
  userFullName,
  type AvailabilityRecord,
  type ChatMessage,
  type ChecklistTemplate,
  type Conversation,
  type TechnicalDocument,
  type User,
} from '@/domain';
import * as availability from '@/application/availability-operations';
import * as chat from '@/application/chat-operations';
import * as checklists from '@/application/checklist-admin';
import * as library from '@/application/library-operations';
import * as settings from '@/application/settings-operations';
import * as users from '@/application/user-operations';
import { notFound } from '../errors';
import { recordSecurityEvent } from '../security-audit';
import { getServerRuntime } from '@/server/runtime';
import { command, type CommandContext, type CommandRegistry } from './types';

/**
 * The office's registers: people, rates, checklists, the library, the
 * calendar and the chat.
 *
 * The same discipline as `registers.ts`: an update loads the stored record and
 * overlays only the editable fields. Nothing a client sends reaches `role`
 * except through the explicit role command, whose own rules
 * (`assertManages`) decide whether this actor may set it — a Coordinator
 * cannot promote anybody, and no Master can edit another Master.
 */
const text = (max: number) => z.string().max(max);
const id = z.string().min(1).max(100);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a calendar date.');
const isoTime = z.string().regex(/^\d{2}:\d{2}$/, 'Use a time of day.');

const loadUser = async (context: CommandContext, target: string): Promise<User> => {
  const found = await context.repos.users.findById(asUserId(target));
  if (found === null) throw notFound('That user does not exist.');
  return found;
};

const loadDocument = async (
  context: CommandContext,
  target: string,
): Promise<TechnicalDocument> => {
  const found = await context.repos.documents.findById(asDocumentId(target));
  if (found === null) throw notFound('That document does not exist.');
  return found;
};

const loadTemplate = async (
  context: CommandContext,
  target: string,
  version: string,
): Promise<ChecklistTemplate> => {
  const found = await context.repos.checklistTemplates.findByVersion(
    asChecklistTemplateId(target),
    version,
  );
  if (found === null) throw notFound('That checklist version does not exist.');
  return found;
};

const loadRecord = async (
  context: CommandContext,
  target: string,
): Promise<AvailabilityRecord> => {
  const found = await context.repos.availability.findById(target);
  if (found === null) throw notFound('That availability record does not exist.');
  return found;
};

/**
 * A conversation this actor is actually in.
 *
 * Not found rather than refused, for the same reason a job is: confirming the
 * thread exists would say who is talking to whom.
 */
const loadConversation = async (
  context: CommandContext,
  target: string,
): Promise<Conversation> => {
  const found = await context.repos.chat.findConversation(target);
  if (found === null || !found.participantIds.includes(context.actor.id)) {
    throw notFound('That conversation does not exist.');
  }
  return found;
};

const loadMessage = async (context: CommandContext, messageId: string): Promise<ChatMessage> => {
  const found = await context.repos.chat.findMessage(messageId);
  if (found === null) throw notFound('That message does not exist.');
  // Reachable only through a thread this actor is in.
  await loadConversation(context, found.conversationId);
  return found;
};

const roles = z.enum(['master', 'coordinator', 'technician']);

export const USER_COMMANDS: CommandRegistry = {
  update: command({
    schema: z
      .object({
        firstName: z.string().min(1).max(120),
        lastName: text(120),
        email: z.string().min(1).max(320),
        mobile: text(60),
        jobTitle: text(160),
        role: roles,
      })
      .strict(),
    async run(context, input, target) {
      const stored = await loadUser(context, target);
      /*
       * `active`, `createdAt` and `initials` come from the stored record.
       *
       * Activation has its own command, because disabling somebody revokes
       * their sessions and that must not be a side effect of an edit.
       */
      return users.updateUser(context.operation, { ...stored, ...input });
    },
  }),

  set_active: command({
    schema: z.object({ active: z.boolean() }).strict(),
    async run(context, input, target) {
      const stored = await loadUser(context, target);
      const saved = await users.setUserActive(context.operation, stored, input.active);

      /*
       * DISABLING SOMEBODY ENDS THEIR SESSIONS, NOW.
       *
       * Not at the next expiry: a technician who has been let go is holding a
       * tablet with a live cookie, and twelve hours of continued access to
       * customer details is not an acceptable notice period. Sessions are not
       * domain data, so the revocation happens here rather than inside
       * `setUserActive` — the application layer does not know a session exists.
       *
       * `requireAuthenticatedActor` re-checks `active` as well, so the two
       * mechanisms are independent and either one alone would close the door.
       */
      if (!input.active) {
        const now = new Date().toISOString();
        const revoked = await getServerRuntime().auth.revokeSessionsForUser(
          stored.id,
          now,
          'account disabled',
        );
        if (revoked > 0) {
          await recordSecurityEvent(context.repos, {
            type: 'user_sessions_revoked',
            summary: `Sessions ended: ${userFullName(stored)}`,
            detail: `${revoked} active ${revoked === 1 ? 'session was' : 'sessions were'} ended because the account was disabled.`,
            actorId: context.actor.id,
            occurredAt: now,
          });
        }
      }

      return saved;
    },
  }),

  send_password_reset: command({
    schema: z.object({}).strict(),
    async run(context, _input: Record<string, never>, target) {
      const stored = await loadUser(context, target);
      return users.sendPasswordReset(context.operation, stored);
    },
  }),
};

export const createUserSchema = z
  .object({
    firstName: z.string().min(1).max(120),
    lastName: text(120),
    email: z.string().min(1).max(320),
    mobile: text(60),
    jobTitle: text(160),
    role: roles,
  })
  .strict();

export const runCreateUser = (context: CommandContext, input: z.infer<typeof createUserSchema>) =>
  users.createUser(context.operation, input);

export const settingsSchema = z
  .object({
    companyName: text(200),
    companyRegistration: text(60),
    companyVatNumber: text(60),
    companyPhone: text(60),
    companyEmail: text(320),
    companyAddress: text(500),
    labourRates: z
      .object({
        normal: z.number().int().nonnegative().max(100_000_000),
        overtime: z.number().int().nonnegative().max(100_000_000),
        double: z.number().int().nonnegative().max(100_000_000),
      })
      .strict(),
    calloutRate: z.number().int().nonnegative().max(100_000_000),
    kilometreRate: z.number().int().nonnegative().max(100_000_000),
    vatPercentage: z.number().nonnegative().max(100),
    jobNumberPrefix: text(20),
    quietHoursStart: text(5),
    quietHoursEnd: text(5),
  })
  .strict();

/**
 * Charge-out rates and the company details.
 *
 * `nextJobSequence` is deliberately NOT in the schema and is taken from the
 * stored settings: against PostgreSQL the job number comes from a sequence and
 * a settings write cannot move it, so accepting one from a client would be
 * accepting a value that does nothing — or, on the demonstration store, one
 * that hands out a number twice.
 */
export const runUpdateSettings = async (
  context: CommandContext,
  input: z.infer<typeof settingsSchema>,
) => {
  const stored = await context.repos.settings.get();
  return settings.updateSettings(context.operation, {
    ...input,
    nextJobSequence: stored.nextJobSequence,
  });
};

const documentFields = z
  .object({
    name: z.string().min(1).max(200),
    description: text(2000),
    documentType: z.enum([
      'machine_manual',
      'electrical_diagram',
      'service_manual',
      'safety_procedure',
      'work_procedure',
      'datasheet',
    ]),
    manufacturer: text(160),
    machineModel: text(160),
    version: text(40),
    fileName: text(260),
    pageCount: z.number().int().positive().max(100_000),
    tags: z.array(text(60)).max(30),
  })
  .strict();

export const LIBRARY_COMMANDS: CommandRegistry = {
  update: command({
    schema: documentFields.partial({ fileName: true, pageCount: true }),
    async run(context, input, target) {
      const stored = await loadDocument(context, target);
      /*
       * `status`, `uploadedBy`, `uploadedAt` and `storageKey` come from the
       * stored record. A client that could set `status: 'current'` would be
       * approving its own upload.
       */
      return library.updateDocument(context.operation, {
        ...stored,
        ...input,
        fileName: input.fileName ?? stored.fileName,
        pageCount: input.pageCount ?? stored.pageCount,
      });
    },
  }),

  approve: command({
    schema: z.object({}).strict(),
    async run(context, _input: Record<string, never>, target) {
      return library.approveDocument(context.operation, await loadDocument(context, target));
    },
  }),

  archive: command({
    schema: z.object({}).strict(),
    async run(context, _input: Record<string, never>, target) {
      return library.archiveDocument(context.operation, await loadDocument(context, target));
    },
  }),

  add_version: command({
    schema: z
      .object({
        version: z.string().min(1).max(40),
        fileName: text(260),
        pageCount: z.number().int().positive().max(100_000),
        description: text(2000),
      })
      .strict(),
    async run(context, input, target) {
      return library.addDocumentVersion(
        context.operation,
        await loadDocument(context, target),
        input,
      );
    },
  }),

  toggle_favourite: command({
    schema: z.object({}).strict(),
    async run(context, _input: Record<string, never>, target) {
      const stored = await loadDocument(context, target);
      return { favourites: await context.repos.documents.toggleFavourite(context.actor.id, stored.id) };
    },
  }),

  record_view: command({
    schema: z.object({}).strict(),
    async run(context, _input: Record<string, never>, target) {
      const stored = await loadDocument(context, target);
      await context.repos.documents.recordView(context.actor.id, stored.id);
      return { viewed: true };
    },
  }),
};

export const createDocumentSchema = documentFields;

export const runCreateDocument = (
  context: CommandContext,
  input: z.infer<typeof createDocumentSchema>,
) => library.addDocument(context.operation, input);

const sectionSchema = z
  .object({
    id: id,
    title: text(200),
    description: text(2000),
    items: z
      .array(
        z
          .object({
            id: id,
            text: text(2000),
            helpText: text(2000),
            responseType: z.enum(['pass_fail_na', 'measurement', 'text', 'yes_no']),
            required: z.boolean(),
            photoRequired: z.boolean(),
            unit: text(20).nullable(),
            expectedRange: z
              .object({ min: z.number(), max: z.number() })
              .strict()
              .nullable(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();

export const CHECKLIST_COMMANDS: CommandRegistry = {
  save_draft: command({
    schema: z
      .object({
        version: z.string().min(1).max(40),
        name: z.string().min(1).max(200),
        description: text(2000),
        sourceDocument: text(200),
        sections: z.array(sectionSchema).max(50),
      })
      .strict(),
    async run(context, input, target) {
      const stored = await loadTemplate(context, target, input.version);
      // `status` and `jobTypeCode` are the template's identity, not an edit.
      return checklists.saveTemplateDraft(context.operation, {
        ...stored,
        name: input.name,
        description: input.description,
        sourceDocument: input.sourceDocument,
        sections: input.sections,
      });
    },
  }),

  publish: command({
    schema: z.object({ version: z.string().min(1).max(40) }).strict(),
    async run(context, input, target) {
      return checklists.publishTemplate(
        context.operation,
        await loadTemplate(context, target, input.version),
      );
    },
  }),

  start_version: command({
    schema: z.object({ version: z.string().min(1).max(40) }).strict(),
    async run(context, input, target) {
      return checklists.startNewVersion(
        context.operation,
        await loadTemplate(context, target, input.version),
      );
    },
  }),

  archive: command({
    schema: z.object({ version: z.string().min(1).max(40) }).strict(),
    async run(context, input, target) {
      return checklists.archiveTemplate(
        context.operation,
        await loadTemplate(context, target, input.version),
      );
    },
  }),
};

export const createTemplateSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: text(2000),
    jobTypeCode: z.enum(['breakdown', 'installation', 'service', 'parts', 'test_and_repair']),
    sourceDocument: text(200),
  })
  .strict();

export const runCreateTemplate = (
  context: CommandContext,
  input: z.infer<typeof createTemplateSchema>,
) => checklists.createTemplate(context.operation, input);

const availabilityFields = z
  .object({
    userId: id,
    type: z.enum([
      'appointment',
      'sick_leave',
      'annual_leave',
      'personal_leave',
      'training',
      'other',
    ]),
    startDate: isoDate,
    endDate: isoDate,
    allDay: z.boolean(),
    startTime: isoTime.nullable(),
    endTime: isoTime.nullable(),
    description: text(2000),
    fromMessageId: id.nullable().optional(),
  })
  .strict();

export const AVAILABILITY_COMMANDS: CommandRegistry = {
  update: command({
    schema: availabilityFields,
    async run(context, input, target) {
      const stored = await loadRecord(context, target);
      return availability.updateAvailability(context.operation, stored, {
        ...input,
        userId: asUserId(input.userId),
      });
    },
  }),

  cancel: command({
    schema: z.object({}).strict(),
    async run(context, _input: Record<string, never>, target) {
      return availability.cancelAvailability(context.operation, await loadRecord(context, target));
    },
  }),
};

export const createAvailabilitySchema = availabilityFields;

export const runCreateAvailability = (
  context: CommandContext,
  input: z.infer<typeof createAvailabilitySchema>,
) =>
  availability.createAvailability(context.operation, {
    ...input,
    userId: asUserId(input.userId),
  });

export const CONVERSATION_COMMANDS: CommandRegistry = {
  send: command({
    schema: z.object({ body: z.string().min(1).max(4000) }).strict(),
    async run(context, input, target) {
      return chat.sendMessage(
        context.operation,
        await loadConversation(context, target),
        input.body,
      );
    },
  }),

  mark_read: command({
    schema: z.object({}).strict(),
    async run(context, _input: Record<string, never>, target) {
      await chat.markConversationRead(context.operation, await loadConversation(context, target));
      return { read: true };
    },
  }),

  attach_availability: command({
    schema: z.object({ messageId: id, availabilityId: id }).strict(),
    async run(context, input, target) {
      await loadConversation(context, target);
      const [message, record] = await Promise.all([
        loadMessage(context, input.messageId),
        loadRecord(context, input.availabilityId),
      ]);
      return chat.attachAvailabilityToMessage(context.operation, message, record);
    },
  }),
};

/**
 * Starting a thread.
 *
 * AN EMPTY RECIPIENT LIST MEANS "THE OFFICE". `startConversation` resolves it
 * to every active Master, so a technician never has to guess who is on duty —
 * and the resolution happens on the SERVER, from the register, rather than the
 * browser picking names out of a list it was served.
 */
export const startConversationSchema = z
  .object({
    recipientIds: z.array(id).max(20),
    body: z.string().min(1).max(4000),
    jobId: id.nullable().optional(),
  })
  .strict();

export const runStartConversation = async (
  context: CommandContext,
  input: z.infer<typeof startConversationSchema>,
) => {
  const job =
    input.jobId === undefined || input.jobId === null
      ? null
      : await context.repos.jobs.findById(asJobId(input.jobId));

  return chat.startConversation(context.operation, {
    recipientIds: input.recipientIds.map((value) => asUserId(value)),
    body: input.body,
    job: job === null ? null : { id: job.id, jobNumber: job.jobNumber },
  });
};

export const NOTIFICATION_COMMANDS: CommandRegistry = {
  /**
   * Marking one notification read.
   *
   * `target` is the notification id, and the repository is scoped by recipient
   * on the way in — a client cannot mark somebody else's notification read,
   * because the list it is checked against is this actor's own.
   */
  read: command({
    schema: z.object({}).strict(),
    async run(context, _input: Record<string, never>, target) {
      const mine = await context.repos.notifications.list(context.actor.id);
      const found = mine.find((entry) => entry.id === target);
      if (found === undefined) throw notFound('That notification does not exist.');
      await context.repos.notifications.markRead(asNotificationId(target));
      return { read: true };
    },
  }),

  handled: command({
    schema: z.object({}).strict(),
    async run(context, _input: Record<string, never>, target) {
      const mine = await context.repos.notifications.list(context.actor.id);
      const found = mine.find((entry) => entry.id === target);
      if (found === undefined) throw notFound('That notification does not exist.');
      await context.repos.notifications.markHandled(asNotificationId(target));
      return { handled: true };
    },
  }),
};

export const runMarkAllNotificationsRead = async (context: CommandContext) => {
  await context.repos.notifications.markAllRead(context.actor.id);
  return { read: true };
};
