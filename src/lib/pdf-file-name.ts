/**
 * A NAME A PERSON GIVES A PDF. PAYROLL-ONE-1 (the owner, 5 November 2026):
 * "Rename" on My Monthly Forms stores the name of a working PDF, and every
 * download, save and listing of it uses that name until the forms are
 * submitted — the submitted documents keep the name they went with.
 *
 * It is METADATA, never a path: the server stores files under keys it makes
 * itself, so a name can never reach a directory. It is still held to the rules
 * a file name needs on every device it is saved to, and the same rules run in
 * the browser (said beside the field) and on the server (which decides):
 *
 *  - letters and digits of any language, spaces, and - _ . , ( ) & ' only —
 *    no / \ : * ? " < > |, no control or invisible formatting characters (a
 *    right-to-left override could make "fdp.exe" look like "exe.pdf");
 *  - ".pdf" at the end, added when it is left off; no other extension;
 *  - not starting with a dot, no "..", not ending in a dot or space;
 *  - not a name Windows keeps for itself (CON, PRN, AUX, NUL, COM1…, LPT1…);
 *  - 1 to 116 characters before ".pdf" — 120 in all.
 *
 * Spaces are tidied (trimmed, runs made one) and the text is normalised
 * (NFC), so the same name typed on two keyboards is the same name.
 */

export const PDF_FILE_NAME_MAX = 120;
const EXTENSION = '.pdf';
const ALLOWED = /^[\p{L}\p{M}\p{N} \-_.,()&']+$/u;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/iu;
const OTHER_EXTENSION = /\.([a-z][a-z0-9]{0,4})$/iu;

export type PdfFileNameResult = { readonly ok: true; readonly name: string } | { readonly ok: false; readonly problem: string };

/** The name as it will be stored, or why it cannot be. Pure. */
export const normalisePdfFileName = (raw: string): PdfFileNameResult => {
  const tidy = raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (tidy.length === 0) return { ok: false, problem: 'Enter a file name.' };
  const hasPdf = tidy.toLowerCase().endsWith(EXTENSION);
  const base = (hasPdf ? tidy.slice(0, -EXTENSION.length) : tidy).trimEnd();
  if (base.length === 0) return { ok: false, problem: 'Enter a name before .pdf.' };
  const unsafe = [...base].find((character) => !ALLOWED.test(character));
  if (unsafe !== undefined) {
    const shown = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(unsafe) ? 'an invisible character' : `“${unsafe}”`;
    return { ok: false, problem: `A file name cannot contain ${shown}. Use letters, digits, spaces and - _ . , ( ) & ' only.` };
  }
  if (base.startsWith('.')) return { ok: false, problem: 'A file name cannot start with a dot.' };
  if (base.includes('..')) return { ok: false, problem: 'A file name cannot contain two dots in a row.' };
  if (base.endsWith('.')) return { ok: false, problem: 'A file name cannot end in a dot before .pdf.' };
  if (!hasPdf) {
    const other = OTHER_EXTENSION.exec(base);
    if (other !== null) return { ok: false, problem: `This is a PDF: its name ends in .pdf, not .${other[1]}.` };
  }
  if (RESERVED.test(base)) return { ok: false, problem: `“${base}” is a name devices keep for themselves. Choose another.` };
  const name = `${base}${EXTENSION}`;
  if ([...name].length > PDF_FILE_NAME_MAX) {
    return { ok: false, problem: `Keep the name to ${PDF_FILE_NAME_MAX} characters, .pdf included (this one has ${[...name].length}).` };
  }
  return { ok: true, name };
};

/** Two names that would be taken for the same file on a device that ignores case. */
export const sameFileName = (a: string, b: string): boolean =>
  a.normalize('NFC').toLocaleLowerCase('en-ZA') === b.normalize('NFC').toLocaleLowerCase('en-ZA');
