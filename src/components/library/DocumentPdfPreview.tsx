'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { TechnicalDocument } from '@/domain';
import { Icon, LoadingPanel, ProvenanceNotice } from '@/components/ui';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { ApiRequestError, apiDownload } from '@/api/client';
import { library } from '@/api/endpoints';
import { canDisplayPdfInline } from '@/lib/pdf-support';
import { formatFileSize } from '@/lib/format';

/**
 * THE STORED DOCUMENT, SHOWN AS ITSELF. MASTER SCOPE LIB-5.
 *
 * WHAT THIS REPLACES, AND WHY IT HAD TO GO. The library's preview was a
 * FACSIMILE: a white box with the manufacturer's name, the document's title and
 * nine grey bars where the text would be, captioned "Document preview is
 * simulated in this demonstration". It was honest about being fake, which is
 * the only good thing about it — a technician on a machine cannot read a
 * drawing out of nine grey bars, and a Master cannot approve a document they
 * have not seen. This fetches the REVISION'S OWN BYTES and gives them to the
 * browser's PDF viewer.
 *
 * NOTHING IS RECONSTRUCTED. There is no HTML rendering of the document, no
 * extracted-text view standing in for the page, and no sample content. Either
 * the real file is on screen or the screen says why it is not.
 *
 * THE BYTES COME THROUGH THE AUTHORISED ROUTE, every time it is opened:
 * `/api/library/:revisionId/file` resolves the storage key server-side after
 * `canOpenDocumentFile`, so a pending, archived or unauthorised revision is
 * refused here exactly as it is refused to `curl`. There is no "preview" path
 * with lighter rules, because a preview is a read of the document.
 *
 * AND THE REVISION IS CHECKED, NOT ASSUMED. The route names the revision it
 * served; this refuses to render bytes whose revision is not the one it asked
 * for. The route is keyed by the revision's own id and cannot serve another —
 * the check is there so that if it ever could, the screen would not quietly
 * show a technician a different version of the document they are working from.
 *
 * FIVE OUTCOMES, EACH SAID DIFFERENTLY, because they need different things
 * doing about them:
 *
 *   loading      — the bytes are on their way.
 *   ready        — the real PDF, in the browser's viewer.
 *   no viewer    — this browser cannot display a PDF in the page (Chrome on
 *                  Android, which is what the EJE tablets run). The document is
 *                  NOT faked: the panel says so and offers the download, which
 *                  the operating system opens in a reader that can.
 *   not a PDF    — the stored bytes do not begin with `%PDF-`. Said plainly,
 *                  because it means the file in storage is wrong.
 *   unavailable  — no file is stored against this record, or the server refused
 *                  it. The server's own words are shown.
 */
const subscribeToNothing = (): (() => void) => () => {};
const unknownOnServer = (): boolean | null => null;

type PreviewState =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'ready';
      readonly url: string;
      readonly bytes: number;
      readonly version: string;
    }
  | { readonly kind: 'not_pdf'; readonly bytes: number }
  | { readonly kind: 'unavailable'; readonly message: string; readonly detail: readonly string[] }
  | { readonly kind: 'wrong_revision'; readonly served: string };

/** `%PDF-`, which every PDF begins with and nothing else does. */
const looksLikePdf = (bytes: Uint8Array): boolean =>
  bytes.length > 5 &&
  bytes[0] === 0x25 &&
  bytes[1] === 0x50 &&
  bytes[2] === 0x44 &&
  bytes[3] === 0x46 &&
  bytes[4] === 0x2d;

export const DocumentPdfPreview = ({ document }: { readonly document: TechnicalDocument }) => {
  const [state, setState] = useState<PreviewState>({ kind: 'loading' });

  /*
   * CAN THIS BROWSER SHOW A PDF AT ALL? MASTER SCOPE PDF-3, BROWSER-1.
   *
   * The same question the signed job card asks, and the same reason: Chrome on
   * Android paints its own "couldn't display this PDF" block with an Open
   * button that cannot act on a `blob:` URL, so handing it a frame would show
   * the technician an error on the screen that is supposed to show them the
   * manual. `null` until it has been asked, which can only happen in a browser.
   */
  const inlinePdf = useSyncExternalStore(subscribeToNothing, canDisplayPdfInline, unknownOnServer);

  /**
   * WHETHER THERE IS A FILE TO FETCH AT ALL. October mandate §1.2.
   *
   * A record with no stored bytes — every seeded demonstration document, and
   * any metadata somebody adds without a file — must not produce a request, a
   * spinner, or a download button. It used to: the panel fetched, the server
   * answered 404, and the technician read "the document could not be fetched",
   * which describes a fault and this is not one. The size is the server's own
   * answer to the question (see `libraryView`), so there is nothing to probe.
   */
  const nothingStored = document.fileSizeBytes <= 0;

  useEffect(() => {
    // Nothing to fetch, and nothing to set: the render path below answers
    // this case directly, which keeps the effect free of a synchronous state
    // change that would cascade a render for a panel that needs no data.
    if (nothingStored) return;
    let cancelled = false;
    let objectUrl: string | null = null;

    void (async () => {
      setState({ kind: 'loading' });
      try {
        const file = await apiDownload(library.fileUrl(document.id), document.fileName);
        if (cancelled) return;

        // The revision the server says it served, against the one asked for.
        const served = file.headers.get('x-eje-document-revision');
        if (served !== null && served !== document.id) {
          setState({ kind: 'wrong_revision', served });
          return;
        }

        if (!looksLikePdf(file.bytes)) {
          setState({ kind: 'not_pdf', bytes: file.bytes.byteLength });
          return;
        }

        // A copy, because the Blob must own its buffer.
        const blob = new Blob([new Uint8Array(file.bytes)], { type: 'application/pdf' });
        objectUrl = URL.createObjectURL(blob);
        setState({
          kind: 'ready',
          url: objectUrl,
          bytes: file.bytes.byteLength,
          version: file.headers.get('x-eje-document-version') ?? document.version,
        });
      } catch (cause) {
        if (cancelled) return;
        setState({
          kind: 'unavailable',
          message:
            cause instanceof ApiRequestError
              ? cause.message
              : 'The document could not be fetched from the EJE server.',
          detail:
            cause instanceof ApiRequestError
              ? cause.violations.map((violation) => violation.message)
              : [],
        });
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [document.id, document.fileName, document.version, nothingStored]);

  /*
   * NOTHING IS STORED, AND NOTHING IS OFFERED. October mandate §1.2.
   *
   * No frame, no download, and no generated stand-in: a simulated preview of a
   * manual EJE do not hold would be the fabrication the mandate forbids. The
   * sentence says which situation it is — demonstration metadata, or a genuine
   * record whose file is missing — because the remedies are opposite.
   */
  if (nothingStored) {
    return (
      <div
        className="rounded-[var(--radius-control)] border border-dashed border-steel-300 bg-steel-50 p-4"
        data-testid="document-metadata-only"
        data-preview-kind="metadata-only"
      >
        <ProvenanceNotice provenance={document.provenance} storedFile={false} />
        <p className="mt-3 text-xs leading-relaxed text-steel-500">
          {document.fileName} is the name this record carries. No bytes were ever stored under it,
          so there is nothing to preview or download — and nothing has been generated to stand in
          for one.
        </p>
      </div>
    );
  }

  if (state.kind === 'loading') {
    return <LoadingPanel rows={4} label={`Fetching ${document.fileName}`} />;
  }

  if (state.kind === 'unavailable') {
    return (
      <RuleViolationNotice
        title="This document cannot be shown"
        message={state.message}
        violations={state.detail.map((message) => ({ code: 'document_unavailable', message }))}
      />
    );
  }

  if (state.kind === 'wrong_revision') {
    return (
      <RuleViolationNotice
        title="The server answered with a different revision"
        message={`This screen asked for revision ${document.version} and the server returned ${state.served}. Nothing is shown, because a document somebody works from must be the revision they chose.`}
        violations={[]}
      />
    );
  }

  if (state.kind === 'not_pdf') {
    return (
      <RuleViolationNotice
        title="The stored file is not a PDF"
        message={`${formatFileSize(state.bytes)} were stored against ${document.fileName}, and they do not begin with a PDF header. The file in storage is wrong — nothing is drawn in its place, because a preview of something else would be worse than none.`}
        violations={[]}
      />
    );
  }

  /*
   * THE FRAME IS THE SHAPE OF THE PAGE. MASTER SCOPE PDF-1.
   *
   * A4's own proportions, capped so the box never grows taller than the
   * viewport — the same geometry the signed job card's preview uses, for the
   * same reason: a portrait page in a letterbox is a squeezed strip nobody can
   * read without zooming. A manual may be landscape; the viewer fits the page
   * inside the box either way.
   */
  return (
    <div
      data-testid="library-pdf-preview"
      data-preview-revision={document.id}
      data-preview-version={state.version}
      /*
        HOW MANY BYTES ARRIVED, stated on the element.
        
        It is set only after the bytes have been checked for a PDF header, so a
        browser test can assert that the file the server stored is the file this
        screen is showing — which is the claim a facsimile could never make. It
        is a length, not a key or a path.
      */
      data-preview-bytes={state.bytes}
      data-preview-kind={inlinePdf === true ? 'pdf-viewer' : 'download-only'}
    >
      <p className="mb-2 text-xs text-steel-500">
        {document.fileName} · version {state.version} · {formatFileSize(state.bytes)} · the stored
        file, served for this revision
      </p>

      {inlinePdf === true ? (
        <div className="mx-auto w-full max-w-[calc(80vh*595.28/841.89)]">
          <iframe
            data-testid="library-pdf-frame"
            data-preview-kind="pdf-viewer"
            title={`${document.name} (version ${state.version})`}
            src={state.url}
            className="aspect-[595.28/841.89] w-full rounded-[var(--radius-control)] border border-steel-200 bg-white"
          />
        </div>
      ) : (
        /*
         * NO VIEWER, AND NO SUBSTITUTE. MASTER SCOPE PDF-3.
         *
         * The job card has a second renderer to fall back on, because this
         * system wrote it and can draw it again from the same model. A
         * machine builder's manual has nothing of the sort: the only honest
         * things to do are to say so and to hand over the file, which the
         * tablet opens in a reader that can display it. Drawing a facsimile
         * here is exactly what this component exists to remove.
         */
        <div
          data-testid="library-pdf-no-viewer"
          data-preview-kind="download-only"
          className="rounded-[var(--radius-control)] border border-amber-eje-200 bg-amber-eje-50 px-4 py-4 text-sm text-amber-eje-800"
        >
          <p className="flex items-center gap-2 font-semibold">
            <Icon name="document" className="size-4" />
            This browser cannot display a PDF inside the page
          </p>
          <p className="mt-1.5">
            Chrome on Android has no built-in PDF viewer, so there is nothing here that could show
            you the document — and nothing is drawn in its place. Use{' '}
            <span className="font-semibold">Download the document</span> below: the tablet opens it
            in a reader that can, and it is the same {formatFileSize(state.bytes)} the server holds
            for version {state.version}.
          </p>
        </div>
      )}
    </div>
  );
};
