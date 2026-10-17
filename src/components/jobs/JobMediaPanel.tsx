'use client';

import { useEffect, useRef, useState } from 'react';
import {
  getJobTypeDefinition,
  type Attachment,
  type Job,
  type MediaVisibility,
  type User,
} from '@/domain';
import {
  Button,
  Card,
  EmptyState,
  Icon,
  Modal,
  SelectField,
  TextField,
} from '@/components/ui';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { jobs } from '@/api/endpoints';
import { newIdempotencyKey } from '@/api/client';
import { useOperation } from '@/hooks/useOperation';
import { useOnline } from '@/hooks/useOnline';
import { holdMedia } from '@/lib/pwa/pending-media';
import { useCurrentUser } from '@/providers/AppProvider';
import { formatFileSize, formatRelative } from '@/lib/format';

/**
 * PHOTOGRAPHS ON A JOB — THE REAL ONES NOW. PWA-3, CR-09 Phase 3.
 *
 * WHAT THIS PANEL USED TO DO, because it is the thing that changed: it posted a
 * JSON body containing a file name it invented and a size it made up, showed a
 * grey placeholder tile, and wore an amber badge reading "Simulated — no file
 * is uploaded". A technician could photograph a burnt contactor, watch it
 * appear on the job card, and no photograph existed anywhere.
 *
 * WHAT IT DOES NOW: opens the tablet camera (or the gallery), shows the
 * technician the frame they actually captured, and uploads the bytes to
 * `POST /api/jobs/:jobId/media`, which sniffs them, stores them and records the
 * attachment only once they have landed. The tiles are the photographs
 * themselves, read back through the authenticated route.
 *
 * WHAT IS STILL NOT HERE, said plainly rather than left to be discovered:
 *
 *   - VIDEO. The simulated "Add video" button is gone, not reimplemented.
 *     Video capture is MEDIA-5, and its duration limit, size limit and whether
 *     a customer ever receives one are undecided business questions. A button
 *     that uploaded an MP4 would be answering them.
 *   - CAPTURE WITHOUT A CONNECTION. There is no queue in Phase 3, so a failed
 *     upload is reported as a failure and nothing is kept locally. The one
 *     honest thing to tell a technician whose photograph did not reach the
 *     server is that it did not reach the server.
 */
export const JobMediaPanel = ({
  job,
  users,
  editable,
  onChanged,
}: {
  readonly job: Job;
  readonly users: readonly User[];
  readonly editable: boolean;
  readonly onChanged: () => void;
}) => {
  const operation = useOperation();
  const online = useOnline();
  const currentUser = useCurrentUser();
  /** Said on the panel when the device could not keep a photograph. */
  const [holdProblem, setHoldProblem] = useState<string | null>(null);
  const [heldJustNow, setHeldJustNow] = useState(false);
  const [selection, setSelection] = useState<{
    readonly file: File;
    readonly preview: string;
    /*
     * MINTED WHEN THE PHOTOGRAPH IS CHOSEN, NOT WHEN IT IS SENT. TAB-UPLOAD-1.
     *
     * So *Try again* after a connection that dropped mid-upload re-sends the
     * same capture under the same key, and the server answers from the first
     * attempt if it had already stored the bytes — instead of putting the same
     * photograph on the job card twice. A genuinely different photograph is a
     * new selection and gets a new key.
     */
    readonly idempotencyKey: string;
  } | null>(null);
  const [caption, setCaption] = useState('');
  const [visibility, setVisibility] = useState<MediaVisibility>('customer_facing');
  const [attempted, setAttempted] = useState(false);
  const cameraInput = useRef<HTMLInputElement>(null);
  const galleryInput = useRef<HTMLInputElement>(null);

  const definition = getJobTypeDefinition(job.jobType);
  const photosRequired = definition.photosRequired && job.photos.length === 0;

  /*
   * The object URL is this browser's handle on the chosen file, and it is held
   * in a ref as well as in state because it has to be REVOKED — when it is
   * replaced and when the panel goes away. A leaked blob holds the whole
   * photograph in memory for the life of the tab, which on a tablet left open
   * all day is the whole shift.
   */
  const previewUrl = useRef<string | null>(null);
  const select = (picked: File | null) => {
    if (previewUrl.current !== null) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = picked === null ? null : URL.createObjectURL(picked);
    setSelection(
      picked === null || previewUrl.current === null
        ? null
        : { file: picked, preview: previewUrl.current, idempotencyKey: newIdempotencyKey() },
    );
  };
  useEffect(
    () => () => {
      if (previewUrl.current !== null) URL.revokeObjectURL(previewUrl.current);
    },
    [],
  );

  /** Reclassifies one, through the operation that records what it was. MEDIA-1. */
  const reclassify = async (attachmentId: string, next: MediaVisibility) => {
    const ok = await operation.run(() => jobs.setMediaVisibility(job.id, attachmentId, next));
    if (ok) onChanged();
  };

  /** Takes an attachment off the job, through the operation that records it. */
  const remove = async (kindToRemove: 'photo' | 'video', attachmentId: string) => {
    const ok = await operation.run(() => jobs.removeMedia(job.id, kindToRemove, attachmentId));
    if (ok) onChanged();
  };

  const close = () => {
    select(null);
    setCaption('');
    setVisibility('customer_facing');
    setAttempted(false);
    setHoldProblem(null);
    operation.clearError();
  };

  const chosen = (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0] ?? null;
    select(picked);
    setAttempted(false);
    operation.clearError();
    // Cleared so choosing the SAME file again still fires a change event — the
    // technician who retakes one shot of the same nameplate twice.
    event.target.value = '';
  };

  /**
   * KEEPS THE PHOTOGRAPH ON THE DEVICE. OFF-MEDIA-1.
   *
   * The bytes, the caption, the classification the technician chose and the
   * key the attempt used — so the queue's send is a retry of THIS capture and
   * the server replays it if the bytes had already landed.
   */
  const hold = async (): Promise<boolean> => {
    if (selection === null) return false;
    const outcome = await holdMedia({
      userId: currentUser?.id ?? '',
      jobId: job.id,
      jobNumber: job.jobNumber,
      destination: { kind: 'job_photo', visibility },
      file: selection.file,
      caption: caption.trim(),
      idempotencyKey: selection.idempotencyKey,
    });
    if (!outcome.held) {
      setHoldProblem(outcome.reason);
      return false;
    }
    setHeldJustNow(true);
    close();
    return true;
  };

  const submit = async () => {
    if (selection === null) return;
    setAttempted(true);
    setHoldProblem(null);

    /*
     * NO NETWORK, NO ATTEMPT. Two megabytes at a dead connection costs a
     * technician thirty seconds and tells them nothing the queue does not.
     */
    if (!online && (await hold())) return;

    const result = await operation.runFor(() =>
      jobs.uploadMedia(job.id, selection.file, {
        caption: caption.trim(),
        visibility,
        idempotencyKey: selection.idempotencyKey,
      }),
    );

    /*
     * THE REQUEST NEVER ARRIVED, so the photograph is kept rather than lost.
     * A refusal the SERVER made is a different thing entirely and is left on
     * screen for the technician to read: the tablet holding it would not make
     * it acceptable to the job.
     */
    if (result === null && operation.code === 'network' && (await hold())) return;
    /*
     * A RETRY IS THE SAME FILE, NOT A SECOND ONE. The selection is cleared only
     * on success, so "Try again" re-sends what was already chosen rather than
     * asking the technician to find it again — and because only a success
     * clears it, a failure cannot leave the modal looking as though the
     * photograph went.
     *
     * The job is refreshed either way. If the upload committed and the answer
     * was lost on the way back, the photograph is on the job and the technician
     * can see it in the grid behind this modal before deciding to retry.
     */
    onChanged();
    if (result !== null) close();
  };

  return (
    <div className="space-y-4">
      {/*
        HELD IS NOT ATTACHED, and the panel says which. OFF-MEDIA-1. The grid
        below shows what the JOB has; a held photograph is on the tablet, in
        the queue panel above the tabs, until the server takes it.
      */}
      {heldJustNow && (
        <div
          className="rounded-[var(--radius-control)] border border-amber-eje-200 bg-amber-eje-50 px-4 py-3 text-sm font-medium text-amber-eje-800"
          data-testid="job-photo-held"
        >
          The photograph is kept on this tablet and is NOT on the job yet. It is sent when there is
          a signal, and it stays under your name until then.
        </div>
      )}

      {holdProblem !== null && (
        <div
          role="alert"
          className="rounded-[var(--radius-control)] border border-signal-200 bg-signal-50 px-4 py-3 text-sm font-medium text-signal-700"
          data-testid="job-photo-hold-refused"
        >
          {holdProblem}
        </div>
      )}

      {photosRequired && (
        <div className="rounded-[var(--radius-control)] border border-amber-eje-200 bg-amber-eje-50 px-4 py-3 text-sm font-medium text-amber-eje-700">
          At least one photo is required before an {definition.label.toLowerCase()} job can be
          signed off.
        </div>
      )}

      {editable && (
        <div className="flex flex-wrap items-center gap-2">
          {/*
            TWO INPUTS, NOT ONE WITH A TOGGLE. `capture="environment"` asks the
            tablet for the rear camera directly; the same input without it opens
            the gallery. Android honours the attribute and iOS offers the
            camera — and where a device ignores it entirely the technician still
            gets a file picker, so the button never does nothing. ACC-PWA-3.
          */}
          <input
            ref={cameraInput}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={chosen}
            data-testid="job-photo-camera"
          />
          <input
            ref={galleryInput}
            type="file"
            accept="image/png,image/jpeg,image/tiff,image/webp"
            className="hidden"
            onChange={chosen}
            data-testid="job-photo-gallery"
          />
          <Button
            leadingIcon={<Icon name="camera" className="size-4" />}
            onClick={() => cameraInput.current?.click()}
          >
            Take photo
          </Button>
          <Button
            variant="secondary"
            leadingIcon={<Icon name="image" className="size-4" />}
            onClick={() => galleryInput.current?.click()}
          >
            Choose photo
          </Button>
          {/* Said once, where somebody might otherwise go looking for it. */}
          <span className="text-xs text-steel-500">
            Video capture is not available yet — it is awaiting the MEDIA-5 decision.
          </span>
        </div>
      )}

      <MediaGrid
        title="Photos"
        jobId={job.id}
        items={job.photos}
        users={users}
        onRemove={editable ? (id) => remove('photo', id) : undefined}
        onReclassify={editable ? reclassify : undefined}
      />
      <MediaGrid
        title="Videos"
        jobId={job.id}
        items={job.videos}
        users={users}
        onRemove={editable ? (id) => remove('video', id) : undefined}
        onReclassify={editable ? reclassify : undefined}
      />

      <Modal
        open={selection !== null}
        title="Attach photo"
        description="The photograph is uploaded to the EJE server and stored against this job."
        onClose={close}
        footer={
          <>
            <Button variant="secondary" onClick={close} disabled={operation.running}>
              Cancel
            </Button>
            <Button onClick={submit} loading={operation.running}>
              {attempted && operation.error !== null ? 'Try again' : 'Attach photo'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {operation.error !== null && (
            <RuleViolationNotice
              title="The photograph was not attached"
              message={operation.error}
              violations={operation.violations}
            />
          )}

          {/*
            THE FRAME THEY ACTUALLY CAPTURED, before it goes anywhere. A thumb
            over the lens, the wrong machine, a shot of the floor — all obvious
            here and invisible on a placeholder tile.
          */}
          {selection !== null && (
            <>
              <div className="overflow-hidden rounded-[var(--radius-control)] border border-steel-200 bg-steel-900">
                {/* eslint-disable-next-line @next/next/no-img-element -- a blob: URL from this device's camera; there is nothing for the image optimiser to fetch */}
                <img
                  src={selection.preview}
                  alt="The photograph about to be attached"
                  className="mx-auto max-h-64 w-auto object-contain"
                  data-testid="job-photo-preview"
                />
              </div>
              <p className="text-xs text-steel-500">
                {selection.file.name} · {formatFileSize(selection.file.size)}
              </p>
            </>
          )}

          <TextField
            label="Caption"
            value={caption}
            onChange={(event) => setCaption(event.target.value)}
            placeholder="e.g. Spindle drive showing alarm 750"
            hint="A customer-facing caption appears on the customer job card."
          />
          {/*
            WHO IT IS FOR, asked at capture. MEDIA-1.
            Customer-facing by default, because most photographs on a job are
            evidence of the work. The technician marks the exceptions.
          */}
          <SelectField
            label="Who it is for"
            value={visibility}
            onChange={(event) => setVisibility(event.target.value as MediaVisibility)}
            options={[
              { value: 'customer_facing', label: 'Customer — appears on the job card' },
              { value: 'internal', label: 'Internal — EJE only, kept off the job card' },
            ]}
            hint="Internal is for what EJE needs and the customer does not: a damaged part being claimed for, an unsafe installation, a note to the workshop."
          />
        </div>
      </Modal>
    </div>
  );
};

const MediaGrid = ({
  title,
  jobId,
  items,
  users,
  onRemove,
  onReclassify,
}: {
  readonly title: string;
  readonly jobId: string;
  readonly items: readonly Attachment[];
  readonly users: readonly User[];
  /** Offered only where the job may still be changed. */
  readonly onRemove?: (attachmentId: string) => void;
  /** Offered only where the job may still be changed. MEDIA-1. */
  readonly onReclassify?: (attachmentId: string, next: MediaVisibility) => void;
}) => {
  if (items.length === 0) {
    if (title === 'Videos') return null;
    return (
      <EmptyState
        title="No photos attached"
        description="Photographs of the fault, the repair and the installed condition support the job card."
        icon={<Icon name="camera" />}
      />
    );
  }

  return (
    <Card>
      <h3 className="mb-3 text-sm font-semibold text-steel-900">
        {title} <span className="tabular ml-1 text-steel-400">{items.length}</span>
      </h3>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {items.map((item) => {
          const uploader = users.find((candidate) => candidate.id === item.uploadedBy);
          return (
            <li key={item.id}>
              <div className="relative flex aspect-4/3 flex-col items-center justify-center overflow-hidden rounded-[var(--radius-control)] border border-steel-200 bg-steel-100 text-steel-400">
                <MediaThumbnail jobId={jobId} item={item} />
                {/* The obvious mistake, caught before the customer signs: the
                    wrong machine, a thumb over the lens, a shot of the floor. */}
                {onRemove !== undefined && (
                  <button
                    type="button"
                    aria-label={`Remove ${item.caption.length > 0 ? item.caption : item.fileName}`}
                    onClick={() => onRemove(item.id)}
                    className="absolute top-1.5 right-1.5 flex size-8 items-center justify-center rounded-full bg-steel-900/70 text-white transition-colors hover:bg-signal-600"
                  >
                    <Icon name="close" className="size-4" />
                  </button>
                )}
                {/*
                  ON THE TILE, not behind a menu. MEDIA-1.
                  Whether a photograph reaches the customer is the kind of thing
                  somebody needs to see at a glance across a whole grid before the
                  job card is signed, not one item at a time.
                */}
                {item.visibility === 'internal' && (
                  <span className="absolute bottom-1.5 left-1.5 rounded bg-steel-900/80 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-white uppercase">
                    Internal
                  </span>
                )}
              </div>
              <p className="mt-1.5 truncate text-xs font-medium text-steel-800">
                {item.caption.length > 0 ? item.caption : item.fileName}
              </p>
              {onReclassify !== undefined && (
                /*
                  A 44px target, because this is set on a tablet with gloves on —
                  rule 25. A full-width button rather than a toggle: the label says
                  what tapping it DOES, so nobody has to work out which way a
                  switch is pointing.
                */
                <button
                  type="button"
                  onClick={() =>
                    onReclassify(
                      item.id,
                      item.visibility === 'internal' ? 'customer_facing' : 'internal',
                    )
                  }
                  className="mt-1.5 flex h-11 w-full items-center justify-center rounded-[var(--radius-control)] border border-steel-200 px-2 text-[11px] font-semibold text-steel-700 transition-colors hover:bg-steel-50"
                >
                  {item.visibility === 'internal' ? 'Show to customer' : 'Mark internal'}
                </button>
              )}
              <p className="truncate text-[11px] text-steel-400">
                {uploader?.initials ?? '—'} · {formatRelative(item.uploadedAt)} ·{' '}
                {formatFileSize(item.sizeBytes)}
              </p>
            </li>
          );
        })}
      </ul>
    </Card>
  );
};

/**
 * THE PHOTOGRAPH, OR AN HONEST ADMISSION THAT THERE IS NOT ONE.
 *
 * Every row captured before PWA-3 has a storage key with nothing behind it, and
 * a video has bytes this grid cannot render. Both answer with the icon tile
 * rather than a broken image, and the caption underneath still says what the
 * row claims to be — a placeholder is only dishonest when it is indistinguishable
 * from a photograph, which is what the old grid got wrong.
 */
const MediaThumbnail = ({
  jobId,
  item,
}: {
  readonly jobId: string;
  readonly item: Attachment;
}) => {
  const [failed, setFailed] = useState(false);

  if (item.kind !== 'photo' || failed) {
    return (
      <>
        <Icon name="camera" className="size-7" />
        <span className="mt-1 text-[10px] font-medium tracking-wide uppercase">{item.kind}</span>
      </>
    );
  }

  return (
    /* eslint-disable-next-line @next/next/no-img-element -- an authenticated API route, not an optimisable asset: the optimiser would fetch it server-side without the session cookie */
    <img
      src={jobs.mediaUrl(jobId, item.id)}
      alt={item.caption.length > 0 ? item.caption : item.fileName}
      loading="lazy"
      onError={() => setFailed(true)}
      className="size-full object-cover"
      data-testid="job-photo-thumbnail"
    />
  );
};
