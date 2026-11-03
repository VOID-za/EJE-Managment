'use client';

import { useState } from 'react';
import { standbyCategoryOf, type StandbyPosition } from '@/domain';
import type { StandbyPerson, StandbyWeekView } from '@/application/standby';
import { Button, SelectField } from '@/components/ui';
import { standby } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';

const EMPTY = '__empty__';

/**
 * THE OFFICE CHANGES ONE PLACE. STANDBY-4.
 *
 * A draft week saves as soon as a person is chosen. A PUBLISHED week asks the
 * office to confirm first, because people already work to it and they are told
 * — no reason is asked (STANDBY-NOREASON-1, 3 November 2026); who changed it
 * and when is on the record. A change to the week in progress is recorded as an
 * emergency change. The server checks everything again, including that the
 * place still holds who this screen showed.
 */
export const StandbyPlaceEditor = ({
  week,
  position,
  people,
  onSaved,
}: {
  readonly week: StandbyWeekView;
  readonly position: StandbyPosition;
  readonly people: readonly StandbyPerson[];
  readonly onSaved?: (message: string) => void;
}) => {
  const place = week.places.find((candidate) => candidate.position === position)!;
  const [choice, setChoice] = useState<string | null>(null);
  const operation = useOperation();
  const category = standbyCategoryOf(position);
  const published = week.status === 'published';
  const readOnly = week.timing === 'past';

  const eligible = people.filter(
    (person) => person.active && (category === 'main' ? person.main : category === 'helper' ? person.helper : person.apprentice),
  );
  const options = [
    { value: EMPTY, label: 'Not assigned' },
    ...eligible.map((person) => ({ value: person.id as string, label: person.name })),
    // Somebody no longer eligible stays visible while they hold the place.
    ...(place.userId !== null && !eligible.some((person) => person.id === place.userId)
      ? [{ value: place.userId as string, label: `${place.name ?? 'Unknown'} (not eligible)` }]
      : []),
  ];

  const save = async (value: string) => {
    const ok = await operation.run(() =>
      standby.assign({
        weekStart: week.weekStart,
        position,
        userId: value === EMPTY ? null : value,
        expectedUserId: place.userId,
      }),
    );
    if (ok) {
      setChoice(null);
      onSaved?.(published ? 'Saved. Everyone affected has been told.' : 'Saved.');
    }
  };

  return (
    <div data-testid={`standby-edit-${position}`}>
      <SelectField
        label={place.label}
        value={choice ?? place.userId ?? EMPTY}
        disabled={readOnly || operation.running}
        options={options}
        onChange={(event) => {
          const value = event.target.value;
          if ((value === EMPTY ? null : value) === place.userId) {
            setChoice(null);
            return;
          }
          if (published) setChoice(value);
          else void save(value);
        }}
      />
      {choice !== null && (
        <div className="mt-2 space-y-2 rounded-md border border-amber-eje-200 bg-amber-eje-50 p-2">
          <p className="text-xs text-steel-700" data-testid={`standby-edit-confirm-${position}`}>
            {week.timing === 'current' ? 'This week is in progress: an emergency change.' : 'This week is published.'} Everyone affected is told.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => void save(choice)}
              loading={operation.running}
              data-testid={`standby-edit-save-${position}`}
            >
              Save change
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setChoice(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {operation.error !== null && (
        <p role="alert" className="mt-1 text-sm font-medium text-signal-600">
          {operation.error}
        </p>
      )}
    </div>
  );
};
