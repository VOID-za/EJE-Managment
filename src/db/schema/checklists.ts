import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { cents, createdAt, instant, primaryId, rowVersion, updatedAt } from './columns';
import { checklistResponseType, checklistVersionStatus, passFailNa } from './enums';
import { jobs } from './jobs';
import { jobTypes } from './settings';
import { users } from './identity';
import type { ChecklistField, ChecklistLayout } from '@/domain';

/**
 * A checklist's identity, independent of any version of its wording.
 *
 * Installation and Service require one; Breakdown and Test & Repair do not.
 * Which types require it is a property of the JOB TYPE (`checklist_required`),
 * not of the checklist, so it is not duplicated here.
 */
export const checklists = pgTable(
  'checklists',
  {
    id: primaryId(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    jobTypeCode: text('job_type_code')
      .notNull()
      .references(() => jobTypes.code),
    /**
     * Which of the business's checklists this is — 'installation',
     * 'service_milling', 'service_lathe' — or null (CHK-SRC-1, 0051). Frozen
     * by trigger once a job has used the checklist.
     */
    kind: text('kind'),
    /** What the Service choice screen calls it; '' for a checklist simply issued. */
    selectionLabel: text('selection_label').notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('checklists_job_type_idx').on(table.jobTypeCode),
    uniqueIndex('checklists_kind_key')
      .on(table.kind)
      .where(sql`${table.kind} is not null`),
  ],
);

/**
 * One revision of the wording. WRITE-ONCE ONCE USED.
 *
 * A completed checklist must for ever render the wording the customer actually
 * saw, so a version a job has answered against can never be edited — only a new
 * version may be started. A draft is freely editable until it is published.
 *
 * Exactly one version per checklist may be `current`, and that is the one a new
 * job picks up.
 */
export const checklistVersions = pgTable(
  'checklist_versions',
  {
    id: primaryId(),
    checklistId: uuid('checklist_id')
      .notNull()
      .references(() => checklists.id, { onDelete: 'restrict' }),
    version: text('version').notNull(),
    status: checklistVersionStatus('status').notNull().default('draft'),
    /**
     * Which approved EJE / WD Hearn document this wording came from.
     *
     * The seeded templates are representative demo content; the production
     * wording comes from the approved source documents and replaces them
     * without any model change.
     */
    sourceDocument: text('source_document').notNull().default(''),
    /** What the source prints around the rows (CHK-SRC-1). Frozen once used. */
    layout: jsonb('layout').$type<ChecklistLayout>(),
    publishedAt: instant('published_at'),
    publishedBy: uuid('published_by').references(() => users.id),
    archivedAt: instant('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('checklist_versions_checklist_version_key').on(table.checklistId, table.version),
    uniqueIndex('checklist_versions_one_current')
      .on(table.checklistId)
      .where(sql`${table.status} = 'current'`),
    index('checklist_versions_checklist_idx').on(table.checklistId),
  ],
);

export const checklistSections = pgTable(
  'checklist_sections',
  {
    id: primaryId(),
    versionId: uuid('version_id')
      .notNull()
      .references(() => checklistVersions.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    position: integer('position').notNull(),
  },
  (table) => [
    uniqueIndex('checklist_sections_position_key').on(table.versionId, table.position),
    index('checklist_sections_version_idx').on(table.versionId),
  ],
);

/**
 * A question, with its ordering and its answer configuration.
 *
 * `expected_min`/`expected_max` carry the out-of-range rule for a measurement:
 * `isMeasurementOutOfRange` compares against them, and an out-of-range answer
 * is what makes a note mandatory alongside a straight fail.
 */
export const checklistQuestions = pgTable(
  'checklist_questions',
  {
    id: primaryId(),
    sectionId: uuid('section_id')
      .notNull()
      .references(() => checklistSections.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    helpText: text('help_text').notNull().default(''),
    responseType: checklistResponseType('response_type').notNull(),
    required: boolean('required').notNull().default(true),
    photoRequired: boolean('photo_required').notNull().default(false),
    /** e.g. "mm", "bar". Null for anything that is not a measurement. */
    unit: text('unit'),
    expectedMin: numeric('expected_min', { precision: 14, scale: 4 }),
    expectedMax: numeric('expected_max', { precision: 14, scale: 4 }),
    position: integer('position').notNull(),
    /** As printed in the source's number column; '' for an unnumbered row. CHK-SRC-1. */
    number: text('number').notNull().default(''),
    /** A label the source prints once across several rows. */
    groupLabel: text('group_label').notNull().default(''),
    /** The labelled blanks in the row's Comments column. */
    fields: jsonb('fields').$type<readonly ChecklistField[]>().notNull().default([]),
    /** What the transcription says about the row's source, e.g. handwritten. */
    sourceNote: text('source_note').notNull().default(''),
  },
  (table) => [
    uniqueIndex('checklist_questions_position_key').on(table.sectionId, table.position),
    index('checklist_questions_section_idx').on(table.sectionId),
    check(
      'checklist_questions_range_ordered',
      sql`${table.expectedMin} is null or ${table.expectedMax} is null or ${table.expectedMax} >= ${table.expectedMin}`,
    ),
    // A range only means something on a measurement.
    check('checklist_questions_fields_array', sql`jsonb_typeof(${table.fields}) = 'array'`),
    check(
      'checklist_questions_range_only_for_measurement',
      sql`${table.responseType} = 'measurement'
          or (${table.expectedMin} is null and ${table.expectedMax} is null)`,
    ),
  ],
);

/**
 * A job's answered checklist. WRITE-ONCE ONCE COMPLETED.
 *
 * `version_id` is a REAL FOREIGN KEY, which is the production form of the
 * demo's "resolve by stored version" lookup. It makes rendering an old job card
 * against a newer revision impossible rather than merely avoided, and removes
 * the `checklistVersionMissing` case entirely — the version cannot vanish while
 * a row references it.
 */
export const checklistInstances = pgTable(
  'checklist_instances',
  {
    id: primaryId(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    versionId: uuid('version_id')
      .notNull()
      .references(() => checklistVersions.id, { onDelete: 'restrict' }),
    /**
     * The checklist chosen — 'service_milling' / 'service_lathe' — or issued.
     * A trigger keeps it equal to the kind of the version's checklist.
     */
    checklistKind: text('checklist_kind'),
    startedAt: instant('started_at'),
    startedBy: uuid('started_by').references(() => users.id),
    completedAt: instant('completed_at'),
    completedBy: uuid('completed_by').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: rowVersion(),
  },
  (table) => [
    uniqueIndex('checklist_instances_job_key').on(table.jobId),
    index('checklist_instances_version_idx').on(table.versionId),
  ],
);

/**
 * One answer.
 *
 * Four nullable answer columns rather than one polymorphic value, because the
 * domain reads them by type (`choice`, `yesNo`, `measurement`, `text`) and a
 * single text column would make "was this measured, or left blank?"
 * unanswerable.
 *
 * A FAIL REQUIRES A NOTE — by the time the checklist is COMPLETED. Enforced by
 * `requiresNote`/`completeChecklist` in the domain and, since 0051, by the
 * `checklist_instances_fail_needs_note` trigger, which refuses to stamp a
 * checklist complete over an unexplained Fail. It was a CHECK on this row
 * (0000), which refused the technician's TAP on Fail before the note could be
 * typed — a server error on PostgreSQL. A failed check with no explanation is
 * still the one answer that tells nobody anything; it is refused where it ends.
 */
export const checklistAnswers = pgTable(
  'checklist_answers',
  {
    id: primaryId(),
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => checklistInstances.id, { onDelete: 'cascade' }),
    questionId: uuid('question_id')
      .notNull()
      .references(() => checklistQuestions.id, { onDelete: 'restrict' }),
    choice: passFailNa('choice'),
    yesNo: boolean('yes_no'),
    measurement: numeric('measurement', { precision: 14, scale: 4 }),
    textAnswer: text('text_answer').notNull().default(''),
    notes: text('notes').notNull().default(''),
    /** Values typed into the row's labelled blanks, by field id. CHK-SRC-1. */
    fieldValues: jsonb('field_values')
      .$type<Readonly<Record<string, string>>>()
      .notNull()
      .default({}),
    answeredAt: instant('answered_at'),
    answeredBy: uuid('answered_by').references(() => users.id),
  },
  (table) => [
    uniqueIndex('checklist_answers_question_key').on(table.instanceId, table.questionId),
    index('checklist_answers_instance_idx').on(table.instanceId),
    check(
      'checklist_answers_field_values_object',
      sql`jsonb_typeof(${table.fieldValues}) = 'object'`,
    ),
  ],
);

/** Photographs attached to a single answer. */
export const checklistAnswerPhotos = pgTable(
  'checklist_answer_photos',
  {
    id: primaryId(),
    answerId: uuid('answer_id')
      .notNull()
      .references(() => checklistAnswers.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key').notNull(),
    fileName: text('file_name').notNull(),
    caption: text('caption').notNull().default(''),
    contentType: text('content_type').notNull().default(''),
    sizeBytes: cents('size_bytes').notNull().default(0),
    /**
     * SHA-256 of the stored bytes. Null when nothing measured them.
     *
     * This is the evidence a `photoRequired` checklist item gates completion
     * on, so "is this still the photograph that was taken" is a question worth
     * being able to answer about it.
     */
    checksumSha256: text('checksum_sha256'),
    uploadedAt: instant('uploaded_at').notNull(),
    uploadedBy: uuid('uploaded_by').references(() => users.id),
  },
  (table) => [
    index('checklist_answer_photos_answer_idx').on(table.answerId),
    uniqueIndex('checklist_answer_photos_storage_key_key').on(table.storageKey),
  ],
);
