'use client';

import { useRef } from 'react';
import { Button, Icon } from '@/components/ui';

/**
 * THE TWO WAYS A VIDEO GETS ONTO A TABLET. MEDIA-5.
 *
 * `PhotoCaptureButtons`'s pattern, deliberately — a hidden input behind a real
 * button, `capture="environment"` for the rear camera, the value cleared on
 * every change so the same file can be chosen twice — because a technician
 * should not have to learn a second way of doing the same thing. What differs
 * is everything video-specific:
 *
 *   - THE ACCEPT LIST is the four container formats the server will sniff.
 *     `video/*` on the camera input, because a device offers whatever its own
 *     recorder produces and narrowing it there only makes the button do
 *     nothing on a phone that records something else; the server is what
 *     refuses, after looking at the bytes.
 *   - THE SIZE IS SAID OUT LOUD, before anybody records anything. A technician
 *     who films for two minutes and then loses the upload has lost the thing
 *     they were filming.
 *   - IT IS ONLINE ONLY, and the caller says so by disabling it. The held-work
 *     queue is capped at 40 MB for ALL of a technician's unsent captures, so
 *     one video could fill it and leave no room for the photographs the job
 *     actually needs. Refusing it with a reason is better than accepting it
 *     and silently dropping something else.
 */
export const VideoCaptureButtons = ({
  onFile,
  disabled = false,
  busy = false,
  size = 'md',
  testIdPrefix,
}: {
  readonly onFile: (file: File) => void;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly size?: 'sm' | 'md';
  /** So a test can drive the hidden input a headless browser cannot tap. */
  readonly testIdPrefix: string;
}) => {
  const camera = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);

  const chosen = (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0] ?? null;
    event.target.value = '';
    if (picked !== null) onFile(picked);
  };

  return (
    <>
      <input
        ref={camera}
        type="file"
        accept="video/*"
        capture="environment"
        className="hidden"
        onChange={chosen}
        data-testid={`${testIdPrefix}-video-camera`}
      />
      <input
        ref={library}
        type="file"
        accept="video/mp4,video/quicktime,video/webm,video/3gpp"
        className="hidden"
        onChange={chosen}
        data-testid={`${testIdPrefix}-video-library`}
      />
      <Button
        type="button"
        size={size}
        variant="secondary"
        disabled={disabled}
        loading={busy}
        leadingIcon={<Icon name="camera" className="size-4" />}
        onClick={() => camera.current?.click()}
      >
        Record video
      </Button>
      <Button
        type="button"
        size={size}
        variant="secondary"
        disabled={disabled || busy}
        leadingIcon={<Icon name="image" className="size-4" />}
        onClick={() => library.current?.click()}
      >
        Choose video
      </Button>
    </>
  );
};
