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
  // 0040 (written for the 1a34d1c probe): a September period, its monthly submission, a Finance package.
  monthPeriod: '00000000-0000-4000-8000-0000000005e1',
  submission: '00000000-0000-4000-8000-0000000005e2',
  financePackage: '00000000-0000-4000-8000-0000000005e3',
} as const;

/**
 * The integration rows only the release after c68b3c3 can write (migration
 * 0042): an email template and version, a SENT customer email, a WhatsApp
 * message with a delivery status. Copied into the probe as `INTEGRATIONS`.
 */
export const ROLLBACK_INTEGRATIONS = {
  template: '00000000-0000-4000-8000-0000000006a1',
  templateVersion: '00000000-0000-4000-8000-0000000006a2',
  email: '00000000-0000-4000-8000-0000000006b1',
  outbox: '00000000-0000-4000-8000-0000000006c1',
} as const;

export const ROLLBACK_DOCUMENTS = {
  indexed: '00000000-0000-4000-8000-0000000004a1',
  partial: '00000000-0000-4000-8000-0000000004a2',
  needsOcr: '00000000-0000-4000-8000-0000000004a3',
  failed: '00000000-0000-4000-8000-0000000004a4',
  coverageUnknown: '00000000-0000-4000-8000-0000000004a5',
} as const;

/**
 * The rows only the release after b3a9014 can write (migration 0047): an
 * Apprentice, a customer on Custom Rates with its rates, a document chosen for
 * the customer email, a QUEUED email carrying an extra attachment, an approved
 * standby day swap with its two days, and a day-swap notification. Copied into
 * the probe as `BATCH_0047`, so the live release meets each of them.
 */
export const ROLLBACK_0047 = {
  apprentice: '00000000-0000-4000-8000-0000000007a1',
  document: '00000000-0000-4000-8000-0000000007b1',
  queuedEmail: '00000000-0000-4000-8000-0000000007c1',
  daySwap: '00000000-0000-4000-8000-0000000007d1',
  overrideA: '00000000-0000-4000-8000-0000000007d2',
  overrideB: '00000000-0000-4000-8000-0000000007d3',
  notification: '00000000-0000-4000-8000-0000000007e1',
  weekA: '2027-03-01',
  weekB: '2027-03-08',
  saturdayA: '2027-03-06',
  saturdayB: '2027-03-13',
} as const;
