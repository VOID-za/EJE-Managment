import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  asAttachmentId,
  asChecklistTemplateId,
  asUserId,
  type ChecklistInstance,
  type ChecklistResponse,
  type Job,
} from '@/domain';
import type { DatabaseExecutor } from '@/db/client';
import * as schema from '@/db/schema';

type InstanceRow = typeof schema.checklistInstances.$inferSelect;
type AnswerRow = typeof schema.checklistAnswers.$inferSelect;
type PhotoRow = typeof schema.checklistAnswerPhotos.$inferSelect;

/**
 * A job's answered checklist, in PostgreSQL.
 *
 * Its own module because it is its own aggregate: the wording belongs to the
 * checklist repository, the ANSWERS belong to the job, and the join between
 * them is a version id rather than a name and a number.
 *
 * `checklist_instances.version_id` being a real foreign key is the whole point.
 * The demo resolved a template by (id, version) and had to handle the version
 * having gone — `checklistVersionMissing` exists for that case. Here the
 * version cannot vanish while an instance references it, so a historical job
 * card cannot silently re-render against newer wording.
 *
 * A COMPLETED CHECKLIST IS FROZEN, by trigger. Once `completed_at` is set,
 * neither the instance nor its answers accept another write — so a job that is
 * saved again for an unrelated reason cannot disturb what the customer signed.
 */

const toDomainResponse = (
  row: AnswerRow,
  photos: readonly PhotoRow[],
): ChecklistResponse => ({
  itemId: row.questionId,
  choice: row.choice,
  yesNo: row.yesNo,
  measurement: row.measurement === null ? null : Number(row.measurement),
  text: row.textAnswer,
  notes: row.notes,
  photos: photos.map((photo) => ({
    id: asAttachmentId(photo.id),
    kind: 'photo' as const,
    fileName: photo.fileName,
    caption: photo.caption,
    storageKey: photo.storageKey,
    uploadedAt: photo.uploadedAt,
    uploadedBy: asUserId(photo.uploadedBy ?? ''),
    sizeBytes: photo.sizeBytes,
  })),
  answeredAt: row.answeredAt,
  answeredBy: row.answeredBy === null ? null : asUserId(row.answeredBy),
});

/** Loads every job's checklist in one pass, keyed by job id. */
export const loadChecklists = async (
  db: DatabaseExecutor,
  jobIds: readonly string[],
): Promise<ReadonlyMap<string, ChecklistInstance>> => {
  if (jobIds.length === 0) return new Map();

  const instances = await db
    .select({
      instance: schema.checklistInstances,
      version: schema.checklistVersions.version,
      checklistId: schema.checklistVersions.checklistId,
    })
    .from(schema.checklistInstances)
    .innerJoin(
      schema.checklistVersions,
      eq(schema.checklistVersions.id, schema.checklistInstances.versionId),
    )
    .where(inArray(schema.checklistInstances.jobId, [...jobIds]));

  if (instances.length === 0) return new Map();

  const answers = await db
    .select()
    .from(schema.checklistAnswers)
    .innerJoin(
      schema.checklistQuestions,
      eq(schema.checklistQuestions.id, schema.checklistAnswers.questionId),
    )
    .where(
      inArray(
        schema.checklistAnswers.instanceId,
        instances.map((row) => row.instance.id),
      ),
    )
    // The order the technician saw them in, so a re-read renders identically.
    .orderBy(asc(schema.checklistQuestions.position));

  const photos =
    answers.length === 0
      ? []
      : await db
          .select()
          .from(schema.checklistAnswerPhotos)
          .where(
            inArray(
              schema.checklistAnswerPhotos.answerId,
              answers.map((row) => row.checklist_answers.id),
            ),
          )
          .orderBy(asc(schema.checklistAnswerPhotos.uploadedAt));

  const byJob = new Map<string, ChecklistInstance>();
  for (const { instance, version, checklistId } of instances) {
    const mine = answers.filter((row) => row.checklist_answers.instanceId === instance.id);
    byJob.set(instance.jobId, {
      templateId: asChecklistTemplateId(checklistId),
      templateVersion: version,
      responses: mine.map((row) =>
        toDomainResponse(
          row.checklist_answers,
          photos.filter((photo) => photo.answerId === row.checklist_answers.id),
        ),
      ),
      completedAt: instance.completedAt,
      completedBy: instance.completedBy === null ? null : asUserId(instance.completedBy),
    });
  }
  return byJob;
};

/**
 * Writes the job's checklist, if it has one and it is not already frozen.
 *
 * Does NOTHING for a job with no checklist: removing a started checklist is not
 * an operation the application has, and a save that happened to carry `null`
 * must not be able to destroy answers a technician captured.
 */
export const writeChecklist = async (db: DatabaseExecutor, job: Job): Promise<void> => {
  const checklist = job.checklist;
  if (checklist === null) return;

  const versions = await db
    .select({ id: schema.checklistVersions.id })
    .from(schema.checklistVersions)
    .where(
      and(
        eq(schema.checklistVersions.checklistId, checklist.templateId),
        eq(schema.checklistVersions.version, checklist.templateVersion),
      ),
    )
    .limit(1);

  const versionId = versions[0]?.id;
  if (versionId === undefined) {
    throw new Error(
      `${job.jobNumber} answers checklist ${checklist.templateId} v${checklist.templateVersion}, ` +
        'which is not held. A job card must render the wording the customer saw, so this is ' +
        'refused rather than stored against a different version.',
    );
  }

  const existing = await db
    .select()
    .from(schema.checklistInstances)
    .where(eq(schema.checklistInstances.jobId, job.id))
    .limit(1);

  const current: InstanceRow | undefined = existing[0];

  // Already completed: frozen, by trigger as well as by this check. There is
  // nothing legitimate left to write.
  if (current?.completedAt != null) return;

  const instanceId = current?.id ?? crypto.randomUUID();
  if (current === undefined) {
    await db.insert(schema.checklistInstances).values({
      id: instanceId,
      jobId: job.id as string,
      versionId,
      startedAt: sql`now()`,
      startedBy: job.primaryTechnicianId,
      completedAt: checklist.completedAt,
      completedBy: checklist.completedBy,
    });
  } else if (checklist.completedAt !== null) {
    // Completion is a one-way door, so the answers are written BEFORE it is
    // stamped — afterwards the trigger refuses them.
    await replaceAnswers(db, instanceId, checklist);
    await db
      .update(schema.checklistInstances)
      .set({
        completedAt: checklist.completedAt,
        completedBy: checklist.completedBy,
        updatedAt: sql`now()`,
        version: current.version + 1,
      })
      .where(eq(schema.checklistInstances.id, instanceId));
    return;
  }

  await replaceAnswers(db, instanceId, checklist);
};

/**
 * Replaces the answers of a checklist still in progress.
 *
 * Wholesale, like the job's own line items: a checklist has tens of answers,
 * the write is one round trip either way, and a diff is a place for a bug to
 * live. Photographs are re-inserted with their own ids, so the link between an
 * answer and the bytes behind its storage key survives.
 */
const replaceAnswers = async (
  db: DatabaseExecutor,
  instanceId: string,
  checklist: ChecklistInstance,
): Promise<void> => {
  await db.delete(schema.checklistAnswers).where(eq(schema.checklistAnswers.instanceId, instanceId));
  if (checklist.responses.length === 0) return;

  const answerIds = new Map<string, string>();
  await db.insert(schema.checklistAnswers).values(
    checklist.responses.map((response) => {
      const id = crypto.randomUUID();
      answerIds.set(response.itemId, id);
      return {
        id,
        instanceId,
        questionId: response.itemId,
        choice: response.choice,
        yesNo: response.yesNo,
        measurement: response.measurement === null ? null : String(response.measurement),
        textAnswer: response.text,
        notes: response.notes,
        answeredAt: response.answeredAt,
        answeredBy: response.answeredBy,
      };
    }),
  );

  const photos = checklist.responses.flatMap((response) =>
    response.photos.map((photo) => ({
      id: photo.id as string,
      answerId: answerIds.get(response.itemId)!,
      storageKey: photo.storageKey,
      fileName: photo.fileName,
      caption: photo.caption,
      sizeBytes: photo.sizeBytes,
      uploadedAt: photo.uploadedAt,
      uploadedBy: photo.uploadedBy.length === 0 ? null : (photo.uploadedBy as string),
    })),
  );
  if (photos.length > 0) await db.insert(schema.checklistAnswerPhotos).values(photos);
};
