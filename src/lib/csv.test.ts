import { describe, expect, it } from 'vitest';
import { CSV_BOM, csvField, csvFileName, toCsv } from './csv';

/**
 * THE FILE FORMAT ITSELF. MASTER SCOPE SEARCH-4.
 *
 * Every one of these is a case the office would actually hit: a fault
 * description typed with a comma and a line break in it, a customer name with
 * an umlaut, and — the one that matters most — a field somebody filled in
 * with something a spreadsheet would run.
 */
describe('a CSV field', () => {
  it('is left alone when there is nothing to escape', () => {
    expect(csvField('EJE-1048')).toBe('EJE-1048');
  });

  it('is quoted when it holds a comma', () => {
    expect(csvField('Hoërskool, Centurion')).toBe('"Hoërskool, Centurion"');
  });

  it('doubles a quote inside a quoted field', () => {
    expect(csvField('the "spindle" drive')).toBe('"the ""spindle"" drive"');
  });

  it('keeps an embedded newline, quoted, rather than losing the rest of the line', () => {
    expect(csvField('Replaced the fan.\r\nRan it under load.')).toBe(
      '"Replaced the fan.\r\nRan it under load."',
    );
  });

  it('quotes leading and trailing whitespace, which a reader would otherwise eat', () => {
    expect(csvField('  PO-78500')).toBe('"  PO-78500"');
  });
});

describe('a field a spreadsheet would treat as a formula', () => {
  /*
   * WHY THIS IS A SECURITY TEST AND NOT A FORMATTING ONE. The value comes from
   * a field a person types — an order number, a fault description. A cell
   * beginning `=` is executed when the file is opened, so an exported CSV is a
   * way to put a formula on a colleague's screen.
   */
  it('is neutralised with an apostrophe, and the value itself is kept', () => {
    expect(csvField('=HYPERLINK("https://example.test","click")')).toBe(
      '"\'=HYPERLINK(""https://example.test"",""click"")"',
    );
  });

  it.each(['=1+1', '+1', '@SUM(A1)', '-1+1', '\tTAB'])('is neutralised: %s', (value) => {
    expect(csvField(value).replace(/^"/, '').startsWith("'")).toBe(true);
  });

  it('leaves a plain negative number alone, so a column of figures stays numeric', () => {
    expect(csvField('-150.00')).toBe('-150.00');
    expect(csvField('-150')).toBe('-150');
  });
});

interface Row {
  readonly name: string;
  readonly note: string;
}

const COLUMNS = [
  { header: 'Name', value: (row: Row) => row.name },
  { header: 'Note', value: (row: Row) => row.note },
];

describe('the whole file', () => {
  it('starts with a BOM, so Excel reads it as UTF-8', () => {
    expect(toCsv(COLUMNS, []).startsWith(CSV_BOM)).toBe(true);
  });

  it('carries the header row even when nothing matched', () => {
    expect(toCsv(COLUMNS, [])).toBe(`${CSV_BOM}Name,Note\r\n`);
  });

  it('writes one CRLF-terminated line per row, in the order given', () => {
    const csv = toCsv(COLUMNS, [
      { name: 'Müller & Seuns', note: 'first' },
      { name: 'Highveld', note: 'second' },
    ]);
    expect(csv).toBe(`${CSV_BOM}Name,Note\r\nMüller & Seuns,first\r\nHighveld,second\r\n`);
  });

  it('keeps the columns stable: the header is the definition, not the data', () => {
    // A row with an empty value must not shift the columns of the row after it.
    const csv = toCsv(COLUMNS, [
      { name: '', note: '' },
      { name: 'Highveld', note: 'second' },
    ]);
    expect(csv.split('\r\n')[1]).toBe(',');
    expect(csv.split('\r\n')[2]).toBe('Highveld,second');
  });

  it('survives a large result without losing a row', () => {
    const rows = Array.from({ length: 5000 }, (_unused, index) => ({
      name: `Customer ${index}`,
      note: 'x',
    }));
    const lines = toCsv(COLUMNS, rows).trimEnd().split('\r\n');
    expect(lines).toHaveLength(5001);
    expect(lines[5000]).toBe('Customer 4999,x');
  });
});

describe('the file name', () => {
  it('carries the date, so the office can find it again', () => {
    expect(csvFileName('eje-closed-jobs', '2026-10-18')).toBe('eje-closed-jobs-2026-10-18.csv');
  });

  it('replaces anything a filesystem would object to rather than dropping it', () => {
    expect(csvFileName('eje/closed jobs', '2026-10-18')).toBe('eje-closed-jobs-2026-10-18.csv');
  });
});
