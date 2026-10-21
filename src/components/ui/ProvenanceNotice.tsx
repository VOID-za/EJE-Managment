import {
  METADATA_ONLY_NOTICE,
  MISSING_FILE_NOTICE,
  SIMULATED_BADGE,
  SIMULATED_NOTICE,
  UNRECORDED_PROVENANCE_BADGE,
  UNRECORDED_PROVENANCE_NOTICE,
  type Provenance,
} from '@/domain';
import { cn } from '@/lib/cn';

/**
 * SAYING THAT SOMETHING IS DEMONSTRATION DATA, THE SAME WAY EVERYWHERE.
 * October mandate §1.
 *
 * Two components and one rule: wherever a record could be mistaken for a
 * genuine EJE document, the screen says which it is. The badge goes in list
 * rows, search results and panels; the notice goes on detail views and
 * previews, where there is room for the whole sentence.
 *
 * ONE PLACE, because the alternative is what the application had: nothing
 * anywhere, and nine library documents, three machine photographs and six job
 * cards presented exactly as EJE's own records. A label invented separately in
 * each of a dozen components is a label that will be missing from three of
 * them.
 *
 * NOTHING HERE IS SHOWN FOR A GENUINE RECORD. A real document gets no badge,
 * no notice and no border: the absence of a label is what makes the label mean
 * something.
 *
 * AND THERE IS A THIRD ANSWER. A record whose provenance was never recorded —
 * one written before the column existed — is neither. It carries a NEUTRAL
 * badge saying so, in grey rather than amber, because "we did not write this
 * down" is a statement about EJE's record-keeping and not an accusation
 * against the document. See `Provenance`.
 */
export const SimulatedBadge = ({
  provenance,
  className,
  testId = 'simulated-badge',
}: {
  readonly provenance: Provenance;
  readonly className?: string;
  readonly testId?: string;
}) => {
  if (provenance === 'genuine') return null;

  const unrecorded = provenance === 'unknown';
  const sentence = unrecorded ? UNRECORDED_PROVENANCE_NOTICE : SIMULATED_NOTICE;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.625rem] ' +
          'font-bold tracking-wider uppercase',
        unrecorded
          ? 'border-steel-300 bg-steel-50 text-steel-700'
          : 'border-amber-eje-300 bg-amber-eje-50 text-amber-eje-800',
        className,
      )}
      // The full sentence on hover and for a screen reader; the compact word on
      // screen, because a list row cannot carry twelve words.
      title={sentence}
      aria-label={sentence}
      data-testid={unrecorded ? 'unrecorded-provenance-badge' : testId}
    >
      {unrecorded ? UNRECORDED_PROVENANCE_BADGE : SIMULATED_BADGE}
    </span>
  );
};

/**
 * The full statement, for a detail view or a preview.
 *
 * `storedFile` is a SEPARATE fact and the two sentences it produces are
 * opposites, which is why one component carries both: demonstration metadata
 * with no file is housekeeping and says so plainly, while a GENUINE record
 * whose file is missing is an incident and says that instead. Telling them
 * apart by "there is no file" is exactly the mistake this prevents.
 */
export const ProvenanceNotice = ({
  provenance,
  storedFile,
  className,
}: {
  readonly provenance: Provenance;
  readonly storedFile: boolean;
  readonly className?: string;
}) => {
  const simulated = provenance === 'simulated';
  const unrecorded = provenance === 'unknown';
  if (!simulated && !unrecorded && storedFile) return null;

  /*
   * THREE SENTENCES, AND THE THIRD IS WHY THIS IS NOT A BOOLEAN.
   *
   *   simulated          — a fixture with no file. Housekeeping; says so.
   *   genuine, no file   — an INCIDENT. `MISSING_FILE_NOTICE` says the record
   *                        is EJE's and the file should be restored.
   *   unknown            — nobody recorded where it came from, so neither of
   *                        the above may be said. Saying "this is a genuine
   *                        EJE record" of a row whose origin was defaulted is
   *                        the claim §1.3 forbids.
   */
  const tone = simulated
    ? 'border-amber-eje-300 bg-amber-eje-50 text-amber-eje-900'
    : unrecorded
      ? 'border-steel-300 bg-steel-50 text-steel-800'
      : 'border-red-300 bg-red-50 text-red-900';

  const testId = simulated
    ? 'simulated-notice'
    : unrecorded
      ? 'unrecorded-provenance-notice'
      : 'missing-file-notice';

  const heading = simulated ? SIMULATED_NOTICE : unrecorded ? UNRECORDED_PROVENANCE_BADGE : null;

  return (
    <div
      className={cn(
        'rounded-[var(--radius-control)] border px-3 py-2.5 text-xs leading-relaxed',
        tone,
        className,
      )}
      data-testid={testId}
    >
      {heading !== null && <p className="font-bold tracking-wide uppercase">{heading}</p>}
      <p className={heading === null ? '' : 'mt-1'}>
        {simulated
          ? METADATA_ONLY_NOTICE
          : unrecorded
            ? `${UNRECORDED_PROVENANCE_NOTICE}${storedFile ? '' : ' There is also no file stored for it.'}`
            : MISSING_FILE_NOTICE}
      </p>
    </div>
  );
};
