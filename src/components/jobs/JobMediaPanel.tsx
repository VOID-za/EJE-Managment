'use client';

import { useState } from 'react';
import { getJobTypeDefinition, type Attachment, type Job, type User } from '@/domain';
import { addMedia, removeMedia } from '@/application/job-operations';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  Modal,
  SelectField,
  TextField,
} from '@/components/ui';
import { useOperation } from '@/hooks/useOperation';
import { formatFileSize, formatRelative } from '@/lib/format';

/**
 * Photos and videos.
 *
 * SIMULATED: no file is uploaded. Attaching media records the attachment
 * against the job exactly as production will, and renders a placeholder tile
 * instead of image data. The storage port is what changes in Phase 2.
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
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'photo' | 'video'>('photo');
  const [caption, setCaption] = useState('');

  const definition = getJobTypeDefinition(job.jobType);
  const photosRequired = definition.photosRequired && job.photos.length === 0;

  /** Takes an attachment off the job, through the operation that records it. */
  const remove = async (kindToRemove: 'photo' | 'video', attachmentId: string) => {
    const ok = await operation.run((context) =>
      removeMedia(context, job, kindToRemove, attachmentId),
    );
    if (ok) onChanged();
  };

  const submit = async () => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
    const ok = await operation.run((context) =>
      addMedia(context, job, {
        kind,
        fileName: `${job.jobNumber}-${stamp}.${kind === 'photo' ? 'jpg' : 'mp4'}`,
        caption: caption.trim(),
        sizeBytes: kind === 'photo' ? 2_140_000 : 18_600_000,
      }),
    );
    if (ok) {
      setOpen(false);
      setCaption('');
      onChanged();
    }
  };

  return (
    <div className="space-y-4">
      {photosRequired && (
        <div className="rounded-[var(--radius-control)] border border-amber-eje-200 bg-amber-eje-50 px-4 py-3 text-sm font-medium text-amber-eje-700">
          At least one photo is required before an {definition.label.toLowerCase()} job can be
          signed off.
        </div>
      )}

      {editable && (
        <div className="flex flex-wrap gap-2">
          <Button
            leadingIcon={<Icon name="camera" className="size-4" />}
            onClick={() => {
              setKind('photo');
              setOpen(true);
            }}
          >
            Add photo
          </Button>
          <Button
            variant="secondary"
            leadingIcon={<Icon name="camera" className="size-4" />}
            onClick={() => {
              setKind('video');
              setOpen(true);
            }}
          >
            Add video
          </Button>
          <Badge tone="amber" size="sm">
            Simulated — no file is uploaded
          </Badge>
        </div>
      )}

      <MediaGrid
        title="Photos"
        items={job.photos}
        users={users}
        onRemove={editable ? (id) => remove('photo', id) : undefined}
      />
      <MediaGrid
        title="Videos"
        items={job.videos}
        users={users}
        onRemove={editable ? (id) => remove('video', id) : undefined}
      />

      <Modal
        open={open}
        title={kind === 'photo' ? 'Add photo' : 'Add video'}
        description="In the production system this opens the tablet camera. In the demonstration the attachment is recorded without a file."
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} loading={operation.running}>
              Attach {kind}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <SelectField
            label="Type"
            value={kind}
            onChange={(event) => setKind(event.target.value as 'photo' | 'video')}
            options={[
              { value: 'photo', label: 'Photo' },
              { value: 'video', label: 'Video' },
            ]}
          />
          <TextField
            label="Caption"
            value={caption}
            onChange={(event) => setCaption(event.target.value)}
            placeholder="e.g. Spindle drive showing alarm 750"
            hint="Captions appear on the customer job card."
          />
        </div>
      </Modal>
    </div>
  );
};

const MediaGrid = ({
  title,
  items,
  users,
  onRemove,
}: {
  readonly title: string;
  readonly items: readonly Attachment[];
  readonly users: readonly User[];
  /** Offered only where the job may still be changed. */
  readonly onRemove?: (attachmentId: string) => void;
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
              <div className="relative flex aspect-4/3 flex-col items-center justify-center rounded-[var(--radius-control)] border border-steel-200 bg-steel-100 text-steel-400">
                <Icon name="camera" className="size-7" />
                <span className="mt-1 text-[10px] font-medium tracking-wide uppercase">
                  {item.kind}
                </span>
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
              </div>
              <p className="mt-1.5 truncate text-xs font-medium text-steel-800">
                {item.caption.length > 0 ? item.caption : item.fileName}
              </p>
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
