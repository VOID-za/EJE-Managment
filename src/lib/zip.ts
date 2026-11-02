/**
 * A ZIP ARCHIVE, WRITTEN BY HAND. JOB-ATT-2 (2 November 2026).
 *
 * "Download Attachments" hands the office every document on a job as one ZIP.
 * The project carries no ZIP library, and one is not needed for this: the
 * entries are STORED (method 0), not compressed — a job's documents are PDFs,
 * photographs and archives that are already compressed, so deflating them
 * again would cost time and save nothing — and the format for stored entries
 * is a few fixed headers around the original bytes, which come out of the
 * archive exactly as they were uploaded.
 *
 * Names are UTF-8 (general-purpose bit 11), so a document called "Bestelling
 * — Ölpumpe.pdf" keeps its name. Two documents with the same name are kept
 * apart ("Order.pdf", "Order (2).pdf") by `uniqueEntryNames`, never one
 * overwriting the other. ZIP64 is not written: a job's documents are at most
 * 25 MB each, so an archive never approaches the 4 GB the classic format holds,
 * and `createZip` refuses rather than writes a broken one if it ever did.
 */
export interface ZipEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
  /** When the file was last changed; stored in the archive's DOS date field. */
  readonly modifiedAt?: Date;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The CRC-32 every ZIP entry carries (IEEE 802.3, as zlib computes it). */
export const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

/** A name safe as an archive entry: no folders, no control characters, never empty. */
const entryBaseName = (raw: string): string => {
  const base = (raw.split(/[/\\]/u).pop() ?? '').replace(/[\u0000-\u001f\u007f]/gu, '').trim();
  return base.length === 0 ? 'document' : base;
};

/**
 * Every name made unique, case-insensitively (Windows' rule), by numbering the
 * later copies before their extension: "Order.pdf", "Order (2).pdf", "Order (3).pdf".
 */
export const uniqueEntryNames = (names: readonly string[]): readonly string[] => {
  const taken = new Set<string>();
  return names.map((raw) => {
    const name = entryBaseName(raw);
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : '';
    let candidate = name;
    for (let copy = 2; taken.has(candidate.toLowerCase()); copy += 1) candidate = `${stem} (${copy})${extension}`;
    taken.add(candidate.toLowerCase());
    return candidate;
  });
};

const dosDateTime = (at: Date): { readonly time: number; readonly date: number } => {
  const year = Math.min(Math.max(at.getUTCFullYear(), 1980), 2107);
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
};

const ZIP32_LIMIT = 0xffffffff;

/** The archive's bytes. Entry names should already be unique (`uniqueEntryNames`). */
export const createZip = (entries: readonly ZipEntry[]): Uint8Array => {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const size = entry.bytes.length;
    const crc = crc32(entry.bytes);
    const { time, date } = dosDateTime(entry.modifiedAt ?? new Date(Date.UTC(1980, 0, 1)));
    if (offset + 30 + name.length + size > ZIP32_LIMIT) throw new Error('The documents are too large for one archive.');

    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true); // local file header
    l.setUint16(4, 20, true); // version needed: 2.0
    l.setUint16(6, 0x0800, true); // UTF-8 names
    l.setUint16(8, 0, true); // stored
    l.setUint16(10, time, true);
    l.setUint16(12, date, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, size, true);
    l.setUint32(22, size, true);
    l.setUint16(26, name.length, true);
    l.setUint16(28, 0, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true); // central directory header
    c.setUint16(4, 20, true); // made by: 2.0
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, time, true);
    c.setUint16(14, date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, size, true);
    c.setUint32(24, size, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true); // where its local header is
    central.set(name, 46);

    locals.push(local, entry.bytes);
    centrals.push(central);
    offset += local.length + size;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); // end of central directory
  e.setUint16(8, entries.length, true);
  e.setUint16(10, entries.length, true);
  e.setUint32(12, centralSize, true);
  e.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/**
 * Reads back a STORED archive's entries — for the tests and the checks, which
 * prove the download holds the original bytes under the expected names.
 */
export const readStoredZip = (archive: Uint8Array): readonly { readonly name: string; readonly bytes: Uint8Array; readonly crc: number }[] => {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let endAt = -1;
  for (let i = archive.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      endAt = i;
      break;
    }
  }
  if (endAt < 0) throw new Error('Not a ZIP archive.');
  const count = view.getUint16(endAt + 10, true);
  let at = view.getUint32(endAt + 16, true);
  const decoder = new TextDecoder();
  const found: { name: string; bytes: Uint8Array; crc: number }[] = [];
  for (let n = 0; n < count; n += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('A broken central directory.');
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = decoder.decode(archive.subarray(at + 46, at + 46 + nameLength));
    const localName = view.getUint16(localAt + 26, true);
    const localExtra = view.getUint16(localAt + 28, true);
    const dataAt = localAt + 30 + localName + localExtra;
    found.push({ name, bytes: archive.slice(dataAt, dataAt + size), crc });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return found;
};
