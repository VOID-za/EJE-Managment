import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_USERS, signedInAs, startTestServer } from '@/test/api-harness';

/**
 * WHAT THE BROWSER ACTUALLY RECEIVES WHEN IT ASKS FOR A SIGNED JOB CARD.
 *
 * Written while investigating the Signed step failing on the tablets. The
 * investigation found that the step renders the document in the BROWSER and
 * never asks the server for it at all — so the failure could not be a status
 * code, a content type, a cookie or a header. These tests pin down the other
 * half of the chain, the one that does go over HTTP: the stored document a
 * closed job serves, which is what Download and the review screen read.
 *
 * PDF-1 (valid bytes) and PDF-2 (correct content type) at the transport, not
 * only in the application layer where `final-document.test.ts` asserts them.
 */

interface DocumentPayload {
  readonly fileName: string;
  readonly contentType: string;
  readonly base64: string;
}

/** EJE-1044 is seeded closed, with the document it was issued. */
const CLOSED_JOB = 'EJE-1044';

describe('the stored job card, over HTTP', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('PDF-1: answers 200 with bytes that are a real PDF', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const response = await master.post<DocumentPayload>(`/api/documents/${CLOSED_JOB}`, {});

    expect(response.status).toBe(200);
    const bytes = Buffer.from(response.data.base64, 'base64');
    expect(bytes.byteLength).toBeGreaterThan(1000);

    const text = bytes.toString('latin1');
    expect(text.startsWith('%PDF-')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    // Not an HTML error page wearing a PDF's name, which is what a session
    // failure or a redirect would have handed the tablet.
    expect(text).not.toContain('<html');
  });

  it('PDF-2: says it is a PDF, under the name stored on the job', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const response = await master.post<DocumentPayload>(`/api/documents/${CLOSED_JOB}`, {});

    expect(response.data.contentType).toBe('application/pdf');
    expect(response.data.fileName.endsWith('.pdf')).toBe(true);
    expect(response.data.fileName).toContain(CLOSED_JOB);
  });

  it('needs a session: an unauthenticated request gets nothing', async () => {
    const anonymous = await signedInAs(DEMO_USERS.master);
    await anonymous.post('/api/auth/logout', {});

    const response = await anonymous.post(`/api/documents/${CLOSED_JOB}`, {});
    expect([401, 403, 404]).toContain(response.status);
  });

  it('is the same document every time it is asked for', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const first = await master.post<DocumentPayload>(`/api/documents/${CLOSED_JOB}`, {});
    const second = await master.post<DocumentPayload>(`/api/documents/${CLOSED_JOB}`, {});

    // Immutability, seen from the outside: reading it twice cannot re-render it.
    expect(second.data.base64).toBe(first.data.base64);
    expect(second.data.fileName).toBe(first.data.fileName);
  });
});
