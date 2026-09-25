'use client';

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { JobView } from '@/application/job-view';
import { Badge, Button, Icon, LoadingPanel } from '@/components/ui';
import { SimulatedPdfService } from '@/services/simulated/pdf';
import { SystemClock } from '@/services/simulated/system';
import { downloadBytes } from '@/lib/download';
import { canDisplayPdfInline } from '@/lib/pdf-support';
import { JobCardDocument } from './JobCardDocument';
import { PartsCollectionNote } from './PartsCollectionNote';
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
/** A browser's PDF capability never changes while the page is open. */
const subscribeToNothing = (): (() => void) => () => {};

/**
 * The server has no browser to ask, so it answers "unknown" and draws neither
 * viewer. The first client render agrees with it, and the real answer arrives
 * on the render after — which is the same render the document is ready on.
 */
const unknownOnServer = (): boolean | null => null;

export const JobCardPdfPreview = ({
  view,
  caption,
}: {
  readonly view: JobView;
  /** One line above the document saying what this copy is. */
  readonly caption?: string;
}) => {
  /*
   * The renderer runs HERE, in the browser, on the view the server sent.
   *
   * It is drawing, not business: no record is read, written or decided by it,
   * so there is nothing for the server to authorise. The bytes never leave the
   * tablet unless the job is issued, and issuing goes through the API like
   * every other change. Deliberately unchanged from the previous phase — the
   * document a customer signs must keep looking exactly as it did.
   */
  const [pdf, clock] = useMemo(() => {
    const tick = new SystemClock();
    return [new SimulatedPdfService(tick), tick] as const;
  }, []);
  /*
   * CAN THIS BROWSER SHOW A PDF AT ALL? MASTER SCOPE PDF-3 (CR-11).
   *
   * `null` until it has been asked, which can only happen in the browser —
   * the server has no answer and must not guess one, or the markup it sends
   * and the markup that hydrates would disagree.
   *
   * See `canDisplayPdfInline` for what is being asked and why the answer
   * differs between a desktop and the tablet this system is built for.
   */
  const inlinePdf = useSyncExternalStore(subscribeToNothing, canDisplayPdfInline, unknownOnServer);
  /*
   * ONLY A BROWSER THAT SAYS YES GETS THE FRAME.
   *
   * Written this way round deliberately: "unknown" — the server's answer, and
   * the first client render's — draws the document rather than an iframe, so a
   * tablet never builds a viewer it cannot use, not even for one frame.
   */
  const useNativeViewer = inlinePdf === true;

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
        // The descriptor names the file; the renderer produces the bytes. Both
        // come from the same service the final document is issued through, so a
        // courier's copy previews as a Delivery Note and a customer's does not.
        const descriptor =
          view.job.jobType === 'parts'
            ? await pdf.generatePartsNote(view.job, 'preview')
            : await pdf.generateJobCard(view.job, 'preview');
        const rendered = await pdf.render(
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
          clock.now(),
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

      {!useNativeViewer && (
        <p className="mb-2 text-xs text-steel-500">
          This browser has no built-in PDF viewer, so the document is shown here directly. It is
          the same job card, from the same record — use Download preview for the PDF file itself.
        </p>
      )}

      {caption !== undefined && <p className="mb-2 text-sm text-steel-600">{caption}</p>}

      {/*
        THE FRAME IS THE SHAPE OF THE PAGE. MASTER SCOPE PDF-1.

        It was `h-[60vh] w-full`: a letterbox, far wider than it was tall,
        holding a portrait A4 document. The browser's viewer fits the page to
        whichever dimension runs out first, so on any normal screen the page
        was shrunk to a squeezed strip with empty grey either side of it, and
        reading it meant zooming.

        So the frame is given A4's own proportions — 595.28 × 841.89 pt, the
        page box every EJE document is written at, which is 1 : 1.4143 — and
        the width is then capped so that box never grows taller than the
        viewport. `aspect-ratio` sets the height from the width; `max-width`
        set in `vh` is what stops a wide screen making it taller than the
        screen. The result is a page at its true proportions, readable without
        zooming, with the viewer's own scrolling for further pages.

        Nothing about the DOCUMENT changed. This is the viewer, not the file.
      */}
      <div className="mx-auto w-full max-w-[calc(80vh*595.28/841.89)]">
        {useNativeViewer ? (
          <iframe
            title={`${view.job.jobNumber} job card preview`}
            src={state.url}
            className="aspect-[595.28/841.89] w-full rounded-[var(--radius-control)] border border-steel-200 bg-white"
          />
        ) : (
          /*
           * THE SAME DOCUMENT, DRAWN BY THE BROWSER ITSELF. MASTER SCOPE PDF-3.
           *
           * A browser with no built-in PDF viewer — Chrome on Android, which is
           * what the EJE tablets run — cannot show the frame above. It does not
           * fail quietly either: it paints its own "couldn't display" block with
           * an Open button, and that button cannot act on a `blob:` URL, so it
           * does nothing at all. The technician was left looking at an error on
           * the one screen that has to show the customer's document.
           *
           * So on those browsers the document is drawn as HTML instead, by the
           * component the review screen has always used. It is not a lookalike
           * and it is not a second definition of the job card: `JobCardDocument`
           * and the PDF renderer are both built from `buildJobCardModel`, so the
           * content, the order, the labels and the signature are the same in
           * both, and neither can drift from the other.
           *
           * The frame keeps A4's proportions either way — that is PDF-1, and it
           * is the viewer, not the file. The PDF itself is untouched: it is the
           * same bytes, and Download hands them over unchanged.
           */
          <div className="eje-scrollbar aspect-[595.28/841.89] w-full overflow-y-auto rounded-[var(--radius-control)] border border-steel-200 bg-steel-200/60 p-2">
            {view.job.jobType === 'parts' ? (
              <PartsCollectionNote view={view} />
            ) : (
              <JobCardDocument view={view} />
            )}
          </div>
        )}
      </div>
    </div>
  );
};
