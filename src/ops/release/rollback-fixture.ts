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

/**
 * The rows only the release after 9569c85 can write (migration 0048): a
 * Delivery Note job still being completed, with a commented part line; an
 * overlapping timesheet submission that superseded an earlier one; a Senior
 * Tech in a main standby place. Copied into the probe as `BATCH_0048`.
 */
export const ROLLBACK_0048 = {
  deliveryNoteJob: '00000000-0000-4000-8000-0000000008a1',
  partLine: '00000000-0000-4000-8000-0000000008a2',
  earlyPeriod: '00000000-0000-4000-8000-0000000008b1',
  latePeriod: '00000000-0000-4000-8000-0000000008b2',
  standbyWeek: '2027-04-05',
} as const;

/**
 * The rows only the release after 6ec5655 can write (migration 0049): a
 * Delivery Note with NO site, and the office's delivery-note reference photo
 * on phase 1's Test & Repair job. Copied into the probe as `BATCH_0049`.
 */
export const ROLLBACK_0049 = {
  siteLessNote: '00000000-0000-4000-8000-0000000009a1',
  referencePhoto: '00000000-0000-4000-8000-0000000009b2',
} as const;

/**
 * The rows only the release after 89668e8 can write (migration 0050, TS-PAPER):
 * a submitted timesheet period longer than 92 days, the open sheet's comment,
 * and a technician's month submitted as attendance only. Copied into the probe
 * as `BATCH_0050`.
 */
export const ROLLBACK_0050 = {
  longPeriod: '00000000-0000-4000-8000-000000000aa1',
  longFrom: '2027-04-01',
  longTo: '2027-08-31',
  attendanceOnlyMonth: '00000000-0000-4000-8000-000000000ab1',
  month: '2027-03',
} as const;

/**
 * The rows only the release after f693747 can write (migration 0051, CHK-SRC):
 * a Service job on the Lathe checklist with the choice recorded and a Fail
 * tapped before its note, and an Installation job with readings typed into a
 * row's printed blanks. Copied into the probe as `BATCH_0051`.
 */
export const ROLLBACK_0051 = {
  latheJob: '00000000-0000-4000-8000-000000000ba1',
  installationJob: '00000000-0000-4000-8000-000000000ba2',
  latheChecklist: 'a664c9a7-e7c9-527b-b920-d02c6bd7313f',
  installationChecklist: '69479130-a5bf-5041-a6ef-eb91dddab44b',
  /** Lathe ELECTRICAL, the handwritten "Changed Fanuc control battery". */
  handwrittenRow: '49ce73ee-0a1f-5e6f-b583-b8caccd634f3',
  /** Installation 2, "Check electrical voltage" — R / S / T. */
  voltageRow: 'f59a9e7a-1331-51c0-81b1-07019a1a8dc4',
} as const;
