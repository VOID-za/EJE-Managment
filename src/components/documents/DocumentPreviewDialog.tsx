'use client';

import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button, Icon, Modal } from '@/components/ui';
import { downloadBytes } from '@/lib/download';
import { canDisplayPdfInline } from '@/lib/pdf-support';

export interface PreviewPdf {
  readonly bytes: Uint8Array;
  readonly fileName: string;
}

interface PreviewProps {
  readonly title: string;
  readonly description?: string;
  readonly loadPdf: () => Promise<PreviewPdf>;
  readonly renderHtml: () => ReactNode;
  readonly onClose: () => void;
  /** Print as soon as the document is ready — the Print button's own action. */
  readonly autoPrint?: boolean;
}

/**
 * A DOCUMENT PREVIEW THAT WORKS ON THE TABLETS. TS-11, TS-13, TR-02 (the
 * real-world reviewer, 28 October 2026).
 *
 * WHY IT EXISTS. The job card's "Job card PDF" button opened the PDF in a new
 * tab — on a desktop. On the EJE tablets (Chrome on Android, which has no
 * built-in PDF viewer) the same button silently DOWNLOADED the file instead:
 * nothing appeared on screen, which reads as "Preview does not work"
 * (reproduced in a browser with no PDF viewer on 28 October 2026).
 *
 * So the preview is shown IN the application, always:
 *   - where the browser can display a PDF, the actual PDF in a frame;
 *   - where it cannot, the same document drawn as HTML by the component built
 *     from the same model the PDF is (`renderHtml`), never a lookalike.
 * Print prints the PDF where it can be displayed, and otherwise the HTML
 * document alone — never the application around it. Download hands over the
 * PDF bytes unchanged. Opening the preview reads; it never submits, signs,
 * locks or stores anything.
 */
export const DocumentPreviewDialog = ({ open, ...props }: PreviewProps & { readonly open: boolean }) =>
  // Mounted only while open, so every opening starts from nothing.
  open ? <OpenPreview {...props} /> : null;

const OpenPreview = ({ title, description, loadPdf, renderHtml, onClose, autoPrint = false }: PreviewProps) => {
  const [inline] = useState(() => canDisplayPdfInline());
  const [pdf, setPdf] = useState<PreviewPdf | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [printingHtml, setPrintingHtml] = useState(false);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const printed = useRef(false);

  const load = useEffectEvent(() => loadPdf());

  useEffect(() => {
    let cancelled = false;
    let created: string | null = null;
    load()
      .then((loaded) => {
        if (cancelled) return;
        setPdf(loaded);
        created = URL.createObjectURL(new Blob([new Uint8Array(loaded.bytes)], { type: 'application/pdf' }));
        setUrl(created);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'The document could not be produced.');
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
      if (created !== null) URL.revokeObjectURL(created);
    };
  }, []);

  const print = () => {
    const target = frame.current?.contentWindow;
    if (inline && target) {
      try {
        target.focus();
        target.print();
        return;
      } catch {
        // A viewer that refuses scripted printing: print the HTML instead.
      }
    }
    setPrintingHtml(true);
  };

  // The Print button's action: print once the document is ready.
  const printWhenReady = useEffectEvent(() => print());
  const ready = inline ? url !== null : !busy;
  useEffect(() => {
    if (!autoPrint || !ready || printed.current) return;
    printed.current = true;
    // After the frame has had a moment to load the PDF.
    const timer = window.setTimeout(() => printWhenReady(), inline ? 600 : 50);
    return () => window.clearTimeout(timer);
  }, [autoPrint, ready, inline]);

  // Printing the HTML document: it is rendered alone at the top of the page
  // (see `.eje-print-root` in globals.css), printed, then removed.
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
        description={description}
        onClose={onClose}
        size="xl"
        footer={
          <>
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
              disabled={inline && url === null}
              leadingIcon={<Icon name="document" className="size-4" />}
              onClick={print}
              data-testid="preview-print"
            >
              Print
            </Button>
          </>
        }
      >
        {error !== null && (
          <p role="alert" className="mb-3 text-sm font-medium text-signal-600">
            {error}
          </p>
        )}
        {inline ? (
          url === null ? (
            <p className="py-10 text-center text-sm text-steel-500">{busy ? 'Preparing the document…' : ''}</p>
          ) : (
            <iframe
              ref={frame}
              src={url}
              title={title}
              data-testid="document-preview"
              data-preview-kind="pdf-viewer"
              className="aspect-[595.28/841.89] w-full rounded-[var(--radius-control)] border border-steel-200 bg-white"
            />
          )
        ) : (
          <div
            data-testid="document-preview"
            data-preview-kind="document"
            className="eje-scrollbar max-h-[70dvh] overflow-y-auto rounded-[var(--radius-control)] border border-steel-200 bg-steel-200/60 p-2"
          >
            {renderHtml()}
          </div>
        )}
      </Modal>
      {printingHtml && typeof document !== 'undefined'
        ? createPortal(<div className="eje-print-root">{renderHtml()}</div>, document.body)
        : null}
    </>
  );
};
