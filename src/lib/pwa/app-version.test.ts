import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DISMISS_MS,
  buildOfWorkerUrl,
  dismissRelease,
  forgetAttempt,
  isDismissed,
  isKnownBuild,
  isNewRelease,
  mayActivateQuietly,
  outcomeAfterReload,
  recordAttempt,
  serverBuildOf,
  workerUrl,
} from './app-version';
import { hasUnsavedWork, holdUnsavedWork, resetUnsavedWork, subscribeToUnsavedWork, unsavedWork } from './unsaved-work';
import { shareOrDownload } from '@/lib/share-file';

/** sessionStorage, as far as these functions use it. */
const memoryStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, String(value)),
  };
};

describe('every release is a new version (REL-UPD-1)', () => {
  it('registers the worker under the build, so a release with an unchanged worker file still installs one', () => {
    expect(workerUrl('a46e767')).toBe('/eje-sw.js?build=a46e767');
    expect(workerUrl('b1c2d3e')).not.toBe(workerUrl('a46e767'));
    // A build that cannot say which commit it is keeps the plain URL rather than inventing one.
    expect(workerUrl('unknown')).toBe('/eje-sw.js');
  });

  it('reads the build back from a worker script URL, absolute or relative', () => {
    expect(buildOfWorkerUrl('https://eje.syncza.co.za/eje-sw.js?build=a46e767')).toBe('a46e767');
    expect(buildOfWorkerUrl('/eje-sw.js?build=b1c2d3e')).toBe('b1c2d3e');
    // The worker every release before this one registered.
    expect(buildOfWorkerUrl('https://eje.syncza.co.za/eje-sw.js')).toBeNull();
    expect(buildOfWorkerUrl('/eje-sw.js?build=unknown')).toBeNull();
    expect(buildOfWorkerUrl(null)).toBeNull();
  });

  it('calls it a new release only when both sides name a commit and they differ', () => {
    expect(isNewRelease('a46e767', 'b1c2d3e')).toBe(true);
    expect(isNewRelease('a46e767', 'a46e767')).toBe(false);
    expect(isNewRelease('unknown', 'b1c2d3e')).toBe(false);
    expect(isNewRelease('a46e767', null)).toBe(false);
    expect(isKnownBuild('')).toBe(false);
  });

  it('reads the server build from /api/health, and nothing from anything else', () => {
    expect(serverBuildOf({ status: 'ok', build: { commit: 'b1c2d3e', builtAt: 'x' } })).toBe('b1c2d3e');
    expect(serverBuildOf({ build: { commit: 'unknown' } })).toBeNull();
    expect(serverBuildOf('<html>proxy error</html>')).toBeNull();
    expect(serverBuildOf(null)).toBeNull();
    expect(serverBuildOf({ build: { commit: 42 } })).toBeNull();
  });

  it('switches on a waiting worker quietly only when the page is already its release', () => {
    expect(mayActivateQuietly('b1c2d3e', 'https://x/eje-sw.js?build=b1c2d3e')).toBe(true);
    // A worker for a NEWER release than the page waits for Update now.
    expect(mayActivateQuietly('a46e767', 'https://x/eje-sw.js?build=b1c2d3e')).toBe(false);
    expect(mayActivateQuietly('a46e767', 'https://x/eje-sw.js')).toBe(false);
    expect(mayActivateQuietly('unknown', 'https://x/eje-sw.js?build=unknown')).toBe(false);
  });
});

describe('Update now, and the page that comes back', () => {
  it('confirms the update ONCE when the reloaded page is the release asked for', () => {
    const storage = memoryStorage();
    recordAttempt(storage, 'a46e767', 'b1c2d3e', 1000);
    expect(outcomeAfterReload(storage, 'b1c2d3e')).toEqual({ kind: 'updated', from: 'a46e767', to: 'b1c2d3e' });
    // Read again (another reload, another tab render): nothing more to say — no repeated notice.
    expect(outcomeAfterReload(storage, 'b1c2d3e')).toEqual({ kind: 'none' });
  });

  it('says plainly when the reload came back on the old release, and counts the tries — it never retries by itself', () => {
    const storage = memoryStorage();
    recordAttempt(storage, 'a46e767', 'b1c2d3e', 1000);
    expect(outcomeAfterReload(storage, 'a46e767')).toEqual({ kind: 'not-applied', to: 'b1c2d3e', tries: 1 });
    recordAttempt(storage, 'a46e767', 'b1c2d3e', 2000);
    expect(outcomeAfterReload(storage, 'a46e767')).toEqual({ kind: 'not-applied', to: 'b1c2d3e', tries: 2 });
    // A different release starts the count again.
    recordAttempt(storage, 'a46e767', 'c9d8e7f', 3000);
    expect(outcomeAfterReload(storage, 'a46e767')).toMatchObject({ tries: 1 });
    forgetAttempt(storage);
    expect(outcomeAfterReload(storage, 'a46e767')).toEqual({ kind: 'none' });
  });

  it('forgets an attempt the server has moved past', () => {
    const storage = memoryStorage();
    recordAttempt(storage, 'a46e767', 'b1c2d3e', 1000);
    expect(outcomeAfterReload(storage, 'c9d8e7f')).toEqual({ kind: 'none' });
    expect(outcomeAfterReload(storage, 'a46e767')).toEqual({ kind: 'none' });
  });

  it('holds "Not now" for an hour for that release only; a newer release shows at once', () => {
    const storage = memoryStorage();
    dismissRelease(storage, 'b1c2d3e', 1000);
    expect(isDismissed(storage, 'b1c2d3e', 1000 + DISMISS_MS - 1)).toBe(true);
    expect(isDismissed(storage, 'b1c2d3e', 1000 + DISMISS_MS)).toBe(false);
    expect(isDismissed(storage, 'c9d8e7f', 2000)).toBe(false);
  });

  it('a successful update clears the "Not now" too', () => {
    const storage = memoryStorage();
    dismissRelease(storage, 'b1c2d3e', 1000);
    recordAttempt(storage, 'a46e767', 'b1c2d3e', 1000);
    outcomeAfterReload(storage, 'b1c2d3e');
    expect(isDismissed(storage, 'b1c2d3e', 1001)).toBe(false);
  });

  it('works without storage (private mode): the update still happens, only the confirmation is lost', () => {
    expect(() => recordAttempt(null, 'a', 'b', 1)).not.toThrow();
    expect(outcomeAfterReload(null, 'b')).toEqual({ kind: 'none' });
    const refusing = memoryStorage();
    refusing.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    expect(() => recordAttempt(refusing, 'a', 'b', 1)).not.toThrow();
  });
});

describe('unsaved work is named before Update now reloads over it', () => {
  afterEach(() => resetUnsavedWork());

  it('lists what each screen holds, once each, until released', () => {
    const changes = vi.fn();
    subscribeToUnsavedWork(changes);
    expect(hasUnsavedWork()).toBe(false);
    const releaseLine = holdUnsavedWork('a timesheet line');
    const releaseOther = holdUnsavedWork('a timesheet line');
    const releaseReport = holdUnsavedWork('the completion write-up');
    expect(unsavedWork()).toEqual(['a timesheet line', 'the completion write-up']);
    releaseLine();
    releaseLine(); // twice is harmless
    expect(unsavedWork()).toEqual(['a timesheet line', 'the completion write-up']);
    releaseOther();
    releaseReport();
    expect(hasUnsavedWork()).toBe(false);
    expect(changes).toHaveBeenCalledTimes(6);
  });
});

describe('Export PDF hands the file to the share sheet, or downloads it', () => {
  const bytes = new TextEncoder().encode('%PDF-1.7');

  it('shares the file under its own name where the browser can', async () => {
    const share = vi.fn(() => Promise.resolve());
    const outcome = await shareOrDownload(bytes, 'JC ATTEN OCTOBER.pdf', 'application/pdf', { share, canShare: () => true });
    expect(outcome).toBe('shared');
    const files = (share.mock.calls[0] as unknown as [ShareData])[0].files ?? [];
    expect(files[0]?.name).toBe('JC ATTEN OCTOBER.pdf');
    expect(files[0]?.type).toBe('application/pdf');
  });

  it('a cancelled share is not a failure and downloads nothing', async () => {
    const share = vi.fn(() => Promise.reject(new DOMException('cancelled', 'AbortError')));
    expect(await shareOrDownload(bytes, 'x.pdf', 'application/pdf', { share, canShare: () => true })).toBe('cancelled');
  });
});
