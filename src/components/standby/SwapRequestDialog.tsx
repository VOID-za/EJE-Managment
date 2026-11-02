'use client';

import { useMemo, useState } from 'react';
import { STANDBY_POSITION_LABELS, STANDBY_SWAP_KIND_LABELS, type IsoDate } from '@/domain';
import { Button, Modal, SelectField, TextAreaField } from '@/components/ui';
import { standby } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';
import { useQuery } from '@/hooks/useQuery';
import { weekRangeLabel } from './standby-format';

/**
 * ASKING FOR A STANDBY SWAP. STANDBY-5, STANDBY-6 steps 2–6.
 *
 * Offers only what the server says is possible: the requester's own main or
 * apprentice places in published weeks that have not started, and — for the
 * kind chosen — the same kind of place held by another eligible person. The
 * server checks all of it again on submit; this only keeps the choices honest.
 */
interface SwapRequestDialogProps {
  readonly open: boolean;
  readonly initialWeek: IsoDate | null;
  readonly onClose: () => void;
  readonly onDone: (message: string) => void;
}

/** Mounted only while open, so every opening starts from a clean form and fresh options. */
export const SwapRequestDialog = (props: SwapRequestDialogProps) =>
  props.open ? <SwapRequestForm {...props} /> : null;

const SwapRequestForm = ({ open, initialWeek, onClose, onDone }: SwapRequestDialogProps) => {
  const optionsQuery = useQuery('standby-options', () => standby.options());
  const options = optionsQuery.data;
  const loadError = optionsQuery.error;
  const [mineChoice, setMine] = useState<string | null>(null);
  const [person, setPerson] = useState('');
  const [theirs, setTheirs] = useState('');
  const [reason, setReason] = useState('');
  const operation = useOperation();
  const preferred = options?.mine.find((place) => place.weekStart === initialWeek) ?? options?.mine[0];
  const mine = mineChoice ?? (preferred === undefined ? '' : `${preferred.weekStart}|${preferred.position}`);

  const myPlace = options?.mine.find((place) => `${place.weekStart}|${place.position}` === mine) ?? null;
  const candidates = useMemo(
    () => (options?.candidates ?? []).filter((candidate) => myPlace !== null && candidate.kind === myPlace.kind && candidate.weekStart !== myPlace.weekStart),
    [options, myPlace],
  );
  const people = [...new Map(candidates.map((candidate) => [candidate.userId as string, candidate.name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const theirWeeks = candidates.filter((candidate) => candidate.userId === person);

  const submit = async () => {
    if (myPlace === null) return;
    const target = theirWeeks.find((candidate) => candidate.weekStart === theirs);
    if (target === undefined) return;
    const ok = await operation.run(() =>
      standby.requestSwap({
        kind: myPlace.kind,
        weekStart: myPlace.weekStart,
        counterpartId: person,
        counterpartWeekStart: target.weekStart,
        reason,
      }),
    );
    if (ok) onDone('Swap request sent to the office. Your standby weeks stay as they are until it is approved.');
  };

  return (
    <Modal
      open={open}
      title="Request a standby swap"
      description="Exchange one of your standby places with another person's place of the same kind. Nothing changes until the office approves it."
      onClose={onClose}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            loading={operation.running}
            disabled={myPlace === null || person.length === 0 || theirs.length === 0}
            data-testid="standby-swap-submit"
          >
            Send request
          </Button>
        </>
      }
    >
      {loadError !== null && (
        <p role="alert" className="text-sm font-medium text-signal-600">
          {loadError}
        </p>
      )}
      {options === null && loadError === null && <p className="text-sm text-steel-600">Loading…</p>}
      {options !== null && options.mine.length === 0 && (
        <p className="text-sm text-steel-700" data-testid="standby-swap-none">
          You have no standby place that can be swapped: only a main or apprentice place in a published week that has
          not started, and not already in a request waiting for the office.
        </p>
      )}
      {options !== null && options.mine.length > 0 && (
        <div className="space-y-4">
          <SelectField
            label="Your standby week"
            value={mine}
            data-testid="standby-swap-mine"
            onChange={(event) => {
              setMine(event.target.value);
              setPerson('');
              setTheirs('');
            }}
            options={options.mine.map((place) => ({
              value: `${place.weekStart}|${place.position}`,
              label: `${weekRangeLabel(place.weekStart)} — ${STANDBY_POSITION_LABELS[place.position]}`,
            }))}
          />
          {myPlace !== null && (
            <p className="text-sm text-steel-600">
              Swap type: <span className="font-semibold text-steel-900">{STANDBY_SWAP_KIND_LABELS[myPlace.kind]}</span>. Only
              this place is exchanged; everyone else in both weeks stays as they are.
            </p>
          )}
          {people.length === 0 ? (
            <p className="text-sm text-steel-700" data-testid="standby-swap-nobody">
              Nobody else eligible holds a {myPlace === null ? '' : STANDBY_SWAP_KIND_LABELS[myPlace.kind].toLowerCase()} place in another published week that can be swapped.
            </p>
          ) : (
            <SelectField
              label="Swap with"
              value={person}
              placeholder="Choose the person…"
              data-testid="standby-swap-person"
              onChange={(event) => {
                setPerson(event.target.value);
                setTheirs('');
              }}
              options={people.map(([id, name]) => ({ value: id, label: name }))}
            />
          )}
          {person.length > 0 && (
            <SelectField
              label="Their standby week"
              value={theirs}
              placeholder="Choose their week…"
              data-testid="standby-swap-theirs"
              onChange={(event) => setTheirs(event.target.value)}
              options={theirWeeks.map((candidate) => ({
                value: candidate.weekStart,
                label: `${weekRangeLabel(candidate.weekStart)} — ${STANDBY_POSITION_LABELS[candidate.position]}`,
              }))}
            />
          )}
          <TextAreaField
            label="Reason (optional)"
            value={reason}
            maxLength={1000}
            rows={3}
            data-testid="standby-swap-reason"
            onChange={(event) => setReason(event.target.value)}
          />
          {operation.error !== null && (
            <p role="alert" className="text-sm font-medium text-signal-600" data-testid="standby-swap-error">
              {operation.error}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
};
