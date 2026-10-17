/**
 * WHAT THE SCREEN IS ALLOWED TO SAY ABOUT CACHED WORK. PWA-6, CR-09 Phase 3.
 *
 * The whole value of a read cache on a tablet is that the technician knows
 * WHICH of these they are looking at. A list that looks identical whether it
 * came from the server a second ago or from this device last Tuesday is worse
 * than no list, because the technician trusts it either way — and "the job was
 * cancelled this morning" is exactly the kind of thing that moves.
 *
 * So the state is computed here, from facts rather than from optimism, and it
 * is the screen's only source of wording. `navigator.onLine` is NOT one of
 * those facts on its own: it reports the network interface, so a tablet
 * connected to a site's WiFi with no route to the internet still answers true.
 * The authority is what the last refresh actually DID.
 */
export interface CacheStatusInput {
  /** The browser's own claim. Useful, not decisive. */
  readonly online: boolean;
  /** A refresh is in flight right now. */
  readonly refreshing: boolean;
  /** Somebody is signed in. Protected cached data is unreadable otherwise. */
  readonly signedIn: boolean;
  /** When this device last got an answer from the server, or null. */
  readonly lastRefreshedAt: string | null;
  /** The last attempt failed — a different fact from being offline. */
  readonly lastRefreshFailed: boolean;
  /** Whether this device holds a cached copy for the signed-in user at all. */
  readonly hasCachedCopy: boolean;
}

export type CacheStatusKind =
  | 'signed_out'
  | 'online_current'
  | 'online_refreshing'
  | 'offline_cached'
  | 'offline_empty'
  | 'refresh_failed';

export interface CacheStatus {
  readonly kind: CacheStatusKind;
  readonly title: string;
  readonly detail: string;
  /**
   * Whether what is on screen may be out of date.
   *
   * Drives the visual treatment, and is true wherever the data did not come
   * from a successful refresh just now — including the case where the refresh
   * failed while the device still believes it is online.
   */
  readonly stale: boolean;
  /** Whether the screen may show cached records at all. */
  readonly showsCachedData: boolean;
}

/** `2026-10-17T09:14:03.000Z` → `09:14 on 17 Oct`, in the viewer's own zone. */
export const formatRefreshedAt = (iso: string | null): string => {
  if (iso === null) return 'never';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'never';
  const time = at.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' });
  const day = at.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
  return `${time} on ${day}`;
};

/**
 * The one place that decides what a technician is told.
 *
 * Order matters: signed out beats everything, because protected data must not
 * be described — let alone shown — to whoever is holding the tablet now. A
 * failed refresh beats "online", because a device that cannot reach the server
 * is not current whatever the network interface says.
 */
export const describeCacheStatus = (input: CacheStatusInput): CacheStatus => {
  const at = formatRefreshedAt(input.lastRefreshedAt);

  if (!input.signedIn) {
    return {
      kind: 'signed_out',
      title: 'Signed out',
      detail: 'Sign in to see your jobs. Nothing cached on this device is readable until you do.',
      stale: true,
      showsCachedData: false,
    };
  }

  if (input.refreshing) {
    return {
      kind: 'online_refreshing',
      title: 'Refreshing',
      detail:
        input.lastRefreshedAt === null
          ? 'Fetching your jobs from the EJE server.'
          : `Showing the copy from ${at} while the server answers.`,
      stale: input.lastRefreshedAt !== null,
      showsCachedData: true,
    };
  }

  if (input.lastRefreshFailed) {
    return input.hasCachedCopy
      ? {
          kind: 'refresh_failed',
          title: 'Could not reach the EJE server',
          detail: `Showing the copy this tablet last received at ${at}. It may be out of date.`,
          stale: true,
          showsCachedData: true,
        }
      : {
          kind: 'offline_empty',
          title: 'Could not reach the EJE server',
          detail: 'This tablet holds no cached copy of your jobs, so there is nothing to show.',
          stale: true,
          showsCachedData: false,
        };
  }

  if (!input.online) {
    return input.hasCachedCopy
      ? {
          kind: 'offline_cached',
          title: 'Offline',
          detail: `Showing the copy this tablet last received at ${at}. It may be out of date.`,
          stale: true,
          showsCachedData: true,
        }
      : {
          kind: 'offline_empty',
          title: 'Offline',
          detail:
            'This tablet holds no cached copy of your jobs. Connect to a network to load them.',
          stale: true,
          showsCachedData: false,
        };
  }

  return {
    kind: 'online_current',
    title: 'Up to date',
    detail: `Received from the EJE server at ${at}.`,
    stale: false,
    showsCachedData: true,
  };
};
