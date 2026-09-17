'use client';

import { useCallback, useRef, useState } from 'react';
import { Button, Icon } from '@/components/ui';
import { cn } from '@/lib/cn';
import {
  isSignatureEmpty,
  SIGNATURE_INK,
  SIGNATURE_STROKE_WIDTH,
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
  const surfaceRef = useRef<HTMLDivElement>(null);
  const strokesRef = useRef<SignatureStroke[]>([]);
  const [strokes, setStrokes] = useState<readonly SignatureStroke[]>([]);
  const [drawing, setDrawing] = useState(false);

  /** Single place that keeps the ref and the rendered state in step. */
  const commit = useCallback((next: SignatureStroke[]) => {
    strokesRef.current = next;
    setStrokes(next);
  }, []);

  const pointFrom = useCallback((event: React.PointerEvent): SignaturePoint | null => {
    const bounds = surfaceRef.current?.getBoundingClientRect();
    if (bounds === undefined || bounds.width === 0 || bounds.height === 0) return null;
    return {
      x: (event.clientX - bounds.left) / bounds.width,
      y: (event.clientY - bounds.top) / bounds.height,
    };
  }, []);

  const begin = (event: React.PointerEvent) => {
    if (disabled) return;
    const point = pointFrom(event);
    if (point === null) return;

    event.currentTarget.setPointerCapture(event.pointerId);
    setDrawing(true);
    commit([...strokesRef.current, [point]]);
  };

  const extend = (event: React.PointerEvent) => {
    if (!drawing || disabled) return;
    const point = pointFrom(event);
    if (point === null) return;

    const current = strokesRef.current;
    const last = current[current.length - 1];
    if (last === undefined) return;

    commit([...current.slice(0, -1), [...last, point]]);
  };

  const end = () => {
    if (!drawing) return;
    setDrawing(false);
    // Read the ref, not state: this runs in an event handler, so the parent is
    // notified after this component's own state has already been committed.
    onChange(strokesToPath(strokesRef.current));
  };

  const clear = () => {
    commit([]);
    onChange('');
  };

  const empty = isSignatureEmpty(strokes);

  return (
    <div>
      <div
        ref={surfaceRef}
        onPointerDown={begin}
        onPointerMove={extend}
        onPointerUp={end}
        onPointerLeave={end}
        onPointerCancel={end}
        // Pinned to the light palette, like the job card preview: the customer
        // signs in black ink on white, which is what the document will show.
        // Black on the dark theme's surface would be invisible.
        data-theme="light"
        className={cn(
          'relative h-52 w-full touch-none overflow-hidden rounded-[var(--radius-control)] border-2 border-dashed bg-white select-none',
          disabled
            ? 'cursor-not-allowed border-steel-200 bg-steel-50'
            : 'cursor-crosshair border-steel-300',
        )}
      >
        <svg
          viewBox="0 0 1 1"
          preserveAspectRatio="none"
          className="absolute inset-0 size-full"
          aria-hidden="true"
        >
          <path
            d={strokesToPath(strokes)}
            fill="none"
            stroke={SIGNATURE_INK}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            style={{ strokeWidth: SIGNATURE_STROKE_WIDTH }}
          />
        </svg>

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
      className={cn('h-24 w-full', className)}
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
