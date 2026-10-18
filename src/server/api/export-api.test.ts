import { beforeEach, describe, expect, it } from 'vitest';
import { ApiTestClient, DEMO_USERS, signedInAs, startTestServer } from '@/test/api-harness';

/**
 * THE EXPORTS, OVER THE REAL ROUTES. MASTER SCOPE SEARCH-4.
 *
 * The application tests cover what the file contains. These cover what only the
 * route can answer for:
 *
 *   1. A SESSION IS REQUIRED. An export is a bulk read of business records; an
 *      unauthenticated request gets 401 and no bytes.
 *   2. AUTHORISATION IS THE SERVER'S. A technician asking for the closed-job
 *      archive as a file is refused with 403 by the read, not by a missing
 *      button — and the refusal is the archive's own wording.
 *   3. IT ARRIVES AS A FILE. `Content-Disposition: attachment` with a dated
 *      name, `text/csv`, `nosniff`, and `no-store` — a file built from one
 *      person's authorised read must not sit in a shared cache.
 *   4. A MALFORMED FILTER IS REFUSED. A status that does not exist is a bad
 *      request, not an empty spreadsheet that looks like an answer.
 */
describe('exporting the Jobs list', () => {
  let master: ApiTestClient;
  let technician: ApiTestClient;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
    technician = await signedInAs(DEMO_USERS.technician);
  });

  it('refuses a request with no session', async () => {
    const stranger = new ApiTestClient();
    const answer = await stranger.download('/api/jobs/export?status=all');
    expect(answer.status).toBe(401);
    expect(answer.text).not.toContain('EJE-');
  });

  it('serves a CSV file, named and marked as a download', async () => {
    const answer = await master.download('/api/jobs/export?status=all');
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(answer.headers.get('content-disposition')).toMatch(
      /^attachment; filename="eje-jobs-\d{4}-\d{2}-\d{2}\.csv"/,
    );
    expect(answer.headers.get('x-content-type-options')).toBe('nosniff');
    expect(answer.headers.get('cache-control')).toBe('no-store');
    // The bytes start with the BOM, which is what makes Excel read UTF-8.
    expect(answer.bytes[0]).toBe(0xef);
    expect(answer.text).toContain('Job number,Status,Priority');
  });

  it('gives a technician their own list, through the same route', async () => {
    const office = await master.download('/api/jobs/export?status=all');
    const field = await technician.download('/api/jobs/export?status=all');
    expect(field.status).toBe(200);
    const rows = (text: string) => text.trimEnd().split('\r\n').length;
    expect(rows(field.text)).toBeGreaterThan(1);
    expect(rows(field.text)).toBeLessThan(rows(office.text));
  });

  it('refuses a status filter that does not exist', async () => {
    const answer = await master.download('/api/jobs/export?status=not-a-status');
    expect(answer.status).toBe(400);
    expect(answer.error?.code).toBe('validation_failed');
  });

  it('refuses a filter nobody offers, rather than ignoring it', async () => {
    const answer = await master.download('/api/jobs/export?status=all&customerId=cust-abc');
    expect(answer.status).toBe(400);
  });
});

describe('exporting the closed-job archive', () => {
  let master: ApiTestClient;
  let coordinator: ApiTestClient;
  let technician: ApiTestClient;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
    coordinator = await signedInAs(DEMO_USERS.coordinator);
    technician = await signedInAs(DEMO_USERS.technician);
  });

  it('is served to the office', async () => {
    for (const client of [master, coordinator]) {
      const answer = await client.download('/api/jobs/closed/export');
      expect(answer.status).toBe(200);
      expect(answer.headers.get('content-disposition')).toMatch(/eje-closed-jobs-/);
      expect(answer.text).toContain('Job number,Closed,Customer');
    }
  });

  /*
   * THE DISCRIMINATING TEST. The archive is where the office invoices from, and
   * the read refuses a technician before it reads a row. If the export ever
   * stopped going through `loadClosedJobs`, this is what fails — and it asserts
   * that NO bytes came back, not merely that a status code was unhappy.
   */
  it('refuses a technician, and hands over nothing', async () => {
    const answer = await technician.download('/api/jobs/closed/export');
    expect(answer.status).toBe(403);
    expect(answer.error?.message).toMatch(/office screen/);
    expect(answer.text).not.toContain('Job number');
    expect(answer.headers.get('content-disposition')).toBeNull();
  });

  it('honours the archive filters and refuses a malformed one', async () => {
    const filtered = await master.download('/api/jobs/closed/export?customerId=cust-abc');
    expect(filtered.status).toBe(200);
    const all = await master.download('/api/jobs/closed/export');
    expect(filtered.text.length).toBeLessThan(all.text.length);

    const bad = await master.download('/api/jobs/closed/export?jobType=nonsense');
    expect(bad.status).toBe(400);
  });
});
