'use client';

import { useMemo, useState } from 'react';
import type { JobView } from '@/application/job-view';
import { Button, Icon } from '@/components/ui';
import { downloadBytes } from '@/lib/download';
import { canDisplayPdfInline } from '@/lib/pdf-support';
import { SimulatedPdfService } from '@/services/simulated/pdf';
import { SystemClock } from '@/services/simulated/system';
import { renderJobCardPdf } from './job-card-pdf';

/**
 * THE JOB CARD AS A PDF, ON DEMAND, FROM THE REVIEW SCREENS.
 *
 * The close-out's Review step and the job's review page show the job card as a
 * page, and until now neither offered the PDF itself before the job was issued.
 * This renders it with the SAME renderer as the inline preview and the issued
 * document (`renderJobCardPdf`), from the view the screen already holds — the
 * saved job, its completion write-up and its collection answer — so what opens
 * is exactly the card the customer will be shown.
 *
 * It OPENS the PDF where the browser has a viewer, and DOWNLOADS it where it
 * does not (the tablet's Chrome has none — PDF-3), or where a pop-up blocker
 * refuses the new tab. Either way the person gets the file. A failure is said
 * on the button's own line, not swallowed.
 */
export const JobCardPdfButton = ({
  view,
  label = 'Job card PDF',
}: {
  readonly view: JobView;
  readonly label?: string;
}) => {
  const [pdf, clock] = useMemo(() => {
    const tick = new SystemClock();
    return [new SimulatedPdfService(tick), tick] as const;
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const rendered = await renderJobCardPdf(view, pdf, clock);
      const blob = new Blob([new Uint8Array(rendered.bytes)], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      // Not `noopener`: with it `window.open` always returns null, and a blocked
      // tab could not be told apart from an opened one. The URL is our own blob.
      const opened = canDisplayPdfInline() ? window.open(url, '_blank') : null;
      if (opened === null) downloadBytes(rendered.bytes, rendered.fileName, 'application/pdf');
      // Long enough for the new tab to load it; the bytes are the browser's own.
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The job card PDF could not be produced.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        size="sm"
        variant="secondary"
        loading={busy}
        leadingIcon={<Icon name="document" className="size-4" />}
        onClick={() => void open()}
        data-testid="job-card-pdf-button"
      >
        {label}
      </Button>
      {error !== null && (
        <p role="alert" className="text-xs font-medium text-danger-700">
          {error}
        </p>
      )}
    </div>
  );
};
