/**
 * The library documents the rollback-compatibility check writes (phase 1, this
 * release) and reads back (phase 2, the live release). Shared so the two phases
 * cannot disagree about which id holds which state.
 *
 * The probe in `scripts/release/rollback-probe.db.test.ts` runs inside a
 * checkout of the LIVE release, which does not have this file — so it carries a
 * copy of these ids, and `rollback-fixture.test.ts` asserts the two match.
 */
/**
 * The timesheet, attendance and delivery-note rows only the release after
 * ef0f695 can write (migrations 0037–0039). Copied into the probe as
 * `TIMESHEET`, held to this by `rollback-fixture.test.ts` like the documents.
 */
export const ROLLBACK_TIMESHEET = {
  absentDay: '2026-10-20',
  workshopLine: '00000000-0000-4000-8000-0000000005a1',
  customerLine: '00000000-0000-4000-8000-0000000005a2',
  period: '00000000-0000-4000-8000-0000000005b1',
  correction: '00000000-0000-4000-8000-0000000005c1',
  deliveryNote: '00000000-0000-4000-8000-0000000005d1',
} as const;

export const ROLLBACK_DOCUMENTS = {
  indexed: '00000000-0000-4000-8000-0000000004a1',
  partial: '00000000-0000-4000-8000-0000000004a2',
  needsOcr: '00000000-0000-4000-8000-0000000004a3',
  failed: '00000000-0000-4000-8000-0000000004a4',
  coverageUnknown: '00000000-0000-4000-8000-0000000004a5',
} as const;
