/**
 * CSV, written once, for every export in the system. MASTER SCOPE SEARCH-4.
 *
 * WHAT A SPREADSHEET EXPORT HAS TO SURVIVE. The office opens these in Excel on
 * Windows and in LibreOffice, and the data in them is typed by people: a fault
 * description with a comma and a line break in it, a customer called
 * "Müller & Seuns (Pty) Ltd", an order number somebody prefixed with an equals
 * sign. Every one of those breaks a naive `values.join(',')`, and the last one
 * is not merely a formatting problem — see the injection note below.
 *
 * So the rules are stated here, in one place, and every export goes through
 * this function rather than building a line of its own:
 *
 * QUOTING — RFC 4180. A field is quoted when it contains a comma, a double
 * quote, a carriage return, a line feed, or leading or trailing whitespace
 * that would otherwise be eaten; a quote inside a quoted field is doubled.
 * Fields are joined with commas and rows ended with CRLF, which is what the
 * specification says and what Excel expects.
 *
 * ENCODING — UTF-8 with a BOM. The bytes are UTF-8 either way; the BOM is
 * what makes Excel on Windows read them as UTF-8 instead of the system's
 * legacy code page, which is the difference between "Müller" and "MÃ¼ller".
 * Everything else reads a BOM-prefixed file correctly.
 *
 * FORMULA INJECTION — a cell is not allowed to become code. A spreadsheet
 * treats a cell beginning with `=`, `+`, `-`, `@`, a tab or a carriage return
 * as a formula, so a customer who writes `=HYPERLINK("https://…", "click")`
 * into a field EJE later exports has written a formula into the office's
 * spreadsheet — and with `=WEBSERVICE(…)` or a DDE call, something worse than
 * a hyperlink. Such a cell is prefixed with an apostrophe, which is the
 * spreadsheet's own "treat this as text" mark.
 *
 * A PLAIN NUMBER IS LEFT ALONE, deliberately: `-150.00` begins with a minus
 * and is not a formula, and prefixing it would turn every negative figure and
 * every column of amounts into text nobody can sum. The test for "plain" is
 * strict — an optional sign, digits, one optional decimal part, nothing else —
 * so `-1+1` is escaped and `-150.00` is not.
 *
 * NO LIBRARY, AND NO XLSX. There is no spreadsheet dependency in this project
 * and this does not add one: CSV is a format that can be written correctly in
 * forty lines, and a real `.xlsx` writer is a zip container and a schema that
 * cannot be. If EJE want native Excel files, that is a dependency decision for
 * the owner, not something to smuggle in behind an export button.
 */

/** One column: the header as it is written, and how to read a row's cell. */
export interface CsvColumn<TRow> {
  readonly header: string;
  readonly value: (row: TRow) => string;
}

const NEEDS_QUOTING = /[",\r\n]|^\s|\s$/;

/** What a spreadsheet would read as the start of a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** A number, and nothing that could also be an expression. */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * One field, escaped for a spreadsheet and then quoted for the file.
 *
 * The order matters: the apostrophe goes on first, because it is part of the
 * VALUE the spreadsheet must see, and the quoting is the file format around it.
 */
export const csvField = (raw: string): string => {
  const neutralised =
    FORMULA_START.test(raw) && !PLAIN_NUMBER.test(raw) ? `'${raw}` : raw;
  if (!NEEDS_QUOTING.test(neutralised)) return neutralised;
  return `"${neutralised.replaceAll('"', '""')}"`;
};

/** The BOM, as its own export so a test can assert the bytes rather than guess. */
export const CSV_BOM = '﻿';

/**
 * The whole file: the header row, then one row per record.
 *
 * The header is written from the column definitions, so a file with no rows in
 * it is still a valid CSV with the columns the screen has — an empty export
 * that opens and says "no rows" is useful, and a zero-byte file is not.
 */
export const toCsv = <TRow>(
  columns: readonly CsvColumn<TRow>[],
  rows: readonly TRow[],
): string => {
  const lines = [columns.map((column) => csvField(column.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => csvField(column.value(row))).join(','));
  }
  // A trailing CRLF: every line is terminated, which is what tools that read
  // the file line by line expect.
  return `${CSV_BOM}${lines.join('\r\n')}\r\n`;
};

/**
 * A file name an operating system will accept and a person can recognise.
 *
 * Dated, because the office keeps these: "closed-jobs-2026-10-18.csv" sorts
 * and can be found again, where "export.csv" is the file everybody has four
 * copies of. Anything that is not a letter, a digit, a dash or a dot is
 * replaced rather than removed, so two different names cannot collapse into
 * one.
 */
export const csvFileName = (stem: string, isoDate: string): string =>
  `${stem.replace(/[^A-Za-z0-9-]+/g, '-')}-${isoDate}.csv`;
