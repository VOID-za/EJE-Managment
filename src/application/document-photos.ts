import type { Job } from '@/domain';
import { documentPhotos } from '@/lib/job-card/model';
import { preparePdfImage, unavailable, type PreparedPhoto } from '@/lib/pdf/image';
import { StorageIntegrityFailed, type StorageService } from '@/services/ports';

/**
 * The customer-facing photographs' pixels, read from storage, for the server's
 * own rendering of a customer document — the issued copy and the one-time
 * backfill. The browser's preview loads the same bytes through the media route
 * (`loadPreviewPhotos`) and prepares them with the same function.
 *
 * NEVER THROWS FOR A PHOTOGRAPH. A job card must be issuable even when one of
 * its photographs cannot be drawn; the document then says, in that photograph's
 * place, why it is not shown. A file whose bytes fail their integrity check is
 * named as damaged rather than drawn, because drawing it would put on the
 * customer's document a picture that is not the one the technician took.
 */
export const loadDocumentPhotos = async (
  storage: Pick<StorageService, 'getDocument'>,
  job: Job,
): Promise<ReadonlyMap<string, PreparedPhoto>> => {
  const images = new Map<string, PreparedPhoto>();
  for (const photo of documentPhotos(job)) {
    if (photo.provenance === 'simulated') {
      images.set(photo.id, unavailable('Demonstration photograph: there is no image file behind it.'));
      continue;
    }
    try {
      const stored = await storage.getDocument(photo.storageKey);
      images.set(
        photo.id,
        stored === null || stored.bytes.byteLength === 0
          ? unavailable('The image file is not in storage.')
          : await preparePdfImage(stored.bytes),
      );
    } catch (cause) {
      images.set(
        photo.id,
        unavailable(
          cause instanceof StorageIntegrityFailed
            ? 'The stored image file is damaged, so it has not been drawn.'
            : 'The image file could not be read from storage.',
        ),
      );
    }
  }
  return images;
};
