import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  asChecklistTemplateId,
  asUserId,
  type ChecklistInstance,
  type ChecklistTemplate,
} from '@/domain';
import type { Database } from '@/db/client';
import * as schema from '@/db/schema';
import {
  installationChecklist,
  latheServiceChecklist,
  millingServiceChecklist,
  sourceChecklists,
} from '@/data/checklists/source-checklists';
import { PostgresChecklistTemplateRepository } from './checklist-template-repository';
import { PostgresJobRepository } from './job-repository';
import { openTestDatabase, testDatabaseUrl, truncateAll } from './test-database';
import { IDS, jobFixture, seedBaseline } from './test-fixtures';

/**
 * THE BUSINESS'S CHECKLISTS, IN POSTGRESQL. CHK-SRC-1, migration 0051.
 *
 * What is proved here, against a real PostgreSQL:
 *
 *  1. The rows migration 0051 writes ARE the transcription: read back through
 *     the repository, each of the three checklists equals
 *     `src/data/checklists/source-checklists.ts` field for field, row for row
 *     (`source-checklists.test.ts` proves that module equals the transcription
 *     record a person checks against the PDFs).
 *  2. Migration 0051 archives the demonstration wording and changes nothing a
 *     job answered: a completed checklist on the old wording reads back
 *     identically afterwards, and still renders its own version.
 *  3. The chosen checklist is recorded on the instance, and the database
 *     refuses a recorded kind that is not the version's own.
 *  4. Once a job has used a source checklist, its wording, section headings
 *     and printed layout are frozen.
 *
 * Every test truncates first, so the migration's DATA statements are re-run
 * from the migration file itself — the file the release applies.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

const MIGRATION = readFileSync(
  join(import.meta.dirname, '../../db/migrations/0051_source_checklists.sql'),
  'utf8',
);

/** The statements of 0051 from `marker` onwards (or up to `until`). */
const statementsBetween = (marker: string, until?: string): readonly string[] => {
  const start = MIGRATION.indexOf(marker);
  if (start === -1) throw new Error(`0051 has no "${marker}"`);
  const end = until === undefined ? MIGRATION.length : MIGRATION.indexOf(until, start);
  return MIGRATION.slice(start, end)
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.replace(/^--.*$/gmu, '').trim().length > 0);
};

const ARCHIVE_DEMO = statementsBetween('-- 5 (before 4', '-- 4. The three source checklists');
const INSERT_SOURCE = statementsBetween('-- 4. The three source checklists');

const comparable = (template: ChecklistTemplate) => ({ ...template, updatedAt: undefined });

describeDb('the source checklists in PostgreSQL (CHK-SRC-1)', () => {
  let db: Database;
  let templates: PostgresChecklistTemplateRepository;
  let jobs: PostgresJobRepository;

  const run = async (statements: readonly string[]) => {
    for (const statement of statements) await db.execute(sql.raw(statement));
  };

  beforeAll(async () => {
    db = await openTestDatabase(url ?? '');
  });

  afterAll(async () => {
    await db.execute(sql`select 1`);
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedBaseline(db);
    templates = new PostgresChecklistTemplateRepository(db);
    jobs = new PostgresJobRepository(db);
    await run(INSERT_SOURCE);
  });

  const jobOf = async (jobType: 'installation' | 'service', checklist: ChecklistInstance | null) => {
    const allocated = await jobs.allocateJobNumber();
    return jobFixture(allocated.jobNumber, {
      jobType,
      priority: 'normal',
      status: 'in_progress',
      primaryTechnicianId: asUserId(IDS.technician),
      scheduledDate: '2026-11-04',
      checklist,
    });
  };

  const started = (template: ChecklistTemplate, over: Partial<ChecklistInstance> = {}): ChecklistInstance => ({
    templateId: template.id,
    templateVersion: template.version,
    checklistKind: template.kind ?? null,
    responses: [],
    completedAt: null,
    completedBy: null,
    ...over,
  });

  describe('what migration 0051 writes', () => {
    it('is the transcription, field for field, for all three checklists', async () => {
      for (const expected of sourceChecklists) {
        const stored = await templates.findByVersion(expected.id, expected.version);
        expect(stored, expected.name).not.toBeNull();
        expect(comparable(stored!)).toEqual(comparable(expected));
      }
    });

    it('holds exactly 36, 39 and 41 rows, in the source order', async () => {
      const rows = async (template: ChecklistTemplate) => {
        const result = await db.execute<{ number: string; text: string }>(sql`
          select q.number, q.text
            from checklist_questions q
            join checklist_sections s on s.id = q.section_id
            join checklist_versions v on v.id = s.version_id
           where v.checklist_id = ${template.id}
           order by s.position, q.position
        `);
        return Array.from(result).map((row) => `${row.number}|${row.text}`);
      };
      const expected = (template: ChecklistTemplate) =>
        template.sections.flatMap((section) =>
          section.items.map((item) => `${item.number ?? ''}|${item.text}`),
        );

      expect(await rows(installationChecklist)).toHaveLength(36);
      expect(await rows(millingServiceChecklist)).toHaveLength(39);
      expect(await rows(latheServiceChecklist)).toHaveLength(41);
      for (const template of sourceChecklists) {
        expect(await rows(template)).toEqual(expected(template));
      }
    });

    it('issues Installation alone for installation, and Milling and Lathe for service', async () => {
      const installation = await templates.listCurrentForJobType('installation');
      const service = await templates.listCurrentForJobType('service');
      expect(installation.map((template) => template.kind)).toEqual(['installation']);
      expect(service.map((template) => template.kind)).toEqual(['service_milling', 'service_lathe']);
      expect(service.map((template) => template.selectionLabel)).toEqual([
        'Milling Machine / Machining Centre',
        'Lathe',
      ]);
    });

    it('keeps the handwritten Lathe line, marked as handwritten', async () => {
      const lathe = await templates.findByVersion(latheServiceChecklist.id, '1.0');
      const electrical = lathe!.sections.find((section) => section.title === 'ELECTRICAL')!;
      const handwritten = electrical.items.find(
        (item) => item.text === 'Changed Fanuc control battery',
      );
      expect(handwritten?.number).toBe('');
      expect(handwritten?.sourceNote).toBe('Handwritten on the supplied source.');
    });
  });

  describe('the demonstration wording it replaces', () => {
    const DEMO = asChecklistTemplateId('00000000-0000-4000-8000-0000000000d1');
    const DEMO_SECTION = '00000000-0000-4000-8000-0000000000d2';
    const DEMO_ITEM = '00000000-0000-4000-8000-0000000000d3';
    const demo: ChecklistTemplate = {
      id: DEMO,
      name: 'Preventative Service Checklist (DEMO)',
      description: '',
      jobTypeCode: 'service',
      version: '1.0-DEMO',
      status: 'current',
      sourceDocument: 'DEMO CONTENT — pending replacement',
      updatedAt: '2026-05-26T08:00:00.000Z',
      sections: [
        {
          id: DEMO_SECTION,
          title: 'Safety Systems',
          description: '',
          items: [
            {
              id: DEMO_ITEM,
              text: 'Emergency stop circuits tested',
              helpText: '',
              responseType: 'pass_fail_na',
              required: true,
              photoRequired: false,
              unit: null,
              expectedRange: null,
            },
          ],
        },
      ],
    };

    it('is archived, and a job completed on it reads back exactly as it was', async () => {
      // The state production is in before 0051: the demonstration version current
      // and a job that completed against it — and no source checklist yet.
      await truncateAll(db);
      await seedBaseline(db);
      await templates.save(demo);
      const completed: ChecklistInstance = {
        templateId: DEMO,
        templateVersion: '1.0-DEMO',
        checklistKind: null,
        responses: [
          {
            itemId: DEMO_ITEM,
            choice: 'fail',
            yesNo: null,
            measurement: null,
            text: '',
            notes: 'Guard switch loose.',
            fieldValues: {},
            photos: [],
            answeredAt: '2026-10-01T10:00:00.000Z',
            answeredBy: asUserId(IDS.technician),
          },
        ],
        completedAt: '2026-10-01T11:00:00.000Z',
        completedBy: asUserId(IDS.technician),
      };
      const job = await jobOf('service', null);
      await jobs.save({ ...job, checklist: { ...completed, completedAt: null, completedBy: null } });
      await jobs.save({ ...job, checklist: completed });
      const before = await jobs.findById(job.id);

      // 0051, in its own order: archive the demonstration wording, then issue.
      await run(ARCHIVE_DEMO);
      await run(INSERT_SOURCE);

      const after = await jobs.findById(job.id);
      expect(after?.checklist).toEqual(before?.checklist);
      const wording = await templates.findByVersion(DEMO, '1.0-DEMO');
      expect(wording?.status).toBe('archived');
      expect(wording?.sections[0]?.items[0]?.text).toBe('Emergency stop circuits tested');
      expect((await templates.listCurrentForJobType('service')).map((t) => t.kind)).toEqual([
        'service_milling',
        'service_lathe',
      ]);
    });
  });

  describe('a job on a source checklist', () => {
    it('records the checklist chosen, with the typed blanks, and reads them back', async () => {
      const item = installationChecklist.sections[0]!.items[1]!; // 2 Check electrical voltage
      const job = await jobOf(
        'installation',
        started(installationChecklist, {
          responses: [
            {
              itemId: item.id,
              choice: 'pass',
              yesNo: null,
              measurement: null,
              text: '',
              notes: '',
              fieldValues: { r: '401', s: '399', t: '400' },
              photos: [],
              answeredAt: '2026-11-04T09:00:00.000Z',
              answeredBy: asUserId(IDS.technician),
            },
          ],
        }),
      );
      await jobs.save(job);

      const read = await jobs.findById(job.id);
      expect(read?.checklist?.checklistKind).toBe('installation');
      expect(read?.checklist?.templateVersion).toBe('1.0');
      expect(read?.checklist?.responses[0]?.fieldValues).toEqual({ r: '401', s: '399', t: '400' });
    });

    it('stores Lathe for a Lathe choice and Milling for a Milling choice', async () => {
      const lathe = await jobOf('service', started(latheServiceChecklist));
      const milling = await jobOf('service', started(millingServiceChecklist));
      await jobs.save(lathe);
      await jobs.save(milling);
      expect((await jobs.findById(lathe.id))?.checklist?.checklistKind).toBe('service_lathe');
      expect((await jobs.findById(milling.id))?.checklist?.checklistKind).toBe('service_milling');
    });

    it('refuses a recorded kind that is not the version’s own checklist', async () => {
      // A Lathe label on Milling wording is exactly the confusion the choice exists to prevent.
      const job = await jobOf(
        'service',
        started(millingServiceChecklist, { checklistKind: 'service_lathe' }),
      );
      await expect(jobs.save(job)).rejects.toThrow();
    });

    it('takes a new Lathe version beside the used one, which keeps its wording and its job', async () => {
      const job = await jobOf('service', started(latheServiceChecklist));
      await jobs.save(job);
      const fresh = (prefix: string, index: number) =>
        `00000000-0000-4000-8${prefix}-${String(index).padStart(12, '0')}`;
      let n = 0;
      const v2: ChecklistTemplate = {
        ...latheServiceChecklist,
        version: '2.0',
        status: 'draft',
        sections: latheServiceChecklist.sections.map((section) => ({
          ...section,
          id: fresh('001', (n += 1)),
          items: section.items.map((item) => ({ ...item, id: fresh('002', (n += 1)) })),
        })),
      };
      await templates.save(v2);
      await templates.save({ ...latheServiceChecklist, status: 'archived' });
      await templates.save({ ...v2, status: 'current' });

      expect((await templates.listCurrentForJobType('service')).map((t) => `${t.kind}@${t.version}`)).toEqual([
        'service_milling@1.0',
        'service_lathe@2.0',
      ]);
      expect((await jobs.findById(job.id))?.checklist?.templateVersion).toBe('1.0');
      const used = await templates.findByVersion(latheServiceChecklist.id, '1.0');
      expect(comparable({ ...used!, status: 'current' })).toEqual(comparable(latheServiceChecklist));
    });

    it('takes a Fail on the tap, before its note, and will not complete the checklist until the note is there', async () => {
      const row = latheServiceChecklist.sections[1]!.items[5]!; // the handwritten battery line
      const answer = (notes: string) => ({
        itemId: row.id,
        choice: 'fail' as const,
        yesNo: null,
        measurement: null,
        text: '',
        notes,
        fieldValues: {},
        photos: [],
        answeredAt: '2026-11-04T09:00:00.000Z',
        answeredBy: asUserId(IDS.technician),
      });
      const job = await jobOf('service', started(latheServiceChecklist, { responses: [answer('')] }));
      await jobs.save(job); // the tap: Fail, no note yet — saved, not a server error
      expect((await jobs.findById(job.id))?.checklist?.responses[0]?.choice).toBe('fail');

      const complete = (notes: string): ChecklistInstance =>
        started(latheServiceChecklist, {
          responses: [answer(notes)],
          completedAt: '2026-11-04T10:00:00.000Z',
          completedBy: asUserId(IDS.technician),
        });
      await expect(jobs.save({ ...job, checklist: complete('') })).rejects.toThrow();
      expect((await jobs.findById(job.id))?.checklist?.completedAt).toBeNull();

      await jobs.save({ ...job, checklist: complete('Battery replaced.') });
      expect((await jobs.findById(job.id))?.checklist?.completedAt).not.toBeNull();

      // Nor can a checklist be written ALREADY complete with an unexplained Fail in it.
      const born = await jobOf('service', complete(''));
      await expect(jobs.save(born)).rejects.toThrow();
    });

    it('fills in the kind for a writer that sends none (the release before, after a rollback)', async () => {
      const job = await jobOf('service', started(latheServiceChecklist, { checklistKind: null }));
      await jobs.save(job);
      expect((await jobs.findById(job.id))?.checklist?.checklistKind).toBe('service_lathe');
    });

    it('freezes the wording, the headings and the printed layout once a job has used it', async () => {
      await jobs.save(await jobOf('service', started(latheServiceChecklist)));
      const section = latheServiceChecklist.sections[1]!;
      const question = section.items[5]!;

      await expect(
        db
          .update(schema.checklistQuestions)
          .set({ text: 'Changed control battery' })
          .where(eq(schema.checklistQuestions.id, question.id)),
      ).rejects.toThrow();
      await expect(
        db
          .update(schema.checklistSections)
          .set({ title: 'ELECTRICS' })
          .where(eq(schema.checklistSections.id, section.id)),
      ).rejects.toThrow();
      await expect(
        db
          .update(schema.checklistVersions)
          .set({ layout: { ...latheServiceChecklist.layout!, title: 'LATHE' } })
          .where(eq(schema.checklistVersions.checklistId, latheServiceChecklist.id)),
      ).rejects.toThrow();
      await expect(
        db
          .update(schema.checklists)
          .set({ kind: 'service_milling_2' })
          .where(eq(schema.checklists.id, latheServiceChecklist.id)),
      ).rejects.toThrow();

      // Archiving it stays possible: that withdraws it without touching the job.
      await db
        .update(schema.checklistVersions)
        .set({ status: 'archived' })
        .where(eq(schema.checklistVersions.checklistId, latheServiceChecklist.id));
      const archived = await templates.findByVersion(latheServiceChecklist.id, '1.0');
      expect(archived?.status).toBe('archived');
      expect(comparable({ ...archived!, status: 'current' })).toEqual(
        comparable(latheServiceChecklist),
      );
    });
  });
});
