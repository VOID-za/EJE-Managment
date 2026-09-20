import type { DemoDatabase } from './store';

/**
 * Migrations for the persisted demonstration dataset.
 *
 * A demonstration that discards its data on every deployment is a demonstration
 * that cannot be trusted: the customer added on Tuesday has to still be there on
 * Wednesday. So a persisted snapshot from an older shape is UPGRADED in place —
 * every record is kept and the new fields are filled in from what is already
 * known — rather than thrown away and re-seeded.
 *
 * Each step takes the snapshot one version forward and they are applied in
 * order, which is exactly how the Phase 2 Drizzle migrations will run against
 * PostgreSQL. The steps work on loosely typed records on purpose: an old
 * snapshot does not satisfy the current types, and pretending otherwise with a
 * cast would hide the very mismatch the step exists to fix.
 */

type Loose = Record<string, unknown>;

/** The oldest shape that can still be carried forward. */
export const OLDEST_MIGRATABLE_VERSION = 8;

const rows = (data: Loose, key: string): Loose[] =>
  Array.isArray(data[key]) ? (data[key] as Loose[]) : [];

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * v8 -> v9.
 *
 * Adds the customer's office address, the customer's own machine number, the
 * delivery record a job now carries, the archive marker that lets a site,
 * contact or machine be withdrawn without destroying the jobs that name it, and
 * `capturedBy` on every captured line.
 *
 * The office address is taken from the customer's first site, which is where it
 * was in practice before the field existed — a single-site customer's site IS
 * their office. It is editable afterwards, so a customer whose head office is
 * elsewhere is corrected in one place rather than guessed at here.
 */
const withCapturedBy = (entries: Loose[], fallback: string): Loose[] =>
  entries.map((entry) =>
    entry.capturedBy !== undefined
      ? entry
      : { ...entry, capturedBy: text(entry.technicianId) || fallback },
  );

const v8ToV9 = (data: Loose): Loose => {
  const sites = rows(data, 'sites');

  return {
    ...data,
    customers: rows(data, 'customers').map((customer) => {
      if (customer.officeAddress !== undefined) return customer;
      const first = sites.find((site) => site.customerId === customer.id);
      return {
        ...customer,
        officeAddress: {
          line1: text(first?.addressLine1),
          line2: text(first?.addressLine2),
          city: text(first?.city),
          province: text(first?.province),
          postalCode: text(first?.postalCode),
        },
      };
    }),
    sites: sites.map((site) => ({ archivedAt: null, ...site })),
    contacts: rows(data, 'contacts').map((contact) => ({ archivedAt: null, ...contact })),
    machines: rows(data, 'machines').map((machine) => ({
      machineNumber: '',
      archivedAt: null,
      ...machine,
    })),
    // A job persisted before delivery was tracked has no delivery record. Null
    // is the honest value: nothing is known about what became of its copy, and
    // a closed job is closed either way.
    //
    // A line captured before the office could capture work administratively was
    // captured by the technician it is attributed to, so that is who it says
    // wrote it down. Parts carry no technician, so they fall back to whoever
    // created the job — the only person the record actually knows about.
    jobs: rows(data, 'jobs').map((job) => ({
      delivery: null,
      ...job,
      labour: withCapturedBy(rows(job, 'labour'), text(job.createdBy)),
      travel: withCapturedBy(rows(job, 'travel'), text(job.createdBy)),
      parts: withCapturedBy(rows(job, 'parts'), text(job.createdBy)),
    })),
  };
};

/**
 * v9 -> v10.
 *
 * Adds the customer's refusal to sign. Null is the only honest value for a job
 * persisted before the field existed: nothing in the old snapshot records a
 * refusal, so every one of those jobs either was signed or never reached the
 * signature stage. Nothing is inferred and nothing is discarded.
 */
const v9ToV10 = (data: Loose): Loose => ({
  ...data,
  jobs: rows(data, 'jobs').map((job) => ({ signatureRefusal: null, ...job })),
});

/**
 * v10 -> v11.
 *
 * Renames the signature-refusal resolution audit event and the wording it was
 * written with. A Master clearing a refusal was briefly recorded as a "review",
 * which reads as the retired Master Review stage and is not what the action is:
 * it resolves an exception on a job that never left Review.
 *
 * Only the system's own fixed wording is rewritten. The refusal reason and the
 * Master's own note are the words people typed, and are carried through
 * untouched — as are the actor, the timestamp and the job the event belongs to.
 */
const v10ToV11 = (data: Loose): Loose => ({
  ...data,
  activity: rows(data, 'activity').map((event) => {
    if (event.type !== 'signature_refusal_reviewed') return event;
    return {
      ...event,
      type: 'signature_refusal_resolved',
      summary: 'Signature refusal resolved',
      detail: text(event.detail)
        .replace(/^Reviewed by /, 'Signature refusal resolved by ')
        .replace(/ Master's note: /, ' Master note: '),
    };
  }),
});

/**
 * v11 -> v12.
 *
 * Three additions, all of them carrying what the snapshot already knew:
 *
 * - A refusal becomes the first entry of a refusal LIST, because a customer can
 *   refuse a corrected job card too and the office has to be able to see both.
 *   Its `acknowledged*` fields become `resolved*`; a refusal that had been
 *   resolved under the old shape is recorded as having been issued without a
 *   signature, which is what resolving used to mean.
 * - The courier's waybill number, empty: no snapshot before this recorded one.
 * - The customer's delivery note reference, empty, for the same reason.
 */
const v11ToV12 = (data: Loose): Loose => ({
  ...data,
  jobs: rows(data, 'jobs').map((job) => {
    const existing = job.signatureRefusal;
    const carried =
      existing === null || existing === undefined || typeof existing !== 'object'
        ? []
        : [
            (() => {
              const refusal = existing as Loose;
              const resolvedAt = refusal.acknowledgedAt ?? null;
              return {
                refused: true,
                reason: text(refusal.reason),
                recordedBy: text(refusal.recordedBy),
                recordedAt: text(refusal.recordedAt),
                resolvedBy: refusal.acknowledgedBy ?? null,
                resolvedAt,
                // Resolving used to mean exactly one thing: release the job
                // card as it stands. Recorded as that, rather than guessed at.
                resolution: resolvedAt === null ? null : 'issued_unsigned',
                resolutionNote: text(refusal.acknowledgementNote),
              };
            })(),
          ];

    const { signatureRefusal: _dropped, ...rest } = job;
    return {
      waybillNumber: '',
      deliveryNote: '',
      ...rest,
      signatureRefusals: Array.isArray(job.signatureRefusals) ? job.signatureRefusals : carried,
    };
  }),
});

const STEPS: Readonly<Record<number, (data: Loose) => Loose>> = {
  8: v8ToV9,
  9: v9ToV10,
  10: v10ToV11,
  11: v11ToV12,
};

/**
 * Brings a persisted snapshot up to `target`, or returns null when it cannot be.
 *
 * Null means the snapshot predates the oldest migration that is still carried,
 * and the caller re-seeds. That is a real limit rather than a shortcut: the
 * shapes before v8 are no longer described anywhere, so a step for them could
 * only guess.
 */
export const migrateDatabase = (
  version: number,
  data: unknown,
  target: number,
): DemoDatabase | null => {
  if (typeof data !== 'object' || data === null) return null;
  if (version > target) return null;
  if (version < OLDEST_MIGRATABLE_VERSION) return null;

  let current = data as Loose;
  for (let from = version; from < target; from += 1) {
    const step = STEPS[from];
    if (step === undefined) return null;
    current = step(current);
  }
  return current as unknown as DemoDatabase;
};
