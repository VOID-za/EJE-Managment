import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadBytes } from './download';

/**
 * Handing a file to the browser.
 *
 * The bug being guarded: "Download Final PDF" called `window.print()`, so the
 * user got a print dialog and had to choose "Save as PDF" — which produces a
 * fresh rendering of the page rather than the document that was issued. These
 * assert that a download is a download.
 */

interface Harness {
  readonly anchor: Record<string, unknown> & { click: () => void; remove: () => void };
  readonly blobs: { type: string; size: number }[];
  readonly created: string[];
  readonly revoked: string[];
  readonly printCalls: number;
}

const withDom = (run: () => void): Harness => {
  const blobs: { type: string; size: number }[] = [];
  const created: string[] = [];
  const revoked: string[] = [];
  let printCalls = 0;
  const appended: unknown[] = [];

  const anchor: Harness['anchor'] = {
    style: {},
    click: vi.fn(),
    remove: vi.fn(),
  };

  const timers: (() => void)[] = [];

  vi.stubGlobal('Blob', class {
    readonly size: number;
    readonly type: string;
    constructor(parts: Uint8Array[], options?: { type?: string }) {
      this.size = parts.reduce((total, part) => total + part.byteLength, 0);
      this.type = options?.type ?? '';
      blobs.push({ type: this.type, size: this.size });
    }
  });

  vi.stubGlobal('URL', {
    createObjectURL: (): string => {
      const url = `blob:eje/${created.length}`;
      created.push(url);
      return url;
    },
    revokeObjectURL: (url: string): void => {
      revoked.push(url);
    },
  });

  vi.stubGlobal('document', {
    createElement: () => anchor,
    body: { append: (node: unknown) => appended.push(node) },
  });

  vi.stubGlobal('window', {
    setTimeout: (callback: () => void) => {
      timers.push(callback);
      return 1;
    },
    print: () => {
      printCalls += 1;
    },
  });

  run();
  // Flush the deferred revoke.
  timers.forEach((callback) => callback());

  return { anchor, blobs, created, revoked, printCalls };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('downloadBytes', () => {
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

  it('NEVER opens the print dialog', () => {
    const harness = withDom(() => {
      downloadBytes(bytes, 'EJE-1065-Final-Job-Card.pdf', 'application/pdf');
    });
    expect(harness.printCalls).toBe(0);
  });

  it('downloads under the exact file name it was given', () => {
    const harness = withDom(() => {
      downloadBytes(bytes, 'EJE-1065-Final-Job-Card.pdf', 'application/pdf');
    });
    // The `download` attribute is what makes the browser write a file instead
    // of displaying it, and it carries the name.
    expect(harness.anchor.download).toBe('EJE-1065-Final-Job-Card.pdf');
    expect(harness.anchor.click).toHaveBeenCalledTimes(1);
  });

  it('gives the blob the PDF content type', () => {
    const harness = withDom(() => {
      downloadBytes(bytes, 'x.pdf', 'application/pdf');
    });
    expect(harness.blobs).toEqual([{ type: 'application/pdf', size: bytes.byteLength }]);
  });

  it('hands over every byte it was given', () => {
    const big = new Uint8Array(9000).fill(7);
    const harness = withDom(() => {
      downloadBytes(big, 'x.pdf', 'application/pdf');
    });
    expect(harness.blobs[0]?.size).toBe(9000);
  });

  it('points the anchor at the blob and then releases it', () => {
    const harness = withDom(() => {
      downloadBytes(bytes, 'x.pdf', 'application/pdf');
    });
    expect(harness.created).toHaveLength(1);
    expect(harness.anchor.href).toBe(harness.created[0]);
    // Released after the click, so the document is not held for the page's life.
    expect(harness.revoked).toEqual(harness.created);
  });

  it('removes the anchor it added, leaving no stray node behind', () => {
    const harness = withDom(() => {
      downloadBytes(bytes, 'x.pdf', 'application/pdf');
    });
    expect(harness.anchor.remove).toHaveBeenCalledTimes(1);
  });
});
