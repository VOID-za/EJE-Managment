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
    const issued = await harness.repos.checklistTemplates.findForJobType('breakdown');
    expect(issued).toBeNull();
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

  it('issues a completed draft and archives what it replaces', async () => {
    const draft = await createTemplate(harness.as(elmarie), {
      name: 'Replacement Service Checklist',
      description: '',
      jobTypeCode: 'service',
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
    const forService = await harness.repos.checklistTemplates.findForJobType('service');
    expect(forService?.id).toBe(issued.id);

    // The previously current version is archived, not removed.
    const previous = await templateNamed(harness, 'chk-service', '2.0-DEMO');
    expect(previous.status).toBe('archived');
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
    const used = await templateNamed(harness, 'chk-service', '1.0-DEMO');
    const draft = await startNewVersion(harness.as(elmarie), used);
    await publishTemplate(harness.as(elmarie), draft);

    // The historical read path: resolve by the version stored on the job.
    const resolved = await harness.repos.checklistTemplates.findByVersion(
      asChecklistTemplateId('chk-service'),
      '1.0-DEMO',
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
    expect(draft.sections).toEqual(used.sections);

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
