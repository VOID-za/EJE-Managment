import type { ChecklistTemplateId } from '../types/common';
import type { ChecklistTemplate } from '../types/checklist';

/**
 * Checklist template versioning.
 *
 * A completed job stores `templateId` + `templateVersion` and its job card is
 * rendered from that exact version. Editing a version a job has already used
 * would silently rewrite history on a document a customer has signed, so it is
 * refused: the Master publishes a new version instead, and the old one is
 * archived rather than destroyed.
 */

/** A checklist a job has recorded against it. */
export interface TemplateUsage {
  readonly templateId: ChecklistTemplateId;
  readonly templateVersion: string;
}

export const isVersionInUse = (
  template: Pick<ChecklistTemplate, 'id' | 'version'>,
  usage: readonly TemplateUsage[],
): boolean =>
  usage.some(
    (used) => used.templateId === template.id && used.templateVersion === template.version,
  );

/**
 * Whether the Master may edit this version's wording in place.
 *
 * A draft is always editable. A published version is editable only while no job
 * has completed against it.
 */
export const canEditInPlace = (
  template: Pick<ChecklistTemplate, 'id' | 'version' | 'status'>,
  usage: readonly TemplateUsage[],
): boolean => {
  if (template.status === 'draft') return true;
  return !isVersionInUse(template, usage);
};

export const editInPlaceRefusal = (
  template: Pick<ChecklistTemplate, 'id' | 'version' | 'status'>,
  usage: readonly TemplateUsage[],
): string | null =>
  canEditInPlace(template, usage)
    ? null
    : `Version ${template.version} has been completed on a job, so its wording is fixed. Publish a new version instead.`;

/**
 * The next version number in the same family.
 *
 * Versions are "major.minor" strings. A new published version bumps the major
 * part, which is what a Master means by "a new version of the checklist".
 */
export const nextVersion = (current: string): string => {
  const [major = '1'] = current.split('.');
  const parsed = Number.parseInt(major, 10);
  if (!Number.isFinite(parsed)) return `${current}.1`;
  return `${parsed + 1}.0`;
};

/** Every version of a template family, newest version first. */
export const versionsOf = (
  templates: readonly ChecklistTemplate[],
  templateId: ChecklistTemplateId,
): readonly ChecklistTemplate[] =>
  templates
    .filter((template) => template.id === templateId)
    .slice()
    .sort((a, b) => compareVersions(b.version, a.version));

export const compareVersions = (a: string, b: string): number => {
  const parse = (value: string): readonly number[] =>
    value.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

/** One entry per template family: the version currently issued to new jobs. */
export const currentTemplates = (
  templates: readonly ChecklistTemplate[],
): readonly ChecklistTemplate[] => templates.filter((template) => template.status === 'current');
