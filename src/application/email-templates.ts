import {
  EMAIL_EVENTS,
  SAMPLE_PLACEHOLDER_VALUES,
  SYSTEM_EMAIL_TEMPLATES,
  can,
  emailEventDefinition,
  getJobTypeDefinition,
  isEmailEvent,
  renderEmailBody,
  renderEmailSubject,
  userFullName,
  validateEmailTemplate,
  type EmailEvent,
  type EmailTemplate,
  type EmailTemplateVersion,
  type EmailTemplateWithVersion,
  type IsoDateTime,
  type JobTypeCode,
  type PlaceholderValues,
  type SystemTemplate,
  type TemplateProblem,
} from '@/domain';
import type { OperationContext } from './context';
import { audit } from './audit';
import { WorkflowError } from './errors';

/**
 * THE OFFICE'S EMAIL TEMPLATES. INT-EMAIL-1/2 (the owner, 1 November 2026).
 *
 * One shared set, kept in the database, the same for the Master and the
 * Coordinator (`emailTemplates.manage`, both office roles). Every save is a
 * NEW VERSION — a version is never edited, so an email already composed from
 * version 3 still says exactly what version 3 said. Every change is on the
 * audit trail.
 *
 * Which template a signed job card uses is never a guess: the ONE active
 * default for its event and job type (the database allows no second default,
 * and no inactive default). If there is none, the email is not composed and
 * the job is flagged for the office — see `customer-email.ts`.
 */

const refuse = (message: string, code: string, detail: string): WorkflowError =>
  new WorkflowError(message, [{ code, message: detail }]);

const assertManages = (context: OperationContext): void => {
  if (!can(context.actor.role, 'emailTemplates.manage')) {
    throw refuse(
      'Only the office manages email templates.',
      'not_permitted',
      'A Master or a Coordinator manages the customer email templates.',
    );
  }
};

const problemsError = (problems: readonly TemplateProblem[]): WorkflowError =>
  new WorkflowError(
    'The template cannot be saved like this.',
    problems.map((problem) => ({ code: problem.code, message: problem.message })),
  );

const jobTypeLabel = (jobType: JobTypeCode): string => getJobTypeDefinition(jobType).label;

const describe = (template: Pick<EmailTemplate, 'name' | 'event' | 'jobType'>): string =>
  `“${template.name}” (${emailEventDefinition(template.event).label}, ${jobTypeLabel(template.jobType)})`;

/* -------------------------------------------------------------------------- */
/* The templates EJE ships                                                    */
/* -------------------------------------------------------------------------- */

const systemTemplateRecord = (
  context: OperationContext,
  system: SystemTemplate,
  now: IsoDateTime,
  isDefault: boolean,
): { template: EmailTemplate; version: EmailTemplateVersion } => {
  const id = context.services.ids.next('etpl');
  return {
    template: {
      id,
      event: system.event,
      jobType: system.jobType,
      name: system.name,
      description: 'Supplied with EJE. Edit it freely; “Restore system default” brings these words back.',
      active: true,
      isDefault,
      currentVersion: 1,
      systemKey: system.systemKey,
      createdAt: now,
      createdBy: null,
      updatedAt: now,
      updatedBy: null,
    },
    version: {
      id: context.services.ids.next('etplv'),
      templateId: id,
      version: 1,
      subject: system.subject,
      body: system.body,
      changeNote: 'System default.',
      createdAt: now,
      createdBy: null,
    },
  };
};

/**
 * Creates any shipped template that has never existed. Safe to run on every
 * request, from several at once: a template whose system key exists — even a
 * deactivated one the office switched off on purpose — is never created again,
 * and the store refuses a second default rather than this guessing.
 */
export const ensureSystemEmailTemplates = async (context: OperationContext): Promise<void> => {
  const existing = await context.repos.emailTemplates.list();
  const now = context.services.clock.now();
  for (const system of SYSTEM_EMAIL_TEMPLATES) {
    if (existing.some((template) => template.systemKey === system.systemKey)) continue;
    const hasDefault = existing.some(
      (template) => template.isDefault && template.event === system.event && template.jobType === system.jobType,
    );
    const record = systemTemplateRecord(context, system, now, !hasDefault);
    await context.repos.emailTemplates.insert(record.template, record.version);
  }
};

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

export interface EmailTemplateCoverage {
  readonly event: EmailEvent;
  readonly jobType: JobTypeCode;
  /** The template that would be used, or null — then nothing is sent for that job type. */
  readonly defaultTemplateId: string | null;
}

export const listEmailTemplates = async (
  context: OperationContext,
): Promise<{ readonly templates: readonly EmailTemplateWithVersion[]; readonly coverage: readonly EmailTemplateCoverage[] }> => {
  assertManages(context);
  await ensureSystemEmailTemplates(context);
  const templates = await context.repos.emailTemplates.list();
  const coverage = EMAIL_EVENTS.flatMap((definition) =>
    definition.jobTypes.map((jobType) => ({
      event: definition.event,
      jobType,
      defaultTemplateId:
        templates.find((template) => template.event === definition.event && template.jobType === jobType && template.isDefault && template.active)
          ?.id ?? null,
    })),
  );
  return { templates, coverage };
};

export const getEmailTemplate = async (
  context: OperationContext,
  id: string,
): Promise<{ readonly template: EmailTemplateWithVersion; readonly versions: readonly EmailTemplateVersion[] }> => {
  assertManages(context);
  const template = await context.repos.emailTemplates.findById(id);
  if (template === null) throw refuse('That template does not exist.', 'unknown_template', 'It may have been removed. Reload the list.');
  return { template, versions: await context.repos.emailTemplates.versions(id) };
};

/* -------------------------------------------------------------------------- */
/* Writing                                                                    */
/* -------------------------------------------------------------------------- */

export interface NewEmailTemplateInput {
  readonly event: string;
  readonly jobType: string;
  readonly name: string;
  readonly description: string;
  readonly subject: string;
  readonly body: string;
}

const assertEventAndJobType = (event: string, jobType: string): { event: EmailEvent; jobType: JobTypeCode } => {
  if (!isEmailEvent(event)) throw refuse('Unknown email event.', 'unknown_event', 'Choose one of the listed events.');
  if (!(emailEventDefinition(event).jobTypes as readonly string[]).includes(jobType)) {
    throw refuse('That job type does not have this email.', 'unknown_job_type', 'Choose one of the listed job types.');
  }
  return { event, jobType: jobType as JobTypeCode };
};

/**
 * A new template, saved INACTIVE. It is only ever sent once the office
 * activates it as the default for its job type, after seeing the preview.
 */
export const createEmailTemplate = async (
  context: OperationContext,
  input: NewEmailTemplateInput,
): Promise<EmailTemplateWithVersion> => {
  assertManages(context);
  const { event, jobType } = assertEventAndJobType(input.event, input.jobType);
  const problems = validateEmailTemplate(input);
  if (problems.length > 0) throw problemsError(problems);

  const now = context.services.clock.now();
  const id = context.services.ids.next('etpl');
  const template: EmailTemplate = {
    id,
    event,
    jobType,
    name: input.name.trim(),
    description: input.description.trim().slice(0, 500),
    active: false,
    isDefault: false,
    currentVersion: 1,
    systemKey: null,
    createdAt: now,
    createdBy: context.actor.id,
    updatedAt: now,
    updatedBy: context.actor.id,
  };
  const version: EmailTemplateVersion = {
    id: context.services.ids.next('etplv'),
    templateId: id,
    version: 1,
    subject: input.subject.trim(),
    body: input.body.replace(/\r\n?/g, '\n').trim(),
    changeNote: 'Created.',
    createdAt: now,
    createdBy: context.actor.id,
  };
  await context.repos.emailTemplates.insert(template, version);
  await audit(context, {
    jobId: null,
    type: 'email_template_changed',
    summary: `Email template created: ${template.name}`,
    detail: `${userFullName(context.actor)} created ${describe(template)}, inactive, as version 1.`,
    changes: [
      { field: 'Subject', from: null, to: version.subject },
      { field: 'Message', from: null, to: version.body },
    ],
  });
  return { ...template, current: version };
};

export interface EmailTemplateEdit {
  readonly name: string;
  readonly description: string;
  readonly subject: string;
  readonly body: string;
  readonly changeNote: string;
  /** The version the editor opened. Refused if somebody saved since. */
  readonly expectedVersion: number;
}

/**
 * Saves the editor as the template's NEXT version. An active template stays
 * active — so the new words must pass validation, exactly as activation
 * requires. What was already composed from an earlier version is untouched.
 */
export const saveEmailTemplateVersion = async (
  context: OperationContext,
  id: string,
  edit: EmailTemplateEdit,
): Promise<EmailTemplateWithVersion> => {
  assertManages(context);
  const existing = await context.repos.emailTemplates.findById(id);
  if (existing === null) throw refuse('That template does not exist.', 'unknown_template', 'Reload the list.');
  if (existing.currentVersion !== edit.expectedVersion) {
    throw refuse(
      'Somebody saved this template after you opened it.',
      'template_changed',
      `It is now at version ${existing.currentVersion}. Reload it, check the changes, and make yours again.`,
    );
  }
  const problems = validateEmailTemplate(edit);
  if (problems.length > 0) throw problemsError(problems);

  const subject = edit.subject.trim();
  const body = edit.body.replace(/\r\n?/g, '\n').trim();
  const name = edit.name.trim();
  const description = edit.description.trim().slice(0, 500);
  const unchanged =
    subject === existing.current.subject && body === existing.current.body && name === existing.name && description === existing.description;
  if (unchanged) return existing;

  const now = context.services.clock.now();
  let next = existing;
  if (subject !== existing.current.subject || body !== existing.current.body) {
    const version: EmailTemplateVersion = {
      id: context.services.ids.next('etplv'),
      templateId: id,
      version: existing.currentVersion + 1,
      subject,
      body,
      changeNote: edit.changeNote.trim().slice(0, 300),
      createdAt: now,
      createdBy: context.actor.id,
    };
    await context.repos.emailTemplates.addVersion(version);
    next = { ...existing, currentVersion: version.version, current: version };
  }
  next = { ...next, name, description, updatedAt: now, updatedBy: context.actor.id };
  await context.repos.emailTemplates.update(next);

  await audit(context, {
    jobId: null,
    type: 'email_template_changed',
    summary: `Email template edited: ${name}`,
    detail:
      next.currentVersion === existing.currentVersion
        ? `${userFullName(context.actor)} renamed or re-described ${describe(existing)}.`
        : `${userFullName(context.actor)} saved version ${next.currentVersion} of ${describe(next)}${next.active ? ', which is active — emails composed from now on use it' : ''}.`,
    changes: [
      ...(name === existing.name ? [] : [{ field: 'Name', from: existing.name, to: name }]),
      ...(subject === existing.current.subject ? [] : [{ field: 'Subject', from: existing.current.subject, to: subject }]),
      ...(body === existing.current.body ? [] : [{ field: 'Message', from: existing.current.body, to: body }]),
    ],
  });
  return next;
};

/**
 * Makes a template active — and, with `makeDefault`, THE template for its
 * event and job type, taking the place of the previous default (which stays
 * active, as an alternative, until somebody deactivates it).
 */
export const activateEmailTemplate = async (
  context: OperationContext,
  id: string,
  options: { readonly makeDefault: boolean },
): Promise<EmailTemplateWithVersion> => {
  assertManages(context);
  const template = await context.repos.emailTemplates.findById(id);
  if (template === null) throw refuse('That template does not exist.', 'unknown_template', 'Reload the list.');
  const problems = validateEmailTemplate({ name: template.name, subject: template.current.subject, body: template.current.body });
  if (problems.length > 0) throw problemsError(problems);
  if (template.active && (template.isDefault || !options.makeDefault)) return template;

  const now = context.services.clock.now();
  let replaced: EmailTemplateWithVersion | null = null;
  if (options.makeDefault) {
    replaced = await context.repos.emailTemplates.findDefault(template.event, template.jobType);
    if (replaced !== null && replaced.id !== template.id) {
      await context.repos.emailTemplates.update({ ...replaced, isDefault: false, updatedAt: now, updatedBy: context.actor.id });
    }
  }
  const next = {
    ...template,
    active: true,
    isDefault: options.makeDefault || template.isDefault,
    updatedAt: now,
    updatedBy: context.actor.id,
  };
  await context.repos.emailTemplates.update(next);
  await audit(context, {
    jobId: null,
    type: 'email_template_changed',
    summary: `Email template ${next.isDefault ? 'made the default' : 'activated'}: ${next.name}`,
    detail:
      `${userFullName(context.actor)} ${next.isDefault ? 'made' : 'activated'} ${describe(next)}` +
      (next.isDefault ? ` the template every ${jobTypeLabel(next.jobType)} signed job card is sent with (version ${next.currentVersion})` : '') +
      (replaced !== null && replaced.id !== next.id ? `, in place of “${replaced.name}”.` : '.'),
    changes: [
      { field: 'Active', from: template.active, to: true },
      ...(next.isDefault !== template.isDefault ? [{ field: 'Default', from: template.isDefault, to: next.isDefault }] : []),
    ],
  });
  return next;
};

/**
 * Switches a template off. If it was the default, that job type then has NO
 * template, and its signed job cards are flagged for the office instead of
 * being emailed — the audit entry and the screen say so.
 */
export const deactivateEmailTemplate = async (context: OperationContext, id: string): Promise<EmailTemplateWithVersion> => {
  assertManages(context);
  const template = await context.repos.emailTemplates.findById(id);
  if (template === null) throw refuse('That template does not exist.', 'unknown_template', 'Reload the list.');
  if (!template.active) return template;
  const now = context.services.clock.now();
  const next = { ...template, active: false, isDefault: false, updatedAt: now, updatedBy: context.actor.id };
  await context.repos.emailTemplates.update(next);
  await audit(context, {
    jobId: null,
    type: 'email_template_changed',
    summary: `Email template deactivated: ${template.name}`,
    detail:
      `${userFullName(context.actor)} deactivated ${describe(template)}.` +
      (template.isDefault
        ? ` It was the default: until another template is made the default, ${jobTypeLabel(template.jobType)} signed job cards are NOT emailed and are flagged for the office.`
        : ''),
    changes: [
      { field: 'Active', from: true, to: false },
      ...(template.isDefault ? [{ field: 'Default', from: true, to: false }] : []),
    ],
  });
  return next;
};

/**
 * Brings the shipped words back for one job type: as a new version of the
 * shipped template (re-created if it never existed), made active and default.
 */
export const restoreSystemEmailTemplate = async (
  context: OperationContext,
  input: { readonly event: string; readonly jobType: string },
): Promise<EmailTemplateWithVersion> => {
  assertManages(context);
  const { event, jobType } = assertEventAndJobType(input.event, input.jobType);
  const system = SYSTEM_EMAIL_TEMPLATES.find((candidate) => candidate.event === event && candidate.jobType === jobType);
  if (system === undefined) throw refuse('There is no system default for that.', 'no_system_default', 'Write a template instead.');
  await ensureSystemEmailTemplates(context);
  const shipped = (await context.repos.emailTemplates.list()).find((template) => template.systemKey === system.systemKey);
  if (shipped === undefined) throw refuse('The system default could not be found.', 'no_system_default', 'Reload and try again.');

  let restored = shipped;
  if (shipped.current.subject !== system.subject || shipped.current.body !== system.body) {
    restored = await saveEmailTemplateVersion(context, shipped.id, {
      name: shipped.name,
      description: shipped.description,
      subject: system.subject,
      body: system.body,
      changeNote: 'Restored the system default.',
      expectedVersion: shipped.currentVersion,
    });
  }
  const active = await activateEmailTemplate(context, restored.id, { makeDefault: true });
  await audit(context, {
    jobId: null,
    type: 'email_template_changed',
    summary: `System default restored: ${active.name}`,
    detail: `${userFullName(context.actor)} restored the system default for ${jobTypeLabel(jobType)} (${emailEventDefinition(event).label}); it is the default, at version ${active.currentVersion}.`,
  });
  return active;
};

/**
 * What a template would say. Sample values unless a job's are given (the
 * editor's "preview with a real job" — the office's own data, never sent).
 * Refused, with the reasons, when the template could not be sent as written.
 */
export const previewEmailTemplate = (
  context: OperationContext,
  input: { readonly name: string; readonly subject: string; readonly body: string },
  values: PlaceholderValues = SAMPLE_PLACEHOLDER_VALUES,
): { readonly subject: string; readonly body: string; readonly problems: readonly TemplateProblem[] } => {
  assertManages(context);
  const problems = validateEmailTemplate({ ...input, name: input.name.trim().length === 0 ? 'Preview' : input.name });
  if (problems.length > 0) return { subject: '', body: '', problems };
  return { subject: renderEmailSubject(input.subject, values), body: renderEmailBody(input.body, values), problems: [] };
};
