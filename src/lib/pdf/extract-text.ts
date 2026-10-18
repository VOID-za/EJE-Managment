import { inflateRawSync, inflateSync } from 'node:zlib';

/**
 * Reads the text out of a PDF SOMEBODY ELSE WROTE. MASTER SCOPE LIB-5.
 *
 * WHY THIS IS NOT `inspect.ts`. That module reads back documents THIS system
 * wrote, with our own writer's uncompressed streams, our own four font
 * resources and our own page tree, and it measures geometry. A manual uploaded
 * to the technical library comes out of whatever produced it — Acrobat, a
 * machine builder's documentation tool, a scanner — and is almost always
 * compressed. Pointing the geometry inspector at one would report nothing and
 * mean nothing.
 *
 * WHAT IT DOES. The bytes are read as latin-1, which is byte-exact and makes
 * offsets in the string offsets in the file. Every `N 0 obj … endobj` is found;
 * each stream is decompressed when its dictionary says `/FlateDecode` and taken
 * as-is when it says nothing; the ones that look like page content — they carry
 * text operators — have their strings pulled out of `Tj`, `TJ`, `'` and `"`,
 * with the text-positioning operators turned into spaces and line breaks so
 * words do not run together.
 *
 * WHAT IT HONESTLY CANNOT DO, STATED HERE RATHER THAN DISCOVERED LATER:
 *
 *  - NO OCR. A scanned manual is a picture of a page and has no text in it at
 *    all. This reports `needs_ocr` and the caller records that state against
 *    the document, so the library can say "this one is not searchable yet"
 *    instead of pretending it indexed it. No OCR service is added here: that
 *    is infrastructure EJE would have to pay for and decide on.
 *  - NO CID/ToUnicode MAPPING. A PDF whose fonts are subset with a custom
 *    encoding stores glyph ids, not characters, and reading them without the
 *    font's `/ToUnicode` map yields mojibake. Rather than index gibberish —
 *    which would match nothing and look indexed — the result is checked for a
 *    plausible proportion of readable characters and reported as needing OCR
 *    when it is not readable. Better a document that says it is not searchable
 *    than one that lies about being searchable.
 *  - NO OBJECT STREAMS OR ENCRYPTION. A PDF 1.5+ file that packs its objects
 *    into `/ObjStm`, or one that is encrypted, yields little or nothing. Both
 *    are reported rather than swallowed.
 *
 * NOTHING IS SILENTLY DISCARDED. A stream that cannot be decompressed is
 * COUNTED and the count is returned, so a document that was half read says so.
 */

/** Below this many usable characters per page, a document is not text-based. */
const MIN_CHARACTERS_PER_PAGE = 24;

/** Below this proportion of readable characters, what came out is not text. */
const MIN_READABLE_RATIO = 0.6;

/** The most text one document contributes to the index. */
export const MAX_INDEXED_CHARACTERS = 400_000;

export type PdfTextOutcome =
  | {
      readonly kind: 'text';
      readonly text: string;
      readonly pages: number;
      /** Content streams read, and the ones that could not be decompressed. */
      readonly streams: number;
      readonly unreadableStreams: number;
      /** True when the text was cut at `MAX_INDEXED_CHARACTERS`. */
      readonly truncated: boolean;
    }
  | {
      readonly kind: 'needs_ocr';
      readonly reason: string;
      readonly pages: number;
      readonly unreadableStreams: number;
    }
  | { readonly kind: 'failed'; readonly reason: string };

const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1');

/** A readable character: what a person would accept as text in a manual. */
const isReadable = (code: number): boolean =>
  code === 9 ||
  code === 10 ||
  code === 13 ||
  (code >= 32 && code <= 126) ||
  // Latin-1 letters: accented names and the degree, micro and plus-minus signs
  // that machine documentation is full of.
  (code >= 160 && code <= 255);

const readableRatio = (value: string): number => {
  if (value.length === 0) return 0;
  let readable = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (isReadable(value.charCodeAt(index))) readable += 1;
  }
  return readable / value.length;
};

interface RawStream {
  readonly dictionary: string;
  readonly body: Buffer;
}

/**
 * Every stream in the file, with the dictionary that describes it.
 *
 * Found by scanning for the `stream` keyword rather than by walking the xref
 * table: a damaged or linearised xref is common in the wild, and the keyword is
 * the one thing every writer agrees on. The dictionary is whatever preceded it
 * in the same object.
 */
const streamsOf = (text: string, bytes: Uint8Array): readonly RawStream[] => {
  const found: RawStream[] = [];
  /*
   * `endstream` ENDS WITH `stream`, which is how the first version of this
   * counted every stream twice and reported a corrupt stream that was not
   * there. The keyword only starts a stream when a letter does not precede it.
   */
  const keyword = /(?<![A-Za-z])stream(?:\r\n|\n|\r)/g;

  for (let match = keyword.exec(text); match !== null; match = keyword.exec(text)) {
    const start = match.index + match[0].length;
    const end = text.indexOf('endstream', start);
    if (end === -1) continue;

    // The dictionary is the object header just before the keyword.
    const objectStart = text.lastIndexOf('obj', match.index);
    const dictionary = text.slice(objectStart === -1 ? match.index - 400 : objectStart, match.index);
    found.push({ dictionary, body: Buffer.from(bytes.subarray(start, end)) });
  }
  return found;
};

const inflated = (stream: RawStream): Buffer | null => {
  if (!/\/FlateDecode/.test(stream.dictionary)) return stream.body;
  try {
    return inflateSync(stream.body);
  } catch {
    try {
      // Some writers omit the zlib header; raw deflate is still readable.
      return inflateRawSync(stream.body);
    } catch {
      return null;
    }
  }
};

/** A PDF string literal, with the escapes the specification defines. */
const literal = (source: string, from: number): { readonly value: string; readonly next: number } => {
  let depth = 1;
  let out = '';
  let index = from;

  while (index < source.length) {
    const character = source[index] ?? '';
    if (character === '\\') {
      const escaped = source[index + 1] ?? '';
      index += 2;
      switch (escaped) {
        case 'n':
          out += '\n';
          break;
        case 'r':
          out += '\r';
          break;
        case 't':
          out += '\t';
          break;
        case 'b':
        case 'f':
          out += ' ';
          break;
        case '(':
        case ')':
        case '\\':
          out += escaped;
          break;
        case '\n':
          break;
        default:
          if (escaped >= '0' && escaped <= '7') {
            let octal = escaped;
            while (octal.length < 3) {
              const digit = source[index] ?? '';
              if (digit < '0' || digit > '7') break;
              octal += digit;
              index += 1;
            }
            out += String.fromCharCode(Number.parseInt(octal, 8));
          } else {
            out += escaped;
          }
      }
      continue;
    }

    index += 1;
    if (character === '(') {
      depth += 1;
      out += character;
      continue;
    }
    if (character === ')') {
      depth -= 1;
      if (depth === 0) return { value: out, next: index };
      out += character;
      continue;
    }
    out += character;
  }
  return { value: out, next: index };
};

/** A hex string: `<48656c6c6f>`. Two digits a character, as written. */
const hexString = (source: string, from: number): { readonly value: string; readonly next: number } => {
  const end = source.indexOf('>', from);
  const digits = (end === -1 ? source.slice(from) : source.slice(from, end)).replace(/[^0-9a-fA-F]/g, '');
  let out = '';
  for (let index = 0; index + 1 < digits.length; index += 2) {
    out += String.fromCharCode(Number.parseInt(digits.slice(index, index + 2), 16));
  }
  return { value: out, next: end === -1 ? source.length : end + 1 };
};

/**
 * The text drawn by one content stream.
 *
 * The positioning operators matter as much as the strings: `Td`, `TD`, `T*` and
 * `ET` end a line, and without them a two-column page comes back as one
 * unsearchable word. A string is only kept when a text-showing operator
 * follows it, so a stream's other string literals — a font name, a title — do
 * not become page text.
 */
const textOf = (content: string): string => {
  let out = '';
  let pending: string[] = [];

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index] ?? '';

    if (character === '(') {
      const read = literal(content, index + 1);
      pending.push(read.value);
      index = read.next - 1;
      continue;
    }
    if (character === '<' && content[index + 1] !== '<') {
      const read = hexString(content, index + 1);
      pending.push(read.value);
      index = read.next - 1;
      continue;
    }

    // The operators, read as whole words so `Tj` is not seen inside `BTj`.
    if (character === 'T' || character === "'" || character === '"' || character === 'E') {
      const word = /^(Tj|TJ|Td|TD|T\*|ET|'|")/.exec(content.slice(index));
      const operator = word?.[1];
      if (operator !== undefined) {
        if (operator === 'Tj' || operator === 'TJ' || operator === "'" || operator === '"') {
          out += pending.join('');
          pending = [];
          if (operator === "'" || operator === '"') out += '\n';
        } else {
          pending = [];
          out += operator === 'ET' || operator === 'T*' ? '\n' : ' ';
        }
        index += operator.length - 1;
      }
    }
  }
  return out;
};

const collapse = (value: string): string =>
  value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n+ */g, '\n')
    .trim();

export const extractPdfText = (bytes: Uint8Array): PdfTextOutcome => {
  if (bytes.length === 0) return { kind: 'failed', reason: 'The file is empty.' };

  const text = latin1(bytes);
  if (!text.startsWith('%PDF-')) {
    return { kind: 'failed', reason: 'The file does not begin with a PDF header.' };
  }
  if (/\/Encrypt\b/.test(text)) {
    return {
      kind: 'failed',
      reason: 'The PDF is encrypted, so its text cannot be read. Upload an unprotected copy.',
    };
  }

  // One per page object; `/Type /Pages` is the tree node and is excluded.
  const pages = Math.max(1, [...text.matchAll(/\/Type\s*\/Page[^s]/g)].length);

  const streams = streamsOf(text, bytes);
  let unreadable = 0;
  let collected = '';
  let contentStreams = 0;

  for (const stream of streams) {
    const body = inflated(stream);
    if (body === null) {
      unreadable += 1;
      continue;
    }
    const content = body.toString('latin1');
    // A content stream is one that draws text. An image or a font file is not.
    if (!/\bBT\b|\bTj\b|\bTJ\b/.test(content)) continue;
    contentStreams += 1;
    collected += `${textOf(content)}\n`;
    if (collected.length > MAX_INDEXED_CHARACTERS * 2) break;
  }

  if (/\/ObjStm\b/.test(text) && contentStreams === 0) {
    return {
      kind: 'needs_ocr',
      reason:
        'This PDF packs its objects into object streams, which this extractor does not unpack, so no text could be read.',
      pages,
      unreadableStreams: unreadable,
    };
  }

  const body = collapse(collected);
  if (body.length < MIN_CHARACTERS_PER_PAGE * pages) {
    return {
      kind: 'needs_ocr',
      reason:
        body.length === 0
          ? 'No text could be extracted: the pages are images, so the document needs OCR before it can be searched.'
          : `Only ${body.length} characters could be extracted across ${pages} page(s), which is too little to be the document's text.`,
      pages,
      unreadableStreams: unreadable,
    };
  }

  const ratio = readableRatio(body);
  if (ratio < MIN_READABLE_RATIO) {
    return {
      kind: 'needs_ocr',
      reason: `The extracted characters are not readable text (${Math.round(ratio * 100)}% readable), which means the fonts carry no usable encoding. The document needs OCR to be searchable.`,
      pages,
      unreadableStreams: unreadable,
    };
  }

  const truncated = body.length > MAX_INDEXED_CHARACTERS;
  return {
    kind: 'text',
    text: truncated ? body.slice(0, MAX_INDEXED_CHARACTERS) : body,
    pages,
    streams: contentStreams,
    unreadableStreams: unreadable,
    truncated,
  };
};
