'use client';

import { useMemo, useState } from 'react';
import {
  evaluateChecklist,
  isMeasurementOutOfRange,
  requiresNote,
  type ChecklistItem,
  type ChecklistResponse,
  type ChecklistTemplate,
  type Job,
  type PassFailNa,
} from '@/domain';
import type { ChecklistAnswer } from '@/application/job-operations';
import { Badge, Button, Card, ConfirmDialog, Icon } from '@/components/ui';
import { jobs } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';
import { cn } from '@/lib/cn';
import { RuleViolationNotice } from './RuleViolationNotice';

/**
 * Tablet-first checklist.
 *
 * Design rules applied here:
 *  - one tap answers an item; typing is only ever required for measurements and
 *    explicit text items,
 *  - targets are at least 56px high so they are usable with gloves,
 *  - a failed answer immediately reveals the notes field, because a failure
 *    always needs an explanation,
 *  - progress and outstanding items are always visible.
 */
export const ChecklistRunner = ({
  job,
  template,
  editable,
  onChanged,
}: {
  readonly job: Job;
  readonly template: ChecklistTemplate;
  readonly editable: boolean;
  readonly onChanged: () => void;
}) => {
  const operation = useOperation();
  const [confirmComplete, setConfirmComplete] = useState(false);

  const responses = useMemo(() => {
    const map = new Map<string, ChecklistResponse>();
    for (const response of job.checklist?.responses ?? []) map.set(response.itemId, response);
    return map;
  }, [job.checklist]);

  const progress = evaluateChecklist(template, job.checklist);
  const started = job.checklist !== null;
  const completed = job.checklist?.completedAt !== null && job.checklist !== null;

  const answer = async (itemId: string, value: ChecklistAnswer) => {
    const ok = await operation.run(() => jobs.answerChecklist(job.id, { itemId, ...value }));
    if (ok) onChanged();
  };

  if (!started) {
    return (
      <Card>
        <div className="flex flex-col items-center py-8 text-center">
          <span className="mb-4 flex size-14 items-center justify-center rounded-full bg-eje-50 text-eje-600">
            <Icon name="check" className="size-7" />
          </span>
          <h3 className="text-lg font-semibold text-steel-900">{template.name}</h3>
          <p className="mt-2 max-w-md text-sm text-steel-500">{template.description}</p>
          <p className="mt-3 text-xs text-steel-400">
            Version {template.version} · {progress.total} items
          </p>
          {editable ? (
            <Button
              size="lg"
              className="mt-6"
              loading={operation.running}
              onClick={async () => {
                const ok = await operation.run(() => jobs.startChecklist(job.id));
                if (ok) onChanged();
              }}
            >
              Start checklist
            </Button>
          ) : (
            <p className="mt-6 text-sm text-steel-500">
              This checklist has not been started and the job is no longer editable.
            </p>
          )}
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="sticky top-20 z-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold text-steel-900">{template.name}</h3>
              <Badge tone={template.status === 'archived' ? 'amber' : 'neutral'} size="sm">
                Version {template.version}
              </Badge>
              {completed && (
                <Badge tone="green" size="sm" dot>
                  Completed
                </Badge>
              )}
            </div>
            <p className="mt-1 text-sm text-steel-500">
              {progress.answered} of {progress.total} answered
              {progress.failedItems > 0 && (
                <span className="font-semibold text-signal-600">
                  {' '}
                  · {progress.failedItems} failed
                </span>
              )}
            </p>
          </div>
          <div className="tabular text-2xl font-bold text-steel-900">
            {progress.percentComplete}%
          </div>
        </div>
        {template.status === 'archived' && (
          <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-eje-700">
            <Icon name="warning" className="mt-0.5 size-3.5 shrink-0" />
            <span>
              This job was completed against version {template.version}, which has since been
              superseded. It is shown here exactly as the customer saw it. New jobs use the current
              version.
            </span>
          </p>
        )}
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-steel-100">
          <div
            className={cn(
              'h-full rounded-full transition-all duration-300',
              progress.complete ? 'bg-verdant-500' : 'bg-eje-500',
            )}
            style={{ width: `${progress.percentComplete}%` }}
          />
        </div>
      </Card>

      {template.sections.map((section, sectionIndex) => (
        <Card key={section.id} padded={false}>
          <header className="border-b border-steel-100 px-5 py-4">
            <div className="flex items-center gap-2.5">
              <span className="tabular flex size-7 items-center justify-center rounded-full bg-steel-900 text-xs font-bold text-white">
                {sectionIndex + 1}
              </span>
              <h4 className="text-sm font-semibold text-steel-900">{section.title}</h4>
            </div>
            {section.description.length > 0 && (
              <p className="mt-1.5 pl-9 text-sm text-steel-500">{section.description}</p>
            )}
          </header>

          <ul className="divide-y divide-steel-100">
            {section.items.map((item) => (
              <ChecklistItemRow
                key={item.id}
                item={item}
                response={responses.get(item.id)}
                editable={editable && !completed}
                busy={operation.running}
                onAnswer={(value) => answer(item.id, value)}
                onAddPhoto={async () => {
                  const ok = await operation.run(() =>
                    jobs.addChecklistPhoto(job.id, item.id, `${item.id}-evidence.jpg`),
                  );
                  if (ok) onChanged();
                }}
              />
            ))}
          </ul>
        </Card>
      ))}

      {!progress.complete && (
        <RuleViolationNotice
          title={`${progress.issues.length} ${progress.issues.length === 1 ? 'item is' : 'items are'} outstanding`}
          violations={progress.issues.map((issue) => ({
            code: `${issue.itemId}-${issue.reason}`,
            message: issue.message,
          }))}
        />
      )}

      {editable && !completed && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-steel-900">Finish the checklist</p>
              <p className="mt-0.5 text-sm text-steel-500">
                {progress.complete
                  ? 'Every required item has been answered.'
                  : 'All required items must be answered before the checklist can be completed.'}
              </p>
            </div>
            <Button
              size="lg"
              variant="success"
              disabled={!progress.complete}
              onClick={() => setConfirmComplete(true)}
            >
              Complete checklist
            </Button>
          </div>
        </Card>
      )}

      <p className="px-1 text-xs text-steel-400">
        Demonstration content. The production system preserves the exact wording of the approved
        EJE / WD Hearn checklist documents. Source: {template.sourceDocument}
      </p>

      <ConfirmDialog
        open={confirmComplete}
        title="Complete this checklist?"
        message={
          <>
            <p>
              {template.name} ({template.version}) will be marked as complete and attached to{' '}
              {job.jobNumber}.
            </p>
            {progress.failedItems > 0 && (
              <p className="mt-2 font-semibold text-signal-600">
                {progress.failedItems} {progress.failedItems === 1 ? 'item' : 'items'} recorded as
                failed. These will appear on the customer job card.
              </p>
            )}
          </>
        }
        confirmLabel="Complete checklist"
        confirmVariant="success"
        busy={operation.running}
        onConfirm={async () => {
          const ok = await operation.run(() => jobs.completeChecklist(job.id));
          setConfirmComplete(false);
          if (ok) onChanged();
        }}
        onCancel={() => setConfirmComplete(false)}
      />
    </div>
  );
};

const ChecklistItemRow = ({
  item,
  response,
  editable,
  busy,
  onAnswer,
  onAddPhoto,
}: {
  readonly item: ChecklistItem;
  readonly response: ChecklistResponse | undefined;
  readonly editable: boolean;
  readonly busy: boolean;
  readonly onAnswer: (value: ChecklistAnswer) => void;
  readonly onAddPhoto: () => void;
}) => {
  const [measurement, setMeasurement] = useState(
    response?.measurement === null || response?.measurement === undefined
      ? ''
      : String(response.measurement),
  );
  const [text, setText] = useState(response?.text ?? '');
  const [notes, setNotes] = useState(response?.notes ?? '');

  const failed =
    (item.responseType === 'pass_fail_na' && response?.choice === 'fail') ||
    (item.responseType === 'yes_no' && response?.yesNo === false);
  const outOfRange = isMeasurementOutOfRange(item, response);
  const photoMissing = item.photoRequired && (response?.photos.length ?? 0) === 0;
  const noteRequired = requiresNote(item, response);
  const noteMissing = noteRequired && (response?.notes ?? '').trim().length === 0;

  return (
    <li className={cn('px-5 py-4', failed && 'bg-signal-50/40')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-steel-900">
            {item.text}
            {item.required && <span className="ml-1 text-signal-500">*</span>}
          </p>
          {item.helpText.length > 0 && (
            <p className="mt-0.5 text-xs text-steel-500">{item.helpText}</p>
          )}
        </div>
        {item.photoRequired && (
          <Badge tone={photoMissing ? 'amber' : 'green'} size="sm">
            <Icon name="camera" className="size-3" />
            Photo
          </Badge>
        )}
      </div>

      <div className="mt-3">
        {item.responseType === 'pass_fail_na' && (
          <ChoiceButtons
            value={response?.choice ?? null}
            disabled={!editable}
            onChange={(choice) => onAnswer({ choice })}
          />
        )}

        {item.responseType === 'yes_no' && (
          <YesNoButtons
            value={response?.yesNo ?? null}
            disabled={!editable}
            onChange={(yesNo) => onAnswer({ yesNo })}
          />
        )}

        {item.responseType === 'measurement' && (
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-44">
              <label className="mb-1.5 block text-xs font-semibold text-steel-600">
                Measured value{item.unit !== null && ` (${item.unit})`}
              </label>
              <input
                type="number"
                step="any"
                inputMode="decimal"
                value={measurement}
                disabled={!editable || busy}
                onChange={(event) => setMeasurement(event.target.value)}
                onBlur={() => {
                  const parsed = Number.parseFloat(measurement);
                  onAnswer({ measurement: Number.isFinite(parsed) ? parsed : null });
                }}
                className={cn(
                  'tabular h-14 w-full rounded-[var(--radius-control)] border px-3 text-lg font-semibold',
                  'focus:ring-2 focus:ring-eje-100 focus:outline-none disabled:bg-steel-50',
                  outOfRange
                    ? 'border-signal-400 bg-signal-50 text-signal-700'
                    : 'border-steel-300 text-steel-900 focus:border-eje-500',
                )}
              />
            </div>
            {item.expectedRange !== null && (
              <p
                className={cn(
                  'pb-4 text-xs font-medium',
                  outOfRange ? 'text-signal-600' : 'text-steel-500',
                )}
              >
                {outOfRange ? 'Outside the expected range: ' : 'Expected: '}
                {item.expectedRange.min} – {item.expectedRange.max}
                {item.unit !== null && ` ${item.unit}`}
              </p>
            )}
          </div>
        )}

        {item.responseType === 'text' && (
          <textarea
            rows={2}
            value={text}
            disabled={!editable || busy}
            onChange={(event) => setText(event.target.value)}
            onBlur={() => onAnswer({ text })}
            placeholder="Type your answer"
            className="w-full rounded-[var(--radius-control)] border border-steel-300 px-3 py-2.5 text-sm focus:border-eje-500 focus:ring-2 focus:ring-eje-100 focus:outline-none disabled:bg-steel-50"
          />
        )}
      </div>

      {/* A note field on EVERY item. Only a finding makes it compulsory. */}
      <div className="mt-3">
        <label className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-steel-600">
          Note
          {noteRequired ? (
            <span className="font-bold text-signal-600">Required — explain the finding</span>
          ) : (
            <span className="font-normal text-steel-400">Optional</span>
          )}
        </label>
        <textarea
          rows={2}
          value={notes}
          disabled={!editable || busy}
          onChange={(event) => setNotes(event.target.value)}
          onBlur={() => onAnswer({ notes })}
          placeholder={
            noteRequired
              ? 'What was found, and what is recommended?'
              : 'Anything worth recording (optional)'
          }
          aria-invalid={noteMissing}
          className={cn(
            'w-full rounded-[var(--radius-control)] border px-3 py-2.5 text-sm focus:ring-2 focus:outline-none disabled:bg-steel-50',
            noteMissing
              ? 'border-signal-400 bg-signal-50 focus:border-signal-500 focus:ring-signal-100'
              : 'border-steel-300 focus:border-eje-500 focus:ring-eje-100',
          )}
        />
        {noteMissing && (
          <p className="mt-1 text-xs font-medium text-signal-600">
            This item was not passed, so a note is required before the checklist can be
            completed.
          </p>
        )}
      </div>

      {item.photoRequired && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {(response?.photos ?? []).map((photo) => (
            <span
              key={photo.id}
              className="inline-flex items-center gap-1.5 rounded-[var(--radius-control)] bg-verdant-50 px-2.5 py-1.5 text-xs font-medium text-verdant-700"
            >
              <Icon name="camera" className="size-3.5" />
              {photo.fileName}
            </span>
          ))}
          {editable && (
            <Button
              size="sm"
              variant="secondary"
              leadingIcon={<Icon name="camera" className="size-4" />}
              onClick={onAddPhoto}
              disabled={busy}
            >
              Add photo
              <span className="ml-1 text-[10px] font-normal text-steel-400">(simulated)</span>
            </Button>
          )}
        </div>
      )}
    </li>
  );
};

const CHOICES: readonly { value: PassFailNa; label: string; tone: string }[] = [
  { value: 'pass', label: 'Pass', tone: 'verdant' },
  { value: 'fail', label: 'Fail', tone: 'signal' },
  { value: 'na', label: 'N/A', tone: 'steel' },
];

const ChoiceButtons = ({
  value,
  disabled,
  onChange,
}: {
  readonly value: PassFailNa | null;
  readonly disabled: boolean;
  readonly onChange: (choice: PassFailNa) => void;
}) => (
  <div className="grid max-w-md grid-cols-3 gap-2">
    {CHOICES.map((choice) => {
      const active = value === choice.value;
      return (
        <button
          key={choice.value}
          type="button"
          disabled={disabled}
          aria-pressed={active}
          onClick={() => onChange(choice.value)}
          className={cn(
            'h-14 rounded-[var(--radius-control)] border-2 text-sm font-bold transition-colors disabled:opacity-60',
            active && choice.tone === 'verdant' && 'border-verdant-500 bg-verdant-500 text-white',
            active && choice.tone === 'signal' && 'border-signal-500 bg-signal-500 text-white',
            active && choice.tone === 'steel' && 'border-steel-500 bg-steel-500 text-white',
            !active && 'border-steel-200 bg-surface text-steel-600 hover:border-steel-400',
          )}
        >
          {choice.label}
        </button>
      );
    })}
  </div>
);

const YesNoButtons = ({
  value,
  disabled,
  onChange,
}: {
  readonly value: boolean | null;
  readonly disabled: boolean;
  readonly onChange: (value: boolean) => void;
}) => (
  <div className="grid max-w-xs grid-cols-2 gap-2">
    {[
      { label: 'Yes', flag: true },
      { label: 'No', flag: false },
    ].map((option) => {
      const active = value === option.flag;
      return (
        <button
          key={option.label}
          type="button"
          disabled={disabled}
          aria-pressed={active}
          onClick={() => onChange(option.flag)}
          className={cn(
            'h-14 rounded-[var(--radius-control)] border-2 text-sm font-bold transition-colors disabled:opacity-60',
            active
              ? 'border-action bg-action text-white'
              : 'border-steel-200 bg-surface text-steel-600 hover:border-steel-400',
          )}
        >
          {option.label}
        </button>
      );
    })}
  </div>
);
