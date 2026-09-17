import type { Attachment, ChecklistTemplateId, IsoDateTime, UserId } from './common';

/**
 * Checklist model.
 *
 * IMPORTANT (Phase 2): the wording of the production checklists comes from the
 * approved EJE / WD Hearn source documents. The templates in
 * `src/data/seed/checklists.ts` are REPRESENTATIVE DEMO CONTENT only. They are
 * versioned and content-addressed by `templateId` + `version` precisely so the
 * approved wording can replace them without any change to this model, to the
 * response storage, or to the checklist UI.
 */

export type ChecklistResponseType =
  | 'pass_fail_na'
  | 'measurement'
  | 'text'
  | 'yes_no';

export interface ChecklistItem {
  readonly id: string;
  readonly text: string;
  /** Optional guidance shown under the item to reduce technician typing. */
  readonly helpText: string;
  readonly responseType: ChecklistResponseType;
  readonly required: boolean;
  /** A photo must be attached to this item before the checklist can complete. */
  readonly photoRequired: boolean;
  /** Unit label for `measurement` items, e.g. "mm", "bar", "°C". */
  readonly unit: string | null;
  /** Inclusive acceptable range for `measurement` items, when defined. */
  readonly expectedRange: { readonly min: number; readonly max: number } | null;
}

export interface ChecklistSection {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly items: readonly ChecklistItem[];
}

export interface ChecklistTemplate {
  readonly id: ChecklistTemplateId;
  readonly name: string;
  readonly description: string;
  /** Job type this template is mandatory for. */
  readonly jobTypeCode: string;
  readonly version: string;
  readonly status: 'draft' | 'current' | 'archived';
  /** Provenance of the wording, surfaced in the admin UI. */
  readonly sourceDocument: string;
  readonly sections: readonly ChecklistSection[];
  readonly updatedAt: IsoDateTime;
}

export type PassFailNa = 'pass' | 'fail' | 'na';

export interface ChecklistResponse {
  readonly itemId: string;
  readonly choice: PassFailNa | null;
  readonly yesNo: boolean | null;
  readonly measurement: number | null;
  readonly text: string;
  readonly notes: string;
  readonly photos: readonly Attachment[];
  readonly answeredAt: IsoDateTime | null;
  readonly answeredBy: UserId | null;
}

export interface ChecklistInstance {
  readonly templateId: ChecklistTemplateId;
  readonly templateVersion: string;
  readonly responses: readonly ChecklistResponse[];
  readonly completedAt: IsoDateTime | null;
  readonly completedBy: UserId | null;
}

export const emptyChecklistResponse = (itemId: string): ChecklistResponse => ({
  itemId,
  choice: null,
  yesNo: null,
  measurement: null,
  text: '',
  notes: '',
  photos: [],
  answeredAt: null,
  answeredBy: null,
});
