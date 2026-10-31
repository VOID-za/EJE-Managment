'use client';

import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button, Icon, Modal } from '@/components/ui';
import { downloadBytes } from '@/lib/download';
import { PdfViewer, printPdf } from './PdfViewer';

export interface PreviewPdf {
  readonly bytes: Uint8Array;
  readonly fileName: string;
}

interface PreviewProps {
  readonly title: string;
  readonly description?: string;
  readonly loadPdf: () => Promise<PreviewPdf>;
  /**
   * The same document drawn as HTML — shown only if this device cannot draw
   * the PDF. Left out for a STORED document (an issued job card, a correction)
   * that has no HTML twin: the viewer then says so and offers the file.
   */
  readonly renderHtml?: () => ReactNode;
  readonly onClose: () => void;
  /** Print as soon as the document is ready — the Print button's own action. */
  readonly autoPrint?: boolean;
}

/**
 * EVERY DOCUMENT PREVIEW IN THE APPLICATION. TS-11, TS-13, TR-02 (28 October
 * 2026); rebuilt on one viewer for PDF-VIEW-1 (the tester, 31 October 2026).
 *
 * The time sheet, the monthly timesheet and attendance forms, the issued job
 * card, a correction and the delivery note all open here, from the same bytes
 * Download saves — fetched from the server, which authorises them, and handed
 * to `PdfViewer`, which draws the PDF's own pages on every device (see there
 * for what was wrong before). Nothing about a preview depends on the browser
 * having a PDF viewer.
 *
 * The dialog fills a phone's screen and nearly all of a tablet's or a
 * desktop's, above the application's navigation (it is a modal in its own
 * layer, opened last, so it is never behind another dialog). Close, Download
 * PDF and Print are always in its footer. Print prints the PDF's pages
 * (`printPdf`); only if this device cannot draw the PDF at all does it print
 * the same document drawn as HTML. Opening a preview reads; it never submits,
 * signs, locks or stores anything.
 */
export const DocumentPreviewDialog = ({ open, ...props }: PreviewProps & { readonly open: boolean }) =>
  // Mounted only while open, so every opening starts from nothing.
  open ? <OpenPreview {...props} /> : null;

const OpenPreview = ({ title, description, loadPdf, renderHtml, onClose, autoPrint = false }: PreviewProps) => {
  const [pdf, setPdf] = useState<PreviewPdf | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pages, setPages] = useState<number | null>(null);
  const [printing, setPrinting] = useState<string | null>(null);
  const [printingHtml, setPrintingHtml] = useState(false);
  const printed = useRef(false);

  const load = useEffectEvent(() => loadPdf());

  useEffect(() => {
    let cancelled = false;
    load()
      .then((loaded) => {
        if (!cancelled) setPdf(loaded);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'The document could not be produced.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const print = async () => {
    if (pdf === null) return;
    setPrinting('Preparing the pages for printing…');
    try {
      await printPdf(pdf.bytes, (done, total) => setPrinting(total > 3 ? `Preparing page ${done} of ${total} for printing…` : 'Preparing the pages for printing…'));
    } catch {
      // This device cannot draw the PDF: print the same document drawn as HTML, where there is one.
      if (renderHtml !== undefined) setPrintingHtml(true);
      else setError('This device could not prepare the document for printing. Download it and print it from there.');
    } finally {
      setPrinting(null);
    }
  };

  // The Print button's action: print once the document is ready.
  const printWhenReady = useEffectEvent(() => void print());
  useEffect(() => {
    if (!autoPrint || pdf === null || printed.current) return;
    printed.current = true;
    const timer = window.setTimeout(() => printWhenReady(), 50);
    return () => window.clearTimeout(timer);
  }, [autoPrint, pdf]);

  // Printing the HTML document: rendered alone at the top of the page (`.eje-print-root`), printed, then removed.
  useEffect(() => {
    if (!printingHtml) return;
    const root = document.documentElement;
    root.classList.add('eje-print-isolate');
    const done = () => {
      root.classList.remove('eje-print-isolate');
      setPrintingHtml(false);
    };
    window.addEventListener('afterprint', done, { once: true });
    const timer = window.setTimeout(() => window.print(), 50);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('afterprint', done);
      root.classList.remove('eje-print-isolate');
    };
  }, [printingHtml]);

  return (
    <>
      <Modal
        open
        title={title}
        description={
          <span className="block">
            {description}
            {pdf !== null && (
              <span className="mt-0.5 block font-mono text-xs text-steel-500" data-testid="preview-file-name">
                {pdf.fileName}
                {pages === null ? '' : ` · ${pages} ${pages === 1 ? 'page' : 'pages'}`}
              </span>
            )}
          </span>
        }
        onClose={onClose}
        size="document"
        footer={
          <>
            {printing !== null && (
              <span role="status" className="mr-auto self-center text-sm text-steel-600" data-testid="preview-printing">
                {printing}
              </span>
            )}
            <Button variant="ghost" onClick={onClose} data-testid="preview-close">
              Close
            </Button>
            <Button
              variant="secondary"
              disabled={pdf === null}
              leadingIcon={<Icon name="download" className="size-4" />}
              onClick={() => pdf !== null && downloadBytes(pdf.bytes, pdf.fileName, 'application/pdf')}
              data-testid="preview-download"
            >
              Download PDF
            </Button>
            <Button
              disabled={pdf === null}
              loading={printing !== null}
              leadingIcon={<Icon name="document" className="size-4" />}
              onClick={() => void print()}
              data-testid="preview-print"
            >
              Print
            </Button>
          </>
        }
      >
        {error !== null ? (
          <div className="p-4" data-testid="document-preview" data-preview-kind="error">
            <p role="alert" className="text-sm font-medium text-signal-600">
              {error}
            </p>
          </div>
        ) : pdf === null ? (
          <p className="py-10 text-center text-sm text-steel-500" data-testid="document-preview" data-preview-kind="loading">
            Preparing the document…
          </p>
        ) : (
          <PdfViewer
            bytes={pdf.bytes}
            fileName={pdf.fileName}
            title={title}
            {...(renderHtml === undefined ? {} : { fallback: renderHtml })}
            onPages={setPages}
            className="min-h-0 flex-1"
            testId="document-preview"
          />
        )}
      </Modal>
      {printingHtml && renderHtml !== undefined && typeof document !== 'undefined'
        ? createPortal(<div className="eje-print-root">{renderHtml()}</div>, document.body)
        : null}
    </>
  );
};
