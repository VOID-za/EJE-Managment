'use client';

import { useEffect, useMemo, useState } from 'react';
import type { JobView } from '@/application/job-view';
import { Badge, Button, Icon, LoadingPanel } from '@/components/ui';
import { SimulatedPdfService } from '@/services/simulated/pdf';
import { SystemClock } from '@/services/simulated/system';
import { downloadBytes } from '@/lib/download';
import { JobCardDocument } from './JobCardDocument';
import { PdfViewer } from '@/components/documents/PdfViewer';
import { loadPreviewPhotos, renderJobCardPdf } from './job-card-pdf';
import { documentPhotos } from '@/lib/job-card/model';
import {
  canComputeDocumentIdentity,
  documentIdentityFor,
  sha256Hex,
} from '@/lib/job-card/document-identity';
import type { PreparedPhoto } from '@/lib/pdf/image';

/**
 * WHAT WAS ACTUALLY ON SCREEN. BD-23.
 *
 * Reported each time the document is drawn, so a signature taken with no
 * signal can record the identity of the very document the customer was shown
 * (`identity`, null where this browser cannot compute one), the SHA-256 of the
 * PDF bytes displayed, and how many of its genuine photographs could NOT be
 * drawn — a document missing a photograph is not the complete document, and
 * is not signed offline.
 */
export interface RenderedDocumentReport {
  readonly renderKey: string;
  readonly identity: string | null;
  readonly pdfSha256: string | null;
  readonly photosMissing: number;
}

/** Genuine customer-facing photographs whose pixels were not drawn. */
const missingPhotos = (view: JobView, prepared: ReadonlyMap<string, PreparedPhoto>): number =>
  documentPhotos(view.job).filter(
    // A demonstration photograph has no file on any copy, issued or previewed.
    (photo) => photo.provenance !== 'simulated' && prepared.get(photo.id)?.kind !== 'image',
  ).length;
import { PartsCollectionNote } from './PartsCollectionNote';
import { DeliveryNoteDocument } from './DeliveryNoteDocument';
import { requiresDeliveryNote } from '@/domain';
import { buildDeliveryNoteModel, deliveryNoteFileName } from '@/lib/job-card/delivery-note';
import { renderDeliveryNotePdf } from '@/services/simulated/delivery-note-pdf';
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
  photoImages,
  onRendered,
}: {
  readonly view: JobView;
  /** One line above the document saying what this copy is. */
  readonly caption?: string;
  /**
   * Pixels already loaded, used instead of fetching them. BD-23: the wizard
   * loads them while there is signal so the document shown with none is
   * still the complete one.
   */
  readonly photoImages?: ReadonlyMap<string, PreparedPhoto>;
  /** Told what was drawn, every time it is drawn. BD-23. */
  readonly onRendered?: (report: RenderedDocumentReport) => void;
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
  const courierNote = requiresDeliveryNote(job);
  const renderKey = [
    job.id,
    job.status,
    job.courierCollection ? `courier:${job.waybillNumber}` : 'no-courier',
    job.labour.length,
    job.travel.length,
    job.parts.length,
    job.photos.length,
    // A photograph reclassified as internal leaves the document.
    job.photos.map((photo) => `${photo.id}:${photo.visibility}`).join(','),
    job.notes.length,
    job.signature === null ? 'unsigned' : job.signature.signedAt,
    job.signatureRefusals.length,
    job.courierCollection ? 'courier' : 'customer',
    job.waybillNumber,
    job.deliveryNote,
    job.orderNumber,
    job.referenceNumber,
    job.calloutApplied ? 'callout' : 'no-callout',
    job.testBenchApplied ? 'bench' : 'no-bench',
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
        // The shared renderer (`renderJobCardPdf`): the same document the PDF
        // button on the review screens produces, and the one that is issued.
        const prepared = photoImages ?? (await loadPreviewPhotos(view));
        /*
         * A COURIER COLLECTION IS SIGNED ON ITS DELIVERY NOTE (PARTS-03/04): the
         * courier is shown the price-less Delivery Note, not the priced job
         * card, and the identity reported below is the Delivery Note's
         * (`documentIdentityFor` decides, on the tablet and on the server alike).
         */
        const rendered = courierNote
          ? (() => {
              const note = renderDeliveryNotePdf(buildDeliveryNoteModel(view, clock.now()));
              return { fileName: deliveryNoteFileName(view.job), bytes: note.bytes, pageCount: note.pageCount };
            })()
          : await renderJobCardPdf(view, pdf, clock, prepared);
        if (cancelled) return;

        if (onRendered !== undefined) {
          const computable = canComputeDocumentIdentity();
          const report: RenderedDocumentReport = {
            renderKey,
            identity: computable
              ? await documentIdentityFor({
                  job: view.job,
                  customer: view.customer,
                  site: view.site,
                  contact: view.contact,
                  machine: view.machine,
                  settings: view.settings,
                  checklistTemplate: view.checklistTemplate,
                  users: view.users,
                })
              : null,
            pdfSha256: computable ? await sha256Hex(rendered.bytes) : null,
            photosMissing: missingPhotos(view, prepared),
          };
          if (cancelled) return;
          onRendered(report);
        }

        const blob = new Blob([new Uint8Array(rendered.bytes)], { type: 'application/pdf' });
        objectUrl = URL.createObjectURL(blob);
        setState({
          kind: 'ready',
          url: objectUrl,
          fileName: rendered.fileName,
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

      {/*
        THE ACTUAL PDF, DRAWN ON EVERY DEVICE. PDF-VIEW-1 (the tester, 31
        October 2026). This used to be the browser's own viewer in a frame where
        the browser had one, and the HTML document everywhere else — so on the
        EJE tablets the customer was never shown the PDF itself. `PdfViewer`
        draws these very bytes — the document Download saves and the one that is
        issued — with page navigation and zoom, at a height that leaves the page
        readable on a phone, a tablet and a desktop.

        Only if this device cannot draw a PDF at all (the engine could not be
        loaded) is the same document drawn as HTML, by the component the review
        screen has always used: `JobCardDocument` and the PDF renderer are both
        built from `buildJobCardModel`, so neither can drift from the other.
      */}
      <PdfViewer
        bytes={state.bytes}
        fileName={state.fileName}
        title={`${view.job.jobNumber} ${courierNote ? 'delivery note' : 'job card'} preview`}
        testId="job-card-preview"
        className="h-[min(82dvh,1100px)] overflow-hidden rounded-[var(--radius-control)] border border-steel-200"
        fallback={() =>
          courierNote ? (
            <DeliveryNoteDocument model={buildDeliveryNoteModel(view, new Date().toISOString())} />
          ) : view.job.jobType === 'parts' ? (
            <PartsCollectionNote view={view} />
          ) : (
            <JobCardDocument view={view} />
          )
        }
      />
    </div>
  );
};
