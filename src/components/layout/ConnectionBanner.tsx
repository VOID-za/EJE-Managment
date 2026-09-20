'use client';

import { Icon } from '@/components/ui';
import { useApp } from '@/providers/AppProvider';

/**
 * Says, plainly, that the server could not be reached — or that this is not the
 * business's data.
 *
 * WHAT THIS REPLACES: the storage-failure banner. It existed because the
 * browser used to be the store, and a tablet with full storage could confirm a
 * day's work on every screen and lose the lot on the next refresh. The browser
 * is no longer the store, so that failure cannot happen; the one that can is
 * the tablet losing the server mid-job.
 *
 * The rule is the same rule: never let a failed change look like a saved one.
 * Nothing is written locally when a request fails, so this banner is the whole
 * of the recovery story — it says the change did not happen, and the person
 * tries it again once they have signal.
 *
 * The demonstration strip is the other half: a demonstration that looks
 * identical to production is how somebody captures a real job card into
 * nothing.
 */
export const ConnectionBanner = () => {
  const { connectionError, backend } = useApp();

  if (connectionError === null) {
    if (backend !== 'demo') return null;
    return (
      <div className="border-b border-amber-300 bg-amber-50 px-4 py-1.5 text-center lg:px-8 print:hidden">
        <p className="text-xs font-semibold text-amber-800">
          Demonstration data — nothing recorded here is the business&apos;s record.
        </p>
      </div>
    );
  }

  return (
    <div
      role="alert"
      className="border-b-2 border-signal-300 bg-signal-50 px-4 py-3 lg:px-8 print:hidden"
    >
      <div className="mx-auto flex max-w-[1600px] items-start gap-3">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-signal-500 text-white">
          <Icon name="warning" className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-signal-700">The server could not be reached</p>
          <p className="mt-0.5 text-sm text-steel-700">{connectionError}</p>
          <p className="mt-1 text-xs text-steel-600">
            The last change was NOT saved. Nothing has been kept on this tablet — check the signal
            and make the change again once the connection is back.
          </p>
        </div>
      </div>
    </div>
  );
};
