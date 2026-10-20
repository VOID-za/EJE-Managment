'use client';

import { useState } from 'react';
import { can, type Machine, type Provenance } from '@/domain';
import { Card, CardHeader, Icon, SimulatedBadge } from '@/components/ui';
import { PhotoCaptureButtons } from '@/components/media/PhotoCaptureButtons';
import { UploadFailureNotice } from '@/components/media/UploadFailureNotice';
import { machines } from '@/api/endpoints';
import { usePhotoUpload } from '@/hooks/usePhotoUpload';
import { useCurrentUser } from '@/providers/AppProvider';
import { formatFileSize } from '@/lib/format';

/**
 * THE MACHINE'S OWN PHOTOGRAPHS. MACH-PHOTO-1.
 *
 * WHAT THIS REPLACES: a grid of grey camera icons over storage keys with
 * nothing behind them. The photographs are read back through the authenticated
 * machine-photo route, so what is on screen is what was uploaded.
 *
 * WHO IS OFFERED THE CAMERA, and it mirrors the server rather than guessing:
 * the office may photograph any machine, and a technician may photograph a
 * machine THEY raised while it is still awaiting approval. On an approved
 * machine a technician is shown why instead of a button that would be refused
 * — and the refusal is still the server's, this only avoids offering it.
 *
 * It never implies a photograph changes the record: an unapproved machine says
 * so, and nothing here touches manufacturer, model, serial, site or approval.
 */
export const MachinePhotoPanel = ({
  machine,
  onChanged,
}: {
  readonly machine: Machine;
  readonly onChanged: () => void;
}) => {
  const currentUser = useCurrentUser();
  const [caption, setCaption] = useState('');
  /*
   * The caption travels with the file for the same reason the checklist's item
   * id does: it is part of the capture, so a retry sends the caption the
   * technician typed rather than whatever the box holds by then.
   */
  const upload = usePhotoUpload<string>((file, idempotencyKey, withCaption) =>
    machines.addPhoto(machine.id, file, { caption: withCaption, idempotencyKey }),
  );

  const office = can(currentUser.role, 'machines.manage');
  const ownPending =
    machine.approval === 'pending_approval' && machine.createdBy === currentUser.id;
  const mayPhotograph = office || ownPending;

  const capture = async (file: File) => {
    const ok = await upload.send(file, caption);
    if (ok) {
      setCaption('');
      onChanged();
    }
  };

  return (
    <Card>
      <CardHeader title="Photos" description={`${machine.photos.length} on file`} />

      {machine.photos.length === 0 ? (
        <p className="mt-4 text-sm text-steel-500">No photographs on file.</p>
      ) : (
        <ul className="mt-4 grid grid-cols-2 gap-3" data-testid="machine-photos">
          {machine.photos.map((photo) => (
            <li key={photo.id}>
              <MachineThumbnail machineId={machine.id} photo={photo} />
              <p className="mt-1.5 flex items-center gap-1.5 truncate text-xs font-medium text-steel-800">
                <span className="truncate">
                  {photo.caption.length > 0 ? photo.caption : photo.fileName}
                </span>
                {/*
                  A DEMONSTRATION PHOTOGRAPH SAYS SO. October mandate §1.
                  The three seeded ones are metadata with no image behind them,
                  and the register showed them exactly as it shows a photograph
                  a technician took of a customer's machine.
                */}
                <SimulatedBadge provenance={photo.provenance} testId="machine-photo-simulated" />
              </p>
              <p className="truncate text-[11px] text-steel-400">
                {photo.sizeBytes > 0 ? formatFileSize(photo.sizeBytes) : 'No stored image'}
              </p>
            </li>
          ))}
        </ul>
      )}

      {upload.state === 'failed' && (
        <div className="mt-4">
          <UploadFailureNotice
            message={upload.error ?? 'The photograph could not be attached.'}
            fileName={upload.fileName}
            attempts={upload.attempts}
            busy={false}
            onRetry={() => {
              void upload.retry().then((ok) => {
                if (ok) onChanged();
              });
            }}
            onDismiss={upload.dismiss}
          />
        </div>
      )}

      {mayPhotograph ? (
        <div className="mt-4 space-y-2 border-t border-steel-100 pt-4">
          <label
            htmlFor="machine-photo-caption"
            className="block text-xs font-semibold text-steel-700"
          >
            Caption for the next photograph
          </label>
          <input
            id="machine-photo-caption"
            value={caption}
            onChange={(event) => setCaption(event.target.value)}
            placeholder="Rating plate"
            className="h-11 w-full rounded-[var(--radius-control)] border border-steel-300 bg-surface px-3 text-sm placeholder:text-steel-400 focus:border-eje-500 focus:ring-2 focus:ring-eje-100 focus:outline-none"
          />
          <div className="flex flex-wrap gap-2">
            <PhotoCaptureButtons
              testIdPrefix="machine-detail-photo"
              cameraLabel="Photograph machine"
              galleryLabel="Choose photograph"
              busy={upload.state === 'uploading'}
              onFile={(file) => void capture(file)}
            />
          </div>
          {ownPending && !office && (
            <p className="text-xs text-steel-500">
              You added this machine, so you can photograph it while it is awaiting the
              office&rsquo;s approval. A photograph does not change the record or approve it.
            </p>
          )}
        </div>
      ) : (
        <p className="mt-4 border-t border-steel-100 pt-4 text-xs text-steel-500">
          <Icon name="warning" className="mr-1 inline size-3.5 align-text-bottom" />
          This machine is on the official register, so only the office can add photographs to it.
        </p>
      )}
    </Card>
  );
};

/**
 * One machine photograph, or an honest placeholder.
 *
 * Every row from before MACH-PHOTO-1 has a storage key and no bytes; the route
 * answers 404 and this falls back to the icon rather than a broken image.
 */
const MachineThumbnail = ({
  machineId,
  photo,
}: {
  readonly machineId: string;
  readonly photo: {
    readonly id: string;
    readonly caption: string;
    readonly fileName: string;
    readonly sizeBytes: number;
    readonly provenance: Provenance;
  };
}) => {
  const [failed, setFailed] = useState(false);

  /*
   * NOTHING STORED, SO NOTHING IS REQUESTED. October mandate §1.2.
   *
   * A record with no bytes used to be discovered by asking for the image and
   * getting a 404 — one failed request per seeded photograph on every render
   * of the register. The size already says there is nothing there.
   */
  if (failed || photo.sizeBytes <= 0) {
    return (
      <div
        className="flex aspect-4/3 flex-col items-center justify-center gap-1 rounded-[var(--radius-control)] border border-dashed border-steel-300 bg-steel-100 text-steel-400"
        title={
          photo.provenance === 'simulated'
            ? 'Demonstration metadata. No photograph was ever stored for it.'
            : 'This record has no stored file.'
        }
        data-testid="machine-photo-placeholder"
      >
        <Icon name="camera" className="size-6" />
        <span className="text-[10px] font-semibold tracking-wide uppercase">
          {photo.provenance === 'simulated' ? 'Simulated' : 'No image'}
        </span>
      </div>
    );
  }

  return (
    /* eslint-disable-next-line @next/next/no-img-element -- an authenticated API route, not an optimisable asset */
    <img
      src={machines.photoUrl(machineId, photo.id)}
      alt={photo.caption.length > 0 ? photo.caption : photo.fileName}
      loading="lazy"
      onError={() => setFailed(true)}
      className="aspect-4/3 w-full rounded-[var(--radius-control)] border border-steel-200 object-cover"
      data-testid="machine-photo-thumbnail"
    />
  );
};
