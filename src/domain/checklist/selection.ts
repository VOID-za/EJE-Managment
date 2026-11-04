import type { ChecklistItem, ChecklistResponse, ChecklistTemplate } from '../types/checklist';

/**
 * WHICH CHECKLIST A JOB COMPLETES. CHK-SRC-1.
 *
 * Installation has one checklist and a job simply starts it. Service has two —
 * the Milling Machine / Machining Centre checklist and the Lathe checklist —
 * and the technician must say which before either opens; there is no generic
 * Service checklist to fall back on. The rule is the data's, not the job
 * type's: a job type whose current checklists carry a selection label is one
 * the technician chooses for, and the server refuses a start without a choice.
 */

/** The checklists a NEW checklist on this job type may be started from. */
export const checklistOptions = (
  templates: readonly ChecklistTemplate[],
  jobTypeCode: string,
): readonly ChecklistTemplate[] =>
  templates.filter(
    (template) => template.jobTypeCode === jobTypeCode && template.status === 'current',
  );

/** The business's checklists first, in the order the choice screen lists them. */
const KIND_ORDER = ['installation', 'service_milling', 'service_lathe'];

export const orderChecklistOptions = (
  options: readonly ChecklistTemplate[],
): readonly ChecklistTemplate[] => {
  const rank = (template: ChecklistTemplate): number => {
    const index = KIND_ORDER.indexOf(template.kind ?? '');
    return index === -1 ? KIND_ORDER.length : index;
  };
  return [...options].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
};

/** Whether the technician must choose among them before one opens. */
export const checklistChoiceRequired = (options: readonly ChecklistTemplate[]): boolean =>
  options.length > 1 || options.some((option) => (option.selectionLabel ?? '').length > 0);

/** What the choice screen calls a checklist. */
export const checklistChoiceLabel = (template: ChecklistTemplate): string =>
  (template.selectionLabel ?? '').length > 0 ? template.selectionLabel! : template.name;

export type ChecklistStartResolution =
  | { readonly ok: true; readonly template: ChecklistTemplate }
  | {
      readonly ok: false;
      readonly code: 'checklist_not_configured' | 'checklist_selection_required' | 'checklist_selection_invalid';
      readonly message: string;
    };

/**
 * The checklist a start request opens, or why it opens none.
 *
 * Never a guess: with a choice to make and no choice made it refuses, and a
 * choice that is not one of the current options is refused rather than
 * corrected to one that is.
 */
export const resolveChecklistToStart = (
  options: readonly ChecklistTemplate[],
  requestedTemplateId: string | undefined,
): ChecklistStartResolution => {
  if (options.length === 0) {
    return {
      ok: false,
      code: 'checklist_not_configured',
      message: 'No checklist is issued for this job type. The office must publish one first.',
    };
  }
  if (requestedTemplateId === undefined) {
    if (checklistChoiceRequired(options)) {
      return {
        ok: false,
        code: 'checklist_selection_required',
        message: `Choose which checklist to complete first: ${options
          .map(checklistChoiceLabel)
          .join(' or ')}.`,
      };
    }
    return { ok: true, template: options[0]! };
  }
  const chosen = options.find((option) => (option.id as string) === requestedTemplateId);
  if (chosen === undefined) {
    return {
      ok: false,
      code: 'checklist_selection_invalid',
      message: 'That is not one of the checklists issued for this job type.',
    };
  }
  return { ok: true, template: chosen };
};

/** Whether an item belongs to this version's wording at all. */
export const findTemplateItem = (
  template: ChecklistTemplate,
  itemId: string,
): ChecklistItem | undefined =>
  template.sections.flatMap((section) => section.items).find((item) => item.id === itemId);

/**
 * The typed blanks, trimmed, keeping only the ones the row prints. Returns the
 * ids it could not place so the caller can refuse rather than drop them.
 */
export const cleanFieldValues = (
  item: ChecklistItem,
  values: Readonly<Record<string, string>>,
): { readonly values: Readonly<Record<string, string>>; readonly unknown: readonly string[] } => {
  const known = new Set((item.fields ?? []).map((field) => field.id));
  const kept: Record<string, string> = {};
  const unknown: string[] = [];
  for (const [id, value] of Object.entries(values)) {
    if (!known.has(id)) {
      unknown.push(id);
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) kept[id] = trimmed;
  }
  return { values: kept, unknown };
};

/** "R 400 · S 401 · T 399", "12 Bar/PSI", "On time: 5 · Off time: 10" — or ''. */
export const formatFieldValues = (
  item: ChecklistItem,
  response: Pick<ChecklistResponse, 'fieldValues'> | undefined,
): string =>
  (item.fields ?? [])
    .map((field) => {
      const value = response?.fieldValues?.[field.id] ?? '';
      if (value.length === 0) return '';
      return [field.label, value, field.unit].filter((part) => part.length > 0).join(' ');
    })
    .filter((part) => part.length > 0)
    .join(' · ');

/** The row's printed number and group, e.g. "7 Check all oil levels:", for one-line contexts. */
export const itemReference = (item: ChecklistItem): string =>
  [item.number ?? '', item.group ?? ''].filter((part) => part.length > 0).join(' ');
