import { beforeEach, describe, expect, it } from 'vitest';
import {
  archiveTemplate,
  createTemplate,
  loadTemplateUsage,
  publishTemplate,
  saveTemplateDraft,
  startNewVersion,
} from './checklist-admin';
import { WorkflowError } from './errors';
import { buildHarness, seedUser, type Harness } from './test-harness';
import { asChecklistTemplateId, canEditInPlace, type ChecklistTemplate } from '@/domain';
import { latheServiceChecklist } from '@/data/checklists/source-checklists';

/**
 * Checklist administration.
 *
 * The rule under test throughout: a version a job has completed against is
 * immutable, because its job card is rendered from that exact version. A Master
 * publishes a new version rather than rewriting a signed one, and retiring a
 * version archives it rather than destroying it.
 */
const elmarie = seedUser('user-master-elmarie');
const sipho = seedUser('user-tech-sipho');

const templateNamed = async (harness: Harness, id: string, version: string) => {
  const templates = await harness.repos.checklistTemplates.list();
  const match = templates.find(
    (template) => template.id === id && template.version === version,
  );
  if (match === undefined) throw new Error(`${id} v${version} is not seeded`);
  return match;
};

describe('creating and issuing a checklist', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('creates a draft that is not yet issued to jobs', async () => {
    const created = await createTemplate(harness.as(elmarie), {
      name: 'Press Brake Safety Check',
      description: 'Light curtain and guarding verification.',
      jobTypeCode: 'breakdown',
      sourceDocument: 'EJE internal procedure',
    });

    expect(created.status).toBe('draft');
    const issued = await harness.repos.checklistTemplates.listCurrentForJobType('breakdown');
    expect(issued).toEqual([]);
  });

  it('refuses to issue a checklist with no items', async () => {
    const created = await createTemplate(harness.as(elmarie), {
      name: 'Empty',
      description: '',
      jobTypeCode: 'breakdown',
      sourceDocument: '',
    });
    await expect(
      publishTemplate(harness.as(elmarie), created),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('issues a completed draft for a job type without source checklists', async () => {
    const draft = await createTemplate(harness.as(elmarie), {
      name: 'Replacement Service Checklist',
      description: '',
      jobTypeCode: 'breakdown',
      sourceDocument: 'EJE approved wording',
    });
    const withItems: ChecklistTemplate = {
      ...draft,
      sections: [
        {
          id: 'sec-1',
          title: 'Safety',
          description: '',
          items: [
            {
              id: 'item-1',
              text: 'Machine isolated and locked out',
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
    await saveTemplateDraft(harness.as(elmarie), withItems);
    const issued = await publishTemplate(harness.as(elmarie), withItems);

    expect(issued.status).toBe('current');
    const forBreakdown = await harness.repos.checklistTemplates.listCurrentForJobType('breakdown');
    expect(forBreakdown.map((template) => template.id)).toEqual([issued.id]);
  });

  /*
   * CHK-SRC-2. Installation and Service are issued as the source checklists;
   * a checklist of no kind — a new one, or the archived demonstration wording
   * re-issued — would be offered as a generic checklist beside them.
   */
  it('refuses to issue a checklist of no kind beside the source checklists, new or archived', async () => {
    const draft = await createTemplate(harness.as(elmarie), {
      name: 'Generic Service Checklist',
      description: '',
      jobTypeCode: 'service',
      sourceDocument: '',
    });
    const withItems: ChecklistTemplate = {
      ...draft,
      sections: [{ id: 'sec-g', title: 'Safety', description: '', items: [{ id: 'item-g', text: 'Isolated', helpText: '', responseType: 'pass_fail_na', required: true, photoRequired: false, unit: null, expectedRange: null }] }],
    };
    await saveTemplateDraft(harness.as(elmarie), withItems);
    await expect(publishTemplate(harness.as(elmarie), withItems)).rejects.toBeInstanceOf(WorkflowError);
    const demo = await templateNamed(harness, 'chk-service', '2.0-DEMO');
    await expect(publishTemplate(harness.as(elmarie), demo)).rejects.toBeInstanceOf(WorkflowError);
    const current = await harness.repos.checklistTemplates.listCurrentForJobType('service');
    expect(current.map((template) => template.kind)).toEqual(['service_milling', 'service_lathe']);
  });

  /*
   * CHK-SRC-1. Service has two checklists, Milling and Lathe. Publishing a new
   * Lathe version supersedes the Lathe version — and ONLY it. It used to
   * archive every current checklist of the job type, which would have
   * silently withdrawn the Milling checklist.
   */
  it('a new Lathe version supersedes the Lathe version and leaves Milling issued', async () => {
    const lathe = await templateNamed(harness, latheServiceChecklist.id, '1.0');
    const draft = await startNewVersion(harness.as(elmarie), lathe);
    expect(draft.version).toBe('2.0');
    expect(draft.kind).toBe('service_lathe');
    // The same wording, under ids of its own: the copy is a new version.
    const texts = (template: ChecklistTemplate) =>
      template.sections.flatMap((section) => section.items.map((item) => item.text));
    expect(texts(draft)).toEqual(texts(lathe));
    const ids = (template: ChecklistTemplate) =>
      template.sections.flatMap((section) => [section.id, ...section.items.map((item) => item.id)]);
    expect(ids(draft).some((id) => ids(lathe).includes(id))).toBe(false);
    await publishTemplate(harness.as(elmarie), draft);

    const current = await harness.repos.checklistTemplates.listCurrentForJobType('service');
    expect(current.map((template) => `${template.kind}@${template.version}`)).toEqual([
      'service_milling@1.0',
      'service_lathe@2.0',
    ]);
    expect((await templateNamed(harness, latheServiceChecklist.id, '1.0')).status).toBe('archived');
  });

  it('refuses a technician administering checklists', async () => {
    await expect(
      createTemplate(harness.as(sipho), {
        name: 'Unauthorised',
        description: '',
        jobTypeCode: 'service',
        sourceDocument: '',
      }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });
});

describe('a version a job has completed against', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('is reported as in use', async () => {
    const usage = await loadTemplateUsage(harness.as(elmarie));
    expect(
      usage.some(
        (used) =>
          used.templateId === asChecklistTemplateId('chk-service') &&
          used.templateVersion === '1.0-DEMO',
      ),
    ).toBe(true);
  });

  it('cannot be edited in place', async () => {
    const used = await templateNamed(harness, 'chk-service', '1.0-DEMO');
    const usage = await loadTemplateUsage(harness.as(elmarie));
    expect(canEditInPlace(used, usage)).toBe(false);

    await expect(
      saveTemplateDraft(harness.as(elmarie), { ...used, name: 'Rewritten wording' }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('still renders on the job that used it after a new version is issued', async () => {
    // CHK-SRC-2: a new version of a SOURCE checklist (the demonstration wording
    // can no longer be issued beside them).
    const used = await templateNamed(harness, latheServiceChecklist.id, '1.0');
    const draft = await startNewVersion(harness.as(elmarie), used);
    await publishTemplate(harness.as(elmarie), draft);

    // The historical read path: resolve by the version stored on the job.
    const resolved = await harness.repos.checklistTemplates.findByVersion(
      latheServiceChecklist.id,
      '1.0',
    );
    expect(resolved).not.toBeNull();
    expect(resolved?.sections).toEqual(used.sections);
  });

  it('survives being archived, so signed job cards keep rendering', async () => {
    const used = await templateNamed(harness, 'chk-service', '1.0-DEMO');
    await archiveTemplate(harness.as(elmarie), used);

    const resolved = await harness.repos.checklistTemplates.findByVersion(
      asChecklistTemplateId('chk-service'),
      '1.0-DEMO',
    );
    expect(resolved).not.toBeNull();
    expect(resolved?.status).toBe('archived');
    expect(resolved?.sections).toEqual(used.sections);
  });
});

describe('starting a new version', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('copies the wording forward and leaves the original untouched', async () => {
    const used = await templateNamed(harness, 'chk-service', '1.0-DEMO');
    const draft = await startNewVersion(harness.as(elmarie), used);

    expect(draft.status).toBe('draft');
    expect(draft.version).not.toBe(used.version);
    // The same wording under new ids — the copy is a new version (CHK-SRC-1).
    const wording = (template: ChecklistTemplate) =>
      template.sections.map(({ id: _section, items, ...section }) => ({
        ...section,
        items: items.map(({ id: _item, ...item }) => item),
      }));
    expect(wording(draft)).toEqual(wording(used));

    const original = await templateNamed(harness, 'chk-service', '1.0-DEMO');
    expect(original.sections).toEqual(used.sections);
    expect(original.status).toBe('archived');
  });

  it('gives the new draft a version that does not already exist', async () => {
    const current = await templateNamed(harness, 'chk-service', '2.0-DEMO');
    const draft = await startNewVersion(harness.as(elmarie), current);

    const all = await harness.repos.checklistTemplates.list();
    const sameVersion = all.filter(
      (template) => template.id === draft.id && template.version === draft.version,
    );
    expect(sameVersion).toHaveLength(1);
  });

  it('can be edited freely, because no job has used it', async () => {
    const used = await templateNamed(harness, 'chk-service', '1.0-DEMO');
    const draft = await startNewVersion(harness.as(elmarie), used);

    const saved = await saveTemplateDraft(harness.as(elmarie), {
      ...draft,
      description: 'Revised for the 2026 service schedule.',
    });
    expect(saved.description).toBe('Revised for the 2026 service schedule.');
  });
});
