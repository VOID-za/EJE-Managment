'use client';

import { Button, Icon } from '@/components/ui';

/**
 * A PHOTOGRAPH THAT DID NOT REACH THE SERVER SAYS SO. TAB-UPLOAD-1, OFF-8.
 *
 * Not a toast, and not a silent revert to the previous screen. The one thing a
 * technician must never have to guess is whether the evidence they captured is
 * on the job, so this stays on screen until they retry it or dismiss it, and
 * it says plainly that the photograph is not on the server.
 *
 * RETRY IS THE SAME CAPTURE, under the same idempotency key — see
 * `usePhotoUpload`. Dismiss removes it from this screen and nothing else:
 * there is no local copy to lose and nothing on the server to undo.
 */
export const UploadFailureNotice = ({
  message,
  fileName,
  attempts,
  busy,
  onRetry,
  onDismiss,
}: {
  readonly message: string;
  readonly fileName: string | null;
  readonly attempts: number;
  readonly busy: boolean;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
}) => (
  <div
    role="alert"
    data-testid="upload-failure"
    className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-control)] border border-signal-200 bg-signal-50 px-3.5 py-2.5 text-sm text-signal-900"
  >
    <span className="flex min-w-0 items-start gap-2">
      <Icon name="warning" className="mt-0.5 size-4 shrink-0 text-signal-600" />
      <span className="min-w-0">
        <strong className="font-semibold">That photograph is not on the server.</strong>{' '}
        {message}
        {fileName !== null && <span className="text-signal-700"> ({fileName})</span>}
        {attempts > 1 && <span className="text-signal-700"> · {attempts} attempts</span>}
      </span>
    </span>
    <span className="flex shrink-0 gap-2">
      <Button type="button" variant="ghost" onClick={onDismiss} disabled={busy}>
        Dismiss
      </Button>
      <Button type="button" onClick={onRetry} loading={busy}>
        Try again
      </Button>
    </span>
  </div>
);
