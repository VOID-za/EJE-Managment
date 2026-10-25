/**
 * A LONG MANUAL, BUILT IN MEMORY. LIB-TEXT-1 (#70) test support.
 *
 * The 214-page fixture (`src/services/__fixtures__/long-manual.pdf`) is what
 * exposed the old whole-document budget. Proving that budget is gone needs
 * documents MUCH larger than that — a thousand pages and more — and committing
 * those as fixtures would put megabytes of PDF into the repository for no
 * gain over generating them.
 *
 * So this writes a real, minimal PDF: one Helvetica font (a standard font, so
 * every engine reads it), one uncompressed content stream per page, and a
 * correct cross-reference table. Every page carries ITS OWN MARKER WORD —
 * `pagemark` followed by the page number in letters-and-digits that no other
 * page shares — so a test can ask for page 1 100 specifically and know a match
 * could only have come from there.
 */
export interface ManualOptions {
  /** How many pages. */
  readonly pages: number;
  /** Lines of ordinary text per page; 45 is a typical manual page. */
  readonly linesPerPage?: number;
  /** Pages to leave with no text at all — the "scanned diagram" pages. */
  readonly blankPages?: readonly number[];
}

/** The word only page `n` contains. */
export const pageMarker = (pageNumber: number): string => `pagemark${pageNumber}x`;

const escapePdf = (text: string): string => text.replace(/[\\()]/gu, (match) => `\\${match}`);

export const buildManual = (options: ManualOptions): Uint8Array => {
  const lines = options.linesPerPage ?? 45;
  const blank = new Set(options.blankPages ?? []);
  const objects: string[] = [];
  const pageObjectIds: number[] = [];

  // 1 catalog, 2 page tree, 3 font; pages from 4, each a page and its content.
  const firstPageId = 4;
  for (let page = 1; page <= options.pages; page += 1) {
    const pageId = firstPageId + (page - 1) * 2;
    const contentId = pageId + 1;
    pageObjectIds.push(pageId);

    let stream = '';
    if (!blank.has(page)) {
      const body: string[] = [`BT /F1 9 Tf 11 TL 40 800 Td (${escapePdf(`Section ${page} ${pageMarker(page)}`)}) Tj`];
      for (let line = 1; line < lines; line += 1) {
        body.push(
          `T* (${escapePdf(
            `Alarm ${page}-${line}: check the spindle drive parameter P${line} on axis ${line % 5} before restart.`,
          )}) Tj`,
        );
      }
      body.push('ET');
      stream = body.join('\n');
    }
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  }
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${options.pages} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

  const parts: string[] = ['%PDF-1.4\n'];
  const offsets: number[] = [];
  let length = Buffer.byteLength(parts[0]!, 'latin1');
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = length;
    const chunk = `${id} 0 obj\n${objects[id]}\nendobj\n`;
    parts.push(chunk);
    length += Buffer.byteLength(chunk, 'latin1');
  }
  const xrefAt = length;
  const xref = [`xref\n0 ${objects.length}\n`, '0000000000 65535 f \n'];
  for (let id = 1; id < objects.length; id += 1) {
    xref.push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  }
  parts.push(xref.join(''));
  parts.push(`trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  return new Uint8Array(Buffer.from(parts.join(''), 'latin1'));
};
