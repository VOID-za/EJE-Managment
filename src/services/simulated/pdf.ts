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
}
