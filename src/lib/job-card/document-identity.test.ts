import { describe, expect, it } from 'vitest';
import { buildHarness } from '@/application/test-harness';
import { loadJobView, type JobView } from '@/application/job-view';
import type { Attachment } from '@/domain';
import {
  canonicalJson,
  documentIdentityFor,
  isDocumentIdentity,
} from './document-identity';

/**
 * BD-23. The identity is what decides whether a customer's offline signature
 * is accepted, so it must move whenever the document moves and never when it
 * does not. Each case below is one of those two directions.
 */

const viewOf = async (): Promise<JobView> => {
  const harness = buildHarness();
  return (await loadJobView(harness.repos, 'EJE-1048'))!;
};

const identity = (view: JobView) =>
  documentIdentityFor({
    job: view.job,
    customer: view.customer,
    site: view.site,
    contact: view.contact,
    machine: view.machine,
    settings: view.settings,
    checklistTemplate: view.checklistTemplate,
    users: view.users,
  });

const photo = (overrides: Partial<Attachment> = {}): Attachment =>
  ({
    id: 'photo-1',
    fileName: 'fan.jpg',
    caption: 'Replaced fan',
    mimeType: 'image/jpeg',
    storageKey: 'k',
    uploadedAt: '2026-10-27T08:00:00.000Z',
    uploadedBy: 'user-tech-sipho',
    sizeBytes: 10,
    checksumSha256: 'f'.repeat(64),
    provenance: 'genuine',
    visibility: 'customer_facing',
    ...overrides,
  }) as unknown as Attachment;

describe('the identity of a customer document', () => {
  it('is versioned and the same every time for the same job', async () => {
    const view = await viewOf();
    const first = await identity(view);
    expect(isDocumentIdentity(first)).toBe(true);
    expect(first.startsWith('jcm1:')).toBe(true);
    expect(await identity(view)).toBe(first);
  });

  it('changes when anything printed changes — the work, a reference, a charge', async () => {
    const view = await viewOf();
    const base = await identity(view);
    expect(await identity({ ...view, job: { ...view.job, orderNumber: 'PO-OTHER' } })).not.toBe(base);
    expect(
      await identity({
        ...view,
        job: { ...view.job, completionReport: { ...view.job.completionReport, workPerformed: 'Other work' } },
      }),
    ).not.toBe(base);
    // A charge appearing (here the call-out fee) changes the figures printed.
    // A rate change on a job WITH lines is covered in offline-signature.test.ts;
    // this seeded job has none, so its charges block is empty either way.
    expect(await identity({ ...view, job: { ...view.job, calloutApplied: !view.job.calloutApplied } })).not.toBe(base);
  });

  it('changes when a customer-facing photograph is replaced under the same caption', async () => {
    const view = await viewOf();
    const withPhoto = { ...view, job: { ...view.job, photos: [photo()] } };
    const replaced = { ...view, job: { ...view.job, photos: [photo({ checksumSha256: '0'.repeat(64) })] } };
    expect(await identity(withPhoto)).not.toBe(await identity(replaced));
  });

  it('does not change for an internal photograph, which the customer is never shown', async () => {
    const view = await viewOf();
    const internal = { ...view, job: { ...view.job, photos: [photo({ visibility: 'internal' })] } };
    expect(await identity(internal)).toBe(await identity(view));
  });

  it('does not change with the signature itself — the outcome is not the document signed', async () => {
    const view = await viewOf();
    const signed = {
      ...view,
      job: {
        ...view.job,
        signature: {
          customerName: 'A',
          customerSurname: 'B',
          strokeData: 'M0 0',
          signedAt: '2026-10-27T09:00:00.000Z',
          declaration: 'I accept',
        },
      },
    };
    expect(await identity(signed)).toBe(await identity(view));
  });

  it('serialises keys in one order whatever order they were built in', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }));
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });
});
