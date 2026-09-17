'use client';

import { useCallback, useRef, useState } from 'react';
import { Button, Icon } from '@/components/ui';
import { cn } from '@/lib/cn';

/**
 * Touch and pointer signature capture.
 *
 * Strokes are captured as normalised points and serialised to an SVG path, so
 * the signature is stored as data rather than a bitmap. The production system
 * stores the same representation, which keeps signed job cards reproducible at
 * any resolution.
 */

interface Point {
  readonly x: number;
  readonly y: number;
}

const toPath = (strokes: readonly (readonly Point[])[]): string =>
  strokes
    .filter((stroke) => stroke.length > 0)
    .map((stroke) =>
      stroke
        .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(3)},${point.y.toFixed(3)}`)
        .join(' '),
    )
    .join(' ');

export interface SignaturePadProps {
  readonly disabled?: boolean;
  readonly onChange: (pathData: string) => void;
}

export const SignaturePad = ({ disabled = false, onChange }: SignaturePadProps) => {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [strokes, setStrokes] = useState<Point[][]>([]);
  const [drawing, setDrawing] = useState(false);

  const pointFrom = useCallback((event: React.PointerEvent): Point | null => {
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
    setStrokes((current) => [...current, [point]]);
  };

  const extend = (event: React.PointerEvent) => {
    if (!drawing || disabled) return;
    const point = pointFrom(event);
    if (point === null) return;
    setStrokes((current) => {
      if (current.length === 0) return current;
      const next = current.map((stroke, index) =>
        index === current.length - 1 ? [...stroke, point] : stroke,
      );
      return next;
    });
  };

  const end = () => {
    if (!drawing) return;
    setDrawing(false);
    setStrokes((current) => {
      onChange(toPath(current));
      return current;
    });
  };

  const clear = () => {
    setStrokes([]);
    onChange('');
  };

  const isEmpty = strokes.every((stroke) => stroke.length < 2);

  return (
    <div>
      <div
        ref={surfaceRef}
        onPointerDown={begin}
        onPointerMove={extend}
        onPointerUp={end}
        onPointerLeave={end}
        onPointerCancel={end}
        className={cn(
          'relative h-52 w-full touch-none overflow-hidden rounded-[var(--radius-control)] border-2 border-dashed bg-white select-none',
          disabled ? 'cursor-not-allowed border-steel-200 bg-steel-50' : 'cursor-crosshair border-steel-300',
        )}
      >
        <svg
          viewBox="0 0 1 1"
          preserveAspectRatio="none"
          className="absolute inset-0 size-full"
          aria-hidden="true"
        >
          <path
            d={toPath(strokes)}
            fill="none"
            stroke="var(--color-steel-900)"
            strokeWidth="0.005"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            style={{ strokeWidth: 2 }}
          />
        </svg>

        <span
          className="pointer-events-none absolute inset-x-8 bottom-10 h-px bg-steel-200"
          aria-hidden="true"
        />

        {isEmpty && (
          <span className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-steel-400">
            <Icon name="signature" className="size-8" />
            <span className="text-sm font-medium">Sign here</span>
          </span>
        )}
      </div>

      <div className="mt-2 flex items-center justify-between">
        <p className="text-xs text-steel-500">Sign with a finger, stylus or mouse.</p>
        <Button variant="ghost" size="sm" onClick={clear} disabled={disabled || isEmpty}>
          Clear
        </Button>
      </div>
    </div>
  );
};

/** Renders a previously captured signature path. */
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
          className="text-2xl text-steel-700 italic"
          style={{ fontFamily: 'Segoe Script, Brush Script MT, cursive' }}
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
        stroke="var(--color-steel-900)"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        style={{ strokeWidth: 2 }}
      />
    </svg>
  );
};
