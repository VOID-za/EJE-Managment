'use client';

import { useEffect, useState } from 'react';
import type { JobView } from '@/application/job-view';
import { Badge, Button, Icon, LoadingPanel } from '@/components/ui';
import { useApp } from '@/providers/AppProvider';
import { downloadBytes } from '@/lib/download';
import { RuleViolationNotice } from './RuleViolationNotice';

/**
 * The actual job card, rendered to PDF and shown as a PDF.
 *
 * Not a picture of one and not an HTML lookalike: this calls the SAME renderer
 * that produces the document issued to the customer, with the same source, and
 * puts its bytes in the viewer. What the technician holds up to the customer
 * before they sign is therefore the document they will receive — if the two
 * could differ, the preview would be worth nothing.
 *
 * It re-renders whenever the job changes, so going back a step, fixing a figure
 * and coming forward again shows the corrected card rather than a stale one.
 */
export const JobCardPdfPreview = ({
  view,
  caption,
}: {
  readonly view: JobView;
  /** One line above the document saying what this copy is. */
  readonly caption?: string;
}) => {
  const { operationContext } = useApp();
  const [state, setState] = useState<
    | { readonly kind: 'loading' }
    | { readonly kind: 'ready'; readonly url: string; readonly fileName: string; readonly bytes: Uint8Array; readonly pages: number }
    | { readonly kind: 'failed'; readonly message: string }
  >({ kind: 'loading' });

  /*
   * Keyed on everything the document is drawn from.
   *
   * A preview that does not follow a correction is worse than no preview: the
   * customer would be shown one document and sign for another. The job's own
   * updated stamp is not enough on its own, because the write-up, the lines and
   * the signature are all separately mutable — so the key names them.
   */
  const { job } = view;
  const renderKey = [
    job.id,
    job.status,
    job.labour.length,
    job.travel.length,
    job.parts.length,
    job.photos.length,
    job.notes.length,
    job.signature === null ? 'unsigned' : job.signature.signedAt,
    job.signatureRefusals.length,
    job.courierCollection ? 'courier' : 'customer',
    job.waybillNumber,
    job.deliveryNote,
    job.orderNumber,
    job.referenceNumber,
    job.calloutApplied ? 'callout' : 'no-callout',
    JSON.stringify(job.completionReport),
    job.checklist?.completedAt ?? 'no-checklist',
    job.checklist?.responses.length ?? 0,
  ].join('|');

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    void (async () => {
      // Inside the async body, not synchronously in the effect: a synchronous
      // setState here re-renders before the render that scheduled it has
      // settled, which is a cascade the linter is right to object to.
      if (!cancelled) setState({ kind: 'loading' });
      try {
        const { services } = operationContext();
        // The descriptor names the file; the renderer produces the bytes. Both
        // come from the same service the final document is issued through, so a
        // courier's copy previews as a Delivery Note and a customer's does not.
        const descriptor =
          view.job.jobType === 'parts'
            ? await services.pdf.generatePartsNote(view.job, 'preview')
            : await services.pdf.generateJobCard(view.job, 'preview');
        const rendered = await services.pdf.render(
          {
            job: view.job,
            customer: view.customer,
            site: view.site,
            contact: view.contact,
            machine: view.machine,
            settings: view.settings,
            checklistTemplate: view.checklistTemplate,
            users: view.users,
          },
          'preview',
          services.clock.now(),
        );
        if (cancelled) return;

        const blob = new Blob([new Uint8Array(rendered.bytes)], { type: 'application/pdf' });
        objectUrl = URL.createObjectURL(blob);
        setState({
          kind: 'ready',
          url: objectUrl,
          fileName: descriptor.fileName,
          bytes: rendered.bytes,
          pages: rendered.pageCount,
        });
      } catch (error) {
        if (cancelled) return;
        setState({
          kind: 'failed',
          message: error instanceof Error ? error.message : 'The job card could not be rendered.',
        });
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderKey]);

  if (state.kind === 'failed') {
    return (
      <RuleViolationNotice
        title="The job card preview could not be produced"
        message={state.message}
        violations={[]}
      />
    );
  }

  if (state.kind === 'loading') {
    return <LoadingPanel rows={4} label="Rendering the job card" />;
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 font-mono text-xs text-steel-600">
            <Icon name="document" className="size-3.5" />
            {state.fileName}
          </span>
          <Badge tone="neutral" size="sm">
            {state.pages} {state.pages === 1 ? 'page' : 'pages'}
          </Badge>
          <Badge tone="amber" size="sm">
            Preview — not yet issued
          </Badge>
        </div>
        <Button
          size="sm"
          variant="secondary"
          leadingIcon={<Icon name="download" className="size-4" />}
          onClick={() => downloadBytes(state.bytes, state.fileName, 'application/pdf')}
        >
          Download preview
        </Button>
      </div>

      {caption !== undefined && <p className="mb-2 text-sm text-steel-600">{caption}</p>}

      {/* The browser's own PDF viewer. Scroll and zoom come free, and what is
          on screen is unarguably the file rather than a re-drawing of it. */}
      <iframe
        title={`${view.job.jobNumber} job card preview`}
        src={state.url}
        className="h-[60vh] min-h-96 w-full rounded-[var(--radius-control)] border border-steel-200 bg-white"
      />
    </div>
  );
};
