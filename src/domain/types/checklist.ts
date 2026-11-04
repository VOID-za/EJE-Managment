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
  /**
   * The number the SOURCE DOCUMENT prints against this row — "7", "12" — or
   * '' for a row it does not number. Not the position: Installation item 7 is
   * six rows, and the Lathe has two unnumbered rows. Absent on wording written
   * before CHK-SRC-1, which numbered nothing.
   */
  readonly number?: string;
  /**
   * The label a source document prints ONCE across several rows, e.g.
   * "Check all oil levels:" spanning Installation item 7's six oils.
   */
  readonly group?: string;
  /**
   * The labelled blanks a source document prints in the row's Comments column
   * — "R ___ S ___ T ___", "___ Bar/PSI", "On time: / Off time:". Recorded as
   * written, never required: the paper does not say a blank must be filled.
   */
  readonly fields?: readonly ChecklistField[];
  /**
   * What the transcription says about this row's SOURCE, shown with it, e.g.
   * "Handwritten on the supplied source." Never an instruction.
   */
  readonly sourceNote?: string;
}

/** One labelled blank in a row's Comments column. CHK-SRC-1. */
export interface ChecklistField {
  readonly id: string;
  /** As printed before the blank: "R", "On time:". '' when only a unit follows it. */
  readonly label: string;
  /** As printed after the blank: "Bar/PSI", "KPA (0.2)". '' when none. */
  readonly unit: string;
}

/**
 * Where a header line's value comes from. The source documents print blanks
 * for these; the job already knows them, so they are filled from the job
 * rather than retyped.
 */
export type ChecklistHeaderSource =
  | 'quote_number'
  | 'invoice_number'
  | 'customer'
  | 'site_address'
  | 'contact'
  | 'machine_make'
  | 'machine_model'
  | 'machine_control'
  | 'serial_number'
  | 'date';

export type ChecklistSignatureRole =
  | 'engineer_name'
  | 'engineer_signature'
  | 'customer_name'
  | 'customer_signature';

/**
 * Everything a source document prints around its rows, kept with the version
 * so a completed checklist renders the paper it was answered on. CHK-SRC-1.
 */
export interface ChecklistLayout {
  /** The document's own title, exactly as printed. */
  readonly title: string;
  /** The printed letterhead, or ''. */
  readonly letterhead: string;
  readonly headerFields: readonly {
    readonly label: string;
    readonly source: ChecklistHeaderSource;
  }[];
  /** The printed column headings; '' where the source prints none. */
  readonly columns: {
    readonly number: string;
    readonly description: string;
    readonly tick: string;
    readonly comments: string;
  };
  /** Printed instructions, in order. */
  readonly notes: readonly string[];
  /** A printed closing line such as "ALL CHECKS COMPLETE", or ''. */
  readonly closing: string;
  readonly signatures: readonly {
    readonly label: string;
    readonly role: ChecklistSignatureRole;
  }[];
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
  /**
   * Which of the business's checklists this family is — 'installation',
   * 'service_milling', 'service_lathe' — or null for one that is none of them
   * (the earlier demonstration wording, or one the office wrote). CHK-SRC-1.
   */
  readonly kind?: string | null;
  /**
   * The answer to "Which Service checklist do you need to complete?". A job
   * type whose current checklists carry one makes the technician CHOOSE
   * before a checklist starts. '' for a checklist that is simply issued.
   */
  readonly selectionLabel?: string;
  /** What the source prints around the rows. Null on earlier wording. */
  readonly layout?: ChecklistLayout | null;
}

export type PassFailNa = 'pass' | 'fail' | 'na';

export interface ChecklistResponse {
  readonly itemId: string;
  readonly choice: PassFailNa | null;
  readonly yesNo: boolean | null;
  readonly measurement: number | null;
  readonly text: string;
  readonly notes: string;
  /** Values typed into the row's labelled blanks, by field id. CHK-SRC-1. */
  readonly fieldValues?: Readonly<Record<string, string>>;
  readonly photos: readonly Attachment[];
  readonly answeredAt: IsoDateTime | null;
  readonly answeredBy: UserId | null;
}

export interface ChecklistInstance {
  readonly templateId: ChecklistTemplateId;
  readonly templateVersion: string;
  /**
   * The checklist the technician CHOSE — 'service_milling' or 'service_lathe' —
   * or the kind of the one issued. Null on a checklist started before
   * CHK-SRC-1. Recorded with the instance, so it stays what was chosen.
   */
  readonly checklistKind?: string | null;
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
  fieldValues: {},
  photos: [],
  answeredAt: null,
  answeredBy: null,
});
