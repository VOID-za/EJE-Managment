import {
  asChecklistTemplateId,
  can,
  editInPlaceRefusal,
  nextVersion,
  userFullName,
  type ChecklistTemplate,
  type TemplateUsage,
} from '@/domain';
import type { OperationContext } from './context';
import { audit } from './audit';
import { WorkflowError } from './errors';

/**
 * Checklist administration.
 *
 * The rule that governs every operation here: a version a job has completed
 * against is immutable. Historical job cards render the exact wording the
 * customer saw, so a Master publishes a NEW version rather than editing a used
 * one, and retiring a version archives it rather than destroying it.
 */
const assertOffice = (context: OperationContext): void => {
  // `settings.checklists`, not `admin.access`: the owner asked for the office —
  // Master and Coordinator — to maintain the checklists, and for nothing else
  // of the system settings to come with it. A technician completes a checklist
  // and never edits one. The rule that a USED version is immutable is below,
  // and applies to every role alike.
  if (can(context.actor.role, 'settings.checklists')) return;
  throw new WorkflowError('Only the office can administer checklists.', [
    {
      code: 'not_permitted',
      message: 'Checklist administration is done by a Senior Tech or the Office.',
    },
  ]);
};

/** Every (template, version) pair any job has recorded. */
export const loadTemplateUsage = async (
  context: OperationContext,
): Promise<readonly TemplateUsage[]> => {
  const jobs = await context.repos.jobs.list();
  return jobs
    .map((job) => job.checklist)
    .filter((checklist) => checklist !== null)
    .map((checklist) => ({
      templateId: checklist.templateId,
      templateVersion: checklist.templateVersion,
    }));
};

export interface NewTemplateInput {
  readonly name: string;
  readonly description: string;
  readonly jobTypeCode: string;
  readonly sourceDocument: string;
}

export const createTemplate = async (
  context: OperationContext,
  input: NewTemplateInput,
): Promise<ChecklistTemplate> => {
  assertOffice(context);
  const name = input.name.trim();
  if (name.length === 0) {
    throw new WorkflowError('A checklist name is required.', [
      { code: 'name_required', message: 'Give the checklist a name technicians will recognise.' },
    ]);
  }

  const template: ChecklistTemplate = {
    id: asChecklistTemplateId(context.services.ids.next('chk')),
    name,
    description: input.description.trim(),
    jobTypeCode: input.jobTypeCode,
    version: '1.0',
    // New checklists start as a draft, so a half-written one is never issued.
    status: 'draft',
    sourceDocument: input.sourceDocument.trim(),
    sections: [],
    updatedAt: context.services.clock.now(),
  };

  const saved = await context.repos.checklistTemplates.save(template);
  await audit(context, {
    jobId: null,
    type: 'checklist_template_created',
    summary: `Checklist created: ${saved.name}`,
    detail: `Version ${saved.version} created as a draft for ${saved.jobTypeCode} jobs.`,
  });
  return saved;
};

/**
 * Saves edited wording back onto the same version.
 *
 * Refused once a job has completed against that version — the caller publishes
 * a new version instead.
 */
export const saveTemplateDraft = async (
  context: OperationContext,
  template: ChecklistTemplate,
): Promise<ChecklistTemplate> => {
  assertOffice(context);
  const usage = await loadTemplateUsage(context);
  const refusal = editInPlaceRefusal(template, usage);
  if (refusal !== null) {
    throw new WorkflowError(refusal, [
      {
        code: 'version_in_use',
        message: 'A completed job card must keep rendering the wording the customer signed.',
      },
    ]);
  }

  const saved = await context.repos.checklistTemplates.save({
    ...template,
    updatedAt: context.services.clock.now(),
  });
  await audit(context, {
    jobId: null,
    type: 'checklist_template_updated',
    summary: `Checklist updated: ${saved.name}`,
    detail: `Version ${saved.version} amended by ${userFullName(context.actor)}.`,
  });
  return saved;
};

/**
 * Publishes a draft, making it the version issued to new jobs.
 *
 * The version it replaces is archived, not deleted: jobs already completed
 * against it keep resolving it through `findByVersion`.
 */
export const publishTemplate = async (
  context: OperationContext,
  template: ChecklistTemplate,
): Promise<ChecklistTemplate> => {
  assertOffice(context);
  if (template.sections.length === 0) {
    throw new WorkflowError('A checklist with no items cannot be issued.', [
      { code: 'no_items', message: 'Add at least one section with one item first.' },
    ]);
  }

  /*
   * WHAT A NEW VERSION SUPERSEDES: its own SLOT — the same job type and the
   * same kind of checklist. It used to be every current checklist of the job
   * type, which was right while each type had one; Service now has two
   * (Milling and Lathe, CHK-SRC-1), and publishing a new Lathe version must not
   * withdraw the Milling checklist.
   */
  const all = await context.repos.checklistTemplates.list();
  /*
   * A JOB TYPE WITH THE BUSINESS'S OWN CHECKLISTS TAKES NO OTHER KIND. CHK-SRC-2.
   * Installation and Service are issued as the source checklists, each of a
   * kind; issuing a checklist of NO kind beside them — the archived
   * demonstration wording, or a new one — would put a generic checklist back
   * on the Service choice screen. A revision of a source checklist is a new
   * version of it ("New version"), which keeps its kind.
   */
  if (
    (template.kind ?? null) === null &&
    all.some(
      (candidate) => candidate.jobTypeCode === template.jobTypeCode && (candidate.kind ?? null) !== null,
    )
  ) {
    throw new WorkflowError(`${template.name} cannot be issued: this job type uses the source checklists.`, [
      {
        code: 'checklist_kind_required',
        message:
          'Revise one of the source checklists with "New version" instead; a checklist of no kind would be offered beside them.',
      },
    ]);
  }
  const superseded = all.filter(
    (candidate) =>
      candidate.jobTypeCode === template.jobTypeCode &&
      (candidate.kind ?? null) === (template.kind ?? null) &&
      candidate.status === 'current' &&
      !(candidate.id === template.id && candidate.version === template.version),
  );

  for (const previous of superseded) {
    await context.repos.checklistTemplates.save({ ...previous, status: 'archived' });
  }

  const saved = await context.repos.checklistTemplates.save({
    ...template,
    status: 'current',
    updatedAt: context.services.clock.now(),
  });

  await audit(context, {
    jobId: null,
    type: 'checklist_template_versioned',
    summary: `Checklist issued: ${saved.name} v${saved.version}`,
    detail:
      superseded.length === 0
        ? `Version ${saved.version} is now issued to new ${saved.jobTypeCode} jobs.`
        : `Version ${saved.version} is now issued to new ${saved.jobTypeCode} jobs. ` +
          `${superseded.map((previous) => `v${previous.version}`).join(', ')} archived — completed jobs still render it.`,
  });
  return saved;
};

/**
 * Starts a new draft version from an existing one.
 *
 * This is the safe alternative to editing a used version: the wording is copied
 * forward and the original is left exactly as the customer saw it.
 */
export const startNewVersion = async (
  context: OperationContext,
  template: ChecklistTemplate,
): Promise<ChecklistTemplate> => {
  assertOffice(context);

  const all = await context.repos.checklistTemplates.list();
  const family = all.filter((candidate) => candidate.id === template.id);
  let version = nextVersion(template.version);
  while (family.some((candidate) => candidate.version === version)) {
    version = nextVersion(version);
  }

  /*
   * THE COPY IS NEW WORDING, SO IT HAS NEW IDS. Sections and questions are
   * keyed by id — primary keys in PostgreSQL — and the copy used to carry the
   * original's, so saving it collided with the version it was copied from and
   * a new version could not be started at all on the live database. Answers
   * belong to a question id, which is what keeps them on the version they
   * answered. CHK-SRC-1.
   */
  const draft: ChecklistTemplate = {
    ...template,
    version,
    status: 'draft',
    updatedAt: context.services.clock.now(),
    sections: template.sections.map((section) => ({
      ...section,
      id: context.services.ids.next('chks'),
      items: section.items.map((item) => ({ ...item, id: context.services.ids.next('chki') })),
    })),
  };

  const saved = await context.repos.checklistTemplates.save(draft);
  await audit(context, {
    jobId: null,
    type: 'checklist_template_versioned',
    summary: `Checklist version started: ${saved.name} v${saved.version}`,
    detail: `Copied from v${template.version}, which is unchanged and still renders on completed jobs.`,
  });
  return saved;
};

/**
 * Retires a version.
 *
 * Deliberately NOT a delete. Archiving keeps the version resolvable, so a job
 * card completed against it still renders; a hard delete would blank out
 * signed paperwork.
 */
export const archiveTemplate = async (
  context: OperationContext,
  template: ChecklistTemplate,
): Promise<ChecklistTemplate> => {
  assertOffice(context);

  const saved = await context.repos.checklistTemplates.save({
    ...template,
    status: 'archived',
    updatedAt: context.services.clock.now(),
  });
  await audit(context, {
    jobId: null,
    type: 'checklist_template_archived',
    summary: `Checklist archived: ${saved.name} v${saved.version}`,
    detail:
      'The version is no longer issued to new jobs. It is retained so completed job cards still render it.',
  });
  return saved;
};
