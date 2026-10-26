import type { JobView } from '@/application/job-view';
import type { Clock } from '@/services/ports';
import type { SimulatedPdfService } from '@/services/simulated/pdf';
import { jobs } from '@/api/endpoints';
import { documentPhotos } from '@/lib/job-card/model';
import { preparePdfImage, unavailable, type PreparedPhoto } from '@/lib/pdf/image';

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
/**
 * THE PHOTOGRAPHS' PIXELS, FOR THE PREVIEW. The renderer runs in the browser
 * and the job holds only storage keys, so each customer-facing photograph is
 * read through the same authorised media route the Photographs tab uses — not a
 * `blob:` URL, which the renderer cannot open — and prepared by the same
 * function the server uses for the issued copy.
 *
 * A photograph that cannot be fetched (no signal, refused) is drawn as a
 * labelled box saying so; the preview is never withheld for want of one.
 */
export const loadPreviewPhotos = async (
  view: JobView,
  fetchImpl: typeof fetch = fetch,
): Promise<ReadonlyMap<string, PreparedPhoto>> => {
  const entries = await Promise.all(
    documentPhotos(view.job).map(async (photo): Promise<[string, PreparedPhoto]> => {
      if (photo.provenance === 'simulated') {
        return [photo.id, unavailable('Demonstration photograph: there is no image file behind it.')];
      }
      try {
        const response = await fetchImpl(jobs.mediaUrl(view.job.id, photo.id), {
          credentials: 'same-origin',
        });
        if (!response.ok) {
          return [photo.id, unavailable('The image file could not be loaded for the preview.')];
        }
        return [photo.id, await preparePdfImage(new Uint8Array(await response.arrayBuffer()))];
      } catch {
        return [photo.id, unavailable('The image file could not be loaded — check the connection.')];
      }
    }),
  );
  return new Map(entries);
};

export const renderJobCardPdf = async (
  view: JobView,
  pdf: SimulatedPdfService,
  clock: Clock,
  photoImages?: ReadonlyMap<string, PreparedPhoto>,
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
      photoImages: photoImages ?? (await loadPreviewPhotos(view)),
    },
    'preview',
    clock.now(),
  );
  return { fileName: descriptor.fileName, bytes: rendered.bytes, pageCount: rendered.pageCount };
};
