import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptJob,
  addLabour,
  addMedia,
  captureSignature,
  issueJobCard,
  saveCompletionReport,
  startCompletion,
  startSignature,
} from './job-operations';
import { loadFinalDocumentFile } from './final-document';
import { loadDocumentPhotos } from './document-photos';
import { loadJobView } from './job-view';
import { buildHarness, seedUser, type Harness } from './test-harness';
import { loadPreviewPhotos, renderJobCardPdf } from '@/components/jobs/job-card-pdf';
import { pdfPlainText } from '@/lib/pdf/inspect';
import { SimulatedPdfService } from '@/services/simulated/pdf';
import { StorageIntegrityFailed, type Clock } from '@/services/ports';
import type { Job } from '@/domain';

/**
 * THE PHOTOGRAPH IS IN THE PDF. Not a grey box labelled "Photograph", not a
 * bullet list of captions: the pixels of the file the technician uploaded.
 *
 * EJE-1065 carried an uploaded photograph and its PDF printed a placeholder,
 * because the job card model held only captions and the PDF writer could not
 * draw an image. These tests read the embedded image back OUT of the rendered
 * bytes and compare it with the fixture that went in — the issued copy (server,
 * through storage), the one-time backfill, and the browser preview (through the
 * media route) — so none of them can quietly fall back to a placeholder again.
 */
const technician = seedUser('user-tech-sipho');
const clock: Clock = { now: () => '2026-10-26T08:00:00.000Z' };

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../lib/pdf/__fixtures__/${name}`, import.meta.url)));
const JPEG = fixture('quadrants.jpg');
const PNG = fixture('quadrants-alpha.png');

interface EmbeddedImage {
  readonly width: number;
  readonly height: number;
  readonly filter: string;
  readonly smask: boolean;
  readonly data: Buffer;
}

/** Every image XObject in the file, with its stream bytes exactly as stored. */
const embeddedImages = (bytes: Uint8Array): EmbeddedImage[] => {
  const text = Buffer.from(bytes).toString('latin1');
  const found: EmbeddedImage[] = [];
  const pattern = /<< \/Type \/XObject \/Subtype \/Image (.*?)\/Length (\d+) >>\nstream\n/gs;
  for (const match of text.matchAll(pattern)) {
    const dictionary = match[1]!;
    if (dictionary.includes('/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode ') &&
        !dictionary.includes('/SMask') && found.some((image) => image.smask)) {
      // The soft mask of the image before it, not a photograph of its own.
      continue;
    }
    const start = match.index! + match[0].length;
    found.push({
      width: Number(/\/Width (\d+)/.exec(dictionary)![1]),
      height: Number(/\/Height (\d+)/.exec(dictionary)![1]),
      filter: /\/Filter \/(\w+)/.exec(dictionary)![1]!,
      smask: dictionary.includes('/SMask'),
      data: Buffer.from(bytes.subarray(start, start + Number(match[2]))),
    });
  }
  return found;
};

/** Where each image was drawn: the box its matrix maps the unit square to. */
const drawnBoxes = (bytes: Uint8Array): { width: number; height: number }[] =>
  [...Buffer.from(bytes).toString('latin1').matchAll(/q (\S+) (\S+) (\S+) (\S+) \S+ \S+ cm \/Im\d+ Do Q/g)].map(
    (match) => {
      const [a, b, c, d] = match.slice(1, 5).map(Number) as [number, number, number, number];
      return { width: Math.abs(a) + Math.abs(c), height: Math.abs(b) + Math.abs(d) };
    },
  );

describe('photographs in the job card PDF', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  const withPhotos = async (
    photos: readonly { bytes: Uint8Array; name: string; type: string; visibility?: 'internal' }[],
  ): Promise<Job> => {
    const context = harness.as(technician);
    let job = await acceptJob(context, (await harness.repos.jobs.findByJobNumber('EJE-1048'))!);
    for (const photo of photos) {
      job = await addMedia(context, job, {
        kind: 'photo',
        fileName: photo.name,
        caption: `Photo ${photo.name}`,
        contentType: photo.type,
        bytes: photo.bytes,
        ...(photo.visibility === undefined ? {} : { visibility: photo.visibility }),
      });
    }
    return job;
  };

  const issued = async (job: Job): Promise<Uint8Array> => {
    const context = harness.as(technician);
    job = await addLabour(context, job, {
      date: '2026-10-26',
      rateType: 'normal',
      hours: 1,
      description: 'Replaced the light curtain receiver.',
    });
    job = await saveCompletionReport(context, job, {
      ...job.completionReport,
      workPerformed: 'Replaced the light curtain receiver.',
    });
    job = await startCompletion(context, job);
    job = await startSignature(context, job);
    job = await captureSignature(context, job, {
      customerName: 'Gerhard',
      customerSurname: 'Smit',
      strokeData: 'M0.1,0.5 L0.9,0.5',
    });
    await issueJobCard(context, job, 'gerhard@example.test', 'Gerhard Smit');
    return (await loadFinalDocumentFile(context, job.jobNumber)).bytes;
  };

  it('the ISSUED job card carries the uploaded JPEG itself, byte for byte', async () => {
    const bytes = await issued(await withPhotos([{ bytes: JPEG, name: 'curtain.jpg', type: 'image/jpeg' }]));

    const images = embeddedImages(bytes);
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ width: 320, height: 240, filter: 'DCTDecode' });
    expect(images[0]!.data.equals(Buffer.from(JPEG))).toBe(true);
    // Drawn at its own 4:3 proportions, not stretched to the cell.
    const [box] = drawnBoxes(bytes);
    expect(box!.width / box!.height).toBeCloseTo(320 / 240, 2);
    // No placeholder, and the caption is still printed beneath it.
    const text = pdfPlainText(bytes);
    expect(text).not.toContain('Photograph not shown');
    expect(text).toContain('Photo curtain.jpg');
  });

  it('the issued job card carries a PNG with transparency, with its mask', async () => {
    const bytes = await issued(
      await withPhotos([{ bytes: PNG, name: 'screenshot.png', type: 'image/png' }]),
    );
    const images = embeddedImages(bytes);
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ width: 320, height: 240, filter: 'FlateDecode', smask: true });
  });

  it('prints only the customer-facing photographs, each embedded once', async () => {
    const bytes = await issued(
      await withPhotos([
        { bytes: JPEG, name: 'fault.jpg', type: 'image/jpeg' },
        { bytes: PNG, name: 'internal.png', type: 'image/png', visibility: 'internal' },
      ]),
    );
    const images = embeddedImages(bytes);
    expect(images).toHaveLength(1);
    expect(images[0]!.filter).toBe('DCTDecode');
    expect(pdfPlainText(bytes)).not.toContain('internal.png');
  });

  it('a photograph whose file is gone is named as not shown — never a blank frame', async () => {
    const job = await withPhotos([{ bytes: JPEG, name: 'lost.jpg', type: 'image/jpeg' }]);
    const view = (await loadJobView(harness.repos, job.jobNumber))!;
    const images = await loadDocumentPhotos({ getDocument: () => Promise.resolve(null) }, job);
    const rendered = await renderJobCardPdf(view, new SimulatedPdfService(clock), clock, images);

    expect(embeddedImages(rendered.bytes)).toHaveLength(0);
    const text = pdfPlainText(rendered.bytes);
    expect(text).toContain('Photograph not shown');
    expect(text).toContain('The image file is not in storage.');
    expect(text).toContain('lost.jpg');
  });

  it('a damaged stored file is refused, not drawn', async () => {
    const job = await withPhotos([{ bytes: JPEG, name: 'damaged.jpg', type: 'image/jpeg' }]);
    const images = await loadDocumentPhotos(
      { getDocument: () => Promise.reject(new StorageIntegrityFailed('uploads/damaged', 'changed on disk')) },
      job,
    );
    expect(images.get(job.photos[0]!.id)).toEqual({
      kind: 'unavailable',
      reason: 'The stored image file is damaged, so it has not been drawn.',
    });
  });

  it('the one-time BACKFILL of a closed job draws its stored photograph too', async () => {
    // A closed job with a photo and no file yet on storage: the backfill path.
    const context = harness.as(technician);
    const job = await withPhotos([{ bytes: JPEG, name: 'history.jpg', type: 'image/jpeg' }]);
    const closed: Job = {
      ...job,
      status: 'closed',
      finalDocument: {
        fileName: `${job.jobNumber}-Final-Job-Card.pdf`,
        storageKey: `jobcards/final/${job.jobNumber}.pdf`,
        pageCount: 1,
        generatedAt: '2026-10-20T10:00:00.000Z',
        generatedBy: technician.id,
        renderedLocally: true,
        issuedTo: 'gerhard@example.test',
        sizeBytes: 0,
        checksumSha256: null,
        renderer: 3,
        provenance: 'genuine',
      },
    };
    await harness.repos.jobs.save(closed);
    const file = await loadFinalDocumentFile(context, job.jobNumber);
    const images = embeddedImages(file.bytes);
    expect(images).toHaveLength(1);
    expect(images[0]!.data.equals(Buffer.from(JPEG))).toBe(true);
  });
});

describe('photographs in the browser PREVIEW', () => {
  it('reads each photograph through the authorised media route and embeds it', async () => {
    const harness = buildHarness();
    const context = harness.as(technician);
    let job = await acceptJob(context, (await harness.repos.jobs.findByJobNumber('EJE-1048'))!);
    job = await addMedia(context, job, {
      kind: 'photo',
      fileName: 'preview.jpg',
      caption: 'Preview photo',
      contentType: 'image/jpeg',
      bytes: JPEG,
    });
    const view = (await loadJobView(harness.repos, job.jobNumber))!;
    const requested: string[] = [];
    const fakeFetch = ((url: string) => {
      requested.push(url);
      return Promise.resolve(new Response(new Uint8Array(JPEG), { status: 200 }));
    }) as unknown as typeof fetch;

    const images = await loadPreviewPhotos(view, fakeFetch);
    expect(requested).toEqual([`/api/jobs/${job.id}/media/${job.photos[0]!.id}`]);

    const rendered = await renderJobCardPdf(view, new SimulatedPdfService(clock), clock, images);
    const embedded = embeddedImages(rendered.bytes);
    expect(embedded).toHaveLength(1);
    expect(embedded[0]!.data.equals(Buffer.from(JPEG))).toBe(true);
  });

  it('a photograph the route refuses is labelled in the preview, which still renders', async () => {
    const harness = buildHarness();
    const context = harness.as(technician);
    let job = await acceptJob(context, (await harness.repos.jobs.findByJobNumber('EJE-1048'))!);
    job = await addMedia(context, job, {
      kind: 'photo',
      fileName: 'refused.jpg',
      caption: '',
      contentType: 'image/jpeg',
      bytes: JPEG,
    });
    const view = (await loadJobView(harness.repos, job.jobNumber))!;
    const images = await loadPreviewPhotos(view, (() =>
      Promise.resolve(new Response(null, { status: 404 }))) as unknown as typeof fetch);
    const rendered = await renderJobCardPdf(view, new SimulatedPdfService(clock), clock, images);
    // The reason wraps inside the narrow cell; it is the words that matter.
    expect(pdfPlainText(rendered.bytes).replace(/\s+/g, ' ')).toContain(
      'The image file could not be loaded for the preview.',
    );
  });
});
