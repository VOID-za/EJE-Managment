'use client';

import type { StandbyCalendar, StandbySwapView, StandbyWeekView } from '@/application/standby';
import { Badge, Button, Modal } from '@/components/ui';
import { StandbyPlaceEditor } from './StandbyPlaceEditor';
import { weekRangeLabel } from './standby-format';

/**
 * ONE WEEK, IN FULL. STANDBY-2.
 *
 * Everybody sees the four places and the pending swap requests that touch the
 * week (clearly apart from the published places: a pending request changes
 * nothing). A technician holding a swappable place here can ask for a swap;
 * the office can change any place of a week that has not ended.
 */
export const StandbyWeekDialog = ({
  week,
  calendar,
  requests,
  meId,
  onClose,
  onRequestSwap,
  onSaved,
}: {
  readonly week: StandbyWeekView | null;
  readonly calendar: StandbyCalendar;
  readonly requests: readonly StandbySwapView[];
  readonly meId: string | null;
  readonly onClose: () => void;
  readonly onRequestSwap: (weekStart: string) => void;
  readonly onSaved: (message: string) => void;
}) => {
  if (week === null) return null;
  const pending = requests.filter(
    (request) =>
      request.status === 'pending' &&
      (request.requesterWeekStart === week.weekStart || request.counterpartWeekStart === week.weekStart),
  );
  const mySwappable = calendar.mine.some((place) => place.weekStart === week.weekStart && place.swapKind !== null);
  const canSwapHere = calendar.canRequestSwap && week.timing === 'future' && mySwappable;

  return (
    <Modal
      open
      title={`Standby: ${weekRangeLabel(week.weekStart)}`}
      description={
        week.status === 'draft'
          ? 'DRAFT — the office’s working copy. Technicians do not see this week until it is published.'
          : week.timing === 'past'
            ? 'This week has ended. It is kept as history and is not changed.'
            : 'The published standby for this week.'
      }
      onClose={onClose}
      size="lg"
      footer={
        <>
          {canSwapHere && (
            <Button onClick={() => onRequestSwap(week.weekStart)} data-testid="standby-request-swap">
              Request a swap
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <div className="space-y-5" data-testid="standby-week-dialog">
        <section>
          <h3 className="mb-2 text-sm font-semibold text-steel-900">
            {week.status === 'published' ? 'Published assignments' : 'Draft assignments'}
          </h3>
          {calendar.canManage && week.timing !== 'past' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {week.places.map((place) => (
                <StandbyPlaceEditor key={place.position} week={week} position={place.position} people={calendar.people} onSaved={onSaved} />
              ))}
            </div>
          ) : (
            <dl className="grid gap-2 sm:grid-cols-2">
              {week.places.map((place) => (
                <div key={place.position} className="rounded-md bg-steel-50 px-3 py-2">
                  <dt className="text-xs font-semibold uppercase tracking-wide text-steel-500">{place.label}</dt>
                  <dd className="flex items-center gap-2 text-base font-medium text-steel-900">
                    {place.name ?? <span className="text-steel-400">Not assigned</span>}
                    {place.userId !== null && place.userId === meId && <Badge tone="violet" size="sm">You</Badge>}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </section>

        {calendar.canManage && week.problems.length > 0 && (
          <section className="rounded-md border border-signal-200 bg-signal-50 p-3" data-testid="standby-week-problems">
            <h3 className="text-sm font-semibold text-signal-700">Warnings</h3>
            <ul className="mt-1 list-disc pl-5 text-sm text-signal-700">
              {week.problems.map((problem) => (
                <li key={`${problem.position}-${problem.code}`}>{problem.message}</li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <h3 className="mb-2 text-sm font-semibold text-steel-900">Pending swap requests</h3>
          {week.pendingSwaps === 0 ? (
            <p className="text-sm text-steel-600">None.</p>
          ) : pending.length === 0 ? (
            <p className="text-sm text-steel-600">
              {week.pendingSwaps} request(s) involving this week are waiting for the office. The places above stay as
              they are until one is approved.
            </p>
          ) : (
            <ul className="space-y-2">
              {pending.map((request) => (
                <li key={request.id} className="rounded-md border border-amber-eje-200 bg-amber-eje-50 p-3 text-sm text-steel-800">
                  <Badge tone="amber" size="sm">Pending — not yet on the calendar</Badge>
                  <p className="mt-1">
                    {request.requesterName} ({weekRangeLabel(request.requesterWeekStart)}) ⇄ {request.counterpartName} (
                    {weekRangeLabel(request.counterpartWeekStart)}) — {request.kindLabel}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  );
};
