'use client';

import { useMemo, useState } from 'react';
import type { JobView } from '@/application/job-view';
import { Button, Icon } from '@/components/ui';
import { DocumentPreviewDialog } from '@/components/documents/DocumentPreviewDialog';
import { SimulatedPdfService } from '@/services/simulated/pdf';
import { SystemClock } from '@/services/simulated/system';
import { renderJobCardPdf } from './job-card-pdf';
import { JobCardDocument } from './JobCardDocument';
import { PartsCollectionNote } from './PartsCollectionNote';

/**
 * THE JOB CARD PREVIEW, FROM WHAT IS SAVED NOW.
 *
 * Rendered with the SAME renderer as the inline preview and the issued
 * document, so what it shows is what will be issued.
 *
 * TR-02 (the real-world reviewer, 28 October 2026): it used to open the PDF in
 * a new tab — and on the tablets, which have no built-in PDF viewer, it fell
 * back to a silent DOWNLOAD, so pressing it appeared to do nothing ("Preview
 * does not work"). It now opens the preview in the application: the PDF itself
 * where the browser can show one, otherwise the same job card drawn as HTML,
 * with Print and Download beside it. Looking at it changes nothing on the job.
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
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        leadingIcon={<Icon name="document" className="size-4" />}
        onClick={() => setOpen(true)}
        data-testid="job-card-pdf-button"
      >
        {label}
      </Button>
      <DocumentPreviewDialog
        open={open}
        title={`${view.job.jobNumber} — ${view.job.jobType === 'parts' ? 'Parts Collection Note' : 'Job Card'}`}
        description="From what is saved on the job now. Looking at it changes nothing."
        loadPdf={async () => {
          const rendered = await renderJobCardPdf(view, pdf, clock);
          return { bytes: rendered.bytes, fileName: rendered.fileName };
        }}
        renderHtml={() =>
          view.job.jobType === 'parts' ? <PartsCollectionNote view={view} /> : <JobCardDocument view={view} />
        }
        onClose={() => setOpen(false)}
      />
    </>
  );
};
