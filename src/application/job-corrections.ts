import {
  CORRECTED_AREA_LABEL,
  acknowledgementRequiredFor,
  asCorrectedArea,
  can,
  correctionFileName,
  machineLabel,
  userFullName,
  type CorrectedArea,
  type Job,
  type JobCorrection,
} from '@/domain';
import type { OperationContext } from './context';
import { WorkflowError } from './errors';
import { audit } from './audit';
import { formatDateTime } from '@/lib/format';
import { canReadFinalDocument, FINAL_DOCUMENT_CONTENT_TYPE } from './final-document';
import { StorageIntegrityFailed, type StoredDocument } from '@/services/ports';
import { measureStored } from './stored-file';

/**
 * CORRECTING AN ISSUED JOB CARD. BD-02, IMMUT-9, AUD-3.
 *
 * WHAT WAS MISSING, and it was an acceptance blocker: a signed job card with a
 * genuine error had **no remedy at any layer**. Every edit is refused by the
 * application, every UPDATE by the database, and the office was left holding a
 * document that says the wrong thing and nothing it could do about it.
 * "Immutable" was implemented; "and here is what you do instead" was not.
 *
 * NOTHING HERE TOUCHES THE ORIGINAL. Not the job card, not the signature, not
 * the issue date, not the prices, not the bytes. A correction is a NEW record
 * with its OWN document — the shape `refuse_mutation()`'s own message asks for
 * ("correct it by adding a new record") — and the customer keeps what they were
 * sent and receives the addendum beside it.
 *
 * WHY NOT RE-RENDER THE JOB CARD. Because a re-render is a different document
 * wearing the original's date, and because the job may have been corrected in
 * the database since (it may not, but the next person to read this code should
 * not have to establish that). The addendum is drawn from the CORRECTION, and
 * the renderer is given no job at all so that it cannot do otherwise.
 *
 * WHO. Raising one is a Master's (`jobs.raiseCorrection`) — the owner's rule.
 * Recording the customer's acknowledgement is the office's, Coordinator
 * included, because that is clerical work and requiring a Master for it means
 * it does not get recorded.
 *
 * WHAT IS DELIBERATELY NOT DECIDED HERE. Nothing in this application decides
 * that a given change REQUIRES the customer's acknowledgement. That is a
 * business rule with legal weight, EJE have not stated it, and inventing one
 * would be exactly the "legally significant approval rule" the mandate says
 * not to invent. The Master states whether it is required; the system records
 * what then happened, and says so on the addendum either way.
 *
 * *Amended 27 October 2026 — EJE STATED IT (BD-27, approved by the owner):*
 * a correction that changes a price, a quantity or the described work
 * REQUIRES the customer's acknowledgement (`acknowledgementRequiredFor`), and
 * the server refuses to raise one of those as not requiring it. For every
 * other area the Master still decides, as above.
 */

const REASON_LIMIT = 2000;
const NARRATIVE_LIMIT = 8000;

const requireMaster = (context: OperationContext): void => {
  if (can(context.actor.role, 'jobs.raiseCorrection')) return;
  throw new WorkflowError('You cannot raise a correction to an issued job card.', [
    {
      code: 'not_permitted',
      message:
        'Correcting a document EJE have already issued is a Master’s decision. The office can ' +
        'record the customer’s acknowledgement of one.',
    },
  ]);
};

/** The text of a field, or a refusal naming it. */
const required = (value: string, field: string, label: string, limit: number): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new WorkflowError(`${label} is required.`, [
      {
        code: `${field}_required`,
        message:
          'A correction to a document the customer holds has to say what it is for. This is ' +
          'printed on the addendum they receive.',
      },
    ]);
  }
  if (trimmed.length > limit) {
    throw new WorkflowError(`${label} is too long.`, [
      { code: `${field}_too_long`, message: `Keep it under ${limit} characters.` },
    ]);
  }
  return trimmed;
};

export interface RaiseCorrectionInput {
  readonly reason: string;
  readonly narrative: string;
  /** Which parts of the job card are affected. At least one. */
  readonly areas: readonly string[];
  /** Whether EJE will ask the customer to confirm they have seen it. */
  readonly acknowledgementRequired: boolean;
}

/**
 * Every correction on this job, oldest first.
 *
 * Authorised exactly as the final document is: whoever may read the issued job
 * card may read what EJE have since said about it. Anything narrower would
 * leave the technician who did the work unable to see that it had been
 * corrected.
 */
export const listJobCorrections = async (
  context: OperationContext,
  job: Job,
): Promise<readonly JobCorrection[]> => {
  if (!canReadFinalDocument(job, context)) return [];
  return context.repos.jobs.listCorrections(job.id);
};

export const raiseJobCorrection = async (
  context: OperationContext,
  job: Job,
  input: RaiseCorrectionInput,
): Promise<JobCorrection> => {
  requireMaster(context);

  /*
   * THERE HAS TO BE A DOCUMENT TO CORRECT, and it has to be the issued one.
   *
   * A job card that was never issued is corrected by editing the job, which
   * the office can already do — and offering a correction there would create a
   * second, worse way to change a draft.
   */
  const original = job.finalDocument;
  if (original === null) {
    throw new WorkflowError(`${job.jobNumber} has no issued job card to correct.`, [
      {
        code: 'nothing_issued',
        message:
          'A correction is an addendum to a document the customer holds. This job has not ' +
          'issued one, so there is nothing to correct — edit the job card instead.',
      },
    ]);
  }

  const reason = required(input.reason, 'reason', 'The reason', REASON_LIMIT);
  const narrative = required(input.narrative, 'narrative', 'The correction', NARRATIVE_LIMIT);

  const areas = input.areas
    .map((area) => asCorrectedArea(area))
    .filter((area): area is CorrectedArea => area !== null);
  if (areas.length === 0) {
    throw new WorkflowError('Say which part of the job card is affected.', [
      {
        code: 'areas_required',
        message:
          'A correction names at least one part of the job card — labour, parts, the work ' +
          'performed, and so on. It is printed on the addendum.',
      },
    ]);
  }
  // Unique and in the domain's own order, so two corrections listing the same
  // areas print them identically.
  const ordered = (Object.keys(CORRECTED_AREA_LABEL) as CorrectedArea[]).filter((area) =>
    areas.includes(area),
  );

  /*
   * BD-27. Refused, not quietly turned into "required": the Master said it was
   * not needed, and silently overriding what somebody chose is how a record
   * ends up saying something its author never meant. They are told the rule
   * and choose again.
   */
  if (acknowledgementRequiredFor(ordered) && !input.acknowledgementRequired) {
    throw new WorkflowError('This correction needs the customer’s acknowledgement.', [
      {
        code: 'acknowledgement_required',
        message:
          'It changes a price, a quantity or the work described, and EJE require the customer to acknowledge those (BD-27). Raise it as requiring their acknowledgement.',
      },
    ]);
  }

  const existing = await context.repos.jobs.listCorrections(job.id);
  const sequence = existing.length + 1;
  const now = context.services.clock.now();
  const id = context.services.ids.next('job-correction');
  const fileName = correctionFileName({ sequence }, job.jobNumber);

  const [customer, machine, settings] = await Promise.all([
    context.repos.customers.findById(job.customerId),
    job.machineId === null ? Promise.resolve(null) : context.repos.machines.findById(job.machineId),
    context.repos.settings.get(),
  ]);

  const rendered = await context.services.pdf.renderCorrection(
    {
      company: {
        name: settings.companyName,
        address: settings.companyAddress,
        contactLine: `Tel ${settings.companyPhone} · ${settings.companyEmail}`,
        registrationLine: `Reg. ${settings.companyRegistration} · VAT ${settings.companyVatNumber}`,
      },
      jobNumber: job.jobNumber,
      customerName: customer?.name ?? 'Customer no longer on the register',
      machineDescription: machine === null ? '' : machineLabel(machine),
      original: {
        fileName: original.fileName,
        /*
         * FORMATTED HERE, not in the renderer. A raw ISO stamp
         * ("2026-10-21T18:23:51.722Z") on a document handed to a customer is
         * the kind of detail that makes paperwork look machine-generated and
         * unchecked — and the first draft of this printed exactly that.
         */
        issuedAt: formatDateTime(original.generatedAt),
        signed: job.signature !== null,
      },
      correction: {
        sequence,
        reason,
        narrative,
        areas: ordered,
        raisedBy: userFullName(context.actor),
        raisedAt: formatDateTime(now),
        acknowledgementRequired: input.acknowledgementRequired,
        // Never at the moment it is raised, by definition.
        acknowledged: null,
      },
      /*
       * A CORRECTION TO A DEMONSTRATION JOB CARD IS DEMONSTRATION DATA.
       * Mandate §1.1: taken from the original's recorded provenance rather
       * than from the job number, and stamped on every page when it is.
       */
      simulated: original.provenance === 'simulated',
    },
    fileName,
  );

  /*
   * THE BYTES LAND FIRST, as everywhere else in this system. A row pointing at
   * an addendum that is not in storage would be a correction the customer can
   * be told about and never shown.
   */
  const storageKey = `jobcards/corrections/${job.jobNumber}-${sequence}.pdf`;
  await context.services.storage.putDocument({
    storageKey,
    fileName,
    contentType: FINAL_DOCUMENT_CONTENT_TYPE,
    bytes: rendered.bytes,
    renderer: 1,
    backfilled: false,
  });

  // Read back and measured at the key this record carries, which is why it is
  // `measureStored` rather than `storeAndMeasure`.
  const measured = await measureStored(context, storageKey, {
    message: 'The correction could not be stored.',
    code: 'document_not_stored',
    detail: 'The addendum did not land in storage, so nothing was recorded. Try again.',
  });

  const correction: JobCorrection = {
    id,
    jobId: job.id,
    sequence,
    correctsDocumentKey: original.storageKey,
    reason,
    narrative,
    areas: ordered,
    raisedBy: context.actor.id,
    raisedAt: now,
    acknowledgement: input.acknowledgementRequired ? 'required' : 'not_required',
    acknowledged: null,
    documentFileName: fileName,
    documentStorageKey: storageKey,
    documentSizeBytes: measured.sizeBytes,
    documentChecksumSha256: measured.checksumSha256,
    createdAt: now,
  };

  const saved = await context.repos.jobs.saveCorrection(correction);

  await audit(context, {
    jobId: job.id,
    type: 'job_correction_raised',
    summary: `Correction ${sequence} raised on ${job.jobNumber}`,
    /*
     * THE WHOLE RECORD, because this is the audit trail the owner's rule asks
     * for: the reason, the author, the timestamp, the affected fields and the
     * document it refers to. The narrative is NOT repeated here — it is on the
     * correction and on the addendum, and an audit line is an index rather
     * than a second copy that could drift.
     */
    detail:
      `${userFullName(context.actor)} raised correction ${sequence} to ${original.fileName} ` +
      `(issued ${original.generatedAt}). Affects: ` +
      `${ordered.map((area) => CORRECTED_AREA_LABEL[area]).join(', ')}. Reason: ${reason}. ` +
      `The original job card${job.signature === null ? '' : ' and its signature'} are unchanged. ` +
      (input.acknowledgementRequired
        ? "The customer's acknowledgement is required and has not been recorded."
        : "The customer's acknowledgement is not required for this correction."),
  });

  return saved;
};

export interface AcknowledgementInput {
  /** The person at the customer who acknowledged it. */
  readonly acknowledgedBy: string;
  /** How: in person, by telephone, by e-mail. Recorded verbatim. */
  readonly method: string;
  readonly note: string;
}

/**
 * Records that the customer has acknowledged a correction. WRITE-ONCE.
 *
 * The database refuses a second one (`job_corrections_guard`), and this
 * refuses it first with a sentence somebody can act on. Nothing here decides
 * that the acknowledgement was NEEDED — that was stated when the correction
 * was raised.
 */
export const recordCorrectionAcknowledgement = async (
  context: OperationContext,
  correctionId: string,
  input: AcknowledgementInput,
): Promise<JobCorrection> => {
  if (!can(context.actor.role, 'jobs.recordCorrectionAcknowledgement')) {
    throw new WorkflowError('You cannot record a customer’s acknowledgement.', [
      { code: 'not_permitted', message: 'This is office work on the customer’s record.' },
    ]);
  }

  const correction = await context.repos.jobs.findCorrectionById(correctionId);
  if (correction === null) {
    throw new WorkflowError('That correction does not exist.', [
      { code: 'unknown_correction', message: 'No correction with that id is on file.' },
    ]);
  }
  if (correction.acknowledgement === 'recorded') {
    throw new WorkflowError('That correction has already been acknowledged.', [
      {
        code: 'already_acknowledged',
        message:
          'The acknowledgement is a record of what the customer said, and it is not rewritten. ' +
          'Raise another correction if something further has to be said.',
      },
    ]);
  }
  if (correction.acknowledgement === 'not_required') {
    throw new WorkflowError('That correction did not ask for an acknowledgement.', [
      {
        code: 'acknowledgement_not_required',
        message:
          'It was raised as not requiring one. Recording an acknowledgement against it would ' +
          'make the addendum the customer holds disagree with the record.',
      },
    ]);
  }

  const acknowledgedBy = required(
    input.acknowledgedBy,
    'acknowledged_by',
    'The name of the person who acknowledged it',
    200,
  );
  const method = required(input.method, 'method', 'How it was acknowledged', 200);

  const saved = await context.repos.jobs.saveCorrection({
    ...correction,
    acknowledgement: 'recorded',
    acknowledged: {
      acknowledgedBy,
      method,
      recordedBy: context.actor.id,
      recordedAt: context.services.clock.now(),
      note: input.note.trim(),
    },
  });

  await audit(context, {
    jobId: correction.jobId,
    type: 'job_correction_acknowledged',
    summary: `Correction ${correction.sequence} acknowledged`,
    detail:
      `${acknowledgedBy} acknowledged correction ${correction.sequence} (${method}), recorded by ` +
      `${userFullName(context.actor)}.` +
      (input.note.trim().length === 0 ? '' : ` Note: ${input.note.trim()}`),
  });

  return saved;
};

/**
 * The addendum's file, authorised by the JOB and then by the correction.
 *
 * Returns null for every refusal that must not be distinguishable from
 * outside: a correction id that does not exist, one belonging to another job,
 * and one whose bytes are gone.
 */
export const loadCorrectionDocument = async (
  context: OperationContext,
  job: Job,
  correctionId: string,
): Promise<{ readonly correction: JobCorrection; readonly file: StoredDocument } | null> => {
  if (!canReadFinalDocument(job, context)) return null;

  const correction = await context.repos.jobs.findCorrectionById(correctionId);
  if (correction === null || correction.jobId !== job.id) return null;

  let file: StoredDocument | null;
  try {
    file = await context.services.storage.getDocument(correction.documentStorageKey);
  } catch (cause) {
    if (!(cause instanceof StorageIntegrityFailed)) throw cause;
    /*
     * A DAMAGED ADDENDUM IS NOT RE-RENDERED, for the reason a damaged job card
     * is not: a fresh render is a new document carrying an old date. It is
     * restored from a backup, and until then it refuses loudly.
     */
    throw new WorkflowError(`${correction.documentFileName} is damaged.`, [
      {
        code: 'document_damaged',
        message:
          'The stored addendum is not the file that was written, so it has not been served. It ' +
          'must be restored from a backup — it is not re-rendered, because a re-render would be ' +
          'a new document carrying the correction’s original date.',
      },
    ]);
  }

  if (file === null) return null;
  return { correction, file };
};
