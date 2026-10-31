import {
  REPAIR_ITEMS_MAX,
  can,
  getJobTypeDefinition,
  hasRepairItem,
  repairItemsOf,
  storedRepairItems,
  userFullName,
  type Job,
  type RepairItem,
} from '@/domain';
import type { OperationContext } from './context';
import { audit } from './audit';
import { WorkflowError } from './errors';
import { assertEditable } from './job-operations';

/**
 * THE PARTS A TEST & REPAIR JOB WAS BOOKED IN WITH — ANY NUMBER OF THEM.
 * TR-PARTS-1 (the tester, 31 October 2026: "one delivery note must support
 * multiple different parts and their individual quantities").
 *
 * Until now a Test & Repair job held exactly one booked-in item: one part
 * number, one description, one quantity. A customer sending in a bearing, a
 * seal kit, a sensor and a coupling had nowhere to record the other three, and
 * the delivery note that goes back with them listed one.
 *
 * Every part has a description, a part number where there is one, and its own
 * quantity. The rules are creation's for the single item, applied to each:
 * trimmed; at most 120 characters of part number and 500 of description; a
 * quantity that is a positive whole number or blank; a row with nothing in it
 * is not a part and is dropped. The list is stored as the job always stored
 * its item (`storedRepairItems`) and printed whole on the delivery note.
 */
const refuse = (message: string, code: string, detail: string): WorkflowError =>
  new WorkflowError(message, [{ code, message: detail }]);

export const REPAIR_PART_NUMBER_LIMIT = 120;
export const REPAIR_DESCRIPTION_LIMIT = 500;
export const REPAIR_QUANTITY_LIMIT = 100_000;

/** The parts as they will be stored: trimmed, checked, empty rows dropped. */
export const normaliseRepairItems = (items: readonly RepairItem[]): RepairItem[] => {
  const kept: RepairItem[] = [];
  for (const [index, item] of items.entries()) {
    const part = {
      partNumber: item.partNumber.trim(),
      description: item.description.trim(),
      quantity: item.quantity,
    };
    if (!hasRepairItem(part)) continue;
    const row = `Part ${index + 1}`;
    if (part.partNumber.length > REPAIR_PART_NUMBER_LIMIT) {
      throw refuse(`${row}: the part number is too long.`, 'invalid_repair_item', `Keep it to ${REPAIR_PART_NUMBER_LIMIT} characters.`);
    }
    if (part.description.length > REPAIR_DESCRIPTION_LIMIT) {
      throw refuse(`${row}: the description is too long.`, 'invalid_repair_item', `Keep it to ${REPAIR_DESCRIPTION_LIMIT} characters.`);
    }
    if (part.quantity !== null && (!Number.isInteger(part.quantity) || part.quantity <= 0 || part.quantity > REPAIR_QUANTITY_LIMIT)) {
      throw refuse(`${row}: the quantity must be a whole number.`, 'invalid_quantity', 'Enter how many came in, or leave it blank if nobody has counted them yet.');
    }
    if (part.description.length === 0 && part.partNumber.length === 0) {
      throw refuse(`${row}: say what the part is.`, 'repair_item_unnamed', 'Give it a description or a part number, or remove the row.');
    }
    kept.push(part);
  }
  if (kept.length > REPAIR_ITEMS_MAX) {
    throw refuse('Too many parts on one job.', 'too_many_repair_items', `One job holds at most ${REPAIR_ITEMS_MAX} parts.`);
  }
  return kept;
};

/** One line per part, as the activity trail records it. */
export const describeRepairItems = (items: readonly RepairItem[]): string =>
  items.length === 0
    ? '—'
    : items
        .map((item) => [item.description, item.partNumber.length > 0 ? `(${item.partNumber})` : '', item.quantity === null ? '' : `× ${item.quantity}`].filter((part) => part.length > 0).join(' '))
        .join('; ');

const sameItems = (a: readonly RepairItem[], b: readonly RepairItem[]): boolean =>
  a.length === b.length &&
  a.every((item, index) => item.partNumber === b[index]!.partNumber && item.description === b[index]!.description && item.quantity === b[index]!.quantity);

export interface RepairItemsEdit {
  /** The whole list, in order, as it should now read. */
  readonly items: readonly RepairItem[];
  /** The list the editor opened with — refused if the job no longer says that. */
  readonly expected: readonly RepairItem[];
}

/**
 * CHANGES THE PARTS BOOKED IN: add, correct, remove, re-quantify.
 *
 * WHO: the office (`jobs.editDetails`), exactly as for the job's other
 * details. WHEN: while the job is editable (`assertEditable`) — so never once
 * the customer has signed, which is when the delivery note is finalised; a
 * signed job's remedy is a correction. WHAT: a job type that captures a repair
 * item (Test & Repair) and no other. STALE: the editor says what list it
 * opened; if somebody changed it since, the edit is refused rather than one
 * person's list silently replacing the other's.
 */
export const setRepairItems = async (context: OperationContext, job: Job, edit: RepairItemsEdit): Promise<Job> => {
  if (!can(context.actor.role, 'jobs.editDetails')) {
    throw refuse('Only the office can change the parts booked in.', 'not_permitted', 'A Master or a Coordinator records what came in with the job.');
  }
  assertEditable(context, job);
  const definition = getJobTypeDefinition(job.jobType);
  if (!definition.capturesRepairItem) {
    throw refuse(
      `A ${definition.label.toLowerCase()} job does not record parts booked in.`,
      'not_applicable_to_job_type',
      'Parts booked in are kept on a Test & Repair job.',
    );
  }

  const current = [...repairItemsOf(job)];
  if (!sameItems(normaliseRepairItems(edit.expected), current)) {
    throw refuse(
      'The parts booked in were changed by somebody else after you opened them.',
      'job_details_changed',
      `They now read: ${describeRepairItems(current)}. Reload the job, check the parts and make your change again.`,
    );
  }
  const next = normaliseRepairItems(edit.items);
  if (sameItems(next, current)) return job;

  const saved = await context.repos.jobs.save({ ...job, ...storedRepairItems(next) });
  await audit(context, {
    jobId: saved.id,
    type: 'job_details_edited',
    summary: 'Parts booked in changed',
    detail: `${userFullName(context.actor)} changed the parts booked in: ${next.length} part${next.length === 1 ? '' : 's'}.`,
    changes: [{ field: 'details.repairItems', from: describeRepairItems(current), to: describeRepairItems(next) }],
  });
  return saved;
};
