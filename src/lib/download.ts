/**
 * Hands a file to the browser as a download.
 *
 * A real download, not a print dialog: an object URL plus the `download`
 * attribute, which is what makes the browser write a file with the name we give
 * it instead of displaying it. Works on desktop and on the field tablets the
 * system is built for.
 *
 * The object URL is revoked on the next tick — long enough for the click to be
 * dispatched, short enough not to leak the document for the life of the page.
 */
export const downloadBytes = (
  bytes: Uint8Array,
  fileName: string,
  contentType: string,
): void => {
  // A fresh copy: the caller's buffer may be reused, and a Blob over a shared
  // ArrayBuffer can be mutated out from under the browser.
  const blob = new Blob([new Uint8Array(bytes)], { type: contentType });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  // The stored file name, verbatim, so repeated downloads land on the same file.
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';

  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};
