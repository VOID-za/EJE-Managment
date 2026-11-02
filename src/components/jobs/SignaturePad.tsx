'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useCaptureLock } from '@/hooks/useCaptureLock';
import { Button, Icon } from '@/components/ui';
import { cn } from '@/lib/cn';
import {
  isSignatureEmpty,
  padToSignature,
  SIGNATURE_ASPECT,
  SIGNATURE_INK,
  SIGNATURE_STROKE_WIDTH,
  signatureToPad,
  strokesToPath,
  type SignaturePoint,
  type SignatureStroke,
} from '@/lib/signature';

/**
 * Touch and pointer signature capture.
 *
 * Strokes are captured as normalised points and serialised to an SVG path, so
 * the signature is stored as data rather than a bitmap. The production system
 * stores the same representation, which keeps signed job cards reproducible at
 * any resolution.
 *
 * Note on state: the strokes are held in BOTH a ref and React state. The ref is
 * the source of truth for the geometry, so the parent can be notified from the
 * pointer-up handler with the current value; the state exists only to trigger a
 * re-render so the path is drawn. Reading the ref avoids notifying the parent
 * from inside a state updater, which React treats as updating one component
 * while rendering another.
 */
export interface SignaturePadProps {
  readonly disabled?: boolean;
  readonly onChange: (pathData: string) => void;
}

export const SignaturePad = ({ disabled = false, onChange }: SignaturePadProps) => {
  /*
   * NOTHING MAY REFLOW THE PAGE WHILE THIS IS ON SCREEN. PWA-7.
   *
   * The pad being drawn on is the one capture that cannot survive the layout
   * moving: the update bar appearing above it slides the pad out from under a
   * stylus mid-stroke, and the customer signs a line that is not theirs. Held
   * for the pad's whole life rather than only while the pen is down, because
   * the *Confirm signature* button moving under a thumb is the same defect.
   */
  useCaptureLock(true);
  const surfaceRef = useRef<HTMLDivElement>(null);
  /** Strokes in the STORED signature space (`padToSignature`), not pad pixels. */
  const strokesRef = useRef<SignatureStroke[]>([]);
  const [strokes, setStrokes] = useState<readonly SignatureStroke[]>([]);
  /*
   * WHICH FINGER IS DRAWING. SIG-MOBILE-1. A ref, read synchronously by every
   * pointer event: as React state it was stale for the first moves of a stroke,
   * and as a plain boolean a second finger — the hand holding the phone
   * touching the pad — started a new stroke and its lifting ended the first.
   * Only the pointer that began the stroke extends or ends it.
   */
  const activePointer = useRef<number | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  // The pad's size, for drawing the stored strokes back onto it (a phone turned mid-signature included).
  useEffect(() => {
    const surface = surfaceRef.current;
    if (surface === null) return;
    const measure = () => {
      const bounds = surface.getBoundingClientRect();
      setSize(bounds.width > 0 && bounds.height > 0 ? { width: bounds.width, height: bounds.height } : null);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(surface);
    /*
     * THE BROWSER MAY NOT SCROLL OR ZOOM THE PAGE FROM THE PAD. SIG-MOBILE-1.
     * `touch-action: none` asks; a phone that scrolls anyway sends
     * `pointercancel` and the stroke stopped after a few points. A native,
     * non-passive `touchmove` listener — React's cannot prevent the default —
     * makes it so on every browser.
     */
    const hold = (event: TouchEvent) => event.preventDefault();
    surface.addEventListener('touchstart', hold, { passive: false });
    surface.addEventListener('touchmove', hold, { passive: false });
    return () => {
      observer?.disconnect();
      surface.removeEventListener('touchstart', hold);
      surface.removeEventListener('touchmove', hold);
    };
  }, []);

  const commit = useCallback((next: SignatureStroke[]) => {
    strokesRef.current = next;
    setStrokes(next);
  }, []);

  const pointFrom = useCallback((event: React.PointerEvent): SignaturePoint | null => {
    const bounds = surfaceRef.current?.getBoundingClientRect();
    if (bounds === undefined || bounds.width === 0 || bounds.height === 0) return null;
    return padToSignature(event.clientX - bounds.left, event.clientY - bounds.top, bounds.width, bounds.height);
  }, []);

  const begin = (event: React.PointerEvent) => {
    if (disabled || activePointer.current !== null) return;
    const point = pointFrom(event);
    if (point === null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    activePointer.current = event.pointerId;
    commit([...strokesRef.current, [point]]);
  };

  const extend = (event: React.PointerEvent) => {
    if (disabled || activePointer.current !== event.pointerId) return;
    // Every point the device recorded since the last event, not only the last one.
    const events =
      typeof event.nativeEvent.getCoalescedEvents === 'function' ? event.nativeEvent.getCoalescedEvents() : [];
    const bounds = surfaceRef.current?.getBoundingClientRect();
    if (bounds === undefined || bounds.width === 0 || bounds.height === 0) return;
    const points = (events.length > 0 ? events : [event.nativeEvent]).map((sample) =>
      padToSignature(sample.clientX - bounds.left, sample.clientY - bounds.top, bounds.width, bounds.height),
    );
    const current = strokesRef.current;
    const last = current[current.length - 1];
    if (last === undefined) return;
    commit([...current.slice(0, -1), [...last, ...points]]);
  };

  const end = (event: React.PointerEvent) => {
    if (activePointer.current !== event.pointerId) return;
    activePointer.current = null;
    // Read the ref, not state: this runs in an event handler, so the parent is
    // notified after this component's own state has already been committed.
    onChange(strokesToPath(strokesRef.current));
  };

  const clear = () => {
    activePointer.current = null;
    commit([]);
    onChange('');
  };

  const empty = isSignatureEmpty(strokes);
  // Drawn back in pad pixels, so the ink stays exactly under the finger.
  const preview =
    size === null
      ? ''
      : strokesToPath(strokes.map((stroke) => stroke.map((point) => signatureToPad(point, size.width, size.height))));

  return (
    <div>
      <div
        ref={surfaceRef}
        onPointerDown={begin}
        onPointerMove={extend}
        onPointerUp={end}
        onPointerCancel={end}
        // Pinned to the light palette, like the job card preview: the customer
        // signs in black ink on white, which is what the document will show.
        // Black on the dark theme's surface would be invisible.
        data-theme="light"
        data-testid="signature-pad"
        className={cn(
          // A taller pad on a phone, so a finger has room to sign.
          'relative h-64 w-full touch-none overflow-hidden overscroll-contain rounded-[var(--radius-control)] border-2 border-dashed bg-white select-none sm:h-52',
          disabled
            ? 'cursor-not-allowed border-steel-200 bg-steel-50'
            : 'cursor-crosshair border-steel-300',
        )}
      >
        {size !== null && (
          <svg
            viewBox={`0 0 ${size.width} ${size.height}`}
            className="absolute inset-0 size-full"
            aria-hidden="true"
            data-testid="signature-pad-ink"
          >
            <path
              d={preview}
              fill="none"
              stroke={SIGNATURE_INK}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              style={{ strokeWidth: SIGNATURE_STROKE_WIDTH }}
            />
          </svg>
        )}

        <span
          className="pointer-events-none absolute inset-x-8 bottom-10 h-px bg-steel-200"
          aria-hidden="true"
        />

        {empty && (
          <span className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-steel-400">
            <Icon name="signature" className="size-8" />
            <span className="text-sm font-medium">Sign here</span>
          </span>
        )}
      </div>

      <div className="mt-2 flex items-center justify-between">
        <p className="text-xs text-steel-500">Sign with a finger, stylus or mouse.</p>
        <Button variant="ghost" size="sm" onClick={clear} disabled={disabled || empty}>
          Clear
        </Button>
      </div>
    </div>
  );
};

/**
 * Renders a previously captured signature.
 *
 * This is the rendering layer the job card, the parts collection note and the
 * on-screen preview all share, so the ink is black in every one of them rather
 * than being corrected per-surface.
 */
export const SignatureDisplay = ({
  pathData,
  className,
}: {
  readonly pathData: string;
  readonly className?: string;
}) => {
  // Seeded demo signatures are descriptive labels rather than path data.
  const isPath = pathData.startsWith('M');

  if (!isPath) {
    return (
      <div
        className={cn(
          'flex h-24 items-center justify-center rounded-[var(--radius-control)] border border-steel-200 bg-steel-50',
          className,
        )}
      >
        <span
          className="text-2xl italic"
          // Black for the same reason as a real signature: it stands in for ink.
          style={{ color: SIGNATURE_INK, fontFamily: 'Segoe Script, Brush Script MT, cursive' }}
        >
          {pathData.replace(/^demo-signature-/, '').replace(/-/g, ' ')}
        </span>
      </div>
    );
  }

  return (
    <svg
      viewBox="0 0 1 1"
      preserveAspectRatio="none"
      // SIG-MOBILE-1: the stored signature space is 4:1, so it is drawn at 4:1 — never stretched.
      style={{ aspectRatio: String(SIGNATURE_ASPECT) }}
      className={cn('h-auto w-full max-w-sm', className)}
      aria-label="Customer signature"
      role="img"
    >
      <path
        d={pathData}
        fill="none"
        stroke={SIGNATURE_INK}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        style={{ strokeWidth: SIGNATURE_STROKE_WIDTH }}
      />
    </svg>
  );
};
