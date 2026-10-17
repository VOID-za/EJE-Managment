'use client';

import { useState } from 'react';
import { can, isJobTechnician, machineDisplayName, type Job, type Machine } from '@/domain';
import { Button, Icon } from '@/components/ui';
import { PhotoCaptureButtons } from '@/components/media/PhotoCaptureButtons';
import { UploadFailureNotice } from '@/components/media/UploadFailureNotice';
import { machines } from '@/api/endpoints';
import { usePhotoUpload } from '@/hooks/usePhotoUpload';
import { useCurrentUser } from '@/providers/AppProvider';

/**
 * PHOTOGRAPHING THE MACHINE FROM THE JOB YOU ARE ON. BD-14, MACH-PHOTO-2.
 *
 * WHY IT IS HERE AND NOT ON THE REGISTER. The register is the office's screen
 * (`machines.manage`), and a technician cannot open it at all — so until EJE
 * answered BD-14 there was no path from a technician to a machine photograph,
 * which was the real reason the refusal mattered. The technician standing at
 * the machine reaches it through the JOB, which is also exactly what makes the
 * photograph authorised: the job is on this machine, it is theirs, and it is
 * live. The server checks all three (`addMachinePhoto`); this only offers it.
 *
 * WHAT IT IS NOT. It is not a way into the machine record. Nothing here can
 * change a field, approve a machine or alter its history, and the panel says
 * so — because a technician who thinks a photograph corrected the serial
 * number will stop reporting that the serial number is wrong.
 *
 * MACHINE PHOTOGRAPHS ARE NOT JOB MEDIA, which is why this is not in the
 * Photos tab: a photograph of a burnt contactor belongs to the job that found
 * it, and a photograph of the rating plate belongs to the machine for as long
 * as EJE maintain it.
 */
export const MachinePhotoFromJob = ({
  job,
  machine,
  onChanged,
}: {
  readonly job: Job;
  readonly machine: Machine;
  readonly onChanged: () => void;
}) => {
  const currentUser = useCurrentUser();
  const [open, setOpen] = useState(false);
  const [caption, setCaption] = useState('');
  const upload = usePhotoUpload<string>((file, idempotencyKey, withCaption) =>
    machines.addPhoto(machine.id, file, {
      caption: withCaption,
      idempotencyKey,
      // The authorising job. Verified server-side against the machine, the
      // crew and the job's status; sending it is not what makes it true.
      jobId: job.id,
    }),
  );

  const live = job.status !== 'closed' && job.status !== 'cancelled';
  const mayPhotograph =
    live && (can(currentUser.role, 'machines.manage') || isJobTechnician(currentUser, job));
  if (!mayPhotograph) return null;

  const capture = async (file: File) => {
    const ok = await upload.send(file, caption);
    if (ok) {
      setCaption('');
      onChanged();
    }
  };

  return (
    <div className="mt-4 border-t border-steel-100 pt-4">
      {!open ? (
        <Button
          type="button"
          variant="secondary"
          leadingIcon={<Icon name="camera" className="size-4" />}
          onClick={() => setOpen(true)}
          data-testid="machine-photo-from-job-open"
        >
          Photograph this machine
        </Button>
      ) : (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-steel-700">
            Photograph of {machineDisplayName(machine)}
          </p>
          <p className="text-xs text-steel-500">
            Kept on the machine&rsquo;s own record, where it stays useful on every future job.
            It does <strong className="font-semibold">not</strong> change the machine record — if
            something on it is wrong, tell the office.
          </p>
          <input
            aria-label="Caption for the machine photograph"
            value={caption}
            onChange={(event) => setCaption(event.target.value)}
            placeholder="Rating plate"
            className="h-11 w-full rounded-[var(--radius-control)] border border-steel-300 bg-surface px-3 text-sm placeholder:text-steel-400 focus:border-eje-500 focus:ring-2 focus:ring-eje-100 focus:outline-none"
          />
          <div className="flex flex-wrap gap-2">
            <PhotoCaptureButtons
              testIdPrefix="machine-from-job-photo"
              cameraLabel="Take photo"
              galleryLabel="Choose photo"
              busy={upload.state === 'uploading'}
              onFile={(file) => void capture(file)}
            />
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
          {machine.photos.length > 0 && (
            <p className="text-xs text-steel-500" data-testid="machine-photo-count">
              {machine.photos.length}{' '}
              {machine.photos.length === 1 ? 'photograph' : 'photographs'} on this machine&rsquo;s
              record.
            </p>
          )}
          {upload.state === 'failed' && (
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
          )}
        </div>
      )}
    </div>
  );
};
