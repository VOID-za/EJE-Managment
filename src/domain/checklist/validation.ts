import type {
  ChecklistInstance,
  ChecklistItem,
  ChecklistResponse,
  ChecklistTemplate,
} from '../types/checklist';

/**
 * Checklist completeness rules.
 *
 * Kept separate from the workflow machine so the same rules can be reused by an
 * API validator in Phase 2 without dragging job state in with them.
 */

export interface ChecklistItemIssue {
  readonly itemId: string;
  readonly sectionId: string;
  readonly itemText: string;
  readonly reason:
    | 'unanswered'
    | 'photo_required'
    | 'measurement_missing'
    | 'text_missing'
    | 'note_required';
  readonly message: string;
}

export interface ChecklistProgress {
  readonly answered: number;
  readonly total: number;
  readonly percentComplete: number;
  readonly failedItems: number;
  readonly issues: readonly ChecklistItemIssue[];
  readonly complete: boolean;
}

const isAnswered = (item: ChecklistItem, response: ChecklistResponse | undefined): boolean => {
  if (response === undefined) return false;
  switch (item.responseType) {
    case 'pass_fail_na':
      return response.choice !== null;
    case 'yes_no':
      return response.yesNo !== null;
    case 'measurement':
      return response.measurement !== null;
    case 'text':
      return response.text.trim().length > 0;
  }
};

/**
 * Whether this item demands a written explanation.
 *
 * A failure is a finding the customer will read, so it must say what was found.
 * A pass or an N/A needs nothing, and demanding one would train technicians to
 * type filler.
 */
export const requiresNote = (
  item: ChecklistItem,
  response: ChecklistResponse | undefined,
): boolean => isFailedResponse(item, response) || isMeasurementOutOfRange(item, response);

/** A `fail` or `no` answer is a finding the technician should explain. */
export const isFailedResponse = (
  item: ChecklistItem,
  response: ChecklistResponse | undefined,
): boolean => {
  if (response === undefined) return false;
  if (item.responseType === 'pass_fail_na') return response.choice === 'fail';
  if (item.responseType === 'yes_no') return response.yesNo === false;
  return false;
};

export const isMeasurementOutOfRange = (
  item: ChecklistItem,
  response: ChecklistResponse | undefined,
): boolean => {
  if (item.responseType !== 'measurement') return false;
  if (item.expectedRange === null) return false;
  if (response === undefined || response.measurement === null) return false;
  return (
    response.measurement < item.expectedRange.min || response.measurement > item.expectedRange.max
  );
};

export const evaluateChecklist = (
  template: ChecklistTemplate,
  instance: ChecklistInstance | null,
): ChecklistProgress => {
  const responsesById = new Map<string, ChecklistResponse>(
    (instance?.responses ?? []).map((response) => [response.itemId, response]),
  );

  const issues: ChecklistItemIssue[] = [];
  let answered = 0;
  let total = 0;
  let failedItems = 0;

  for (const section of template.sections) {
    for (const item of section.items) {
      total += 1;
      const response = responsesById.get(item.id);
      const itemAnswered = isAnswered(item, response);

      if (itemAnswered) {
        answered += 1;
      } else if (item.required) {
        issues.push({
          itemId: item.id,
          sectionId: section.id,
          itemText: item.text,
          reason:
            item.responseType === 'measurement'
              ? 'measurement_missing'
              : item.responseType === 'text'
                ? 'text_missing'
                : 'unanswered',
          message: `"${item.text}" has not been answered.`,
        });
      }

      if (isFailedResponse(item, response)) {
        failedItems += 1;
      }

      // A failure or an out-of-range reading must be explained before the
      // checklist can be completed.
      if (requiresNote(item, response) && (response?.notes ?? '').trim().length === 0) {
        issues.push({
          itemId: item.id,
          sectionId: section.id,
          itemText: item.text,
          reason: 'note_required',
          message: `"${item.text}" was not passed and needs a note explaining what was found.`,
        });
      }

      if (item.photoRequired && (response === undefined || response.photos.length === 0)) {
        issues.push({
          itemId: item.id,
          sectionId: section.id,
          itemText: item.text,
          reason: 'photo_required',
          message: `"${item.text}" requires a photo.`,
        });
      }
    }
  }

  return {
    answered,
    total,
    percentComplete: total === 0 ? 100 : Math.round((answered / total) * 100),
    failedItems,
    issues,
    complete: issues.length === 0,
  };
};
