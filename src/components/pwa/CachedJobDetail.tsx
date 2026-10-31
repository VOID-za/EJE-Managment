'use client';

import { Badge, Card, Icon } from '@/components/ui';
import type { CachedJobDetail as CachedDetail } from '@/lib/pwa/cached-job';
import { formatDateTime, formatHours, formatKilometres, formatRelative } from '@/lib/format';

/**
 * THE JOB THIS TECHNICIAN HAD OPEN, FROM THIS DEVICE'S OWN COPY.
 * OFF-DETAIL-1.
 *
 * Shown on the offline page, which is the only screen a tablet with no signal
 * can reach — every other page in this application is rendered for one
 * signed-in person and is deliberately never cached by the worker.
 *
 * THREE PROMISES THIS COMPONENT HAS TO KEEP, and they are why it looks
 * deliberately unlike the job screen:
 *
 *   1. IT SAYS IT IS A COPY, AND HOW OLD. Once, at the top, before anything
 *      else — a technician reading hours off a cached page has to know whether
 *      the office changed something since.
 *   2. NOTHING HERE IS AN ACTION. There are no buttons at all. Capturing work
 *      offline happens on the job screen while it is open (the queue), and
 *      pretending to offer it from a cached copy would be offering an action
 *      the server never agreed to.
 *   3. NO PRICES, NO SIGNATURE, NO DOCUMENT. `toCachedJobDetail` does not keep
 *      them, so this cannot render them — which is the only guarantee worth
 *      having.
 */
export const CachedJobDetailCard = ({ detail }: { readonly detail: CachedDetail }) => (
  <Card className="space-y-3">
    {/* The id is on this element rather than on `Card`, which renders a
        section and forwards only its own props — a test needs something to
        hold. */}
    <div
      className="flex flex-wrap items-start justify-between gap-2"
      data-testid="cached-job-detail"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-semibold">{detail.jobNumber}</span>
          <Badge tone="amber" size="sm">
            Copy on this tablet
          </Badge>
        </div>
        <p className="mt-1 text-sm font-medium text-steel-900 dark:text-slate-100">
          {detail.customerName}
        </p>
        <p className="text-xs text-steel-500 dark:text-slate-400">
          {detail.siteName}
          {detail.siteAddress.length > 0 && ` · ${detail.siteAddress}`}
        </p>
        {detail.machineLabel.length > 0 && (
          <p className="text-xs text-steel-500 dark:text-slate-400">
            {detail.machineLabel}
            {detail.machineSerial.length > 0 && ` · ${detail.machineSerial}`}
          </p>
        )}
      </div>
      <p className="shrink-0 text-xs text-steel-500 dark:text-slate-400">
        As the server had it {formatRelative(detail.capturedAt)}
        <br />
        <span className="text-xs">{formatDateTime(detail.capturedAt)}</span>
      </p>
    </div>

    {detail.faultDescription.length > 0 && (
      <p className="text-sm text-steel-700 dark:text-slate-200">{detail.faultDescription}</p>
    )}

    {detail.checklist !== null && (
      <div className="rounded-[var(--radius-control)] bg-steel-50 px-3 py-2 dark:bg-slate-800/60">
        <p className="text-xs font-semibold text-steel-700 dark:text-slate-200">
          <Icon name="check" className="mr-1 inline size-3.5" />
          {detail.checklist.name} ({detail.checklist.templateVersion}) —{' '}
          {detail.checklist.answered} of {detail.checklist.total} answered
          {detail.checklist.completed && ' · completed'}
        </p>
        {detail.checklist.outstanding.length > 0 && (
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-steel-600 dark:text-slate-300">
            {detail.checklist.outstanding.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
      </div>
    )}

    {detail.labour.length > 0 && (
      <Section title="Labour">
        {detail.labour.map((line, index) => (
          <li key={`${line.date}-${index}`}>
            {line.date} · {formatHours(line.hours)} {line.rateType}
            {line.description.length > 0 && ` — ${line.description}`}
          </li>
        ))}
      </Section>
    )}

    {detail.travel.length > 0 && (
      <Section title="Travel">
        {detail.travel.map((line, index) => (
          <li key={`${line.date}-${index}`}>
            {line.date} · {formatKilometres(line.kilometres)}
            {line.description.length > 0 && ` — ${line.description}`}
          </li>
        ))}
      </Section>
    )}

    {detail.parts.length > 0 && (
      <Section title="Parts">
        {detail.parts.map((line, index) => (
          <li key={`${line.partNumber}-${index}`}>
            {line.quantity} × {line.partNumber} — {line.description}
          </li>
        ))}
      </Section>
    )}

    {detail.workPerformed.length > 0 && (
      <Section title="Work performed">
        <li className="list-none">{detail.workPerformed}</li>
      </Section>
    )}

    {detail.notes.length > 0 && (
      <Section title="Notes">
        {detail.notes.map((note, index) => (
          <li key={`${note.createdAt}-${index}`}>
            {note.internal ? 'Internal: ' : ''}
            {note.body}
          </li>
        ))}
      </Section>
    )}

    {detail.photoCaptions.length > 0 && (
      <Section title="Photographs on the job">
        {detail.photoCaptions.map((caption, index) => (
          <li key={`${caption}-${index}`}>{caption}</li>
        ))}
      </Section>
    )}

    <p className="text-xs text-steel-500 dark:text-slate-400">
      Nothing on this copy can be changed from here, and it holds no prices, no signature and no
      customer contact details. New labour, travel, parts and notes can be held below and are sent
      when there is signal — this is what the server last said about the job.
    </p>
  </Card>
);

const Section = ({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) => (
  <div>
    <p className="text-xs font-semibold tracking-wide text-steel-500 uppercase dark:text-slate-400">
      {title}
    </p>
    <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-steel-700 dark:text-slate-200">
      {children}
    </ul>
  </div>
);
