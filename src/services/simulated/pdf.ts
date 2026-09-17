import type { Job } from '@/domain';
import { renderJobCardPdf } from './job-card-pdf';
import type { IsoDateTime } from '@/domain';
import type {
  Clock,
  FinalDocumentSource,
  GeneratedPdf,
  PdfService,
  PdfVariant,
  RenderedPdf,
} from '../ports';

/**
 * Simulated job-card PDF generator.
 *
 * DEMO BEHAVIOUR: returns a descriptor only. The visible job-card preview is
 * rendered from the live job record by `JobCardDocument`, which is deliberately
 * the same data model the production renderer will consume — so the preview is
 * never a hard-coded picture that has to be thrown away later.
 */
export class SimulatedPdfService implements PdfService {
  constructor(private readonly clock: Clock) {}

  private jobCardDescriptor(job: Job, variant: PdfVariant): GeneratedPdf {
    const pageCount = 2 + (job.checklist === null ? 0 : 1) + (job.photos.length > 0 ? 1 : 0);
    const final = variant === 'final';
    return {
      // The final copy gets its own key: a preview must never be able to
      // overwrite the document that was issued to the customer.
      storageKey: final ? `jobcards/final/${job.jobNumber}.pdf` : `jobcards/${job.jobNumber}.pdf`,
      fileName: `${job.jobNumber}-${final ? 'Final-' : ''}Job-Card.pdf`,
      pageCount,
      generatedAt: this.clock.now(),
      simulated: true,
    };
  }

  private partsDescriptor(job: Job, variant: PdfVariant): GeneratedPdf {
    // A courier's copy is titled a delivery note and carries no prices; the
    // customer's own collection note does. The file name says which, so the
    // wrong one cannot be sent without somebody noticing.
    const kind = job.courierCollection ? 'Delivery-Note' : 'Parts-Collection-Note';
    const final = variant === 'final';
    return {
      storageKey: final
        ? `partsnotes/final/${job.jobNumber}.pdf`
        : `partsnotes/${job.jobNumber}.pdf`,
      fileName: `${job.jobNumber}-${final ? 'Final-' : ''}${kind}.pdf`,
      // One page: a parts note is a list of goods and a signature, never a
      // checklist or a write-up.
      pageCount: 1,
      generatedAt: this.clock.now(),
      simulated: true,
    };
  }

  generateJobCard(job: Job, variant: PdfVariant = 'preview'): Promise<GeneratedPdf> {
    return Promise.resolve(this.jobCardDescriptor(job, variant));
  }

  /**
   * Renders the document to bytes.
   *
   * A real PDF, produced by the first-party writer in `src/lib/pdf` from the
   * same data and the same domain functions the on-screen job card uses. The
   * caller writes these bytes to storage once; nothing re-renders them to serve
   * a download.
   */
  render(
    source: FinalDocumentSource,
    variant: PdfVariant,
    generatedAt: IsoDateTime,
  ): Promise<RenderedPdf> {
    const descriptor =
      source.job.jobType === 'parts'
        ? this.partsDescriptor(source.job, variant)
        : this.jobCardDescriptor(source.job, variant);
    return Promise.resolve(renderJobCardPdf(source, descriptor.fileName, generatedAt));
  }

  generatePartsNote(job: Job, variant: PdfVariant = 'preview'): Promise<GeneratedPdf> {
    return Promise.resolve(this.partsDescriptor(job, variant));
  }
}
