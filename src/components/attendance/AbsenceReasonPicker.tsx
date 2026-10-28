'use client';

import { useState } from 'react';
import { ABSENCE_REASONS, ABSENCE_REASON_LABELS, type AbsenceReason } from '@/domain';
import { Button, SelectField } from '@/components/ui';

/**
 * WHY SOMEBODY WAS ABSENT. ATT-01 (the real-world reviewer, 28 October 2026).
 *
 * Shown when a day is marked Absent: exactly the four reasons, one of which
 * must be chosen before the day is recorded. The server refuses an absent day
 * without one, so this is a convenience, not the rule.
 */
export const AbsenceReasonPicker = ({
  initial,
  busy,
  onConfirm,
  onCancel,
}: {
  readonly initial: AbsenceReason | null;
  readonly busy: boolean;
  readonly onConfirm: (reason: AbsenceReason) => void;
  readonly onCancel: () => void;
}) => {
  const [reason, setReason] = useState<AbsenceReason | ''>(initial ?? '');
  return (
    <div className="flex w-full flex-wrap items-end gap-2" data-testid="absence-reason-picker">
      <SelectField
        label="Reason for absence"
        value={reason}
        options={[
          { value: '', label: 'Choose a reason…' },
          ...ABSENCE_REASONS.map((value) => ({ value, label: ABSENCE_REASON_LABELS[value] })),
        ]}
        onChange={(event) => setReason(event.target.value as AbsenceReason | '')}
        containerClassName="w-full sm:w-64"
        data-testid="absence-reason"
      />
      <Button
        size="sm"
        variant="danger"
        disabled={reason === '' || busy}
        loading={busy}
        onClick={() => reason !== '' && onConfirm(reason)}
        data-testid="absence-reason-confirm"
      >
        Record absent
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
};
