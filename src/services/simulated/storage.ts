import type { StorageService, StoredFile } from '../ports';

/**
 * Simulated storage adapter.
 *
 * DEMO BEHAVIOUR: storage keys resolve to deterministic locally-rendered
 * placeholder images rather than uploaded files, so the demo has no binary
 * assets to ship and no upload endpoint to fake. Production swaps this for VPS
 * disk storage and later S3-compatible object storage; `resolveUrl` becomes a
 * signed-URL call and callers are unaffected.
 */
export class SimulatedStorageService implements StorageService {
  resolveUrl(storageKey: string): string {
    return `#storage/${encodeURIComponent(storageKey)}`;
  }

  put(fileName: string, _contentType: string, _data: Blob | null): Promise<StoredFile> {
    const storageKey = `uploads/${Date.now()}-${fileName}`;
    return Promise.resolve({ storageKey, url: this.resolveUrl(storageKey) });
  }
}
