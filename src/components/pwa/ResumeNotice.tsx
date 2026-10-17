'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button, Icon } from '@/components/ui';
import { clearLastPlace, isJobCacheSupported, readLastPlace } from '@/lib/pwa/job-cache';
import { useCurrentUser } from '@/providers/AppProvider';

/**
 * TAKING A TECHNICIAN BACK TO THE JOB THEY WERE ON. PWA-4, ACC-PWA-4.
 *
 * WHY IT IS NEEDED AT ALL. The browser's history does not survive a tablet
 * going flat, being locked for an hour, or the application being killed by the
 * launcher to free memory — the reopened application is a brand-new document
 * with a brand-new history, which drops a technician who was half-way through
 * a job onto a list of thirty of them. This offers the one they had open.
 *
 * WHAT IT DOES NOT CLAIM. It restores a PLACE, not work. Phase 3 keeps nothing
 * locally, so anything typed and not sent is gone, and this says so instead of
 * implying a draft was kept. Offline capture and durable local drafts are
 * OFF-1…OFF-6 and belong to Phase 4.
 *
 * It only ever offers. A technician whose shift has moved on taps Dismiss, and
 * the record goes.
 */
export const ResumeNotice = ({
  /** Job numbers currently on this person's list, so a stale offer is not made. */
  available,
  loading,
}: {
  readonly available: readonly string[];
  readonly loading: boolean;
}) => {
  const currentUser = useCurrentUser();
  const userId = currentUser?.id ?? '';
  const [jobNumber, setJobNumber] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (userId.length === 0 || !isJobCacheSupported()) return;
    let cancelled = false;
    void readLastPlace(userId)
      .then((place) => {
        if (!cancelled) setJobNumber(place?.jobNumber ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const dismiss = () => {
    setDismissed(true);
    void clearLastPlace(userId).catch(() => undefined);
  };

  /*
   * Offered only while the job is still ON the list. A job that has been
   * closed, cancelled or reassigned since the tablet was last awake is not
   * somewhere to send anybody back to, and the list is waited for rather than
   * guessed at — hence `loading`.
   */
  if (dismissed || loading || jobNumber === null || !available.includes(jobNumber)) return null;

  return (
    <div
      role="status"
      data-testid="resume-notice"
      className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-control)] border border-eje-200 bg-eje-50 px-3.5 py-2.5 text-sm text-eje-900"
    >
      <span className="flex min-w-0 items-center gap-2">
        <Icon name="clock" className="size-4 shrink-0 text-eje-600" />
        <span className="min-w-0">
          You were last working on <strong className="font-semibold">{jobNumber}</strong>. Anything
          you had not sent to the EJE server was not kept.
        </span>
      </span>
      {/*
        "Not now" and "Resume", NOT "Dismiss" and "Open".
        Both of those are words the rest of the application already uses as
        button labels — an acceptance outcome has a Dismiss, a notification and
        a library document have an Open — and this notice sits at the top of
        the job list where those flows land. Two buttons with the same
        accessible name on one screen is an ambiguity for anybody driving by
        label: a screen reader, a test, or a person being told what to tap.
      */}
      {/*
        The DEFAULT size, not `sm`. These are the first two things a technician
        taps after picking the tablet back up, in the field, with gloves on —
        `md` is the 44px target the button sizes are built around (UX-1), and
        `sm` is 36px.
      */}
      <span className="flex shrink-0 gap-2">
        <Button type="button" variant="ghost" onClick={dismiss}>
          Not now
        </Button>
        <Link href={`/jobs/${jobNumber}`} prefetch={false}>
          <Button type="button" onClick={dismiss}>
            Resume {jobNumber}
          </Button>
        </Link>
      </span>
    </div>
  );
};
