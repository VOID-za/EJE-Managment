import { describe, expect, it } from 'vitest';
import {
  classifyDocument,
  demonstrationJobNumbers,
  reconcileFailed,
  summarise,
  summaryLine,
  type DocumentRow,
  type StorageFact,
} from './document-rules';

/**
 * THE RULES THAT TELL HOUSEKEEPING FROM AN INCIDENT. BACKUP-1.
 *
 * Every case below is one the live server actually presented: rows with
 * `size_bytes = 0`, files that are there and files that are not, and the one
 * distinction that matters — whether the job behind a missing document is part
 * of the shipped demonstration dataset or a real customer's signed record.
 */
const row = (over: Partial<DocumentRow> = {}): DocumentRow => ({
  jobNumber: 'EJE-3001',
  storageKey: 'jobcards/final/EJE-3001.pdf',
  fileName: 'EJE-3001-Final-Job-Card.pdf',
  sizeBytes: 0,
  checksumSha256: null,
  rendererVersion: 0,
  ...over,
});

const stored = (over: Partial<StorageFact> = {}): StorageFact => ({
  present: true,
  sizeBytes: 48_120,
  sha256: 'a'.repeat(64),
  renderer: 3,
  ...over,
});

const DEMO = new Set(['EJE-2015', 'EJE-2016']);

describe('classifying a document the register points at', () => {
  it('calls a row with no measurements but real bytes UNRECORDED, and measures the file', () => {
    // Production's 14 rows, exactly: the column default of 0 and no checksum,
    // over a file that is perfectly fine.
    const finding = classifyDocument(row(), stored(), DEMO);

    expect(finding.verdict).toBe('unrecorded');
    expect(finding.measurement).toEqual({
      sizeBytes: 48_120,
      checksumSha256: 'a'.repeat(64),
      rendererVersion: 3,
    });
  });

  it('calls a row that already agrees with its file INTACT', () => {
    const finding = classifyDocument(
      row({ sizeBytes: 48_120, checksumSha256: 'a'.repeat(64), rendererVersion: 3 }),
      stored(),
      DEMO,
    );
    expect(finding.verdict).toBe('intact');
    expect(finding.measurement).toBeUndefined();
  });

  /**
   * THE DISTINCTION THE TOOL EXISTS FOR, in the two directions that matter.
   */
  it('calls a missing demonstration job card HOUSEKEEPING', () => {
    const finding = classifyDocument(
      row({ jobNumber: 'EJE-2015', storageKey: 'jobcards/final/EJE-2015.pdf' }),
      { present: false },
      DEMO,
    );

    expect(finding.verdict).toBe('absent_demonstration');
    expect(finding.detail).toMatch(/demonstration dataset/u);
    expect(reconcileFailed([finding])).toBe(false);
  });

  it('calls a missing REAL job card a lost record, and refuses to suggest re-rendering it', () => {
    const finding = classifyDocument(row({ jobNumber: 'EJE-4100' }), { present: false }, DEMO);

    expect(finding.verdict).toBe('absent_genuine');
    expect(finding.detail).toMatch(/Recover it from a backup/u);
    // The one instruction that must never appear: render a replacement.
    expect(finding.detail).toMatch(/must not be\s+re-rendered/u);
    expect(reconcileFailed([finding])).toBe(true);
  });

  it('calls bytes the store REFUSED damaged, not missing', () => {
    const finding = classifyDocument(
      row({ sizeBytes: 48_120, checksumSha256: 'a'.repeat(64) }),
      { present: true, damaged: 'the stored file is 10 bytes and its record says 48120.' },
      DEMO,
    );

    expect(finding.verdict).toBe('damaged');
    expect(reconcileFailed([finding])).toBe(true);
  });

  it('REFUSES to choose when the row and the file disagree', () => {
    // A row that claims 48 120 bytes over a file of 12: repairing this silently
    // would overwrite the only evidence that something went wrong.
    const finding = classifyDocument(
      row({ sizeBytes: 48_120, checksumSha256: 'a'.repeat(64) }),
      stored({ sizeBytes: 12, sha256: 'b'.repeat(64) }),
      DEMO,
    );

    expect(finding.verdict).toBe('contradicted');
    expect(finding.measurement).toBeUndefined();
    expect(reconcileFailed([finding])).toBe(true);
  });

  it('notices a checksum that disagrees even when the length matches', () => {
    const finding = classifyDocument(
      row({ sizeBytes: 48_120, checksumSha256: 'a'.repeat(64) }),
      stored({ sha256: 'c'.repeat(64) }),
      DEMO,
    );
    expect(finding.verdict).toBe('contradicted');
  });

  it('does not treat a demonstration job number as cover for a damaged file', () => {
    // Demonstration data excuses an ABSENT file. It excuses nothing about one
    // that is present and wrong.
    const finding = classifyDocument(
      row({ jobNumber: 'EJE-2015', sizeBytes: 100, checksumSha256: 'a'.repeat(64) }),
      stored({ sizeBytes: 90, sha256: 'd'.repeat(64) }),
      DEMO,
    );
    expect(finding.verdict).toBe('contradicted');
  });
});

describe('classifying by what the ROW says, not by its name', () => {
  /**
   * October mandate §1.3: provenance is recorded, and inferring it from a job
   * number is the fallback for rows written before the column existed — not
   * the primary test.
   */
  it('believes a row that says it is demonstration data, whatever its number', () => {
    // EJE-4100 is not in the dataset; the row says what it is.
    const finding = classifyDocument(
      row({ jobNumber: 'EJE-4100', provenance: 'simulated' }),
      { present: false },
      DEMO,
    );
    expect(finding.verdict).toBe('absent_demonstration');
    expect(finding.detail).toMatch(/the row says so/u);
    expect(reconcileFailed([finding])).toBe(false);
  });

  it('believes a row that says it is GENUINE, even one in the dataset', () => {
    // A real job card issued for a job number the demonstration also uses —
    // which is exactly the situation a name-based test gets wrong, and gets
    // wrong in the dangerous direction.
    const finding = classifyDocument(
      row({ jobNumber: 'EJE-2015', provenance: 'genuine' }),
      { present: false },
      DEMO,
    );
    expect(finding.verdict).toBe('absent_genuine');
    expect(reconcileFailed([finding])).toBe(true);
  });

  it('falls back to the dataset for a row written before the column existed', () => {
    const seeded = classifyDocument(
      row({ jobNumber: 'EJE-2015', provenance: null }),
      { present: false },
      DEMO,
    );
    expect(seeded.verdict).toBe('absent_demonstration');

    const unknown = classifyDocument(
      row({ jobNumber: 'EJE-4100', provenance: null }),
      { present: false },
      DEMO,
    );
    expect(unknown.verdict).toBe('absent_genuine');
  });
});

describe('the demonstration dataset this tool measures against', () => {
  it('is read from the shipped seed rather than written out by hand', () => {
    const numbers = demonstrationJobNumbers();

    // The six job cards the live server was missing are all in it, which is
    // what makes those six housekeeping rather than an incident.
    for (const jobNumber of ['EJE-2015', 'EJE-2016', 'EJE-2017', 'EJE-2019', 'EJE-2020', 'EJE-2021']) {
      expect(numbers.has(jobNumber), jobNumber).toBe(true);
    }
    // And a number the dataset does not contain is not quietly included.
    expect(numbers.has('EJE-9999')).toBe(false);
  });
});

describe('what the run reports', () => {
  it('fails on a lost document and not on an unrendered demonstration one', () => {
    const demonstration = classifyDocument(row({ jobNumber: 'EJE-2015' }), { present: false }, DEMO);
    const lost = classifyDocument(row({ jobNumber: 'EJE-4100' }), { present: false }, DEMO);

    expect(reconcileFailed([demonstration])).toBe(false);
    expect(reconcileFailed([demonstration, lost])).toBe(true);
  });

  it('says so in one line when nothing is wrong, rather than printing nothing', () => {
    const line = summaryLine(summarise([classifyDocument(row(), stored(), DEMO)]));
    expect(line).toMatch(/no lost, damaged or contradicted documents/u);
  });

  it('puts the serious numbers where they cannot be missed', () => {
    const findings = [
      classifyDocument(row({ jobNumber: 'EJE-4100' }), { present: false }, DEMO),
      classifyDocument(row({ jobNumber: 'EJE-2015' }), { present: false }, DEMO),
      classifyDocument(row(), stored(), DEMO),
    ];
    const summary = summarise(findings);

    expect(summary).toMatchObject({
      absentGenuine: 1,
      absentDemonstration: 1,
      unrecorded: 1,
      intact: 0,
    });
    expect(summaryLine(summary)).toMatch(/1 LOST/u);
  });
});
