import {
  METADATA_ONLY_NOTICE,
  MISSING_FILE_NOTICE,
  SIMULATED_BADGE,
  SIMULATED_NOTICE,
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
  if (provenance !== 'simulated') return null;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-amber-eje-300 bg-amber-eje-50 ' +
          'px-2 py-0.5 text-[0.625rem] font-bold tracking-wider text-amber-eje-800 uppercase',
        className,
      )}
      // The full sentence on hover and for a screen reader; the compact word on
      // screen, because a list row cannot carry twelve words.
      title={SIMULATED_NOTICE}
      aria-label={SIMULATED_NOTICE}
      data-testid={testId}
    >
      {SIMULATED_BADGE}
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
  if (!simulated && storedFile) return null;

  return (
    <div
      className={cn(
        'rounded-[var(--radius-control)] border px-3 py-2.5 text-xs leading-relaxed',
        simulated
          ? 'border-amber-eje-300 bg-amber-eje-50 text-amber-eje-900'
          : 'border-red-300 bg-red-50 text-red-900',
        className,
      )}
      data-testid={simulated ? 'simulated-notice' : 'missing-file-notice'}
    >
      {simulated && <p className="font-bold tracking-wide uppercase">{SIMULATED_NOTICE}</p>}
      <p className={simulated ? 'mt-1' : ''}>
        {simulated ? METADATA_ONLY_NOTICE : MISSING_FILE_NOTICE}
      </p>
    </div>
  );
};
