import { seedJobs } from '@/db/seed/jobs';

/**
 * WHICH STORED DOCUMENTS ARE REALLY THERE, AND WHICH ROWS LIE ABOUT THEM.
 * BACKUP-1.
 *
 * The rules behind `npm run documents:reconcile`, kept pure so every one of
 * them can be tested without a database, a filesystem or a deployment.
 *
 * WHAT THIS WAS WRITTEN FOR. On the live server, `final_documents` held 14 rows
 * whose `size_bytes` was 0 and whose checksum was null, `/var/lib/eje/storage`
 * held 8 documents, and the backup's restore test reported 25 rows pointing at
 * files that are not there. Those three numbers do not contradict each other —
 * but nothing in the system could say which rows were which, and that is the
 * whole problem: an operator cannot tell a seeded demonstration job card that
 * was never rendered from a customer-signed document that has been LOST.
 *
 * SO THE FIRST JOB IS CLASSIFICATION, AND IT IS DONE FROM EVIDENCE. The
 * repository ships a demonstration dataset whose job numbers are known
 * (`seedJobs`), whose job cards are deliberately rendered on first download
 * rather than at issue, and whose customers are fictional. A missing document
 * for one of those is expected and harmless. A missing document for ANY OTHER
 * job is a lost record, and the only honest answers are a restore from a backup
 * or an explicit decision by EJE — never a freshly rendered replacement, which
 * would be a new document wearing an old one's date.
 *
 * AND THE SECOND IS THAT NOTHING HERE MANUFACTURES ANYTHING. A row whose bytes
 * exist can have its length and checksum filled in, because the bytes are the
 * evidence. A row whose bytes do not exist is reported and left alone.
 */

/** What the database row says about a document. */
export interface DocumentRow {
  readonly jobNumber: string;
  /**
   * What the row itself says it is. October mandate §1.3.
   *
   * ASKED FIRST, and the reason matters: this tool used to classify a missing
   * document by looking the job number up in the shipped demonstration
   * dataset, which is sound as a fallback and wrong as a primary test —
   * "infer authenticity from a name" is exactly what §1.3 forbids. The column
   * is written by whoever wrote the row, so it is evidence rather than
   * inference.
   *
   * `null` for a row written before the column existed, and those still fall
   * back to the dataset.
   */
  readonly provenance?: 'genuine' | 'simulated' | null;
  readonly storageKey: string;
  readonly fileName: string;
  /** As stored; 0 is the column default and means "nobody measured it". */
  readonly sizeBytes: number;
  readonly checksumSha256: string | null;
  /** As stored; 0 means "nobody recorded one". */
  readonly rendererVersion: number;
}

/** What the store says about the same key. */
export interface StorageFact {
  /** False when there are no bytes under this key at all. */
  readonly present: boolean;
  readonly sizeBytes?: number;
  readonly sha256?: string;
  readonly renderer?: number;
  /**
   * Set when the store REFUSED the bytes — they are there and they are not the
   * bytes that were written. A damaged file, not a missing one.
   */
  readonly damaged?: string;
}

export type DocumentVerdict =
  /** Bytes present; the row already describes them correctly. */
  | 'intact'
  /**
   * Bytes present; the row records nothing about them.
   *
   * NOT "repairable", which is what this verdict was called first. The row
   * cannot be repaired: `final_documents` is write-once and the database
   * refuses UPDATE on it, which is one of the protections CR-01 rests on. What
   * can be done is to RECORD what the bytes are, beside the document — see
   * `final_document_verifications`.
   */
  | 'unrecorded'
  /** Bytes present and the row describes DIFFERENT bytes. Never resolved silently. */
  | 'contradicted'
  /** The store refused the bytes: they are damaged. Restore them. */
  | 'damaged'
  /** No bytes, and this job is in the shipped demonstration dataset. */
  | 'absent_demonstration'
  /** No bytes, and this job is not. A lost customer record. */
  | 'absent_genuine';

export interface DocumentFinding {
  readonly jobNumber: string;
  readonly storageKey: string;
  readonly verdict: DocumentVerdict;
  /** One sentence an operator can act on. Never contains a credential. */
  readonly detail: string;
  /** What the file measures, taken when it was measured. Only for `unrecorded`. */
  readonly measurement?: {
    readonly sizeBytes: number;
    readonly checksumSha256: string;
    readonly rendererVersion: number;
  };
}

/**
 * The job numbers the shipped demonstration dataset creates.
 *
 * Read from the dataset itself rather than written out here, so a job added to
 * or removed from the demonstration cannot quietly change what this tool calls
 * a lost customer record. That direction matters: a job number wrongly listed
 * here would have a missing signed document dismissed as demonstration data.
 */
export const demonstrationJobNumbers = (): ReadonlySet<string> =>
  new Set(seedJobs.map((job) => job.jobNumber));

/** True when nothing has ever measured the bytes this row points at. */
const unmeasured = (row: DocumentRow): boolean =>
  row.sizeBytes === 0 && (row.checksumSha256 === null || row.checksumSha256.length === 0);

export const classifyDocument = (
  row: DocumentRow,
  fact: StorageFact,
  demonstration: ReadonlySet<string> = demonstrationJobNumbers(),
): DocumentFinding => {
  const base = { jobNumber: row.jobNumber, storageKey: row.storageKey };

  if (fact.damaged !== undefined) {
    return {
      ...base,
      verdict: 'damaged',
      detail:
        `The stored file is damaged: ${fact.damaged} Restore this document from a backup; ` +
        'do not re-render it, because a re-render is a new document carrying an old date.',
    };
  }

  if (!fact.present) {
    /*
     * THE ONE DISTINCTION THE WHOLE TOOL EXISTS FOR, and it is drawn before
     * anything else about the row is considered: a demonstration job card that
     * was never rendered is housekeeping, and a missing signed job card is an
     * incident.
     *
     * THE ROW'S OWN WORD COMES FIRST. The dataset lookup below is the fallback
     * for rows written before `provenance` existed — classifying by job number
     * alone is inference from a name, which §1.3 forbids as a primary test.
     */
    const simulated =
      row.provenance === 'simulated' ||
      (row.provenance !== 'genuine' && demonstration.has(row.jobNumber));
    return simulated
      ? {
          ...base,
          verdict: 'absent_demonstration',
          detail:
            `${row.jobNumber} is demonstration data — ` +
            (row.provenance === 'simulated'
              ? 'the row says so'
              : 'the job is in the shipped demonstration dataset') +
            '. Its job card is rendered on first download rather than at issue, so nothing is ' +
            'lost and opening it will write the file.',
        }
      : {
          ...base,
          verdict: 'absent_genuine',
          detail:
            `${row.jobNumber} is a GENUINE issued document — ` +
            (row.provenance === 'genuine'
              ? 'the row says so'
              : 'nothing marks it as demonstration data and the job is not in the shipped ' +
                'dataset') +
            ' — and its bytes are gone. Recover it from a backup. It must not be re-rendered: ' +
            'the customer holds a signed copy and a fresh render would not be it.',
        };
  }

  const storedSize = fact.sizeBytes ?? 0;
  const storedHash = fact.sha256 ?? '';

  if (unmeasured(row)) {
    return {
      ...base,
      verdict: 'unrecorded',
      detail:
        `The file is there (${storedSize} bytes) and the row records neither its length nor its ` +
        'checksum. The row cannot be changed — it is write-once — so the measurement is ' +
        'recorded beside it instead.',
      measurement: {
        sizeBytes: storedSize,
        checksumSha256: storedHash,
        // Only what the store actually recorded; an unknown renderer stays 0.
        rendererVersion: fact.renderer ?? row.rendererVersion,
      },
    };
  }

  const sizeDisagrees = row.sizeBytes !== 0 && row.sizeBytes !== storedSize;
  const hashDisagrees =
    row.checksumSha256 !== null &&
    row.checksumSha256.length > 0 &&
    storedHash.length > 0 &&
    row.checksumSha256 !== storedHash;

  if (sizeDisagrees || hashDisagrees) {
    return {
      ...base,
      verdict: 'contradicted',
      detail:
        'The row and the file disagree: the row says ' +
        `${row.sizeBytes} bytes${row.checksumSha256 === null ? '' : ' with a checksum'} and the ` +
        `file is ${storedSize} bytes. One of them is wrong and this tool will not choose — ` +
        'compare against a backup before changing either.',
    };
  }

  return {
    ...base,
    verdict: 'intact',
    detail: `${storedSize} bytes, checksum recorded and matching.`,
  };
};

/** Verdicts that mean somebody has to do something about a real record. */
export const SERIOUS: readonly DocumentVerdict[] = ['absent_genuine', 'contradicted', 'damaged'];

export const isSerious = (finding: DocumentFinding): boolean => SERIOUS.includes(finding.verdict);

/**
 * Whether a reconcile run should FAIL.
 *
 * A demonstration job card that has not been downloaded yet is not a failure
 * and must not be, or the check becomes noise on every development machine and
 * stops being read. A lost signed document always is.
 */
export const reconcileFailed = (findings: readonly DocumentFinding[]): boolean =>
  findings.some(isSerious);

export interface ReconcileSummary {
  readonly intact: number;
  readonly unrecorded: number;
  readonly contradicted: number;
  readonly damaged: number;
  readonly absentDemonstration: number;
  readonly absentGenuine: number;
}

export const summarise = (findings: readonly DocumentFinding[]): ReconcileSummary => ({
  intact: findings.filter((f) => f.verdict === 'intact').length,
  unrecorded: findings.filter((f) => f.verdict === 'unrecorded').length,
  contradicted: findings.filter((f) => f.verdict === 'contradicted').length,
  damaged: findings.filter((f) => f.verdict === 'damaged').length,
  absentDemonstration: findings.filter((f) => f.verdict === 'absent_demonstration').length,
  absentGenuine: findings.filter((f) => f.verdict === 'absent_genuine').length,
});

/**
 * The sentence a person reads first.
 *
 * Written so the serious numbers cannot be missed in a terminal full of output,
 * and so a run with nothing wrong says so in one line rather than in silence —
 * a tool that prints nothing when all is well is indistinguishable from one
 * that did not run.
 */
export const summaryLine = (summary: ReconcileSummary): string => {
  const serious =
    summary.absentGenuine + summary.contradicted + summary.damaged === 0
      ? 'no lost, damaged or contradicted documents'
      : `${summary.absentGenuine} LOST, ${summary.damaged} DAMAGED, ` +
        `${summary.contradicted} CONTRADICTED`;
  return (
    `${summary.intact} intact, ${summary.unrecorded} unrecorded, ` +
    `${summary.absentDemonstration} demonstration job card(s) not yet rendered — ${serious}.`
  );
};
