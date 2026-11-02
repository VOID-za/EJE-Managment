'use client';

import { useState } from 'react';
import { STANDBY_SWAP_KIND_LABELS, type StandbyDayPair } from '@/domain';
import { Button, Icon, Modal, SelectField, TextAreaField } from '@/components/ui';
import { standby } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';
import { useQuery } from '@/hooks/useQuery';

/**
 * ASKING FOR A STANDBY DAY SWAP. STANDBY-DAY-1 (2 November 2026).
 *
 * Choose the person, then one or more pairs: a day you give (one of your own
 * future standby days) and a day you take (one of theirs, the same kind of
 * place). Only those days change — and only once the person asked AND the
 * Office have both approved. The server checks everything again.
 */
interface Props {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onDone: (message: string) => void;
}

export const DaySwapDialog = (props: Props) => (props.open ? <DaySwapForm {...props} /> : null);

const key = (date: string, position: string) => `${date}|${position}`;

const DaySwapForm = ({ open, onClose, onDone }: Props) => {
  const optionsQuery = useQuery('standby-day-options', () => standby.dayOptions());
  const options = optionsQuery.data;
  const operation = useOperation();
  const [person, setPerson] = useState('');
  const [rows, setRows] = useState<{ mine: string; theirs: string }[]>([{ mine: '', theirs: '' }]);
  const [reason, setReason] = useState('');

  const mine = options?.mine ?? [];
  const firstMine = mine.find((option) => key(option.date, option.position) === rows[0]?.mine) ?? null;
  const kind = firstMine?.kind ?? null;
  const people = (options?.people ?? []).filter((candidate) => kind === null || candidate.days.some((day) => day.kind === kind));
  const theirDays = (options?.people.find((candidate) => candidate.userId === person)?.days ?? []).filter((day) => kind === null || day.kind === kind);
  const myDays = mine.filter((option) => kind === null || option.kind === kind);

  const chosenMine = new Set(rows.map((row) => row.mine).filter(Boolean));
  const chosenTheirs = new Set(rows.map((row) => row.theirs).filter(Boolean));
  const complete = person !== '' && kind !== null && rows.every((row) => row.mine !== '' && row.theirs !== '');

  const setRow = (index: number, change: Partial<{ mine: string; theirs: string }>) =>
    setRows((current) => current.map((row, at) => (at === index ? { ...row, ...change } : row)));

  const submit = async () => {
    if (!complete || kind === null) return;
    const pairs: StandbyDayPair[] = rows.map((row) => {
      const [requesterDate, requesterPosition] = row.mine.split('|');
      const [recipientDate, recipientPosition] = row.theirs.split('|');
      return {
        requesterDate: requesterDate!,
        requesterPosition: requesterPosition as StandbyDayPair['requesterPosition'],
        recipientDate: recipientDate!,
        recipientPosition: recipientPosition as StandbyDayPair['recipientPosition'],
      };
    });
    const ok = await operation.run(() => standby.requestDaySwap({ recipientId: person, kind, pairs, reason }));
    if (ok) {
      const name = options?.people.find((candidate) => candidate.userId === person)?.name ?? 'They';
      onDone(`Swap request sent to ${name}. Nothing changes until ${name} and then the Office approve it.`);
    }
  };

  return (
    <Modal
      open={open}
      title="Request a standby day swap"
      description="Choose the days to exchange. Only those days change, and only after the other person and then the Office approve."
      onClose={onClose}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={operation.running} disabled={!complete} data-testid="day-swap-submit">
            Send request
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="day-swap-dialog">
        {optionsQuery.error !== null && <p role="alert" className="text-sm text-signal-600">{optionsQuery.error}</p>}
        {options !== null && mine.length === 0 && (
          <p className="text-sm text-steel-600" data-testid="day-swap-none">
            You have no future standby days that can be swapped (main or apprentice places in published weeks).
          </p>
        )}
        {mine.length > 0 && (
          <>
            {rows.map((row, index) => (
              <fieldset key={index} className="space-y-3 rounded-[var(--radius-control)] border border-steel-200 p-3" data-testid="day-swap-pair">
                <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-steel-500">Pair {index + 1}</legend>
                <SelectField
                  label="The day you give"
                  value={row.mine}
                  onChange={(event) => setRow(index, { mine: event.target.value })}
                  options={[
                    { value: '', label: 'Choose one of your days' },
                    ...myDays
                      .filter((option) => !chosenMine.has(key(option.date, option.position)) || key(option.date, option.position) === row.mine)
                      .map((option) => ({ value: key(option.date, option.position), label: option.label })),
                  ]}
                  data-testid={`day-swap-mine-${index}`}
                />
                {index === 0 && (
                  <SelectField
                    label="Swap with"
                    value={person}
                    onChange={(event) => {
                      setPerson(event.target.value);
                      setRows((current) => current.map((candidate) => ({ ...candidate, theirs: '' })));
                    }}
                    options={[{ value: '', label: 'Choose a person' }, ...people.map((candidate) => ({ value: candidate.userId, label: candidate.name }))]}
                    hint={kind === null ? undefined : `Only people who may stand in a ${STANDBY_SWAP_KIND_LABELS[kind].toLowerCase()} place.`}
                    data-testid="day-swap-person"
                  />
                )}
                <SelectField
                  label="The day you take"
                  value={row.theirs}
                  disabled={person === ''}
                  onChange={(event) => setRow(index, { theirs: event.target.value })}
                  options={[
                    { value: '', label: person === '' ? 'Choose the person first' : 'Choose one of their days' },
                    ...theirDays
                      .filter((day) => !chosenTheirs.has(key(day.date, day.position)) || key(day.date, day.position) === row.theirs)
                      .map((day) => ({ value: key(day.date, day.position), label: day.label })),
                  ]}
                  data-testid={`day-swap-theirs-${index}`}
                />
                {rows.length > 1 && (
                  <Button variant="ghost" size="sm" onClick={() => setRows((current) => current.filter((_, at) => at !== index))} data-testid={`day-swap-remove-${index}`}>
                    Remove this pair
                  </Button>
                )}
              </fieldset>
            ))}
            <Button
              variant="secondary"
              size="sm"
              leadingIcon={<Icon name="plus" className="size-4" />}
              disabled={rows.length >= 14 || !complete}
              onClick={() => setRows((current) => [...current, { mine: '', theirs: '' }])}
              data-testid="day-swap-add-pair"
            >
              Add another pair of days
            </Button>
            <TextAreaField label="Reason (optional)" rows={2} value={reason} onChange={(event) => setReason(event.target.value)} data-testid="day-swap-reason" />
          </>
        )}
        {operation.error !== null && (
          <p role="alert" className="text-sm font-medium text-signal-600" data-testid="day-swap-error">
            {operation.error}
          </p>
        )}
      </div>
    </Modal>
  );
};
