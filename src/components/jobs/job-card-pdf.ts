import type { JobView } from '@/application/job-view';
import type { Clock } from '@/services/ports';
import type { SimulatedPdfService } from '@/services/simulated/pdf';

/** A job card rendered to PDF bytes, with the name the document carries. */
export interface RenderedJobCard {
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly pageCount: number;
}

/**
 * THE JOB CARD, AS A PDF, FROM THE ONE RENDERER. Shared by the inline preview
 * (`JobCardPdfPreview`) and the PDF button on the review screens
 * (`JobCardPdfButton`), so a button cannot produce a different document from
 * the preview beside it — or from the one the customer is finally sent.
 *
 * The descriptor names the file and the renderer draws it; both come from the
 * same service the final document is issued through, so a parts job previews
 * as its collection note and a courier's copy carries no prices.
 *
 * Drawing, not business: nothing is read, written or decided, so there is
 * nothing for a server to authorise — the view was already authorised when the
 * screen loaded it, and a preview is never stored or sent.
 */
export const renderJobCardPdf = async (
  view: JobView,
  pdf: SimulatedPdfService,
  clock: Clock,
): Promise<RenderedJobCard> => {
  const descriptor =
    view.job.jobType === 'parts'
      ? await pdf.generatePartsNote(view.job, 'preview')
      : await pdf.generateJobCard(view.job, 'preview');
  const rendered = await pdf.render(
    {
      job: view.job,
      customer: view.customer,
      site: view.site,
      contact: view.contact,
      machine: view.machine,
      settings: view.settings,
      checklistTemplate: view.checklistTemplate,
      users: view.users,
    },
    'preview',
    clock.now(),
  );
  return { fileName: descriptor.fileName, bytes: rendered.bytes, pageCount: rendered.pageCount };
};
