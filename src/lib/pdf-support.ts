/**
 * Whether this browser can display a PDF inside the page.
 *
 * WHY THIS EXISTS. The signed job card is shown in an `<iframe>` holding the
 * rendered PDF. That only works in a browser with a BUILT-IN PDF VIEWER, and
 * the tablets this system is built for do not have one: Chrome on Android has
 * never shipped the PDF plugin, and nor do the Android WebView or the in-app
 * browsers built on it. What such a browser does instead is paint its own
 * "couldn't display this PDF" block with an Open button — and because the
 * document is held in a `blob:` URL, which exists only inside this page and
 * cannot be handed to another application, that button does nothing at all.
 *
 * So the question has to be asked before the frame is drawn, and answered
 * honestly rather than guessed from the user agent. `navigator.pdfViewerEnabled`
 * is the standard signal for exactly this — "the user agent supports inline
 * display of PDF files" — and it is the browser's own answer about its own
 * capability, which no amount of user-agent sniffing can be.
 *
 * WHAT EACH ANSWER MEANS:
 *
 * - `true`  — a desktop browser with its viewer available. Nothing changes.
 * - `false` — Chrome on Android and its relatives. The caller draws the
 *   document itself instead of handing it to a viewer that is not there.
 * - MISSING — a browser older than the property (pre-2021 Chrome/Firefox,
 *   pre-16.4 Safari). Treated as NO, because a readable document is always
 *   better than a frame that may show nothing, and because the fallback is the
 *   same document rather than a lesser one.
 *
 * It is never called during server rendering: the server has no browser to ask
 * and must not answer for one.
 */
export const canDisplayPdfInline = (
  agent: Pick<Navigator, 'pdfViewerEnabled'> | undefined =
    typeof navigator === 'undefined' ? undefined : navigator,
): boolean => agent?.pdfViewerEnabled === true;
