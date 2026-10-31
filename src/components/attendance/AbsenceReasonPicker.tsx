'use client';

import { ABSENCE_REASONS, ABSENCE_REASON_LABELS, type AbsenceReason } from '@/domain';
import { Button, SelectField } from '@/components/ui';

/**
 * WHY SOMEBODY WAS ABSENT. ATT-01 (the real-world reviewer, 28 October 2026).
 *
 * Shown on a day marked Absent: exactly the four reasons. Choosing one SAVES
 * it — attendance saves itself (ATT-AUTO-1, the tester, 31 October 2026) — so
 * there is no separate "Record absent" button any more. Until a reason is
 * chosen the day is held, not sent, and Cancel puts it back as it was. The
 * server refuses an absent day without a reason, so this is a convenience,
 * not the rule.
 */
export const AbsenceReasonPicker = ({
  value,
  onChoose,
  onCancel,
}: {
  readonly value: AbsenceReason | null;
  readonly onChoose: (reason: AbsenceReason) => void;
  /** Offered while no reason is chosen yet: puts the day back as it was. */
  readonly onCancel?: () => void;
}) => (
  <div className="flex w-full flex-wrap items-end gap-2" data-testid="absence-reason-picker">
    <SelectField
      label="Reason for absence"
      value={value ?? ''}
      error={value === null ? 'Choose a reason — the day is saved as Absent once you do.' : undefined}
      options={[
        ...(value === null ? [{ value: '', label: 'Choose a reason…' }] : []),
        ...ABSENCE_REASONS.map((reason) => ({ value: reason, label: ABSENCE_REASON_LABELS[reason] })),
      ]}
      onChange={(event) => {
        if (event.target.value !== '') onChoose(event.target.value as AbsenceReason);
      }}
      containerClassName="w-full sm:w-64"
      data-testid="absence-reason"
    />
    {value === null && onCancel !== undefined && (
      <Button size="sm" variant="ghost" onClick={onCancel} data-testid="absence-reason-cancel">
        Cancel
      </Button>
    )}
  </div>
);
