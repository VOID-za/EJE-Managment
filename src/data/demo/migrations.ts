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

/**
 * v12 -> v13. SPARE-2.
 *
 * `awaitingSparesReason` — one free-text line — becomes a `sparesRequest` with a
 * description, notes, an optional photograph and the date it was raised.
 *
 * THE OLD LINE BECOMES THE DESCRIPTION, because that is what it held: "IGBT
 * module on back order with the supplier" is what somebody has to order. It is
 * deliberately NOT split into description and notes — a guess at where the
 * sentence divides would put half of it under the wrong heading.
 *
 * THE DATE IS THE ONE THING THAT CANNOT BE RECOVERED. No snapshot ever recorded
 * when the request was raised, so a job carrying a reason gets the moment of the
 * upgrade. That is the only honest answer available, and it is why the new
 * database column is nullable rather than defaulted. A job with no reason gets no
 * request at all rather than an empty one.
 */
const v12ToV13 = (data: Loose): Loose => {
  const upgradedAt = new Date().toISOString();
  return {
    ...data,
    jobs: rows(data, 'jobs').map((job) => {
      const reason = text(job.awaitingSparesReason);
      const { awaitingSparesReason: _replaced, ...rest } = job;
      return {
        ...rest,
        sparesRequest:
          reason.trim().length === 0
            ? null
            : { description: reason, notes: '', photoId: null, requestedAt: upgradedAt },
      };
    }),
  };
};

/**
 * v13 -> v14. BD-15.
 *
 * Adds two collections.
 *
 * `captureReferrals` is empty: a snapshot from before the office could be
 * referred a refused capture has none, by definition — there was nowhere to
 * put one.
 *
 * `jobParticipation` is DERIVED FROM THE CREWS THE SNAPSHOT ALREADY HAS, which
 * is the most this upgrade can honestly claim. A technician taken off a job
 * before the upgrade left no trace of having been on it, so that history
 * cannot be recovered; from here on it is recorded as it happens. Nothing else
 * is touched.
 */
const v13ToV14 = (data: Loose): Loose => {
  const jobs = Array.isArray(data.jobs) ? (data.jobs as Loose[]) : [];
  return {
    ...data,
    captureReferrals: Array.isArray(data.captureReferrals) ? data.captureReferrals : [],
    jobParticipation: Array.isArray(data.jobParticipation)
      ? data.jobParticipation
      : jobs.flatMap((job) => {
          const additional = Array.isArray(job.additionalTechnicianIds)
            ? (job.additionalTechnicianIds as string[])
            : [];
          const crew =
            typeof job.primaryTechnicianId === 'string'
              ? [job.primaryTechnicianId, ...additional]
              : additional;
          return crew.map((userId) => ({ jobId: job.id as string, userId }));
        }),
  };
};

/**
 * v14 -> v15.
 *
 * Adds the technical library's full-text index. Nothing is back-filled and
 * nothing could be: the index is built from an uploaded PDF's bytes, and a
 * snapshot written before this existed has no uploaded library files in it. So
 * every existing document comes forward as "not indexed", which is what it is
 * — the alternative would be an index entry claiming text nobody extracted.
 */
const v14ToV15 = (data: Loose): Loose => ({
  ...data,
  documentText: Array.isArray(data.documentText) ? data.documentText : [],
});

/**
 * v15 -> v16. CUST-CR.
 *
 * Adds the register change requests, empty. A snapshot written before the
 * office could be sent one has none, by definition — there was nowhere to put
 * one, which is the gap this feature closes.
 */
const v15ToV16 = (data: Loose): Loose => ({
  ...data,
  changeRequests: Array.isArray(data.changeRequests) ? data.changeRequests : [],
});

/**
 * v16 -> v17. BACKUP-1.
 *
 * `FinalDocument` gained the length, checksum and renderer the store measured
 * when the bytes landed. A snapshot written before that has job cards whose
 * descriptor has none of the three, and the honest value for every one of them
 * is NULL: nobody measured those bytes, and a 0 would say the document is
 * empty, which is a different and false statement. A persisted demonstration
 * job card is rendered on first download anyway, at which point the issue path
 * records the real values.
 */
const v16ToV17 = (data: Loose): Loose => ({
  ...data,
  jobs: rows(data, 'jobs').map((job) => {
    const document = job.finalDocument;
    if (document === null || typeof document !== 'object') return job;
    const descriptor = document as Record<string, unknown>;
    return {
      ...job,
      finalDocument: {
        ...descriptor,
        sizeBytes: descriptor.sizeBytes ?? null,
        checksumSha256: descriptor.checksumSha256 ?? null,
        renderer: descriptor.renderer ?? null,
      },
    };
  }),
});

/**
 * v17 -> v18. October mandate §1.
 *
 * Every document-bearing record gained `provenance`, and a snapshot written
 * before that has none. The honest answer for a snapshot of the DEMONSTRATION
 * store is `simulated` for the records the seed created and `genuine` for
 * anything a person captured during the session — and the snapshot cannot tell
 * them apart, because nothing recorded it at the time.
 *
 * SO IT GOES BY WHETHER THERE ARE BYTES, and only here. A seeded record has a
 * storage key and no file behind it; anything captured in the session went
 * through an upload path that stores bytes first. That is a sound reading of a
 * snapshot's own contents rather than a guess from a name — and it is confined
 * to this one-time upgrade, which is why `provenance` is recorded explicitly
 * everywhere else rather than derived from a size.
 */
const v17ToV18 = (data: Loose): Loose => {
  const files = (data.files ?? {}) as Record<string, unknown>;
  const stored = (storageKey: unknown): boolean =>
    typeof storageKey === 'string' && Object.prototype.hasOwnProperty.call(files, storageKey);
  const classify = (storageKey: unknown): 'genuine' | 'simulated' =>
    stored(storageKey) ? 'genuine' : 'simulated';

  const withProvenance = (row: Record<string, unknown>): Record<string, unknown> =>
    row.provenance === 'genuine' || row.provenance === 'simulated'
      ? row
      : { ...row, provenance: classify(row.storageKey) };

  const attachments = (value: unknown): unknown =>
    Array.isArray(value) ? value.map((entry) => withProvenance(entry as Record<string, unknown>)) : value;

  return {
    ...data,
    /*
     * AND THE NEW COLLECTION, which v18 also introduced (CUST-DOC-1). A
     * snapshot written before it has no such key, and a repository that reads
     * `customerDocuments.filter` on `undefined` does not fail politely — it
     * throws on the first customer screen somebody opens after upgrading.
     */
    customerDocuments: Array.isArray(data.customerDocuments) ? data.customerDocuments : [],
    documents: rows(data, 'documents').map(withProvenance),
    machines: rows(data, 'machines').map((machine) => ({
      ...machine,
      photos: attachments(machine.photos),
    })),
    jobs: rows(data, 'jobs').map((job) => ({
      ...job,
      photos: attachments(job.photos),
      videos: attachments(job.videos),
      attachments: attachments(job.attachments),
      finalDocument:
        job.finalDocument === null || typeof job.finalDocument !== 'object'
          ? job.finalDocument
          : withProvenance(job.finalDocument as Record<string, unknown>),
    })),
  };
};

/**
 * v18 -> v19. October mandate §4.
 *
 * A machine gained its own documents (`MACH-DOC-1`). Nothing derives them and
 * nothing is seeded, so the step only has to make the collection EXIST: the
 * repository reads it directly, and an absent key is a thrown TypeError on the
 * first machine screen rather than an empty list.
 */
const v18ToV19 = (data: Loose): Loose => ({
  ...data,
  machineDocuments: Array.isArray(data.machineDocuments) ? data.machineDocuments : [],
});

/**
 * v19 -> v20. BD-02.
 *
 * Corrections to issued job cards. Nothing derives them and nothing is
 * seeded, so the step only has to make the collection EXIST — the same lesson
 * `customerDocuments` taught at v18, where the key was introduced by a step
 * that did not create it and the first customer screen after an upgrade threw
 * on `undefined.filter`.
 */
const v19ToV20 = (data: Loose): Loose => ({
  ...data,
  jobCorrections: Array.isArray(data.jobCorrections) ? data.jobCorrections : [],
});

/**
 * v20 -> v21. BD-06. The collection has to exist; nothing derives it.
 */
const v20ToV21 = (data: Loose): Loose => ({
  ...data,
  unsignedDeliveryAuthorisations: Array.isArray(data.unsignedDeliveryAuthorisations)
    ? data.unsignedDeliveryAuthorisations
    : [],
});

/**
 * v21 -> v22. A CHECKSUM ON EVERY ATTACHMENT. `0021`'s counterpart.
 *
 * Unlike every step above this one, it does not add a collection — it adds a
 * FIELD to records that already exist, which is the other way a snapshot goes
 * stale. `Attachment.checksumSha256` is `string | null`, and a v21 record has
 * neither: reading it gives `undefined`, which is a type lie at runtime and the
 * kind that surfaces somewhere far away.
 *
 * NULL, NOT A COMPUTED HASH. These bytes are in the snapshot and could be
 * hashed — and doing so would be inventing a measurement that was never taken.
 * Null says "nobody measured this", which is the truth, and is what the column
 * says about every pre-`0021` row in PostgreSQL too.
 */
const withChecksum = (value: unknown): unknown => {
  if (!Array.isArray(value)) return value;
  return value.map((item) =>
    typeof item === 'object' && item !== null && !('checksumSha256' in item)
      ? { ...(item as Record<string, unknown>), checksumSha256: null }
      : item,
  );
};

const v21ToV22 = (data: Loose): Loose => ({
  ...data,
  jobs: Array.isArray(data.jobs)
    ? data.jobs.map((job) => {
        if (typeof job !== 'object' || job === null) return job;
        const row = job as Record<string, unknown>;
        return {
          ...row,
          photos: withChecksum(row.photos),
          videos: withChecksum(row.videos),
          attachments: withChecksum(row.attachments),
          /*
           * CHECKLIST EVIDENCE IS NESTED TWO DEEP — a job's checklist holds
           * responses and each response holds photographs. The flat spread
           * above would have missed it, which is exactly the shape of bug
           * these steps keep finding.
           */
          checklist:
            typeof row.checklist === 'object' && row.checklist !== null
              ? {
                  ...(row.checklist as Record<string, unknown>),
                  responses: Array.isArray((row.checklist as Record<string, unknown>).responses)
                    ? ((row.checklist as Record<string, unknown>).responses as unknown[]).map(
                        (response) =>
                          typeof response === 'object' && response !== null
                            ? {
                                ...(response as Record<string, unknown>),
                                photos: withChecksum(
                                  (response as Record<string, unknown>).photos,
                                ),
                              }
                            : response,
                      )
                    : (row.checklist as Record<string, unknown>).responses,
                }
              : row.checklist,
        };
      })
    : data.jobs,
  machines: Array.isArray(data.machines)
    ? data.machines.map((machine) =>
        typeof machine === 'object' && machine !== null
          ? {
              ...(machine as Record<string, unknown>),
              photos: withChecksum((machine as Record<string, unknown>).photos),
            }
          : machine,
      )
    : data.machines,
});

/**
 * v22 -> v23. LIB-5's OCR queue. The collection has to exist; nothing derives
 * it, and nothing is seeded — no seeded document has an uploaded file.
 */
const v22ToV23 = (data: Loose): Loose => ({
  ...data,
  libraryOcrQueue: Array.isArray(data.libraryOcrQueue) ? data.libraryOcrQueue : [],
});

/**
 * v23 -> v24. A checksum on a library revision. LIB-5's half of `0021`'s idea.
 *
 * The library was the last upload path that measured nothing: it recorded the
 * length of what it HANDED to the write and no hash at all. The field is
 * `string | null`, and a v23 record has neither — `undefined` where the type
 * says null, which is a lie that surfaces somewhere far away.
 *
 * NULL, not a hash of the bytes the snapshot happens to hold: computing one
 * would be recording a measurement nobody took.
 */
const v23ToV24 = (data: Loose): Loose => ({
  ...data,
  documents: Array.isArray(data.documents)
    ? data.documents.map((document) =>
        typeof document === 'object' && document !== null && !('checksumSha256' in document)
          ? { ...(document as Record<string, unknown>), checksumSha256: null }
          : document,
      )
    : data.documents,
});

const STEPS: Readonly<Record<number, (data: Loose) => Loose>> = {
  8: v8ToV9,
  9: v9ToV10,
  10: v10ToV11,
  11: v11ToV12,
  12: v12ToV13,
  13: v13ToV14,
  14: v14ToV15,
  15: v15ToV16,
  16: v16ToV17,
  17: v17ToV18,
  18: v18ToV19,
  19: v19ToV20,
  20: v20ToV21,
  21: v21ToV22,
  22: v22ToV23,
  23: v23ToV24,
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
