/**
 * WHETHER A DOCUMENT IS A REAL EJE RECORD OR A DEMONSTRATION ONE.
 *
 * THE PROBLEM THIS SOLVES, in the owner's words: a demonstration document must
 * never be mistakable for a genuine one. The demonstration deployment carries
 * nine library documents, three machine photographs and six issued job cards
 * that EJE never produced — and until this existed the application presented
 * every one of them exactly as it presents a real document, down to a file size
 * the seed made up for bytes that do not exist ("18.4 MB, 214 pages" for a
 * manual nobody has ever uploaded).
 *
 * TWO FACTS, KEPT APART, because they are independent and both matter:
 *
 *   PROVENANCE   is this record EJE's, or demonstration data? It is recorded on
 *                the row, by whoever wrote the row, and is never guessed from a
 *                name, a file name or a customer. A file called `demo.pdf` may
 *                be a real document somebody named badly; a manual called
 *                `Leadwell V-40 Rev 4` may be a fixture.
 *
 *   STORED BYTES does a file actually exist behind this record? A demonstration
 *                record is usually metadata ALONE — there is nothing to
 *                download — and a genuine record whose bytes are missing is an
 *                incident. Same answer on screen ("no file"), completely
 *                different meaning, which is why provenance is not inferred
 *                from it either.
 *
 * NOTHING HERE DOWNGRADES A REAL DOCUMENT. `genuine` is written by every
 * application path that stores a file; `simulated` is written only by the
 * seed, and the one way a record becomes simulated after the fact is somebody
 * editing the database by hand.
 *
 * AND THERE IS A THIRD ANSWER, WHICH IS THE HONEST ONE FOR OLD ROWS.
 *
 * `provenance` arrived in migration 0015. Rows written before it took the
 * column's default and were therefore never *recorded* as anything — the
 * default was a guess that happened to be right most of the time, and a guess
 * presented as a measurement is the exact failure §1.3 of the October mandate
 * exists to stop. `unknown` says so out loud: this record's origin was not
 * recorded, and nobody has established it since.
 *
 * WHY `unknown` IS NOT TREATED AS `simulated`. Printing SIMULATED on a real
 * customer's job card is not the safe direction — it is a different false
 * statement, and a worse one, because it invites somebody to discard a genuine
 * record. `unknown` is shown as what it is, on screen and in the reconcile,
 * and the customer-facing PDF is not defaced by it. Only a record RECORDED as
 * simulated is stamped.
 *
 * WHY AN UNRECOGNISED VALUE READS AS `unknown`. A value this build does not
 * understand is, precisely, a provenance nobody here can vouch for. Reading it
 * as `genuine` would launder it; reading it as `simulated` would libel it.
 */
export type Provenance = 'genuine' | 'simulated' | 'unknown';

export const PROVENANCE: readonly Provenance[] = ['genuine', 'simulated', 'unknown'];

export const isSimulated = (provenance: Provenance): boolean => provenance === 'simulated';

/** Nobody recorded where this record came from. Not a claim either way. */
export const isProvenanceUnrecorded = (provenance: Provenance): boolean =>
  provenance === 'unknown';

/**
 * Reads a stored value into the domain, erring towards saying nothing.
 *
 * THE ONE PLACE this parse happens, because it was six places that each said
 * `row.provenance === 'genuine' ? 'genuine' : 'simulated'` — which turned every
 * unreadable value into an accusation.
 */
export const asProvenance = (value: string | null | undefined): Provenance => {
  if (value === 'genuine') return 'genuine';
  if (value === 'simulated') return 'simulated';
  return 'unknown';
};

/**
 * The full sentence, for a detail screen, a document's own metadata and every
 * page of a demonstration PDF.
 *
 * Deliberately long and deliberately ugly. It is not a tasteful footnote: it is
 * the line that stops somebody filing a demonstration certificate as evidence,
 * and it has to survive being read on a tablet in a workshop.
 */
export const SIMULATED_NOTICE =
  'SIMULATED — DEMONSTRATION DATA — NOT A GENUINE EJE DOCUMENT';

/**
 * The same sentence for a PDF, in characters the renderer's fonts actually
 * carry.
 *
 * The screen's version uses em dashes. `src/lib/pdf/writer.ts` ships the
 * standard 14 fonts with WinAnsi encoding, and an em dash came out as a gap —
 * so the one line on a demonstration document that MUST be readable was
 * rendering as "SIMULATED  DEMONSTRATION DATA  NOT A GENUINE EJE DOCUMENT",
 * which reads like a glitch rather than a statement. Hyphens, deliberately,
 * and the test asserts this constant rather than the screen's.
 */
export const SIMULATED_NOTICE_PRINT =
  'SIMULATED - DEMONSTRATION DATA - NOT A GENUINE EJE DOCUMENT';

/** The compact form, for a list row, a chip or a search result. */
export const SIMULATED_BADGE = 'SIMULATED';

/**
 * Why a demonstration record has nothing to download.
 *
 * Said in full rather than as "unavailable", because "unavailable" reads as a
 * fault — somebody would go looking for the file, or ask the office to re-upload
 * it. Nothing is wrong: the record is a fixture and there was never a file.
 */
export const METADATA_ONLY_NOTICE =
  'This is demonstration metadata. No document was ever uploaded for it, so there is nothing ' +
  'to open or download — and nothing has been generated to stand in for one.';

/**
 * What a GENUINE record with no bytes means, which is the opposite.
 *
 * Kept beside the sentence above so the two can never be confused in a
 * component: this one is an incident and says so.
 */
export const MISSING_FILE_NOTICE =
  'The file this record points at is not in storage. This is a genuine EJE record, so the file ' +
  'should be restored from a backup — it has not been regenerated or replaced.';

/**
 * What a record whose origin was never recorded says, on screen and nowhere
 * else.
 *
 * Deliberately not alarming and deliberately not reassuring. It is a statement
 * about the RECORD-KEEPING, not about the document: the file may be perfectly
 * genuine, and this build cannot say so, so it does not.
 */
export const UNRECORDED_PROVENANCE_NOTICE =
  'The origin of this record was not recorded. It predates the provenance column, so the ' +
  'application cannot say whether it is a genuine EJE record or demonstration data — and it ' +
  'has not guessed.';

/** The compact form, for a list row or a chip. */
export const UNRECORDED_PROVENANCE_BADGE = 'ORIGIN NOT RECORDED';
