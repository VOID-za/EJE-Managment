'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Icon } from '@/components/ui';
import { downloadBytes } from '@/lib/download';
import { cn } from '@/lib/cn';

/**
 * ONE PDF VIEWER, THE SAME ON EVERY DEVICE. PDF-VIEW-1 (the tester, 31 October
 * 2026: "PDF previews are still broken on desktop, tablets and mobile phones").
 *
 * WHAT WAS WRONG. Three components each decided for themselves how to show a
 * PDF, and all three asked the BROWSER to: an <iframe> on a `blob:` URL where
 * `navigator.pdfViewerEnabled` said yes, and an HTML lookalike of the document
 * everywhere else. So:
 *   - on Chrome for Android — the EJE tablets and every Android phone — nobody
 *     ever saw the PDF at all: they saw the HTML replica, in a fixed box, with
 *     no zoom, no page navigation and an A4-wide layout cut off on a phone;
 *   - on a desktop the frame was the browser's own plugin squeezed into a box
 *     with the A4 page's proportions, so a multi-page document showed one page
 *     at a time inside a dialog that itself scrolled — two scrollbars, and on a
 *     short laptop screen a page smaller than its own toolbar;
 *   - a desktop browser with its PDF viewer switched off (a managed Edge, say)
 *     got the replica too, and printing printed the replica, not the PDF.
 *
 * WHAT THIS IS. pdf.js (Mozilla's PDF engine, Apache-2.0, vendored unchanged
 * under `public/vendor/pdfjs-4.10.38`) draws every page of the ACTUAL bytes —
 * the same bytes Download saves — onto canvases, here, on every device. Nothing
 * depends on the browser having a PDF viewer. It gives:
 *   - every page, scrolled through in one place, drawn only as it comes into
 *     view (a 1 200-page manual opens as quickly as a one-page job card);
 *   - zoom in and out, Fit width, and page-by-page navigation with Page n of N;
 *   - sharp text at the device's own pixel density, redrawn on zoom, rotation
 *     and resize;
 *   - Print of the PDF's own pages (`printPdf`) on every platform that can
 *     print at all — Android Chrome included;
 *   - a plain error, never a blank box, when a document cannot be drawn — with
 *     the document drawn as HTML instead where the caller has one (`fallback`),
 *     and Download still offered.
 *
 * The object it holds — the engine's document, each page's render task — is
 * destroyed when the viewer closes, and so are the canvases it drew.
 */
export const PDFJS_BASE = '/vendor/pdfjs-4.10.38';

/* The small part of pdf.js this viewer uses. It is loaded at run time, so it is described here rather than imported. */
interface PdfViewport {
  readonly width: number;
  readonly height: number;
}
interface PdfRenderTask {
  readonly promise: Promise<void>;
  cancel(): void;
}
interface PdfPage {
  getViewport(options: { scale: number }): PdfViewport;
  render(options: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport; transform?: number[] }): PdfRenderTask;
  cleanup(): void;
}
interface PdfDocument {
  readonly numPages: number;
  getPage(number: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}
interface PdfLoadingTask {
  readonly promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}
interface PdfJs {
  readonly GlobalWorkerOptions: { workerSrc: string };
  getDocument(options: Record<string, unknown>): PdfLoadingTask;
}

let engine: Promise<PdfJs> | null = null;

/** The engine, loaded once per page load from this origin. */
export const loadPdfEngine = (): Promise<PdfJs> => {
  engine ??= (import(/* webpackIgnore: true */ `${PDFJS_BASE}/pdf.min.mjs`) as Promise<PdfJs>)
    .then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/pdf.worker.min.mjs`;
      return pdfjs;
    })
    .catch((cause: unknown) => {
      // Not cached and no connection, say. The next attempt tries again.
      engine = null;
      throw cause;
    });
  return engine;
};

/** Opens the bytes. A COPY is handed over: the engine takes ownership of what it is given, and Download still needs these. */
export const openPdf = async (bytes: Uint8Array): Promise<{ readonly document: PdfDocument; readonly task: PdfLoadingTask }> => {
  const pdfjs = await loadPdfEngine();
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    // No script in a document is ever run, whatever the PDF asks for.
    isEvalSupported: false,
    enableXfa: false,
    standardFontDataUrl: `${PDFJS_BASE}/standard_fonts/`,
  });
  return { document: await task.promise, task };
};

/**
 * Where an element starts inside the scrolling area, in the area's own scroll
 * coordinates. NOT `offsetTop`: that is measured from the nearest positioned
 * ancestor — the dialog — so it carried the dialog's header and toolbar with it.
 * On a phone, where those wrap to ~200px, Next scrolled past its page and the
 * page tracker then read page 1, leaving Previous disabled on page 2 (found by
 * the forms regression at 390×844, 31 October 2026).
 */
const topWithin = (scroller: HTMLElement, element: HTMLElement): number =>
  element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;

const ZOOMS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;
/** A canvas larger than this many pixels is drawn at a lower density rather than failing to draw at all. */
const MAX_CANVAS_PIXELS = 16_000_000;

/** Every page is laid out at the first page's size until it is drawn at its own. */
interface PageBox {
  readonly width: number;
  readonly height: number;
}

export const PdfViewer = ({
  bytes,
  fileName,
  title,
  fallback,
  className,
  testId = 'pdf-viewer',
  onPages,
}: {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  /** What the document is, for screen readers. */
  readonly title: string;
  /** The same document drawn as HTML, shown only if the PDF cannot be drawn on this device. */
  readonly fallback?: () => ReactNode;
  readonly className?: string;
  readonly testId?: string;
  /** Told how many pages the document has once it is open. */
  readonly onPages?: (pages: number) => void;
}) => {
  const [state, setState] = useState<
    | { readonly kind: 'loading' }
    | { readonly kind: 'ready'; readonly document: PdfDocument; readonly pages: number; readonly box: PageBox }
    | { readonly kind: 'failed'; readonly message: string }
  >({ kind: 'loading' });
  /*
   * 'auto' opens the page as large as the width allows up to 125% — a whole
   * page on a phone, a comfortable page on a desktop rather than one the size
   * of a poster; 'fit' is exactly the width; a number is a zoom of the page's
   * own size.
   */
  const [zoom, setZoom] = useState<number | 'fit' | 'auto'>('auto');
  const [width, setWidth] = useState(0);
  const [current, setCurrent] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const scroller = useRef<HTMLDivElement | null>(null);
  const onPagesRef = useRef(onPages);
  useEffect(() => {
    onPagesRef.current = onPages;
  });

  useEffect(() => {
    let cancelled = false;
    let opened: { readonly document: PdfDocument; readonly task: PdfLoadingTask } | null = null;
    void (async () => {
      try {
        opened = await openPdf(bytes);
        if (cancelled) return;
        const first = await opened.document.getPage(1);
        const box = first.getViewport({ scale: 1 });
        if (cancelled) return;
        setState({ kind: 'ready', document: opened.document, pages: opened.document.numPages, box: { width: box.width, height: box.height } });
        onPagesRef.current?.(opened.document.numPages);
      } catch (cause: unknown) {
        if (cancelled) return;
        const detail = cause instanceof Error && cause.message.length > 0 ? ` (${cause.message})` : '';
        setState({ kind: 'failed', message: `This document could not be drawn on this device${detail}.` });
      }
    })();
    return () => {
      cancelled = true;
      if (opened !== null) void opened.task.destroy();
    };
  }, [bytes]);

  // The width available, so Fit width follows rotation and resizing.
  useEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [state.kind]);

  const box = state.kind === 'ready' ? state.box : { width: 595.28, height: 841.89 };
  // Fit width leaves a small gutter either side; never smaller than a quarter or larger than four times the page.
  const fit = width > 0 ? Math.min(4, Math.max(0.25, (width - 24) / box.width)) : 1;
  const scale = zoom === 'fit' ? fit : zoom === 'auto' ? Math.min(fit, 1.25) : zoom;

  const goTo = useCallback((page: number) => {
    const element = scroller.current?.querySelector<HTMLElement>(`[data-page="${page}"]`);
    if (element === null || element === undefined || scroller.current === null) return;
    scroller.current.scrollTo({ top: topWithin(scroller.current, element) - 8, behavior: 'auto' });
    setCurrent(page);
    setPageInput(String(page));
  }, []);

  // Which page is in view: the one nearest the top of the scroll area.
  const onScroll = () => {
    const element = scroller.current;
    if (element === null || state.kind !== 'ready') return;
    const pages = element.querySelectorAll<HTMLElement>('[data-page]');
    const top = element.scrollTop + element.clientHeight * 0.3;
    let seen = 1;
    for (const page of pages) {
      if (topWithin(element, page) <= top) seen = Number(page.dataset.page);
      else break;
    }
    if (seen !== current) {
      setCurrent(seen);
      setPageInput(String(seen));
    }
  };

  const zoomBy = (direction: 1 | -1) => {
    const now = scale;
    const next = direction === 1 ? ZOOMS.find((step) => step > now + 0.01) : [...ZOOMS].reverse().find((step) => step < now - 0.01);
    setZoom(next ?? (direction === 1 ? ZOOMS[ZOOMS.length - 1]! : ZOOMS[0]!));
  };

  if (state.kind === 'failed') {
    return (
      <div className={cn('flex min-h-0 flex-col', className)} data-testid={testId} data-viewer-state="failed">
        <p role="alert" className="mb-2 text-sm font-medium text-signal-600">
          {state.message} {fallback === undefined ? 'Download it to open it in another application.' : 'It is shown below as the same document drawn by the page; Download gives you the PDF itself.'}
        </p>
        {fallback !== undefined && (
          <div className="eje-scrollbar min-h-0 flex-1 overflow-auto rounded-[var(--radius-control)] border border-steel-200 bg-steel-200/60 p-2" data-preview-kind="document">
            {fallback()}
          </div>
        )}
        <div className="mt-2">
          <Button size="sm" variant="secondary" leadingIcon={<Icon name="download" className="size-4" />} onClick={() => downloadBytes(bytes, fileName, 'application/pdf')}>
            Download PDF
          </Button>
        </div>
      </div>
    );
  }

  const pages = state.kind === 'ready' ? state.pages : 0;
  return (
    <div className={cn('flex min-h-0 flex-col', className)} data-testid={testId} data-viewer-state={state.kind} data-pages={pages} data-preview-kind="pdf-viewer">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-steel-200 bg-steel-50 px-2 py-1.5" role="toolbar" aria-label="Document controls">
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" aria-label="Previous page" disabled={current <= 1 || pages === 0} onClick={() => goTo(current - 1)} data-testid="pdf-previous">
            <Icon name="chevronRight" className="size-4 rotate-180" />
          </Button>
          <label className="flex items-center gap-1.5 text-sm text-steel-700">
            <span className="sr-only">Page number</span>
            <input
              type="text"
              inputMode="numeric"
              value={pageInput}
              aria-label="Page number"
              onChange={(event) => setPageInput(event.target.value.replace(/\D/gu, ''))}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                const page = Math.min(Math.max(1, Number(pageInput) || 1), Math.max(1, pages));
                goTo(page);
              }}
              onBlur={() => setPageInput(String(current))}
              className="h-9 w-14 rounded-[var(--radius-control)] border border-steel-300 bg-white px-2 text-center tabular-nums pointer-coarse:h-11"
              data-testid="pdf-page-input"
            />
            <span className="whitespace-nowrap tabular-nums" data-testid="pdf-page-count">of {pages || '…'}</span>
          </label>
          <Button size="sm" variant="ghost" aria-label="Next page" disabled={current >= pages || pages === 0} onClick={() => goTo(current + 1)} data-testid="pdf-next">
            <Icon name="chevronRight" className="size-4" />
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" aria-label="Zoom out" disabled={scale <= ZOOMS[0]! + 0.01} onClick={() => zoomBy(-1)} data-testid="pdf-zoom-out">
            <span aria-hidden="true" className="text-lg leading-none">−</span>
          </Button>
          <span className="w-12 text-center text-sm tabular-nums text-steel-700" data-testid="pdf-zoom" aria-live="polite">
            {Math.round(scale * 100)}%
          </span>
          <Button size="sm" variant="ghost" aria-label="Zoom in" disabled={scale >= ZOOMS[ZOOMS.length - 1]! - 0.01} onClick={() => zoomBy(1)} data-testid="pdf-zoom-in">
            <span aria-hidden="true" className="text-lg leading-none">+</span>
          </Button>
          <Button size="sm" variant={zoom === 'fit' ? 'secondary' : 'ghost'} aria-pressed={zoom === 'fit'} onClick={() => setZoom('fit')} data-testid="pdf-fit">
            Fit width
          </Button>
        </div>
      </div>
      <div
        ref={scroller}
        onScroll={onScroll}
        className="eje-scrollbar min-h-0 flex-1 overflow-auto bg-steel-200/70 px-3 py-3"
        style={{ touchAction: 'pan-x pan-y pinch-zoom' }}
        tabIndex={0}
        role="document"
        aria-label={title}
        data-testid="pdf-scroll"
      >
        {state.kind === 'loading' ? (
          <p className="py-10 text-center text-sm text-steel-500" data-testid="pdf-loading">Opening the document…</p>
        ) : pages === 0 ? (
          <p className="py-10 text-center text-sm text-steel-500">This document has no pages.</p>
        ) : (
          <div className="mx-auto flex w-max min-w-full flex-col items-center gap-3">
            {Array.from({ length: pages }, (_, index) => (
              <PdfPageView key={index + 1} document={state.document} number={index + 1} pages={pages} scale={scale} box={box} root={scroller} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

/** One page: a placeholder of the right size until it is near the screen, then drawn. */
const PdfPageView = ({
  document,
  number,
  pages,
  scale,
  box,
  root,
}: {
  readonly document: PdfDocument;
  readonly number: number;
  readonly pages: number;
  readonly scale: number;
  readonly box: PageBox;
  readonly root: { readonly current: HTMLDivElement | null };
}) => {
  const holder = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [near, setNear] = useState(number <= 2);
  const [own, setOwn] = useState<PageBox | null>(null);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    const element = holder.current;
    if (element === null) return;
    const observer = new IntersectionObserver(
      (entries) => setNear(entries.some((entry) => entry.isIntersecting)),
      // A page and a half either side is drawn ahead of the scroll.
      { root: root.current, rootMargin: '150% 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [root]);

  useEffect(() => {
    if (!near) return;
    let task: PdfRenderTask | null = null;
    let page: PdfPage | null = null;
    let cancelled = false;
    void (async () => {
      try {
        page = await document.getPage(number);
        if (cancelled || canvas.current === null) return;
        const viewport = page.getViewport({ scale });
        const natural = page.getViewport({ scale: 1 });
        setOwn((previous) => (previous?.width === natural.width && previous.height === natural.height ? previous : { width: natural.width, height: natural.height }));
        const density = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)));
        /*
         * DRAWN OFF SCREEN, THEN SWAPPED IN. Resizing the visible canvas wipes
         * it, so drawing straight into it left the page blank for as long as a
         * new zoom took to render — a flash on every zoom and rotation, long on
         * a slow tablet (found by the forms regression on CI's browser). The
         * page keeps what it shows until the new drawing is complete.
         */
        const off = window.document.createElement('canvas');
        off.width = Math.floor(viewport.width * density);
        off.height = Math.floor(viewport.height * density);
        const context = off.getContext('2d');
        if (context === null) return;
        task = page.render({ canvasContext: context, viewport, ...(density === 1 ? {} : { transform: [density, 0, 0, density, 0, 0] }) });
        await task.promise;
        const target = canvas.current;
        if (cancelled || target === null) return;
        target.width = off.width;
        target.height = off.height;
        target.style.width = `${Math.floor(viewport.width)}px`;
        target.style.height = `${Math.floor(viewport.height)}px`;
        target.getContext('2d')?.drawImage(off, 0, 0);
        off.width = 0;
        off.height = 0;
        setDrawn(true);
      } catch {
        // A cancelled render (zoom changed, page scrolled away) is not a failure.
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
      page?.cleanup();
    };
  }, [near, scale, document, number]);

  // A page far from the screen gives its pixels back.
  useEffect(() => {
    if (near || canvas.current === null) return;
    canvas.current.width = 0;
    canvas.current.height = 0;
    setDrawn(false);
  }, [near]);

  const size = own ?? box;
  return (
    <div
      ref={holder}
      data-page={number}
      data-drawn={drawn ? 'yes' : 'no'}
      className="relative shrink-0 bg-white shadow-[0_1px_3px_rgb(0_0_0/0.25)]"
      style={{ width: Math.floor(size.width * scale), height: Math.floor(size.height * scale) }}
      aria-label={`Page ${number} of ${pages}`}
      role="img"
    >
      <canvas ref={canvas} className="block" />
      {!drawn && <span className="absolute inset-0 flex items-center justify-center text-xs text-steel-400">Page {number}</span>}
    </div>
  );
};

/**
 * PRINTS THE PDF'S OWN PAGES. Every page drawn at print resolution (about
 * 200 dpi) and put alone on the page (`.eje-print-root`, globals.css), one PDF
 * page to one sheet with no extra margin, then the browser's print dialog —
 * which works the same on a desktop, a tablet and a phone, with or without a
 * PDF plugin. Removed again when printing ends. `onProgress` is told as pages
 * are prepared, for a long document.
 */
export const printPdf = async (bytes: Uint8Array, onProgress?: (done: number, total: number) => void): Promise<void> => {
  const { document: pdf, task } = await openPdf(bytes);
  const root = window.document.createElement('div');
  root.className = 'eje-print-root';
  const style = window.document.createElement('style');
  style.textContent = '@media print { @page { margin: 0; } .eje-print-root img { display: block; width: 100%; height: auto; break-after: page; page-break-after: always; } .eje-print-root img:last-child { break-after: auto; page-break-after: auto; } }';
  try {
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const page = await pdf.getPage(number);
      const viewport = page.getViewport({ scale: 200 / 72 });
      const canvas = window.document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('This device could not prepare the pages for printing.');
      await page.render({ canvasContext: context, viewport }).promise;
      const image = window.document.createElement('img');
      image.alt = `Page ${number}`;
      image.src = canvas.toDataURL('image/png');
      root.append(image);
      canvas.width = 0;
      page.cleanup();
      onProgress?.(number, pdf.numPages);
    }
  } finally {
    void task.destroy();
  }
  await Promise.all([...root.querySelectorAll('img')].map((image) => image.decode().catch(() => undefined)));
  window.document.head.append(style);
  window.document.body.append(root);
  const html = window.document.documentElement;
  html.classList.add('eje-print-isolate');
  const done = () => {
    html.classList.remove('eje-print-isolate');
    root.remove();
    style.remove();
  };
  window.addEventListener('afterprint', done, { once: true });
  window.print();
  // Some mobile browsers never send `afterprint`; nothing is left behind on screen either way (the root is hidden there).
  window.setTimeout(() => {
    window.removeEventListener('afterprint', done);
    done();
  }, 60_000);
};
