import type { IsoDateTime, JobTypeCode as JobType } from '../types';

/**
 * CUSTOMER EMAIL TEMPLATES. INT-EMAIL-1..4 (the owner, 1 November 2026).
 *
 * The office writes the words; the system fills in the job. Pure functions:
 * which events exist, which placeholders a template may use, whether a
 * template is fit to be made active, and what a template says once a job's
 * values are put into it. Storage, permissions and sending are elsewhere.
 *
 * THE PLACEHOLDER RULES, which the editor shows the office word for word:
 *
 *  - `{{name}}` is replaced by the job's value. Spaces inside the braces are
 *    allowed: `{{ job_number }}` is the same placeholder.
 *  - A placeholder this list does not know is an ERROR when the template is
 *    saved, so it can never reach a customer as `{{custmer_name}}`.
 *  - In the body, a line whose placeholders are ALL blank for this job is
 *    left out — "Order number: {{order_number}}" disappears on a job with no
 *    order number instead of printing "Order number: ".
 *  - In the subject, a blank value leaves no doubled spaces or dangling dashes.
 *  - Values are inserted as plain text. A value never adds a line to the
 *    subject (a mail header), and never adds a placeholder of its own.
 */

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

export type EmailEvent = 'signed_job_card';

export interface EmailEventDefinition {
  readonly event: EmailEvent;
  readonly label: string;
  readonly description: string;
  /** The job types a template for this event can be written for. */
  readonly jobTypes: readonly JobType[];
  /** What is attached, in words. */
  readonly attachment: string;
}

/**
 * The events a template can be written for. A future event (a quotation, a
 * delivery note on its own) is one more entry here and in the migration's
 * CHECK — the tables, the editor and the outbox do not change.
 */
export const EMAIL_EVENTS: readonly EmailEventDefinition[] = [
  {
    event: 'signed_job_card',
    label: 'Signed job card',
    description:
      'Sent automatically to the customer as soon as the customer has signed and the final signed job card has been stored.',
    jobTypes: ['breakdown', 'installation', 'service', 'test_and_repair', 'parts'],
    attachment: 'The final signed job card PDF, and nothing else.',
  },
];

export const isEmailEvent = (value: unknown): value is EmailEvent =>
  typeof value === 'string' && EMAIL_EVENTS.some((definition) => definition.event === value);

export const emailEventDefinition = (event: EmailEvent): EmailEventDefinition =>
  EMAIL_EVENTS.find((definition) => definition.event === event)!;

/* -------------------------------------------------------------------------- */
/* Placeholders                                                               */
/* -------------------------------------------------------------------------- */

export type PlaceholderKey =
  | 'customer_name'
  | 'company_name'
  | 'customer_email'
  | 'job_number'
  | 'job_type'
  | 'machine_name'
  | 'site_name'
  | 'site_address'
  | 'technician_name'
  | 'completion_date'
  | 'order_number'
  | 'reference'
  | 'document_title';

export interface PlaceholderDefinition {
  readonly key: PlaceholderKey;
  readonly label: string;
  /** Where the value comes from, in the office's words. */
  readonly source: string;
  readonly example: string;
}

/**
 * Every placeholder, and the record its value is read from. Each one maps to
 * a field EJE already keeps — none is invented for the template.
 */
export const EMAIL_PLACEHOLDERS: readonly PlaceholderDefinition[] = [
  { key: 'customer_name', label: 'Customer name', source: 'The contact on the job (first and last name); the company name when the job has no contact.', example: 'Thandi Mokoena' },
  { key: 'company_name', label: 'Company name', source: 'The customer (company) the job is for.', example: 'Wadeville Steel (Pty) Ltd' },
  { key: 'customer_email', label: 'Customer email', source: 'The address the email is sent to: the email of the contact on the job.', example: 'thandi@example.co.za' },
  { key: 'job_number', label: 'Job number', source: 'The job number.', example: 'EJE-2078' },
  { key: 'job_type', label: 'Job type', source: 'Breakdown, Installation, Service, Test & Repair or Parts.', example: 'Breakdown' },
  { key: 'machine_name', label: 'Machine', source: 'The machine on the job: manufacturer, model and serial number. Blank when the job has no machine.', example: 'Siemens S7-1500 (SN 4471)' },
  { key: 'site_name', label: 'Site name', source: 'The site the job is at.', example: 'Wadeville Plant' },
  { key: 'site_address', label: 'Site address', source: 'The site address as the office saved it.', example: '3 Wadeville Boulevard, Germiston, 1428' },
  { key: 'technician_name', label: 'Technician', source: 'The technician who did the job (the primary technician).', example: 'Johan van Wyk' },
  { key: 'completion_date', label: 'Completion date', source: 'The date the job was completed (for example 1 November 2026).', example: '1 November 2026' },
  { key: 'order_number', label: 'Order number', source: 'The customer’s order number on the job. Blank when there is none.', example: 'PO-55120' },
  { key: 'reference', label: 'Reference', source: 'The customer’s reference number on the job. Blank when there is none.', example: 'REF-9931' },
  { key: 'document_title', label: 'Document title', source: '“Signed Job Card”, or “Delivery Note” / “Parts Collection Note” for a parts job.', example: 'Signed Job Card' },
];

const KNOWN = new Set<string>(EMAIL_PLACEHOLDERS.map((placeholder) => placeholder.key));

export type PlaceholderValues = Readonly<Record<PlaceholderKey, string>>;

const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** Every placeholder name written in a text, in order, as written. */
export const placeholdersIn = (text: string): readonly string[] =>
  [...text.matchAll(PLACEHOLDER)].map((match) => match[1]!);

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

export const EMAIL_TEMPLATE_LIMITS = { name: 120, subject: 300, body: 20_000 } as const;

export interface TemplateProblem {
  readonly field: 'name' | 'subject' | 'body';
  readonly code: string;
  readonly message: string;
}

/** Braces that do not make a whole placeholder: `{{name`, `name}}`, `{name}`. */
const strayBraces = (text: string): boolean => {
  const withoutPlaceholders = text.replace(PLACEHOLDER, '');
  return /\{\{|\}\}/.test(withoutPlaceholders) || /\{[a-z_]+\}/i.test(withoutPlaceholders);
};

/**
 * Everything wrong with a template, or nothing. Asked before a version is
 * saved and again before a template is activated — an unknown placeholder
 * can never be made the active template.
 */
export const validateEmailTemplate = (input: {
  readonly name: string;
  readonly subject: string;
  readonly body: string;
}): readonly TemplateProblem[] => {
  const problems: TemplateProblem[] = [];
  const name = input.name.trim();
  if (name.length === 0) problems.push({ field: 'name', code: 'name_required', message: 'Give the template a name.' });
  if (name.length > EMAIL_TEMPLATE_LIMITS.name) {
    problems.push({ field: 'name', code: 'name_too_long', message: `Keep the name to ${EMAIL_TEMPLATE_LIMITS.name} characters.` });
  }
  for (const field of ['subject', 'body'] as const) {
    const text = input[field];
    const label = field === 'subject' ? 'subject line' : 'message';
    if (text.trim().length === 0) {
      problems.push({ field, code: `${field}_required`, message: `The ${label} cannot be empty.` });
      continue;
    }
    if (text.length > EMAIL_TEMPLATE_LIMITS[field]) {
      problems.push({ field, code: `${field}_too_long`, message: `Keep the ${label} to ${EMAIL_TEMPLATE_LIMITS[field]} characters.` });
    }
    const unknown = [...new Set(placeholdersIn(text).filter((key) => !KNOWN.has(key)))];
    if (unknown.length > 0) {
      problems.push({
        field,
        code: 'unknown_placeholder',
        message: `The ${label} uses ${unknown.map((key) => `{{${key}}}`).join(', ')}, which ${unknown.length === 1 ? 'is not a placeholder' : 'are not placeholders'} EJE can fill in. Choose from the list.`,
      });
    }
    if (strayBraces(text)) {
      problems.push({
        field,
        code: 'stray_braces',
        message: `The ${label} has braces that do not make a whole placeholder. A placeholder is written {{like_this}}.`,
      });
    }
  }
  if (/[\r\n]/.test(input.subject)) {
    problems.push({ field: 'subject', code: 'subject_one_line', message: 'The subject line must be a single line.' });
  }
  return problems;
};

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

export class UnknownPlaceholderError extends Error {
  constructor(readonly keys: readonly string[]) {
    super(`The template uses placeholders EJE cannot fill in: ${keys.map((key) => `{{${key}}}`).join(', ')}.`);
    this.name = 'UnknownPlaceholderError';
  }
}

const valueOf = (values: PlaceholderValues, key: string): string => {
  if (!KNOWN.has(key)) throw new UnknownPlaceholderError([key]);
  // A value is text: it can never smuggle in a placeholder of its own.
  return (values[key as PlaceholderKey] ?? '').replace(/\{\{|\}\}/g, '').trim();
};

const assertKnown = (text: string): void => {
  const unknown = [...new Set(placeholdersIn(text).filter((key) => !KNOWN.has(key)))];
  if (unknown.length > 0) throw new UnknownPlaceholderError(unknown);
};

/** The subject, filled in. One line, no doubled spaces, no dangling separators. */
export const renderEmailSubject = (template: string, values: PlaceholderValues): string => {
  assertKnown(template);
  const filled = template.replace(PLACEHOLDER, (_whole, key: string) =>
    valueOf(values, key).replace(/[\r\n]+/g, ' '),
  );
  return filled
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/(\s*[—–\-|:]\s*){2,}/g, (match) => ` ${match.trim().charAt(0)} `)
    .replace(/^\s*[—–\-|:]\s*|\s*[—–\-|:]\s*$/g, '')
    .trim();
};

/** The body, filled in. A line whose placeholders are all blank is left out. */
export const renderEmailBody = (template: string, values: PlaceholderValues): string => {
  assertKnown(template);
  const lines = template.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const keys = placeholdersIn(line);
    if (keys.length > 0 && keys.every((key) => valueOf(values, key).length === 0)) continue;
    kept.push(line.replace(PLACEHOLDER, (_whole, key: string) => valueOf(values, key)));
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
};

/** Example values, for the editor's preview. Clearly a sample, never a customer. */
export const SAMPLE_PLACEHOLDER_VALUES: PlaceholderValues = Object.fromEntries(
  EMAIL_PLACEHOLDERS.map((placeholder) => [placeholder.key, placeholder.example]),
) as unknown as PlaceholderValues;

/* -------------------------------------------------------------------------- */
/* Stored shapes                                                              */
/* -------------------------------------------------------------------------- */

export interface EmailTemplateVersion {
  readonly id: string;
  readonly templateId: string;
  readonly version: number;
  readonly subject: string;
  readonly body: string;
  readonly changeNote: string;
  readonly createdAt: IsoDateTime;
  readonly createdBy: string | null;
}

export interface EmailTemplate {
  readonly id: string;
  readonly event: EmailEvent;
  readonly jobType: JobType;
  readonly name: string;
  readonly description: string;
  /** May be chosen at all. A template that is not active is never sent. */
  readonly active: boolean;
  /** THE template for its event and job type. At most one; always active. */
  readonly isDefault: boolean;
  readonly currentVersion: number;
  /** Set on the templates EJE ships, so "Restore system defaults" finds them. */
  readonly systemKey: string | null;
  readonly createdAt: IsoDateTime;
  readonly createdBy: string | null;
  readonly updatedAt: IsoDateTime;
  readonly updatedBy: string | null;
}

export interface EmailTemplateWithVersion extends EmailTemplate {
  readonly current: EmailTemplateVersion;
}

/* -------------------------------------------------------------------------- */
/* System defaults                                                            */
/* -------------------------------------------------------------------------- */

export interface SystemTemplate {
  readonly systemKey: string;
  readonly event: EmailEvent;
  readonly jobType: JobType;
  readonly name: string;
  readonly subject: string;
  readonly body: string;
}

const signedBody = (kind: string): string =>
  [
    'Good day {{customer_name}},',
    '',
    `Please find attached the {{document_title}} for ${kind} job {{job_number}}.`,
    '',
    'Company: {{company_name}}',
    'Site: {{site_name}}',
    'Machine: {{machine_name}}',
    'Technician: {{technician_name}}',
    'Completed: {{completion_date}}',
    'Order number: {{order_number}}',
    'Reference: {{reference}}',
    '',
    'If anything on the job card is not as you expected, please reply to this email.',
    '',
    'Kind regards',
    'EJE Industrial Electronics',
  ].join('\n');

/**
 * The templates EJE ships: one per job type for the signed job card. They are
 * created automatically the first time templates are needed, and "Restore
 * system defaults" saves these words again as a new version.
 */
export const SYSTEM_EMAIL_TEMPLATES: readonly SystemTemplate[] = [
  {
    systemKey: 'signed_job_card:breakdown',
    event: 'signed_job_card',
    jobType: 'breakdown',
    name: 'Signed job card — Breakdown',
    subject: '{{job_number}} — {{document_title}} — Breakdown',
    body: signedBody('your breakdown'),
  },
  {
    systemKey: 'signed_job_card:installation',
    event: 'signed_job_card',
    jobType: 'installation',
    name: 'Signed job card — Installation',
    subject: '{{job_number}} — {{document_title}} — Installation',
    body: signedBody('your installation'),
  },
  {
    systemKey: 'signed_job_card:service',
    event: 'signed_job_card',
    jobType: 'service',
    name: 'Signed job card — Service',
    subject: '{{job_number}} — {{document_title}} — Service',
    body: signedBody('your service'),
  },
  {
    systemKey: 'signed_job_card:test_and_repair',
    event: 'signed_job_card',
    jobType: 'test_and_repair',
    name: 'Signed job card — Test & Repair',
    subject: '{{job_number}} — {{document_title}} — Test & Repair',
    body: signedBody('your test & repair'),
  },
  {
    systemKey: 'signed_job_card:parts',
    event: 'signed_job_card',
    jobType: 'parts',
    name: 'Signed collection note — Parts',
    subject: '{{job_number}} — {{document_title}}',
    body: [
      'Good day {{customer_name}},',
      '',
      'Please find attached the signed collection note for {{job_number}} ({{document_title}}).',
      '',
      'Company: {{company_name}}',
      'Order number: {{order_number}}',
      'Reference: {{reference}}',
      '',
      'Kind regards',
      'EJE Industrial Electronics',
    ].join('\n'),
  },
];

/* -------------------------------------------------------------------------- */
/* Customer emails (the outbox)                                               */
/* -------------------------------------------------------------------------- */

/**
 *   queued    — written, waiting for its turn (or for a retry after a
 *               temporary failure; `nextAttemptAt` says when)
 *   sending   — handed to Microsoft; the answer is not back yet
 *   sent      — Microsoft ACCEPTED it. Not "delivered": nothing here claims
 *               the customer's mail server took it
 *   failed    — not sent, and not going to be without somebody acting
 *   attention — not sent because something only the office can fix is
 *               missing: no valid address, no active template
 */
export type CustomerEmailState = 'queued' | 'sending' | 'sent' | 'failed' | 'attention';

export interface CustomerEmail {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly event: EmailEvent;
  readonly jobId: string | null;
  readonly templateId: string | null;
  readonly templateVersionId: string | null;
  readonly templateName: string;
  readonly templateVersion: number | null;
  readonly sender: string;
  readonly recipient: string;
  readonly cc: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly attachment: {
    readonly storageKey: string;
    readonly fileName: string;
    readonly sha256: string | null;
  } | null;
  /**
   * JOB-ATT-3 (2 November 2026): the job's documents selected for the
   * customer, sent IN the email beside the signed job card — never as links.
   * Fixed when the email is written, like everything else it says. Absent on
   * an email written before this existed.
   */
  readonly extraAttachments?: readonly CustomerEmailAttachment[];
  readonly state: CustomerEmailState;
  readonly attempts: number;
  readonly nextAttemptAt: IsoDateTime | null;
  readonly lastAttemptAt: IsoDateTime | null;
  readonly sentAt: IsoDateTime | null;
  readonly providerRequestId: string | null;
  readonly failureKind: string | null;
  readonly failureReason: string;
  readonly retryOf: string | null;
  readonly createdAt: IsoDateTime;
  readonly createdBy: string | null;
  readonly updatedAt: IsoDateTime;
}

export interface CustomerEmailAttachment {
  readonly storageKey: string;
  readonly fileName: string;
  readonly sha256: string | null;
}

/**
 * THE MOST AN EMAIL'S ATTACHMENTS MAY WEIGH, TOGETHER. JOB-ATT-3.
 *
 * Microsoft 365 (Graph) takes at most 3 MB of attachments on one message
 * without its separate upload-session protocol, which is not used. The rule is
 * applied when the email is written (so the office is told at once, before
 * anything is attempted) and again when it is sent, for every provider — an
 * email that cannot carry the documents chosen for it is never sent without
 * them and never reported as sent.
 */
export const EMAIL_ATTACHMENTS_MAX_BYTES = 3 * 1024 * 1024;

/** Attempts at one email before a temporary failure becomes a failure. */
export const EMAIL_MAX_ATTEMPTS = 6;

/** Minutes before attempt n+1 (index n-1) after a temporary failure. */
const EMAIL_BACKOFF_MINUTES = [1, 5, 15, 60, 180] as const;

/** When the next attempt is due after `attempts` temporary failures, or null for never. */
export const emailRetryAt = (
  now: IsoDateTime,
  attempts: number,
  retryAfterSeconds: number | null,
): IsoDateTime | null => {
  if (attempts >= EMAIL_MAX_ATTEMPTS) return null;
  const minutes = Math.max(EMAIL_BACKOFF_MINUTES[attempts - 1] ?? 180, Math.ceil((retryAfterSeconds ?? 0) / 60));
  return new Date(Date.parse(now) + minutes * 60_000).toISOString() as IsoDateTime;
};

/**
 * How long an email may sit in `sending` before it is treated as UNCERTAIN.
 * Graph answers in seconds; ten minutes means the process died mid-send.
 * Such an email is never re-sent automatically — Microsoft may have accepted
 * it — and the office is asked to check Sent Items before retrying.
 */
export const EMAIL_SENDING_STALE_MS = 10 * 60 * 1000;

const EMAIL_RE = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\]{2,}$/;

/** A plausible single address. Not proof it exists; Microsoft decides that. */
export const isPlausibleEmailAddress = (value: string): boolean =>
  value.length <= 254 && EMAIL_RE.test(value);

const STATE_LABEL: Record<CustomerEmailState, string> = {
  queued: 'Queued',
  sending: 'Sending',
  sent: 'Sent (accepted by Microsoft 365)',
  failed: 'Failed',
  attention: 'Needs office attention',
};

export const customerEmailStateLabel = (state: CustomerEmailState): string => STATE_LABEL[state];

/** May the office press Retry on this email? Only once it has stopped. */
export const customerEmailRetryable = (email: CustomerEmail): boolean =>
  email.state === 'failed' || email.state === 'attention';
