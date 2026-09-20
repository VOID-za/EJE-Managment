'use client';

import { Icon } from '@/components/ui';
import { useApp } from '@/providers/AppProvider';

/**
 * Says, plainly, that saved data could not be read or a change could not be saved.
 *
 * It exists because the alternative was silence. The demo used to answer an
 * unreadable snapshot by quietly handing back the seed — indistinguishable from
 * a first visit — and a failed write by doing nothing at all, so a technician
 * could capture a day's work on a tablet with full storage, see every screen
 * confirm it, and lose the lot on the next refresh.
 *
 * Deliberately not dismissible, and deliberately at the top of every screen: it
 * is not a notification about something that happened, it is a statement about
 * the state the system is in right now. It clears itself when a write succeeds.
 */
export const StorageFailureBanner = () => {
  const { storageFailure } = useApp();
  if (storageFailure === null) return null;

  const couldNotRead = storageFailure.kind !== 'write_failed';

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
          <p className="text-sm font-semibold text-signal-700">
            {couldNotRead
              ? 'Saved demonstration data could not be read'
              : 'The last change was not saved'}
          </p>
          <p className="mt-0.5 text-sm text-steel-700">{storageFailure.message}</p>
          <p className="mt-1 text-xs text-steel-600">
            {couldNotRead
              ? 'Nothing stored in this browser has been overwritten. The demonstration is running on the seeded data, and further changes are not being saved until the demonstration data is reset from Administration → System.'
              : 'Free some space in this browser, or reset the demonstration data from Administration → System, and try the change again.'}
          </p>
        </div>
      </div>
    </div>
  );
};
