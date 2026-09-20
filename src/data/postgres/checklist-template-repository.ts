import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  asChecklistTemplateId,
  type ChecklistItem,
  type ChecklistSection,
  type ChecklistTemplate,
  type ChecklistTemplateId,
} from '@/domain';
import type { ChecklistTemplateRepository } from '@/data/repositories';
import type { DatabaseExecutor } from '@/db/client';
import * as schema from '@/db/schema';

type ChecklistRow = typeof schema.checklists.$inferSelect;
type VersionRow = typeof schema.checklistVersions.$inferSelect;
type SectionRow = typeof schema.checklistSections.$inferSelect;
type QuestionRow = typeof schema.checklistQuestions.$inferSelect;

/** `numeric` arrives as text; the domain compares ranges as numbers. */
const bound = (value: string | null): number | null => (value === null ? null : Number(value));

const toDomainItem = (row: QuestionRow): ChecklistItem => ({
  id: row.id,
  text: row.text,
  helpText: row.helpText,
  responseType: row.responseType,
  required: row.required,
  photoRequired: row.photoRequired,
  unit: row.unit,
  expectedRange:
    row.expectedMin === null || row.expectedMax === null
      ? null
      : { min: bound(row.expectedMin)!, max: bound(row.expectedMax)! },
});

/**
 * Checklist templates, in PostgreSQL.
 *
 * THE UNIT IS A VERSION, not a checklist. The domain's `ChecklistTemplate`
 * carries both an id and a version, and `list()` returns one entry per version
 * — which is exactly the shape the three tables hold: a `checklists` row is the
 * identity, a `checklist_versions` row is one revision of the wording, and the
 * sections and questions hang off the version.
 *
 * `findByVersion` is what makes a historical job card render correctly: a job
 * that answered v1.0 keeps rendering v1.0 after v2.0 becomes current. In
 * PostgreSQL that is stronger than a lookup — `checklist_instances.version_id`
 * is a real foreign key with `on delete restrict`, so the version a job used
 * cannot be removed while the job exists, and a trigger refuses to let its
 * wording be edited. The demo could only avoid rewriting history; this cannot
 * do it.
 */
export class PostgresChecklistTemplateRepository implements ChecklistTemplateRepository {
  constructor(private readonly db: DatabaseExecutor) {}

  async list(): Promise<readonly ChecklistTemplate[]> {
    const rows = await this.db
      .select({ checklist: schema.checklists, version: schema.checklistVersions })
      .from(schema.checklistVersions)
      .innerJoin(
        schema.checklists,
        eq(schema.checklists.id, schema.checklistVersions.checklistId),
      )
      .orderBy(asc(schema.checklists.name), asc(schema.checklistVersions.version));
    return this.assemble(rows);
  }

  /** The wording a NEW job of this type must complete: the current version. */
  async findForJobType(jobTypeCode: string): Promise<ChecklistTemplate | null> {
    const rows = await this.db
      .select({ checklist: schema.checklists, version: schema.checklistVersions })
      .from(schema.checklistVersions)
      .innerJoin(
        schema.checklists,
        eq(schema.checklists.id, schema.checklistVersions.checklistId),
      )
      .where(
        and(
          eq(schema.checklists.jobTypeCode, jobTypeCode),
          eq(schema.checklistVersions.status, 'current'),
        ),
      )
      .limit(1);
    const assembled = await this.assemble(rows);
    return assembled[0] ?? null;
  }

  async findByVersion(
    templateId: ChecklistTemplateId,
    version: string,
  ): Promise<ChecklistTemplate | null> {
    const rows = await this.db
      .select({ checklist: schema.checklists, version: schema.checklistVersions })
      .from(schema.checklistVersions)
      .innerJoin(
        schema.checklists,
        eq(schema.checklists.id, schema.checklistVersions.checklistId),
      )
      .where(
        and(
          eq(schema.checklistVersions.checklistId, templateId),
          eq(schema.checklistVersions.version, version),
        ),
      )
      .limit(1);
    const assembled = await this.assemble(rows);
    return assembled[0] ?? null;
  }

  async save(template: ChecklistTemplate): Promise<ChecklistTemplate> {
    await this.db
      .insert(schema.checklists)
      .values({
        id: template.id,
        name: template.name,
        description: template.description,
        jobTypeCode: template.jobTypeCode,
      })
      .onConflictDoUpdate({
        target: schema.checklists.id,
        set: {
          name: template.name,
          description: template.description,
          jobTypeCode: template.jobTypeCode,
          updatedAt: sql`now()`,
        },
      });

    const existing = await this.db
      .select({ id: schema.checklistVersions.id })
      .from(schema.checklistVersions)
      .where(
        and(
          eq(schema.checklistVersions.checklistId, template.id),
          eq(schema.checklistVersions.version, template.version),
        ),
      )
      .limit(1);

    const versionId = existing[0]?.id ?? crypto.randomUUID();
    await this.db
      .insert(schema.checklistVersions)
      .values({
        id: versionId,
        checklistId: template.id,
        version: template.version,
        status: template.status,
        sourceDocument: template.sourceDocument,
        publishedAt: template.status === 'current' ? template.updatedAt : null,
        archivedAt: template.status === 'archived' ? template.updatedAt : null,
      })
      .onConflictDoUpdate({
        target: [schema.checklistVersions.checklistId, schema.checklistVersions.version],
        set: {
          status: template.status,
          sourceDocument: template.sourceDocument,
          publishedAt:
            template.status === 'current'
              ? sql`coalesce(${schema.checklistVersions.publishedAt}, now())`
              : schema.checklistVersions.publishedAt,
          archivedAt: template.status === 'archived' ? sql`now()` : null,
          updatedAt: sql`now()`,
        },
      });

    await this.replaceWording(versionId, template.sections);

    const saved = await this.findByVersion(template.id, template.version);
    if (saved === null) throw new Error(`${template.name} v${template.version} vanished on save.`);
    return saved;
  }

  /* ---------------------------------------------------------------------- */

  /**
   * Rewrites the sections and questions of a version nobody has answered yet.
   *
   * A version A JOB HAS USED is skipped entirely, deliberately. Its wording is
   * frozen — the triggers refuse an edit and the answers' foreign keys refuse a
   * delete — so there is nothing legitimate to write, and the only calls that
   * reach here for a used version are status changes: publishing a successor,
   * or archiving this one. `editInPlaceRefusal` in `checklist-admin` is what
   * turns an actual attempt to edit used wording into an error the person sees.
   */
  private async replaceWording(
    versionId: string,
    sections: readonly ChecklistSection[],
  ): Promise<void> {
    const used = await this.db
      .select({ id: schema.checklistInstances.id })
      .from(schema.checklistInstances)
      .where(eq(schema.checklistInstances.versionId, versionId))
      .limit(1);
    if (used[0] !== undefined) return;

    await this.db
      .delete(schema.checklistSections)
      .where(eq(schema.checklistSections.versionId, versionId));
    if (sections.length === 0) return;

    await this.db.insert(schema.checklistSections).values(
      sections.map((section, position) => ({
        id: section.id,
        versionId,
        title: section.title,
        description: section.description,
        position,
      })),
    );

    const questions = sections.flatMap((section) =>
      section.items.map((item, position) => ({
        id: item.id,
        sectionId: section.id,
        text: item.text,
        helpText: item.helpText,
        responseType: item.responseType,
        required: item.required,
        photoRequired: item.photoRequired,
        unit: item.unit,
        // A range only means something on a measurement, and the CHECK says so.
        expectedMin:
          item.responseType === 'measurement' && item.expectedRange !== null
            ? String(item.expectedRange.min)
            : null,
        expectedMax:
          item.responseType === 'measurement' && item.expectedRange !== null
            ? String(item.expectedRange.max)
            : null,
        position,
      })),
    );
    if (questions.length > 0) await this.db.insert(schema.checklistQuestions).values(questions);
  }

  private async assemble(
    rows: readonly { checklist: ChecklistRow; version: VersionRow }[],
  ): Promise<readonly ChecklistTemplate[]> {
    if (rows.length === 0) return [];
    const versionIds = rows.map((row) => row.version.id);

    const sections = await this.db
      .select()
      .from(schema.checklistSections)
      .where(inArray(schema.checklistSections.versionId, versionIds))
      .orderBy(asc(schema.checklistSections.position));

    const questions =
      sections.length === 0
        ? []
        : await this.db
            .select()
            .from(schema.checklistQuestions)
            .where(
              inArray(
                schema.checklistQuestions.sectionId,
                sections.map((section) => section.id),
              ),
            )
            .orderBy(asc(schema.checklistQuestions.position));

    const sectionsFor = (versionId: string): SectionRow[] =>
      sections.filter((section) => section.versionId === versionId);

    return rows.map(({ checklist, version }) => ({
      id: asChecklistTemplateId(checklist.id),
      name: checklist.name,
      description: checklist.description,
      jobTypeCode: checklist.jobTypeCode,
      version: version.version,
      status: version.status,
      sourceDocument: version.sourceDocument,
      sections: sectionsFor(version.id).map((section) => ({
        id: section.id,
        title: section.title,
        description: section.description,
        items: questions
          .filter((question) => question.sectionId === section.id)
          .map(toDomainItem),
      })),
      updatedAt: version.updatedAt,
    }));
  }
}
