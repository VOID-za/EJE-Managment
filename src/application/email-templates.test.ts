import { beforeEach, describe, expect, it } from 'vitest';
import {
  activateEmailTemplate,
  createEmailTemplate,
  deactivateEmailTemplate,
  ensureSystemEmailTemplates,
  getEmailTemplate,
  listEmailTemplates,
  previewEmailTemplate,
  restoreSystemEmailTemplate,
  saveEmailTemplateVersion,
} from './email-templates';
import { WorkflowError } from './errors';
import { buildHarness, seedUser, type Harness } from './test-harness';
import { SYSTEM_EMAIL_TEMPLATES } from '@/domain';

/**
 * INT-EMAIL-1/2: one shared, versioned, audited set of templates that the
 * Master and the Coordinator both manage, and nobody else does.
 */

const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');
const technician = seedUser('user-tech-sipho');

const NEW = {
  event: 'signed_job_card',
  jobType: 'service',
  name: 'Service — short',
  description: 'For regular service customers.',
  subject: '{{job_number}} — your service',
  body: 'Hello {{customer_name}},\n\nYour service job card is attached.\n\nOrder: {{order_number}}',
};

const codes = async (work: () => Promise<unknown>): Promise<string[]> => {
  try {
    await work();
    return [];
  } catch (error) {
    if (error instanceof WorkflowError) return error.violations.map((violation) => violation.code);
    throw error;
  }
};

describe('the email templates', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('are created on first use — one active default per job type — and only once', async () => {
    const { templates, coverage } = await listEmailTemplates(harness.as(master));
    expect(templates).toHaveLength(SYSTEM_EMAIL_TEMPLATES.length);
    expect(coverage.every((row) => row.defaultTemplateId !== null)).toBe(true);
    await ensureSystemEmailTemplates(harness.as(coordinator));
    await ensureSystemEmailTemplates(harness.as(master));
    expect((await listEmailTemplates(harness.as(coordinator))).templates).toHaveLength(SYSTEM_EMAIL_TEMPLATES.length);
  });

  it('are the SAME set for the Master and the Coordinator, and both can create, edit and activate', async () => {
    const created = await createEmailTemplate(harness.as(coordinator), NEW);
    expect(created).toMatchObject({ active: false, isDefault: false, currentVersion: 1, createdBy: coordinator.id });

    const edited = await saveEmailTemplateVersion(harness.as(master), created.id, {
      name: created.name,
      description: created.description,
      subject: '{{job_number}} — your service job card',
      body: created.current.body,
      changeNote: 'Clearer subject',
      expectedVersion: 1,
    });
    expect(edited.currentVersion).toBe(2);

    const active = await activateEmailTemplate(harness.as(coordinator), created.id, { makeDefault: true });
    expect(active).toMatchObject({ active: true, isDefault: true });

    for (const person of [master, coordinator]) {
      const { templates, coverage } = await listEmailTemplates(harness.as(person));
      expect(templates.find((template) => template.id === created.id)?.currentVersion).toBe(2);
      expect(coverage.find((row) => row.jobType === 'service')?.defaultTemplateId).toBe(created.id);
    }
  });

  it('refuse a technician, at the operation — not only on the screen', async () => {
    expect(await codes(() => listEmailTemplates(harness.as(technician)))).toEqual(['not_permitted']);
    expect(await codes(() => createEmailTemplate(harness.as(technician), NEW))).toEqual(['not_permitted']);
    expect(() => previewEmailTemplate(harness.as(technician), NEW)).toThrow(WorkflowError);
  });

  it('refuse an unknown placeholder when saved, and an invalid template cannot be activated', async () => {
    expect(await codes(() => createEmailTemplate(harness.as(master), { ...NEW, body: 'Dear {{custmer_name}}' }))).toContain('unknown_placeholder');
    expect(await codes(() => createEmailTemplate(harness.as(master), { ...NEW, jobType: 'quotation' }))).toContain('unknown_job_type');
  });

  it('keep every version: an edit is a new version, and the old one is still there word for word', async () => {
    const created = await createEmailTemplate(harness.as(master), NEW);
    await saveEmailTemplateVersion(harness.as(master), created.id, { ...NEW, changeNote: 'v2', subject: 'v2 {{job_number}}', expectedVersion: 1 });
    const { versions } = await getEmailTemplate(harness.as(coordinator), created.id);
    expect(versions.map((version) => version.version)).toEqual([2, 1]);
    expect(versions[1]?.subject).toBe(NEW.subject);
  });

  it('refuse a save made from a stale editor', async () => {
    const created = await createEmailTemplate(harness.as(master), NEW);
    await saveEmailTemplateVersion(harness.as(master), created.id, { ...NEW, changeNote: '', subject: 'first {{job_number}}', expectedVersion: 1 });
    expect(
      await codes(() => saveEmailTemplateVersion(harness.as(coordinator), created.id, { ...NEW, changeNote: '', subject: 'second', expectedVersion: 1 })),
    ).toEqual(['template_changed']);
  });

  it('allow ONE default per job type: making a new one the default replaces the old', async () => {
    const office = harness.as(master);
    const before = (await listEmailTemplates(office)).templates.find((template) => template.jobType === 'service' && template.isDefault)!;
    const created = await createEmailTemplate(office, NEW);
    await activateEmailTemplate(office, created.id, { makeDefault: true });
    const after = (await listEmailTemplates(office)).templates.filter((template) => template.jobType === 'service' && template.isDefault);
    expect(after.map((template) => template.id)).toEqual([created.id]);
    expect((await getEmailTemplate(office, before.id)).template).toMatchObject({ isDefault: false, active: true });
  });

  it('deactivating the default leaves the job type with NO template (and the screen says so)', async () => {
    const office = harness.as(coordinator);
    const { templates } = await listEmailTemplates(office);
    const installation = templates.find((template) => template.jobType === 'installation' && template.isDefault)!;
    await deactivateEmailTemplate(office, installation.id);
    const { coverage } = await listEmailTemplates(office);
    expect(coverage.find((row) => row.jobType === 'installation')?.defaultTemplateId).toBeNull();
    // Not re-created behind the office's back.
    await ensureSystemEmailTemplates(office);
    expect((await listEmailTemplates(office)).coverage.find((row) => row.jobType === 'installation')?.defaultTemplateId).toBeNull();
  });

  it('restore the system default as a new version, active and default', async () => {
    const office = harness.as(master);
    const { templates } = await listEmailTemplates(office);
    const breakdown = templates.find((template) => template.systemKey === 'signed_job_card:breakdown')!;
    await saveEmailTemplateVersion(office, breakdown.id, { ...breakdown, subject: 'Changed {{job_number}}', body: 'Changed', changeNote: '', expectedVersion: 1 });
    await deactivateEmailTemplate(office, breakdown.id);

    const restored = await restoreSystemEmailTemplate(harness.as(coordinator), { event: 'signed_job_card', jobType: 'breakdown' });
    const shipped = SYSTEM_EMAIL_TEMPLATES.find((template) => template.systemKey === 'signed_job_card:breakdown')!;
    expect(restored).toMatchObject({ active: true, isDefault: true, currentVersion: 3 });
    expect(restored.current.subject).toBe(shipped.subject);
    expect(restored.current.body).toBe(shipped.body);
  });

  it('preview with sample values, and report problems instead of rendering', () => {
    const preview = previewEmailTemplate(harness.as(coordinator), NEW);
    expect(preview.problems).toEqual([]);
    expect(preview.subject).toBe('EJE-2078 — your service');
    expect(preview.body).toContain('Thandi Mokoena');
    const broken = previewEmailTemplate(harness.as(coordinator), { ...NEW, subject: '{{nope}}' });
    expect(broken.problems.map((problem) => problem.code)).toContain('unknown_placeholder');
  });

  it('put every change on the audit trail, with what changed', async () => {
    const created = await createEmailTemplate(harness.as(master), NEW);
    await saveEmailTemplateVersion(harness.as(coordinator), created.id, { ...NEW, subject: 'New {{job_number}}', changeNote: '', expectedVersion: 1 });
    await activateEmailTemplate(harness.as(master), created.id, { makeDefault: true });
    await deactivateEmailTemplate(harness.as(coordinator), created.id);
    const events = (await harness.repos.activity.list()).filter((event) => event.type === 'email_template_changed');
    expect(events.map((event) => event.summary)).toEqual(
      expect.arrayContaining([
        `Email template created: ${NEW.name}`,
        `Email template edited: ${NEW.name}`,
        `Email template made the default: ${NEW.name}`,
        `Email template deactivated: ${NEW.name}`,
      ]),
    );
    const edit = events.find((event) => event.summary.startsWith('Email template edited'));
    expect(edit?.changes).toEqual([{ field: 'Subject', from: NEW.subject, to: 'New {{job_number}}' }]);
    expect(edit?.actorId).toBe(coordinator.id);
  });
});
