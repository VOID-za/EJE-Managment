'use client';

import { jobs } from '@/api/endpoints';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Job, JobCompletionReport } from '@/domain';
import { Badge, Button, Card, CardHeader, ConfirmDialog, TextAreaField } from '@/components/ui';
import { createAutosaver, type AutosaveStatus } from '@/lib/autosave';
import {
  discardReportDraft,
  draftDiffersFrom,
  readReportDraft,
  saveReportDraft,
  type ReportDraft,
} from '@/lib/pwa/report-draft';
import { useCaptureLock } from '@/hooks/useCaptureLock';
import { useCurrentUser } from '@/providers/AppProvider';
import { formatDateTime, formatTime } from '@/lib/format';

const FIELDS: readonly {
  key: keyof JobCompletionReport;
  label: string;
  placeholder: string;
  hint: string;
  required: boolean;
}[] = [
  {
    key: 'faultFindings',
    label: 'Fault findings',
    placeholder: 'What did you find when you arrived and investigated?',
    hint: 'The condition found on site.',
    required: false,
  },
  {
    key: 'diagnosis',
    label: 'Diagnosis',
    placeholder: 'What was the root cause?',
    hint: 'Why the fault occurred.',
    required: false,
  },
  {
    key: 'workPerformed',
    label: 'Work performed',
    placeholder: 'What did you actually do to the machine?',
    hint: 'This is the core of the customer job card and is required before signature.',
    required: true,
  },
  {
    key: 'recommendations',
    label: 'Recommendations',
    placeholder: 'What should the customer do next?',
    hint: 'Follow-up work, parts to budget for, or preventative advice.',
    required: false,
  },
  {
    key: 'generalNotes',
    label: 'General notes',
    placeholder: 'Anything else worth recording.',
    hint: 'Anything else that belongs in the formal completion record.',
    required: false,
  },
];

const sameReport = (a: JobCompletionReport, b: JobCompletionReport): boolean =>
  FIELDS.every((field) => a[field.key] === b[field.key]);

/**
 * Completion write-up.
 *
 * IT SAVES ITSELF. MASTER SCOPE WRITEUP-1.
 *
 * It used to hold everything typed in the browser until somebody pressed Save
 * write-up, with a beforeunload warning as the only safety net — and a warning
 * is not a safety net on a tablet that locks, runs out of battery or gets
 * handed to a customer mid-sentence. A technician standing at a machine should
 * be able to type and walk away.
 *
 * NOT ON EVERY KEYSTROKE. The rules — hold the edit, write once the typing
 * stops, write anyway if it never does, never two writes at once, never lose
 * the text when a write fails — are `createAutosaver`, which is unit-tested on
 * its own. This component only wires it to the fields and says what is
 * happening.
 *
 * Both explicit actions survive, because both still mean something: Save now
 * writes without waiting, which is what the technician wants before handing the
 * tablet over, and Discard is a real operation — it throws the held edit away
 * and puts back what the server holds.
 */
export const CompletionReportPanel = ({
  job,
  editable,
  onChanged,
}: {
  readonly job: Job;
  readonly editable: boolean;
  readonly onChanged: () => void;
}) => {
  const [draft, setDraft] = useState<JobCompletionReport>(job.completionReport);
  const [status, setStatus] = useState<AutosaveStatus>({ kind: 'clean' });

  /*
   * Counted rather than called back.
   *
   * The parent has to be told when a save lands — the close-out wizard reads
   * `job.completionReport` to decide whether the customer may sign, so a Work
   * performed that only exists in this component's draft would leave Continue
   * refused. But `onChanged` is a new function on every render, and closing
   * over it would mean rebuilding the saver on every render — throwing away
   * the pending edit and its timer, which is the exact failure this exists to
   * prevent. A state setter is stable, so the saver closes over THAT, and an
   * effect does the telling.
   */
  const [saves, setSaves] = useState(0);

  /*
   * TYPING IS A CAPTURE. PWA-7.
   *
   * Held while there is an edit the server has not taken — `pending` is the
   * window between a keystroke and the autosave, `saving` is the write itself,
   * `failed` is text that exists only on this tablet. The update bar appearing
   * above the panel in any of those three moves the textarea under the hands
   * typing into it. `clean` and `saved` are not captures: there is nothing
   * outstanding, which is exactly when a technician may update between jobs.
   */
  useCaptureLock(
    status.kind === 'pending' || status.kind === 'saving' || status.kind === 'failed',
  );

  /*
   * THE TEXT THAT COULD NOT BE SAVED, KEPT ON THE DEVICE. OFF-WRITEUP-1.
   *
   * Offline every autosave fails, and until this existed the only copy of the
   * write-up was this component's state — so a tablet locking took it. A
   * failed save now also writes a LOCAL DRAFT, which is the technician's own
   * text under their own id and is never sent by anything: a write-up replaces
   * a value on the job, so replaying one hours later is the silent overwrite
   * CR-02 forbids. `report-draft.ts` is where that reasoning lives.
   *
   * Putting it on the job is the ordinary online save, made deliberately by
   * the technician — see the notice below.
   */
  const currentUser = useCurrentUser();
  const userId = currentUser?.id ?? '';
  const [localDraft, setLocalDraft] = useState<ReportDraft | null>(null);
  const [discarding, setDiscarding] = useState(false);

  const saver = useMemo(
    () =>
      createAutosaver<JobCompletionReport>(job.completionReport, {
        equal: sameReport,
        onStatus: setStatus,
        save: async (report) => {
          try {
            await jobs.saveReport(job.id, report);
          } catch (cause) {
            /*
             * Kept BEFORE the failure is reported, so the status the technician
             * reads and the bytes on the device cannot disagree. The error is
             * rethrown: the autosaver owns what "not saved" means and will try
             * again — this only makes sure the text outlives the attempt.
             */
            await saveReportDraft({
              userId,
              jobId: job.id,
              jobNumber: job.jobNumber,
              report,
            })
              .then((kept) => setLocalDraft(kept))
              .catch(() => undefined);
            throw cause;
          }
          // The server has the text, so the device's copy has nothing to say.
          await discardReportDraft(userId, job.id).catch(() => undefined);
          setLocalDraft(null);
          setSaves((count) => count + 1);
        },
      }),
    // Per job, and only per job. `job.completionReport` deliberately does not
    // key this: the refetch that follows every successful save would otherwise
    // replace the saver mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [job.id],
  );

  /** A draft this tablet kept earlier — on this job, for this technician. */
  const reloadDraft = useCallback(() => {
    if (userId.length === 0) return;
    void readReportDraft(userId, job.id).then(setLocalDraft);
  }, [userId, job.id]);

  useEffect(reloadDraft, [reloadDraft]);

  useEffect(() => {
    if (saves === 0) return;
    onChanged();
    // `onChanged` is intentionally not a dependency: it changes identity on
    // every render, and this must fire per SAVE, not per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saves]);

  const dirty = saver.dirty();

  /*
   * The last line of defence, kept.
   *
   * Autosave makes this rare rather than impossible: a browser closed within
   * the debounce window still has an unwritten edit, and a save that FAILED
   * leaves one indefinitely. The prompt is the only thing between that and
   * losing it.
   */
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  /*
   * Leaving the panel writes what is held.
   *
   * Moving off the Completion tab, or forward through the close-out wizard,
   * unmounts this — and an edit made a second before that would otherwise sit
   * in a timer that is about to be thrown away.
   */
  useEffect(() => () => void saver.flush(), [saver]);

  const edit = (key: keyof JobCompletionReport, value: string): void => {
    setDraft((current) => {
      const next = { ...current, [key]: value };
      saver.change(next);
      return next;
    });
  };

  return (
    <Card>
      <CardHeader
        title="Completion write-up"
        description="The formal technical record of what was done, printed on the customer job card. Running commentary and customer conversations belong on the Notes tab instead."
        action={editable ? <SaveState status={status} /> : undefined}
      />

      <div className="mt-5 space-y-4">
        {FIELDS.map((field) => (
          <TextAreaField
            key={field.key}
            label={field.label}
            required={field.required}
            hint={field.hint}
            rows={field.key === 'workPerformed' ? 5 : 3}
            disabled={!editable}
            value={draft[field.key]}
            onChange={(event) => edit(field.key, event.target.value)}
            placeholder={field.placeholder}
          />
        ))}
      </div>

      {status.kind === 'failed' && (
        <p role="alert" className="mt-3 text-sm text-signal-600">
          {status.message} Your text is still here and has not been lost — it is kept on this
          tablet and will be saved on the next attempt.
        </p>
      )}

      {/*
        A LOCAL DRAFT IS NOT A SAVED WRITE-UP, and the notice says which it is.
        OFF-WRITEUP-1. Shown only while the device's copy says something the
        server's does not — once the text is on the job there is nothing to
        offer back.
      */}
      {localDraft !== null && draftDiffersFrom(localDraft, job.completionReport) && (
        <div
          className="mt-4 rounded-[var(--radius-control)] border border-amber-eje-200 bg-amber-eje-50 px-3.5 py-3"
          data-testid="writeup-local-draft"
        >
          <p className="text-sm font-semibold text-amber-eje-800">
            A write-up typed on this tablet is NOT on the server.
          </p>
          <p className="mt-1 text-xs text-amber-eje-800">
            Kept here since {formatDateTime(localDraft.savedAt)}, under your name and visible to
            nobody else. Nothing sends it by itself: load it into the form and it saves to the job
            the ordinary way, with every rule that applies to a write-up typed at a desk.
          </p>
          {editable && (
            <div className="mt-2.5 flex flex-wrap gap-2">
              <Button
                size="sm"
                data-testid="writeup-use-draft"
                onClick={() => {
                  setDraft(localDraft.report);
                  saver.change(localDraft.report);
                }}
              >
                Load the draft into the form
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDiscarding(true)}>
                Discard the draft
              </Button>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={discarding}
        title="Throw this draft away?"
        message={
          <>
            <p>
              The write-up kept on this tablet will be deleted. It has never reached the EJE
              server, so there is no other copy of it.
            </p>
            <p className="mt-2 text-steel-500">
              What is on the job now stays exactly as it is.
            </p>
          </>
        }
        confirmLabel="Delete the draft"
        confirmVariant="danger"
        onConfirm={() => {
          setDiscarding(false);
          void discardReportDraft(userId, job.id).then(() => setLocalDraft(null));
        }}
        onCancel={() => setDiscarding(false)}
      />

      {editable && (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-steel-100 pt-4">
          <p className="text-xs text-steel-500">
            This write-up saves itself as you type. There is nothing to press.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                // A real operation, not a UI reset: the held edit is thrown
                // away AND its pending write cancelled, so nothing lands after.
                saver.cancel();
                setDraft(saver.saved());
              }}
              disabled={!dirty}
            >
              Discard changes
            </Button>
            <Button
              onClick={() => void saver.flush()}
              loading={status.kind === 'saving'}
              disabled={!dirty}
            >
              {status.kind === 'failed' ? 'Try saving again' : 'Save now'}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
};

/** Saving, saved or failed — said plainly, in the header. */
const SaveState = ({ status }: { readonly status: AutosaveStatus }) => {
  switch (status.kind) {
    case 'pending':
      return (
        <Badge tone="amber" size="sm" dot>
          Unsaved changes
        </Badge>
      );
    case 'saving':
      return (
        <Badge tone="amber" size="sm" dot>
          Saving…
        </Badge>
      );
    case 'saved':
      return (
        <Badge tone="green" size="sm">
          Saved {formatTime(status.at)}
        </Badge>
      );
    case 'failed':
      return (
        <Badge tone="red" size="sm" dot>
          Not saved
        </Badge>
      );
    case 'clean':
      return null;
  }
};
