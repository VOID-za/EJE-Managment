import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Reads that are in flight at the same time share one request.
 *
 * WHY THIS EXISTS. React's strict mode runs every effect twice in development,
 * so the bootstrap asked `/api/auth/me` twice and each screen asked for its
 * data twice — two round-trips for an answer that cannot differ between them.
 * Against a database reached over an SSH tunnel that is seconds of waiting.
 *
 * WHY IT MUST NOT BECOME A CACHE. Identity is read through the same helper, and
 * an identity served from memory after signing in, switching user or having a
 * session revoked would be a security fault, not a performance win. Sharing an
 * answer that has not arrived yet is not the same as remembering one, and the
 * difference is asserted below.
 */
const envelope = (data: unknown): Response =>
  new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('concurrent reads', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => envelope({ unreadNotifications: 0, unreadMessages: 0 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('share one request while it is in flight', async () => {
    const { reads } = await import('./endpoints');

    const [a, b] = await Promise.all([reads.shell(), reads.shell()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it('ask again once the first has settled — nothing is remembered', async () => {
    const { reads } = await import('./endpoints');

    await reads.shell();
    await reads.shell();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('do not share between different paths', async () => {
    const { reads, auth } = await import('./endpoints');

    await Promise.all([reads.shell(), auth.me()]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('hand a failure to every caller, and leave nothing behind', async () => {
    fetchMock.mockRejectedValue(new TypeError('offline'));
    const { reads } = await import('./endpoints');

    const [first, second] = await Promise.allSettled([reads.shell(), reads.shell()]);
    expect(first.status).toBe('rejected');
    expect(second.status).toBe('rejected');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The failed read is not remembered either: the next ask is a fresh request.
    fetchMock.mockResolvedValue(envelope({ unreadNotifications: 1, unreadMessages: 0 }));
    await expect(reads.shell()).resolves.toEqual({ unreadNotifications: 1, unreadMessages: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
