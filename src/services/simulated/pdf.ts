import type { Job } from '@/domain';
import type { Clock, GeneratedPdf, PdfService } from '../ports';

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

  generateJobCard(job: Job): Promise<GeneratedPdf> {
    const pageCount = 2 + (job.checklist === null ? 0 : 1) + (job.photos.length > 0 ? 1 : 0);
    return Promise.resolve({
      storageKey: `jobcards/${job.jobNumber}.pdf`,
      fileName: `${job.jobNumber}-Job-Card.pdf`,
      pageCount,
      generatedAt: this.clock.now(),
      simulated: true,
    });
  }

  generatePartsNote(job: Job): Promise<GeneratedPdf> {
    // A courier's copy is titled a delivery note and carries no prices; the
    // customer's own collection note does. The file name says which, so the
    // wrong one cannot be sent without somebody noticing.
    const kind = job.courierCollection ? 'Delivery-Note' : 'Parts-Collection-Note';
    return Promise.resolve({
      storageKey: `partsnotes/${job.jobNumber}.pdf`,
      fileName: `${job.jobNumber}-${kind}.pdf`,
      // One page: a parts note is a list of goods and a signature, never a
      // checklist or a write-up.
      pageCount: 1,
      generatedAt: this.clock.now(),
      simulated: true,
    });
  }
}
