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
import { PostgresChecklistTemplateRepository } from './checklist-template-repository';
import { PostgresJobRepository } from './job-repository';
import { openTestDatabase, testDatabaseUrl, truncateAll } from './test-database';
import { IDS, jobFixture, seedBaseline } from './test-fixtures';

/**
 * Checklists, in PostgreSQL.
 *
 * The property that matters is the one the demo could only promise: a job card
 * completed against v1.0 keeps rendering v1.0 for ever. Here it is structural —
 * `checklist_instances.version_id` is a foreign key with `on delete restrict`,
 * a trigger refuses to edit wording a job has used, and another refuses to
 * touch a completed instance at all.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

describeDb('checklists in PostgreSQL', () => {
  let db: Database;
  let templates: PostgresChecklistTemplateRepository;
  let jobs: PostgresJobRepository;

  const TEMPLATE = asChecklistTemplateId('00000000-0000-4000-8000-000000000100');
  const SECTION_V1 = '00000000-0000-4000-8000-000000000101';
  const ITEM_V1 = '00000000-0000-4000-8000-000000000102';
  const SECTION_V2 = '00000000-0000-4000-8000-000000000103';
  const ITEM_V2 = '00000000-0000-4000-8000-000000000104';

  const version1 = (over: Partial<ChecklistTemplate> = {}): ChecklistTemplate => ({
    id: TEMPLATE,
    name: 'Service checklist',
    description: 'Planned preventative maintenance.',
    jobTypeCode: 'service',
    version: '1.0',
    status: 'current',
    sourceDocument: 'EJE-SRV-001 Rev 3',
    sections: [
      {
        id: SECTION_V1,
        title: 'Spindle',
        description: '',
        items: [
          {
            id: ITEM_V1,
            text: 'Spindle runout measured at the nose',
            helpText: 'Dial gauge on the taper.',
            responseType: 'measurement',
            required: true,
            photoRequired: false,
            unit: 'mm',
            expectedRange: { min: 0, max: 0.01 },
          },
        ],
      },
    ],
    updatedAt: '2026-01-10T08:00:00.000Z',
    ...over,
  });

  const version2 = (): ChecklistTemplate => ({
    ...version1(),
    version: '2.0',
    status: 'current',
    sourceDocument: 'EJE-SRV-001 Rev 4',
    sections: [
      {
        id: SECTION_V2,
        title: 'Spindle and drawbar',
        description: 'Reworded after the 2026 review.',
        items: [
          {
            id: ITEM_V2,
            text: 'Drawbar force checked against the manufacturer’s figure',
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
    updatedAt: '2026-06-01T08:00:00.000Z',
  });

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
  });

  describe('the templates', () => {
    it('round trips a version with its sections, items and measurement range', async () => {
      const saved = await templates.save(version1());

      expect(saved.sections).toHaveLength(1);
      const item = saved.sections[0]?.items[0];
      expect(item?.text).toContain('runout');
      expect(item?.unit).toBe('mm');
      expect(item?.expectedRange).toEqual({ min: 0, max: 0.01 });
    });

    it('offers only the current version to a new job of that type', async () => {
      await templates.save(version1());
      const current = await templates.findForJobType('service');
      expect(current?.version).toBe('1.0');

      // Publishing v2.0 archives v1.0 first; one version per checklist may be
      // current, and the schema enforces it.
      await templates.save({ ...version1(), status: 'archived' });
      await templates.save(version2());

      const after = await templates.findForJobType('service');
      expect(after?.version).toBe('2.0');
      expect(after?.sections[0]?.title).toBe('Spindle and drawbar');
    });

    it('still resolves the exact wording a historical job answered', async () => {
      await templates.save(version1());
      await templates.save({ ...version1(), status: 'archived' });
      await templates.save(version2());

      const historical = await templates.findByVersion(TEMPLATE, '1.0');
      expect(historical?.sections[0]?.items[0]?.text).toContain('runout');
      expect(historical?.status).toBe('archived');
      expect(historical?.sourceDocument).toBe('EJE-SRV-001 Rev 3');
    });

    it('refuses two versions of one checklist being current at once', async () => {
      await templates.save(version1());
      await expect(templates.save(version2())).rejects.toThrow();
    });

    it('lists every version, because a version is the unit', async () => {
      await templates.save(version1());
      await templates.save({ ...version1(), status: 'archived' });
      await templates.save(version2());

      const all = await templates.list();
      expect(all.map((entry) => entry.version).sort()).toEqual(['1.0', '2.0']);
    });
  });

  describe('a job’s answered checklist', () => {
    const answered = (version: string, itemId: string): ChecklistInstance => ({
      templateId: TEMPLATE,
      templateVersion: version,
      responses: [
        {
          itemId,
          choice: null,
          yesNo: null,
          measurement: 0.004,
          text: '',
          notes: 'Within tolerance.',
          photos: [],
          answeredAt: '2026-09-20T11:00:00.000Z',
          answeredBy: asUserId(IDS.technician),
        },
      ],
      completedAt: null,
      completedBy: null,
    });

    const serviceJob = async (checklist: ChecklistInstance | null) => {
      const allocated = await jobs.allocateJobNumber();
      return jobFixture(allocated.jobNumber, {
        jobType: 'service',
        priority: 'normal',
        status: 'in_progress',
        primaryTechnicianId: asUserId(IDS.technician),
        scheduledDate: '2026-09-20',
        checklist,
      });
    };

    it('round trips the answers with the job', async () => {
      await templates.save(version1());
      const job = await serviceJob(answered('1.0', ITEM_V1));
      await jobs.save(job);

      const read = await jobs.findById(job.id);
      expect(read?.checklist?.templateVersion).toBe('1.0');
      expect(read?.checklist?.responses[0]?.measurement).toBe(0.004);
      expect(read?.checklist?.responses[0]?.notes).toBe('Within tolerance.');
    });

    it('keeps a job on v1.0 after v2.0 becomes current', async () => {
      await templates.save(version1());
      const job = await serviceJob(answered('1.0', ITEM_V1));
      await jobs.save(job);

      await templates.save({ ...version1(), status: 'archived' });
      await templates.save(version2());

      const read = await jobs.findById(job.id);
      expect(read?.checklist?.templateVersion).toBe('1.0');

      const wording = await templates.findByVersion(TEMPLATE, '1.0');
      expect(wording?.sections[0]?.items[0]?.text).toContain('runout');
    });

    it('will not let the version a job used be removed', async () => {
      await templates.save(version1());
      await jobs.save(await serviceJob(answered('1.0', ITEM_V1)));

      await expect(
        db.delete(schema.checklistVersions).where(eq(schema.checklistVersions.version, '1.0')),
      ).rejects.toThrow();
    });

    it('will not let the wording a job answered be reworded in place', async () => {
      await templates.save(version1());
      await jobs.save(await serviceJob(answered('1.0', ITEM_V1)));

      await expect(
        db
          .update(schema.checklistQuestions)
          .set({ text: 'Something the customer never saw' })
          .where(eq(schema.checklistQuestions.id, ITEM_V1)),
      ).rejects.toThrow();
    });

    it('freezes a completed checklist against any later write', async () => {
      await templates.save(version1());
      const job = await serviceJob(answered('1.0', ITEM_V1));
      await jobs.save(job);

      const completed = {
        ...answered('1.0', ITEM_V1),
        completedAt: '2026-09-20T12:00:00.000Z',
        completedBy: asUserId(IDS.technician),
      };
      await jobs.save({ ...job, checklist: completed });

      // A later save carrying different answers changes nothing.
      await jobs.save({
        ...job,
        checklist: {
          ...completed,
          responses: [{ ...completed.responses[0]!, measurement: 9.999, notes: 'Rewritten' }],
        },
      });

      const read = await jobs.findById(job.id);
      expect(read?.checklist?.completedAt).toBe('2026-09-20T12:00:00.000Z');
      expect(read?.checklist?.responses[0]?.measurement).toBe(0.004);
      expect(read?.checklist?.responses[0]?.notes).toBe('Within tolerance.');
    });

    it('refuses a failed check with no explanation, at the database', async () => {
      await templates.save(version2());
      const job = await serviceJob({
        templateId: TEMPLATE,
        templateVersion: '2.0',
        responses: [
          {
            itemId: ITEM_V2,
            choice: 'fail',
            yesNo: null,
            measurement: null,
            text: '',
            notes: '',
            photos: [],
            answeredAt: '2026-09-20T11:00:00.000Z',
            answeredBy: asUserId(IDS.technician),
          },
        ],
        completedAt: null,
        completedBy: null,
      });

      await expect(jobs.save(job)).rejects.toThrow();
    });

    it('refuses to store answers against a version it does not hold', async () => {
      await templates.save(version1());
      const job = await serviceJob(answered('9.9', ITEM_V1));
      await expect(jobs.save(job)).rejects.toThrow(/is not held/);
    });

    it('does not destroy captured answers when a save happens to carry none', async () => {
      await templates.save(version1());
      const job = await serviceJob(answered('1.0', ITEM_V1));
      await jobs.save(job);

      await jobs.save({ ...job, checklist: null, faultDescription: 'Amended by the office.' });

      const read = await jobs.findById(job.id);
      expect(read?.faultDescription).toBe('Amended by the office.');
      expect(read?.checklist?.responses).toHaveLength(1);
    });
  });
});
