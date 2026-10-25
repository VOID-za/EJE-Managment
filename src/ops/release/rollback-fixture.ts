/**
 * The library documents the rollback-compatibility check writes (phase 1, this
 * release) and reads back (phase 2, the live release). Shared so the two phases
 * cannot disagree about which id holds which state.
 *
 * The probe in `scripts/release/rollback-probe.db.test.ts` runs inside a
 * checkout of the LIVE release, which does not have this file — so it carries a
 * copy of these ids, and `rollback-fixture.test.ts` asserts the two match.
 */
export const ROLLBACK_DOCUMENTS = {
  indexed: '00000000-0000-4000-8000-0000000004a1',
  partial: '00000000-0000-4000-8000-0000000004a2',
  needsOcr: '00000000-0000-4000-8000-0000000004a3',
  failed: '00000000-0000-4000-8000-0000000004a4',
  coverageUnknown: '00000000-0000-4000-8000-0000000004a5',
} as const;
