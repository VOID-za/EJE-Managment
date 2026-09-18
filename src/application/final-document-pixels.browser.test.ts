import { describe, expect, it } from 'vitest';
import { loadFinalDocumentFile } from './final-document';
import { inspectPdf } from '@/lib/pdf/inspect';
import { renderPdfRegionInk } from '@/lib/pdf/render';
import { buildJobCardModel } from '@/lib/job-card/model';
import { loadJobView } from './job-view';
import { buildHarness, seedUser } from './test-harness';

/**
 * Does the signature actually APPEAR in the file people download?
 *
 * Every other check on this document reasons about the bytes — the strings it
 * contains, the coordinates it claims, whether a facsimile was decided on — and
 * all of them passed while the customer's signature was invisible in the PDF
 * that was downloaded. So this one renders the stored bytes through Chromium's
 * PDF engine and counts the dark pixels where the signature should be.
 *
 * It fails if the signature is missing, white, clipped, zero-sized, behind the
 * panel fill or drawn off the page — none of which the byte-level checks can
 * see. It takes a few seconds, which is the price of looking.
 */

const master = seedUser('user-master-elmarie');

/** A hand-like path, as `SignaturePad` stores one after a real capture. */
const capturedPath = (): string => {
  const points: string[] = [];
  for (let step = 0; step <= 60; step += 1) {
    const t = step / 60;
    const x = (0.06 + t * 0.86).toFixed(3);
    const y = (0.55 - Math.sin(t * 9) * 0.3 * (1 - t * 0.4)).toFixed(3);
    points.push(`${step === 0 ? 'M' : 'L'}${x},${y}`);
  }
  return points.join(' ');
};

describe('the signature is visible in the stored document', () => {
  it('EJE-1044: the seeded facsimile is drawn, in ink, where it belongs', async () => {
    const harness = buildHarness();
    // The exact bytes a download hands over: stored by FinalDocument, read back
    // through the storage port, not an intermediate render.
    const file = await loadFinalDocumentFile(harness.as(master), 'EJE-1044');
    const report = inspectPdf(file.bytes);

    expect(report.signature, 'no signature in the document at all').not.toBeNull();
    const box = report.signature!.box;
    expect(box.width).toBeGreaterThan(20);
    expect(box.height).toBeGreaterThan(6);

    const ink = await renderPdfRegionInk(file.bytes, box, { label: 'EJE-1044' });
    // A blank region reads as zero. "pieter nel" at 17pt covers hundreds of
    // pixels, so this threshold cannot be met by an empty box or a stray rule.
    expect(
      ink.ink,
      `only ${ink.ink} dark pixels where the signature should be — see ${ink.screenshot}`,
    ).toBeGreaterThan(300);
  }, 120000);

  it('EJE-1044: a captured signature is drawn as its own geometry, in ink', async () => {
    const harness = buildHarness();
    const view = await loadJobView(harness.repos, 'EJE-1044');
    const job = view!.job;
    await harness.repos.jobs.save({
      ...job,
      signature: { ...job.signature!, strokeData: capturedPath() },
    });

    const file = await loadFinalDocumentFile(harness.as(master), 'EJE-1044');
    const report = inspectPdf(file.bytes);
    expect(report.signature?.kind).toBe('drawn');

    const ink = await renderPdfRegionInk(file.bytes, report.signature!.box, {
      label: 'EJE-1044-captured',
    });
    expect(
      ink.ink,
      `only ${ink.ink} dark pixels for the captured signature — see ${ink.screenshot}`,
    ).toBeGreaterThan(200);
  }, 120000);

  it('detects a signature that is NOT drawn, so this cannot false-pass', async () => {
    const harness = buildHarness();
    const view = await loadJobView(harness.repos, 'EJE-1044');
    const job = view!.job;

    // The control: the same document with the signature removed. If the check
    // above passed for a reason other than the signature, this would pass too.
    await harness.repos.jobs.save({ ...job, signature: null });
    const file = await loadFinalDocumentFile(harness.as(master), 'EJE-1044');
    const report = inspectPdf(file.bytes);
    expect(report.signature).toBeNull();

    // Measured over the region the signature occupies when it IS drawn, taken
    // from the real document, so the two are compared over the same rectangle.
    const withSignature = buildHarness();
    const signed = await loadFinalDocumentFile(withSignature.as(master), 'EJE-1044');
    const box = inspectPdf(signed.bytes).signature!.box;

    const blank = await renderPdfRegionInk(file.bytes, box, { label: 'EJE-1044-unsigned' });
    const inked = await renderPdfRegionInk(signed.bytes, box, { label: 'EJE-1044-signed' });

    expect(blank.ink).toBeLessThan(50);
    // The difference is attributable to the signature and nothing else.
    expect(inked.ink - blank.ink).toBeGreaterThan(250);
  }, 180000);
});

describe('the model and the document agree on the signature', () => {
  it('draws exactly what the shared model carries', async () => {
    const harness = buildHarness();
    const view = await loadJobView(harness.repos, 'EJE-1044');
    const model = buildJobCardModel({
      job: view!.job,
      customer: view!.customer,
      site: view!.site,
      contact: view!.contact,
      machine: view!.machine,
      settings: view!.settings,
      checklistTemplate: view!.checklistTemplate,
      users: view!.users,
      generatedAt: view!.job.finalDocument!.generatedAt,
    });
    const report = inspectPdf((await loadFinalDocumentFile(harness.as(master), 'EJE-1044')).bytes);

    // The screen renders `signatureData` through the same `signatureFacsimile`,
    // so matching it here is what keeps the two documents showing one mark.
    expect(model.acceptance?.signatureData).toBe('demo-signature-pieter-nel');
    expect(report.signature).toMatchObject({ kind: 'facsimile', text: 'pieter nel' });
  });
});
