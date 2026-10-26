import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
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
import { buildHarness, seedUser } from './test-harness';
import { renderPdfRegionInk } from '@/lib/pdf/render';

/**
 * THE PHOTOGRAPH IS VISIBLE IN THE FILE THE CUSTOMER OPENS.
 *
 * The byte-level tests prove the image is embedded; this proves Chromium's PDF
 * engine actually paints it, upright and in place. The fixture is four flat
 * quadrants — red, green, blue, yellow — so each quarter of the drawn box must
 * be mostly its own colour. A grey placeholder, a blank cell, a rotated or
 * mirrored image, or one drawn somewhere else all fail it.
 */
const technician = seedUser('user-tech-sipho');
const JPEG = new Uint8Array(
  readFileSync(new URL('../lib/pdf/__fixtures__/quadrants.jpg', import.meta.url)),
);

/** The page and box the first photograph was drawn into. */
const photoPlacement = (bytes: Uint8Array) => {
  const text = Buffer.from(bytes).toString('latin1');
  const contents = [...text.matchAll(/<< \/Length (\d+) >>\nstream\n/g)].map((match) =>
    text.slice(match.index! + match[0].length, match.index! + match[0].length + Number(match[1])),
  );
  for (const [index, stream] of contents.entries()) {
    const draw = /q (\S+) 0 0 (\S+) (\S+) (\S+) cm \/Im\d+ Do Q/.exec(stream);
    if (draw === null) continue;
    const [width, height, x, y] = draw.slice(1, 5).map(Number) as [number, number, number, number];
    return { page: index + 1, x, y, width, height };
  }
  throw new Error('no photograph is drawn in this document');
};

describe('the photograph is painted in the issued job card', () => {
  it('each quadrant of the uploaded photograph is its own colour, where it belongs', async () => {
    const harness = buildHarness();
    const context = harness.as(technician);
    let job = await acceptJob(context, (await harness.repos.jobs.findByJobNumber('EJE-1048'))!);
    job = await addMedia(context, job, {
      kind: 'photo',
      fileName: 'quadrants.jpg',
      caption: 'Light curtain receiver',
      contentType: 'image/jpeg',
      bytes: JPEG,
    });
    job = await addLabour(context, job, {
      date: '2026-10-26',
      rateType: 'normal',
      hours: 1,
      description: 'Replaced the receiver.',
    });
    job = await saveCompletionReport(context, job, {
      ...job.completionReport,
      workPerformed: 'Replaced the receiver.',
    });
    job = await startCompletion(context, job);
    job = await startSignature(context, job);
    job = await captureSignature(context, job, {
      customerName: 'Gerhard',
      customerSurname: 'Smit',
      strokeData: 'M0.1,0.5 L0.9,0.5',
    });
    await issueJobCard(context, job, 'gerhard@example.test', 'Gerhard Smit');
    const { bytes } = await loadFinalDocumentFile(context, job.jobNumber);

    const box = photoPlacement(bytes);
    // The middle of each quarter, clear of the JPEG's soft edges between them.
    const quarter = (column: 0 | 1, row: 0 | 1) => ({
      page: box.page,
      x: box.x + box.width * (column * 0.5 + 0.15),
      // PDF y runs up the page: row 0 is the TOP half.
      y: box.y + box.height * ((1 - row) * 0.5 + 0.15),
      width: box.width * 0.2,
      height: box.height * 0.2,
    });
    const expectations = [
      { name: 'red, top left', region: quarter(0, 0), colour: { r: 0xd0, g: 0x20, b: 0x20 } },
      { name: 'green, top right', region: quarter(1, 0), colour: { r: 0x20, g: 0xa0, b: 0x40 } },
      { name: 'blue, bottom left', region: quarter(0, 1), colour: { r: 0x20, g: 0x40, b: 0xd0 } },
      { name: 'yellow, bottom right', region: quarter(1, 1), colour: { r: 0xe0, g: 0xc0, b: 0x20 } },
    ];
    for (const { name, region, colour } of expectations) {
      const report = await renderPdfRegionInk(bytes, region, {
        label: `photo-${name.split(',')[0]}`,
        colour: { ...colour, tolerance: 45 },
      });
      expect(
        report.ink / report.examined,
        `${name}: only ${report.ink} of ${report.examined} pixels match — see ${report.screenshot}`,
      ).toBeGreaterThan(0.8);
    }
  }, 180000);
});
