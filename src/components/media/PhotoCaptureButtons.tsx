'use client';

import { useRef } from 'react';
import { Button, Icon } from '@/components/ui';

/**
 * THE TWO WAYS A PHOTOGRAPH GETS ONTO A TABLET. PWA-3, ACC-PWA-3.
 *
 * Two inputs rather than one with a toggle: `capture="environment"` asks the
 * device for the rear camera directly, and the same input without it opens the
 * gallery. Android honours the attribute and iOS offers the camera; a device
 * that ignores it entirely still shows a file picker, so neither button can do
 * nothing.
 *
 * The value is cleared on every change so choosing the SAME file twice still
 * fires — a technician retaking one shot of the same nameplate.
 *
 * Shared by the job photo panel, the checklist evidence rows and the machine
 * register, so all three behave identically on the device where it matters.
 */
export const PhotoCaptureButtons = ({
  onFile,
  disabled = false,
  busy = false,
  size = 'md',
  testIdPrefix,
  cameraLabel = 'Take photo',
  galleryLabel = 'Choose photo',
}: {
  readonly onFile: (file: File) => void;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly size?: 'sm' | 'md';
  /** So a test can drive the hidden input a headless browser cannot tap. */
  readonly testIdPrefix: string;
  readonly cameraLabel?: string;
  readonly galleryLabel?: string;
}) => {
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);

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
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={chosen}
        data-testid={`${testIdPrefix}-camera`}
      />
      <input
        ref={gallery}
        type="file"
        accept="image/png,image/jpeg,image/tiff,image/webp"
        className="hidden"
        onChange={chosen}
        data-testid={`${testIdPrefix}-gallery`}
      />
      <Button
        type="button"
        size={size}
        disabled={disabled}
        loading={busy}
        leadingIcon={<Icon name="camera" className="size-4" />}
        onClick={() => camera.current?.click()}
      >
        {cameraLabel}
      </Button>
      <Button
        type="button"
        size={size}
        variant="secondary"
        disabled={disabled || busy}
        leadingIcon={<Icon name="image" className="size-4" />}
        onClick={() => gallery.current?.click()}
      >
        {galleryLabel}
      </Button>
    </>
  );
};
