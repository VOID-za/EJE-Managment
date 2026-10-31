'use client';

import { useState } from 'react';
import { REPAIR_ITEMS_MAX, repairItemsOf, type Job, type RepairItem } from '@/domain';
import { Button, Icon, Modal, TextField } from '@/components/ui';
import { RuleViolationNotice } from './RuleViolationNotice';
import { jobs } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';

/** One part as it is being typed: the quantity is text until it is saved. */
export interface RepairItemDraft {
  readonly key: number;
  readonly description: string;
  readonly partNumber: string;
  readonly quantity: string;
}

let keys = 0;
const nextKey = () => (keys += 1);

export const emptyRepairItemDraft = (): RepairItemDraft => ({ key: nextKey(), description: '', partNumber: '', quantity: '' });

export const repairItemDrafts = (items: readonly RepairItem[]): RepairItemDraft[] =>
  items.length === 0
    ? [emptyRepairItemDraft()]
    : items.map((item) => ({ key: nextKey(), description: item.description, partNumber: item.partNumber, quantity: item.quantity === null ? '' : String(item.quantity) }));

/** Why a typed quantity cannot be saved, or undefined. */
export const quantityProblem = (typed: string): string | undefined =>
  typed.trim().length > 0 && !/^[1-9]\d{0,5}$/u.test(typed.trim()) ? 'A whole number of parts, or blank.' : undefined;

/** The drafts as parts: trimmed, quantities as numbers, empty rows left out. Only call when every quantity is valid. */
export const repairItemsFromDrafts = (drafts: readonly RepairItemDraft[]): RepairItem[] =>
  drafts
    .map((draft) => ({
      partNumber: draft.partNumber.trim(),
      description: draft.description.trim(),
      quantity: draft.quantity.trim().length === 0 ? null : Number(draft.quantity.trim()),
    }))
    .filter((item) => item.partNumber.length > 0 || item.description.length > 0 || item.quantity !== null);

/**
 * THE PARTS BOOKED IN, ROW BY ROW. TR-PARTS-1 (the tester, 31 October 2026).
 *
 * Any number of parts — Add another part, correct any row, Remove one — each
 * with a description, a part number where there is one, and its own quantity.
 * Used on the New Job form and on a Test & Repair job (`RepairItemsDialog`), so
 * the two can never disagree about what a part is. A row with only a quantity
 * is flagged: a part has to say what it is.
 */
export const RepairItemsEditor = ({
  drafts,
  onChange,
}: {
  readonly drafts: readonly RepairItemDraft[];
  readonly onChange: (drafts: RepairItemDraft[]) => void;
}) => {
  const update = (key: number, change: Partial<RepairItemDraft>) =>
    onChange(drafts.map((draft) => (draft.key === key ? { ...draft, ...change } : draft)));
  return (
    <div className="space-y-3" data-testid="repair-items-editor">
      <ol className="space-y-3">
        {drafts.map((draft, index) => {
          const unnamed = draft.description.trim().length === 0 && draft.partNumber.trim().length === 0 && draft.quantity.trim().length > 0;
          return (
            <li
              key={draft.key}
              className="rounded-[var(--radius-control)] border border-steel-200 bg-steel-50/60 p-3"
              data-testid="repair-item-row"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-steel-800">Part {index + 1}</p>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onChange(drafts.length === 1 ? [emptyRepairItemDraft()] : drafts.filter((other) => other.key !== draft.key))}
                  aria-label={`Remove part ${index + 1}`}
                  data-testid="repair-item-remove"
                >
                  Remove
                </Button>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_7rem]">
                <TextField
                  label="Description"
                  value={draft.description}
                  maxLength={500}
                  error={unnamed ? 'Say what the part is, or remove the row.' : undefined}
                  onChange={(event) => update(draft.key, { description: event.target.value })}
                  data-testid="repair-item-description"
                />
                <TextField
                  label="Part number"
                  value={draft.partNumber}
                  maxLength={120}
                  hint="Where there is one."
                  onChange={(event) => update(draft.key, { partNumber: event.target.value })}
                  data-testid="repair-item-part-number"
                />
                <TextField
                  label="Quantity"
                  value={draft.quantity}
                  inputMode="numeric"
                  error={quantityProblem(draft.quantity)}
                  onChange={(event) => update(draft.key, { quantity: event.target.value })}
                  data-testid="repair-item-quantity"
                />
              </div>
            </li>
          );
        })}
      </ol>
      <Button
        variant="secondary"
        size="sm"
        leadingIcon={<Icon name="plus" className="size-4" />}
        disabled={drafts.length >= REPAIR_ITEMS_MAX}
        onClick={() => onChange([...drafts, emptyRepairItemDraft()])}
        data-testid="repair-item-add"
      >
        Add another part
      </Button>
    </div>
  );
};

/** Whether the drafts can be saved: every quantity a whole number, every row with a quantity named. */
export const repairDraftsValid = (drafts: readonly RepairItemDraft[]): boolean =>
  drafts.every(
    (draft) =>
      quantityProblem(draft.quantity) === undefined &&
      !(draft.description.trim().length === 0 && draft.partNumber.trim().length === 0 && draft.quantity.trim().length > 0),
  );

/**
 * CHANGES THE PARTS ON A TEST & REPAIR JOB. The office's, while the job is
 * editable (the caller asks the same rules the server enforces, and the server
 * enforces them regardless). Saves the whole list with the list it opened, so
 * a change somebody else made meanwhile is refused rather than overwritten.
 */
export const RepairItemsDialog = ({ job, onClose, onSaved }: { readonly job: Job; readonly onClose: () => void; readonly onSaved: () => void }) => {
  const operation = useOperation();
  const [original] = useState<readonly RepairItem[]>(() => repairItemsOf(job));
  const [drafts, setDrafts] = useState<RepairItemDraft[]>(() => repairItemDrafts(original));
  const valid = repairDraftsValid(drafts);

  const save = async () => {
    if (!valid) return;
    const ok = await operation.run(() => jobs.setRepairItems(job.id, repairItemsFromDrafts(drafts), original));
    if (ok) {
      onSaved();
      onClose();
    }
  };

  return (
    <Modal
      open
      size="lg"
      title="Parts booked in"
      description="Every part that came in with this job, each with its own quantity. They are all listed on the job's one delivery note. Changes are recorded on the activity trail."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={operation.running} disabled={!valid} onClick={() => void save()} data-testid="save-repair-items">
            Save parts
          </Button>
        </>
      }
    >
      {operation.error !== null && (
        <div className="mb-4">
          <RuleViolationNotice title="The parts were not changed" message={operation.error} violations={operation.violations} />
        </div>
      )}
      <RepairItemsEditor drafts={drafts} onChange={setDrafts} />
    </Modal>
  );
};
