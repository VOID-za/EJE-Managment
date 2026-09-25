import { describe, expect, it } from 'vitest';
import { canDisplayPdfInline } from './pdf-support';

/**
 * Which browsers may be handed a PDF to display, and which may not.
 *
 * The Signed step put the customer's document in an `<iframe>` and assumed
 * every browser could render it. The tablets EJE works on cannot: Chrome on
 * Android has no PDF viewer, so it drew its own error block with an Open button
 * that could not act on a `blob:` URL and therefore did nothing.
 *
 * These are the four answers the browser can give and what each one means.
 */
describe('whether a browser can display a PDF inside the page', () => {
  it('YES for a desktop browser with its own viewer', () => {
    expect(canDisplayPdfInline({ pdfViewerEnabled: true })).toBe(true);
  });

  it('NO for Chrome on Android, which reports that it has no viewer', () => {
    expect(canDisplayPdfInline({ pdfViewerEnabled: false })).toBe(false);
  });

  it('NO for a browser too old to know the question', () => {
    // A readable document is always better than a frame that may show nothing,
    // and the fallback is the same document rather than a lesser one.
    expect(canDisplayPdfInline({} as { pdfViewerEnabled: boolean })).toBe(false);
  });

  it('NO where there is no browser at all, so the server never guesses for one', () => {
    expect(canDisplayPdfInline(undefined)).toBe(false);
  });
});
