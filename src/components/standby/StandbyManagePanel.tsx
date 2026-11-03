'use client';

import { useState } from 'react';
import {
  STANDBY_POSITIONS,
  STANDBY_POSITION_LABELS,
  standbyCategoryOf,
  standbyWeeksOfYear,
  type StandbyPosition,
} from '@/domain';
import type { StandbyCalendar, StandbyGenerateResult, StandbyPerson } from '@/application/standby';
import { Badge, Button, Card, CardHeader, Icon, LoadingPanel, Modal, QueryFailure, SelectField } from '@/components/ui';
import { standby } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';
import { useQuery } from '@/hooks/useQuery';
import { cn } from '@/lib/cn';
import { StandbyPlaceEditor } from './StandbyPlaceEditor';
import { weekRangeLabel } from './standby-format';

type Rotation = Record<StandbyPosition, readonly string[]>;
const NO_ROTATION: Rotation = { main: [], helper: [], apprentice_1: [], apprentice_2: [] };

const fits = (person: StandbyPerson, position: StandbyPosition): boolean => {
  const category = standbyCategoryOf(position);
  return person.active && (category === 'main' ? person.main : category === 'helper' ? person.helper : person.apprentice);
};

/**
 * ANNUAL SCHEDULE ADMINISTRATION. STANDBY-1, STANDBY-4. The office only (the
 * server refuses everybody else).
 *
 *   1. Who may stand by — per person: main, helper, or apprentice.
 *   2. Generate the year — creates the year's remaining weeks as DRAFTS. If the
 *      office enters an order for a place, week n takes person n of that order;
 *      with no order the weeks are created empty. Nothing is invented, a filled
 *      place or a published week is never overwritten, a past week never touched.
 *   3. Review and edit every week; warnings show what is missing or wrong.
 *   4. Publish — refused while a week has an ineligible or inactive person;
 *      empty places only with an explicit acknowledgement.
 */
export const StandbyManagePanel = ({ today, onMessage }: { readonly today: string; readonly onMessage: (message: string) => void }) => {
  const current = Number(today.slice(0, 4));
  const [year, setYear] = useState(current);
  const [rotation, setRotation] = useState<Rotation>(NO_ROTATION);
  const [adding, setAdding] = useState<Record<StandbyPosition, string>>({ main: '', helper: '', apprentice_1: '', apprentice_2: '' });
  const [generated, setGenerated] = useState<StandbyGenerateResult | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [acknowledge, setAcknowledge] = useState(false);
  const operation = useOperation();
  const weeks = standbyWeeksOfYear(year);
  const query = useQuery(`standby-year:${year}`, () => standby.calendar(weeks[0]!, weeks[weeks.length - 1]!));

  if (query.error !== null) return <QueryFailure code={query.errorCode} message={query.error} onRetry={query.refetch} />;
  if (query.data === null) return <LoadingPanel rows={5} label="Loading the standby year" />;
  const data: StandbyCalendar = query.data;
  const technicians = data.people;
  const drafts = data.weeks.filter((week) => week.status === 'draft' && week.timing !== 'past');
  const blocking = drafts.flatMap((week) => week.problems.filter((problem) => problem.code !== 'missing').map((problem) => ({ week, problem })));
  const incomplete = drafts.filter((week) => week.problems.some((problem) => problem.code === 'missing'));

  const setEligibility = async (person: StandbyPerson, next: Pick<StandbyPerson, 'main' | 'helper' | 'apprentice'>) => {
    const ok = await operation.run(() => standby.setEligibility({ userId: person.id, ...next }));
    if (ok) onMessage(`Standby eligibility saved for ${person.name}.`);
  };

  const generate = async () => {
    const result = await operation.runFor(() => standby.generate(year, rotation));
    if (result !== null) {
      setGenerated(result.result);
      onMessage(`${year}: ${result.result.created.length} draft weeks added, ${result.result.placesFilled} places filled. Review them, then publish.`);
    }
  };

  const publish = async () => {
    const result = await operation.runFor(() => standby.publish(year, acknowledge));
    if (result !== null) {
      setPublishing(false);
      setAcknowledge(false);
      onMessage(`${year}: ${result.result.published.length} weeks published. Technicians can now see them.`);
    }
  };

  return (
    <div className="space-y-5" data-testid="standby-manage">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" aria-label="Previous year" disabled={year <= current} onClick={() => setYear(year - 1)}>
              <Icon name="arrowLeft" className="size-4" />
            </Button>
            <h2 className="text-lg font-semibold text-steel-900" data-testid="standby-manage-year">
              Standby {year}
            </h2>
            <Button variant="secondary" size="sm" aria-label="Next year" disabled={year >= current + 1} onClick={() => setYear(year + 1)}>
              <Icon name="chevronRight" className="size-4" />
            </Button>
          </div>
          <p className="text-sm text-steel-600">
            {data.weeks.length} of {weeks.length} weeks on file · {drafts.length} draft · planning up to {data.planningLimit}
          </p>
        </div>
        {operation.error !== null && (
          <div role="alert" className="mt-3 rounded-md border border-signal-200 bg-signal-50 p-3 text-sm text-signal-700" data-testid="standby-manage-error">
            <p className="font-semibold">{operation.error}</p>
            {operation.violations.length > 0 && (
              <ul className="mt-1 list-disc pl-5">
                {operation.violations.slice(0, 12).map((violation, index) => (
                  <li key={`${violation.code}-${index}`}>{violation.message}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>

      <Card data-testid="standby-eligibility">
        <CardHeader
          title="1. Who may stand by"
          description="The office decides who may take each place — no account is assumed to be eligible. A Senior Tech takes main and helper places; an apprentice takes apprentice places only."
        />
        <ul className="mt-3 divide-y divide-steel-100">
          {technicians.map((person) => (
            <li key={person.id} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="standby-eligibility-row">
              <span className={cn('text-sm font-medium', person.active ? 'text-steel-900' : 'text-steel-400')}>
                {person.name}
                {person.seniorTech === true && ' (Senior Tech)'}
                {!person.active && ' (inactive)'}
              </span>
              <span className="flex flex-wrap gap-1.5">
                {(person.seniorTech === true ? (['main', 'helper'] as const) : (['main', 'helper', 'apprentice'] as const)).map((flag) => (
                  <label
                    key={flag}
                    className={cn(
                      'flex min-h-11 cursor-pointer items-center gap-2 rounded-[var(--radius-control)] border px-3 text-sm',
                      person[flag] ? 'border-eje-300 bg-eje-50 text-eje-700' : 'border-steel-200 text-steel-600',
                    )}
                  >
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={person[flag]}
                      disabled={!person.active || operation.running}
                      data-testid={`standby-eligible-${flag}`}
                      onChange={(event) => {
                        const on = event.target.checked;
                        const next =
                          flag === 'apprentice'
                            ? { main: false, helper: false, apprentice: on }
                            : { main: person.main, helper: person.helper, apprentice: false, [flag]: on };
                        void setEligibility(person, next);
                      }}
                    />
                    {flag === 'main' ? 'Main' : flag === 'helper' ? 'Helper' : 'Apprentice'}
                  </label>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Card data-testid="standby-generate">
        <CardHeader
          title={`2. Generate ${year}`}
          description="Creates every remaining week of the year as a draft. Optionally enter an order for a place: week 1 of the year takes the first person, week 2 the second, and so on, repeating. Leave an order empty to fill that place by hand. Existing weeks and filled places are never overwritten."
        />
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          {STANDBY_POSITIONS.map((position) => {
            const order = rotation[position];
            const choices = technicians.filter((person) => fits(person, position));
            return (
              <div key={position} className="rounded-md border border-steel-200 p-3" data-testid={`standby-rotation-${position}`}>
                <p className="text-sm font-semibold text-steel-900">{STANDBY_POSITION_LABELS[position]}</p>
                {order.length === 0 ? (
                  <p className="mt-1 text-sm text-steel-500">No order — filled by hand.</p>
                ) : (
                  <ol className="mt-2 space-y-1">
                    {order.map((id, index) => (
                      <li key={`${id}-${index}`} className="flex items-center justify-between gap-2 rounded bg-steel-50 px-2 py-1 text-sm">
                        <span>
                          {index + 1}. {technicians.find((person) => person.id === id)?.name ?? id}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label="Remove from the order"
                          onClick={() => setRotation({ ...rotation, [position]: order.filter((_, at) => at !== index) })}
                        >
                          <Icon name="close" className="size-4" />
                        </Button>
                      </li>
                    ))}
                  </ol>
                )}
                <div className="mt-2 flex items-end gap-2">
                  <SelectField
                    containerClassName="flex-1"
                    label="Add to the order"
                    value={adding[position]}
                    placeholder={choices.length === 0 ? 'Nobody eligible yet' : 'Choose…'}
                    options={choices.map((person) => ({ value: person.id, label: person.name }))}
                    onChange={(event) => setAdding({ ...adding, [position]: event.target.value })}
                  />
                  <Button
                    variant="secondary"
                    disabled={adding[position].length === 0}
                    onClick={() => {
                      setRotation({ ...rotation, [position]: [...order, adding[position]] });
                      setAdding({ ...adding, [position]: '' });
                    }}
                  >
                    Add
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={() => void generate()} loading={operation.running} data-testid="standby-generate-button">
            Generate {year} as drafts
          </Button>
          {generated !== null && (
            <p className="text-sm text-steel-700" data-testid="standby-generate-result">
              {generated.created.length} weeks added · {generated.placesFilled} places filled · {generated.weeksLeftAlone} left as they were
              {generated.skipped.length > 0 && ` · ${generated.skipped.length} places not filled (someone already held a place that week)`}
            </p>
          )}
        </div>
      </Card>

      <Card data-testid="standby-review">
        <CardHeader
          title={`3. Review ${year}`}
          description="Every week on file. Change any place of a week that has not ended; a published week asks for the reason, and everyone affected is told."
          action={
            <Button onClick={() => setPublishing(true)} disabled={drafts.length === 0} data-testid="standby-publish-open">
              Publish {year}
            </Button>
          }
        />
        {data.weeks.length === 0 ? (
          <p className="mt-3 text-sm text-steel-600">No weeks yet. Generate the year above.</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {data.weeks.map((week) => (
              <li
                key={week.weekStart}
                data-testid="standby-review-week"
                data-week={week.weekStart}
                className={cn('rounded-md border p-3', week.status === 'draft' ? 'border-dashed border-steel-300' : 'border-steel-200')}
              >
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-steel-900">{weekRangeLabel(week.weekStart)}</p>
                  <Badge tone={week.status === 'draft' ? 'outline' : 'green'} size="sm">
                    {week.status === 'draft' ? 'Draft' : 'Published'}
                  </Badge>
                  {week.timing === 'past' && <Badge tone="neutral" size="sm">Ended</Badge>}
                  {week.timing === 'current' && <Badge tone="blue" size="sm">This week</Badge>}
                  {week.pendingSwaps > 0 && <Badge tone="amber" size="sm">Swap pending</Badge>}
                </div>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {STANDBY_POSITIONS.map((position) => (
                    <StandbyPlaceEditor key={`${week.weekStart}-${position}-${week.places.find((p) => p.position === position)?.userId ?? ''}`} week={week} position={position} people={technicians} />
                  ))}
                </div>
                {week.problems.length > 0 && (
                  <ul className="mt-2 list-disc pl-5 text-xs text-signal-700">
                    {week.problems.map((problem) => (
                      <li key={`${problem.position}-${problem.code}`}>{problem.message}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal
        open={publishing}
        title={`Publish standby ${year}`}
        description="Publishing makes the draft weeks the calendar everyone works to. It cannot be undone; changes after this are recorded and the people affected are told."
        onClose={() => setPublishing(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPublishing(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void publish()}
              loading={operation.running}
              disabled={blocking.length > 0 || (incomplete.length > 0 && !acknowledge)}
              data-testid="standby-publish-confirm"
            >
              Publish {drafts.length} weeks
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm" data-testid="standby-publish-review">
          <p>
            {drafts.length} draft {drafts.length === 1 ? 'week' : 'weeks'} will be published.
          </p>
          {blocking.length > 0 && (
            <div className="rounded-md border border-signal-200 bg-signal-50 p-3 text-signal-700">
              <p className="font-semibold">Correct these first:</p>
              <ul className="mt-1 list-disc pl-5">
                {blocking.slice(0, 10).map(({ week, problem }) => (
                  <li key={`${week.weekStart}-${problem.position}-${problem.code}`}>
                    {weekRangeLabel(week.weekStart)}: {problem.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {incomplete.length > 0 && (
            <label className="flex min-h-11 items-start gap-2 rounded-md border border-amber-eje-200 bg-amber-eje-50 p-3 text-amber-eje-700">
              <input type="checkbox" className="mt-0.5 size-4" checked={acknowledge} onChange={(event) => setAcknowledge(event.target.checked)} data-testid="standby-publish-acknowledge" />
              <span>
                {incomplete.length} {incomplete.length === 1 ? 'week has' : 'weeks have'} empty places. Publish anyway — they can be filled later.
              </span>
            </label>
          )}
          {operation.error !== null && (
            <p role="alert" className="font-medium text-signal-600">
              {operation.error}
            </p>
          )}
        </div>
      </Modal>
    </div>
  );
};
