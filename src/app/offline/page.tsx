'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button, Card } from '@/components/ui';
import { CachedJobList } from '@/components/pwa/CachedJobList';
import { CacheStatusNotice } from '@/components/pwa/CacheStatusNotice';
import { describeCacheStatus } from '@/lib/pwa/cache-state';
import {
  isJobCacheSupported,
  readCacheMeta,
  readCachedJobDetails,
  readCachedJobs,
  readDeviceSession,
} from '@/lib/pwa/job-cache';
import { readPendingWork } from '@/lib/pwa/pending-work';
import { heldMediaSummary, readPendingMedia } from '@/lib/pwa/pending-media';
import type { CachedJob, CachedJobDetail } from '@/lib/pwa/cached-job';
import { CachedJobDetailCard } from '@/components/pwa/CachedJobDetail';
import { auth } from '@/api/endpoints';
import { ApiRequestError } from '@/api/client';
import { useOnline } from '@/hooks/useOnline';

/**
 * WHERE A FAILED NAVIGATION LANDS. PWA-5, CR-09 Phase 3.
 *
 * The one page the service worker keeps, and the reason it is safe to keep it:
 * there is no server data in this document. It is rendered on the client and
 * everything it shows comes from this device's own IndexedDB cache, scoped to
 * the signed-in user.
 *
 * IT DOES NOT PRETEND. It says plainly that the tablet is offline, which jobs
 * it has a copy of, and when that copy arrived. A cold cache says there is
 * nothing — it does not show an empty list that looks like "no jobs today",
 * because those are very different facts to a technician deciding whether to
 * drive somewhere.
 *
 * WHO IT WILL SHOW IT TO, which is the careful part. The user id comes from
 * `/api/auth/me` when the server can be reached. When it cannot — which is the
 * whole reason anybody is on this page — it falls back to the session this
 * DEVICE last saw the server confirm, and shows that user's own cached jobs.
 *
 * The distinction that makes this safe is one the API client already draws: a
 * request that could not reach the server is a different outcome from one the
 * server REFUSED. A refusal (the session was revoked, the account disabled,
 * somebody signed out elsewhere) shows nothing and says to sign in again; only
 * an unreachable server falls back. A revoked session also clears this cache
 * on its way out, so there is nothing left to fall back to.
 *
 * WHAT THE FALLBACK IS NOT. It is not an offline session and it grants nothing:
 * no token, no permission, nothing writable, and every action on a reachable
 * server is still authorised there. Offline authentication — signing in, or
 * holding a session through a shift with no signal — is OFF-10 and belongs to
 * Phase 4.
 */
/**
 * Whose jobs this page may show, and on what evidence.
 *
 *   - `server`  — `/api/auth/me` answered. The strongest case, and the one
 *                 that happens when the network came back on the way here.
 *   - `device`  — the server could not be reached, so this is the session the
 *                 device last saw confirmed. Read-only and labelled as such.
 *   - `none`    — the server REFUSED, or this device has no record. Nothing
 *                 protected is shown.
 */
type Identity =
  | { readonly state: 'checking' }
  | { readonly state: 'server' | 'device'; readonly userId: string }
  | { readonly state: 'none' };

const identify = async (): Promise<Identity> => {
  try {
    const me = await auth.me();
    const userId = me.user?.id ?? '';
    return userId.length > 0 ? { state: 'server', userId } : { state: 'none' };
  } catch (cause) {
    /*
     * ONLY AN UNREACHABLE SERVER FALLS BACK. A 401 is the server saying this
     * session is over — a revoked token, a disabled account, a sign-out
     * elsewhere — and answering that from a cache would be inventing a session
     * the server has just ended.
     */
    if (!(cause instanceof ApiRequestError) || cause.code !== 'network') return { state: 'none' };
    const device = await readDeviceSession().catch(() => null);
    return device === null ? { state: 'none' } : { state: 'device', userId: device.userId };
  }
};

const OfflinePage = () => {
  const [jobs, setJobs] = useState<readonly CachedJob[]>([]);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const [identity, setIdentity] = useState<Identity>({ state: 'checking' });
  const [unsent, setUnsent] = useState(0);
  /** Photographs this tablet is holding, which are bytes rather than rows. */
  const [heldPhotos, setHeldPhotos] = useState({ count: 0, bytes: 0 });
  /** The job this technician had open, from this device's own copy. */
  const [details, setDetails] = useState<readonly CachedJobDetail[]>([]);
  const online = useOnline();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const resolved = await identify();
      if (cancelled) return;
      setIdentity(resolved);
      if (resolved.state !== 'server' && resolved.state !== 'device') return;
      if (!isJobCacheSupported()) return;

      const [cached, meta, pending, photos, kept] = await Promise.all([
        readCachedJobs(resolved.userId),
        readCacheMeta(resolved.userId),
        readPendingWork(resolved.userId).catch(() => []),
        readPendingMedia(resolved.userId).catch(() => []),
        readCachedJobDetails(resolved.userId).catch(() => []),
      ]);
      if (cancelled) return;
      setJobs(cached);
      setLastRefreshedAt(meta?.lastRefreshedAt ?? null);
      setUnsent(pending.length);
      setHeldPhotos(heldMediaSummary(photos));
      setDetails(kept);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const status = describeCacheStatus({
    online,
    refreshing: identity.state === 'checking',
    signedIn: identity.state !== 'none',
    lastRefreshedAt,
    // The server could not be reached, which is why this page is on screen at
    // all; where it ANSWERED, the identity is confirmed and this is false.
    lastRefreshFailed: identity.state === 'device',
    hasCachedCopy: jobs.length > 0,
  });

  return (
    <main className="mx-auto w-full max-w-2xl space-y-4 p-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">EJE Job Cards</h1>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          This tablet could not reach the EJE server.
        </p>
      </header>

      <CacheStatusNotice status={status} />

      {/*
        WORK THIS TABLET IS STILL HOLDING. OFF-6, OFF-8.
        A technician whose tablet rebooted in a plant basement lands here, and
        the first thing they need to know is that the hours they captured are
        not lost. They are held, they are not on the job, and they go the
        moment there is signal — said here because this page may be the only
        screen they can reach.
      */}
      {unsent > 0 && (
        <Card className="border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
          {/* The id is on the paragraph because `Card` renders a section and
              forwards only its own props — a test needs something to hold. */}
          <p data-testid="offline-unsent">
          <strong className="font-semibold">
            {unsent} {unsent === 1 ? 'capture is' : 'captures are'} waiting on this tablet.
          </strong>{' '}
          They are kept here — a flat battery or a closed application will not lose them — and are
          sent as soon as this tablet can reach the EJE server. They are{' '}
          <strong className="font-semibold">not on the job</strong> until then.
          </p>
        </Card>
      )}

      {/* The photographs, counted separately because they are bytes and the
          technician needs to know this tablet is carrying them. OFF-MEDIA-1. */}
      {heldPhotos.count > 0 && (
        <Card className="border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
          <p data-testid="offline-held-photos">
            <strong className="font-semibold">
              {heldPhotos.count} {heldPhotos.count === 1 ? 'photograph is' : 'photographs are'}{' '}
              waiting on this tablet.
            </strong>{' '}
            They are kept here with the captures above and are{' '}
            <strong className="font-semibold">not on the job</strong> until the server has them.
          </p>
        </Card>
      )}

      {identity.state === 'device' && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Shown from this tablet&rsquo;s own copy. The EJE server cannot confirm the session until
          there is signal, and nothing below can be changed from here.
        </p>
      )}

      {/*
        THE JOB THEY WERE STANDING AT. OFF-DETAIL-1.
        Most recent first, and only the two most recent: this page is a rescue,
        not a second job screen, and a technician in a basement is looking for
        the job in front of them rather than a browsable history.
      */}
      {status.showsCachedData &&
        details.slice(0, 2).map((detail) => (
          <CachedJobDetailCard key={detail.key} detail={detail} />
        ))}

      {status.showsCachedData ? (
        <CachedJobList jobs={jobs} />
      ) : (
        <Card className="p-4 text-sm text-slate-600 dark:text-slate-300">
          {identity.state === 'none'
            ? 'Nobody is signed in on this tablet, so there is nothing to show. Sign in once there is signal.'
            : 'Checking this tablet for a cached copy of your jobs.'}
        </Card>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => window.location.reload()}>
          Try again
        </Button>
        {/* Not prefetched: a prefetch from this page is a request to the
            server that just could not be reached. If the route payload cannot
            be fetched on the tap either, the navigation falls back to a full
            load, which the service worker answers — with this page again. */}
        <Link href="/jobs" prefetch={false}>
          <Button type="button" variant="secondary">
            Go to jobs
          </Button>
        </Link>
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        Work cannot be captured while this tablet is offline. Anything already sent to the EJE
        server is safe and will be there when the connection returns.
      </p>
    </main>
  );
};

export default OfflinePage;
