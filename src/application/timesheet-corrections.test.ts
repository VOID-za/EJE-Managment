import { beforeEach, describe, expect, it } from 'vitest';
import { asUserId } from '@/domain';
import { businessToday } from '@/lib/business-time';
import { pdfPlainText } from '@/lib/pdf/inspect';
import { renderTimesheetPdf } from '@/services/simulated/timesheet-pdf';
import {
  exportTimesheet,
  loadTimesheet,
  loadTimesheetDocument,
  saveTimesheetEntry,
  saveTimesheetPeriodComment,
  submitTimesheetPeriod,
} from './timesheets';
import {
  decideTimesheetCorrection,
  listPendingTimesheetCorrections,
  requestTimesheetCorrection,
} from './timesheet-corrections';
import { buildHarness, seedUser, type Harness } from './test-harness';

/**
 * TS-16 — CORRECTING A TIMESHEET ALREADY SENT TO THE OFFICE (29 October 2026).
 *
 * Every rule proved at the operation, the server: hiding a button is not a rule.
 */
const SIPHO = asUserId('user-tech-sipho');
const sipho = seedUser('user-tech-sipho');
const riaan = seedUser('user-tech-riaan');
const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');

const day = (offset: number): string => {
  const date = new Date(`${businessToday()}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
};
const FROM = day(6);
const TO = day(2);

const line = (date: string, overrides: Record<string, unknown> = {}) => ({
  date,
  customerName: 'ABC Engineering',
  overtimeHours: 1.5,
  doubleHours: 0,
  calloutAmount: 45000,
  calloutShared: false,
  internalKm: 12.5,
  customerKm: 40,
  ...overrides,
});

let harness: Harness;
beforeEach(() => {
  harness = buildHarness();
});

const events = async (type: string) =>
  (await harness.repos.activity.list()).filter((event) => event.type === type);

/** Sipho sends FROM..TO with two lines and a comment. Returns the sent period. */
const sendPeriod = async () => {
  const tech = harness.as(sipho);
  const first = await saveTimesheetEntry(tech, SIPHO, line(day(5)));
  const second = await saveTimesheetEntry(tech, SIPHO, line(day(3), { customerName: 'Vaal Steel', overtimeHours: 2 }));
  await saveTimesheetPeriodComment(tech, SIPHO, FROM, TO, 'Week of the Vaal shutdown');
  const period = await submitTimesheetPeriod(tech, SIPHO, FROM, TO);
  return { period, first, second };
};

/** The corrected lines: the first line's OT 1.5 → 3, the second kept, a Workshop line added. */
const correctedLines = (first: { id: string }, second: { id: string }) => [
  { ...line(day(5), { overtimeHours: 3 }), entryId: first.id },
  { ...line(day(3), { customerName: 'Vaal Steel', overtimeHours: 2 }), entryId: second.id },
  line(day(4), { customerName: '', workshop: true, calloutAmount: 0, internalKm: 0, customerKm: 0, overtimeHours: 1 }),
];

const ask = (lines: ReturnType<typeof correctedLines>, overrides: Record<string, unknown> = {}) =>
  requestTimesheetCorrection(harness.as(sipho), SIPHO, {
    from: FROM,
    to: TO,
    reason: 'Forgot the Saturday overtime and the workshop morning',
    comment: 'Week of the Vaal shutdown (corrected)',
    lines,
    ...overrides,
  });

describe('TS-16 — asking for a correction', () => {
  it('records a pending correction linked to the sent period, with the complete before and after; the sent snapshot is untouched', async () => {
    const { period, first, second } = await sendPeriod();
    const correction = await ask(correctedLines(first, second));
    expect(correction).toMatchObject({ sequence: 1, status: 'pending', requestedById: SIPHO });
    expect(correction.before.entries).toHaveLength(2);
    expect(correction.after.entries).toHaveLength(3);
    expect(correction.changes.join('\n')).toMatch(/removed — ABC Engineering, OT 1\.5/u);
    expect(correction.changes.join('\n')).toMatch(/added — ABC Engineering, OT 3/u);
    expect(correction.changes.join('\n')).toMatch(/added — Workshop/u);
    expect(correction.changes.join('\n')).toMatch(/Comment:/u);

    // The original submission: the same row, the same snapshot, the same time.
    const after = await harness.repos.attendance.findPeriod(SIPHO, FROM, TO);
    expect(after).toEqual(period);
    // Pending changes nothing in force.
    const sheet = await loadTimesheet(harness.as(master), SIPHO, FROM, TO);
    expect(sheet.totals.overtimeHours).toBe(3.5);
    expect(sheet.period.versionInForce).toBe('Original submission');
    expect(sheet.period.corrections.map((c) => c.status)).toEqual(['pending']);
    expect((await events('timesheet_correction_requested'))).toHaveLength(1);
  });

  it('only the technician whose timesheet it is may ask — not another technician, not the office', async () => {
    const { first, second } = await sendPeriod();
    for (const actor of [riaan, master, coordinator]) {
      await expect(
        requestTimesheetCorrection(harness.as(actor), SIPHO, { from: FROM, to: TO, reason: 'x', comment: '', lines: correctedLines(first, second) }),
      ).rejects.toMatchObject({ violations: [{ code: 'not_permitted' }] });
    }
  });

  it('only a SENT period is corrected; a draft is edited on the sheet itself', async () => {
    const tech = harness.as(sipho);
    await saveTimesheetEntry(tech, SIPHO, line(day(5)));
    await expect(ask([])).rejects.toMatchObject({ violations: [{ code: 'timesheet_not_sent' }] });
    // A range that merely overlaps a sent one is not that period.
    await sendPeriod().catch(() => undefined);
    await expect(
      requestTimesheetCorrection(tech, SIPHO, { from: day(5), to: TO, reason: 'x', comment: '', lines: [] }),
    ).rejects.toMatchObject({ violations: [{ code: 'timesheet_not_sent' }] });
  });

  it('a reason is required; lines stay inside the period; every line rule of the timesheet applies; no day over 24 hours', async () => {
    const { first, second } = await sendPeriod();
    await expect(ask(correctedLines(first, second), { reason: '   ' })).rejects.toMatchObject({ violations: [{ code: 'correction_reason_required' }] });
    await expect(ask([line(day(1))] as never)).rejects.toMatchObject({ violations: [{ code: 'correction_outside_period' }] });
    await expect(ask([line(day(7))] as never)).rejects.toMatchObject({ violations: [{ code: 'correction_outside_period' }] });
    await expect(ask([line(day(5), { overtimeHours: 1.1 })] as never)).rejects.toMatchObject({ violations: [{ code: 'invalid_overtime_hours' }] });
    await expect(ask([line(day(5), { customerName: '' })] as never)).rejects.toMatchObject({ violations: [{ code: 'customer_required' }] });
    await expect(ask([line(day(5), { workshop: true })] as never)).rejects.toMatchObject({ violations: [{ code: 'workshop_and_customer' }] });
    await expect(ask([line(day(5), { normalHours: 2 })] as never)).rejects.toMatchObject({ violations: [{ code: 'nt_not_entered' }] });
    await expect(
      ask([line(day(5), { overtimeHours: 13 }), line(day(5), { overtimeHours: 12 })] as never),
    ).rejects.toMatchObject({ violations: [{ code: 'day_over_24_hours' }] });
    // A line of somebody else's — or one not on the version in force — is refused.
    await expect(ask([{ ...line(day(5)), entryId: 'tse-not-there' }] as never)).rejects.toMatchObject({ violations: [{ code: 'entry_not_found' }] });
    // Identical to the version in force: nothing to correct.
    await expect(
      ask(
        [{ ...line(day(5)), entryId: first.id }, { ...line(day(3), { customerName: 'Vaal Steel', overtimeHours: 2 }), entryId: second.id }] as never,
        { comment: 'Week of the Vaal shutdown' },
      ),
    ).rejects.toMatchObject({ violations: [{ code: 'correction_unchanged' }] });
    expect(await events('timesheet_correction_requested')).toHaveLength(0);
  });

  it('one pending at a time: a retry or a second request is refused and nothing is duplicated', async () => {
    const { first, second } = await sendPeriod();
    await ask(correctedLines(first, second));
    await expect(ask(correctedLines(first, second))).rejects.toMatchObject({ violations: [{ code: 'correction_pending' }] });
    const period = await harness.repos.attendance.findPeriod(SIPHO, FROM, TO);
    expect(await harness.repos.attendance.listCorrections(period!.id)).toHaveLength(1);
    expect(await events('timesheet_correction_requested')).toHaveLength(1);
  });

  it('the office — every active Master and Coordinator — is notified once; technicians are not', async () => {
    const { first, second } = await sendPeriod();
    await ask(correctedLines(first, second));
    const office = (await harness.repos.users.list()).filter((u) => (u.role === 'master' || u.role === 'coordinator') && u.active);
    for (const person of office) {
      const notes = (await harness.repos.notifications.list(person.id)).filter((n) => n.type === 'timesheet_correction_requested');
      expect(notes).toHaveLength(1);
    }
    expect((await harness.repos.notifications.list(riaan.id)).some((n) => n.type === 'timesheet_correction_requested')).toBe(false);
  });

  it('the days stay read-only on the sheet itself, and the period cannot be sent again', async () => {
    const { first, second } = await sendPeriod();
    await ask(correctedLines(first, second));
    await expect(saveTimesheetEntry(harness.as(sipho), SIPHO, line(day(4)))).rejects.toMatchObject({ violations: [{ code: 'timesheet_submitted' }] });
    await expect(submitTimesheetPeriod(harness.as(sipho), SIPHO, FROM, TO)).rejects.toMatchObject({ violations: [{ code: 'timesheet_submitted' }] });
    await expect(submitTimesheetPeriod(harness.as(sipho), SIPHO, day(4), day(1))).rejects.toMatchObject({ violations: [{ code: 'period_overlaps_submitted' }] });
  });
});

describe('TS-16 — the office decides', () => {
  it('accepting makes the correction the version in force — sheet, PDF Layout and export — and keeps the original intact', async () => {
    const { period, first, second } = await sendPeriod();
    const correction = await ask(correctedLines(first, second));
    const decided = await decideTimesheetCorrection(harness.as(coordinator), SIPHO, correction.id, { decision: 'accept' });
    expect(decided).toMatchObject({ status: 'accepted', decidedByName: expect.stringContaining('Christene') as unknown });

    const sheet = await loadTimesheet(harness.as(master), SIPHO, FROM, TO);
    expect(sheet.totals.overtimeHours).toBe(6);
    expect(sheet.period.comment).toBe('Week of the Vaal shutdown (corrected)');
    expect(sheet.period.versionInForce).toMatch(/^Correction 1, accepted/u);
    expect(sheet.days.find((d) => d.date === day(4))?.sentVersion).toBe('Sent — correction 1 accepted');

    const current = await loadTimesheetDocument(harness.as(master), SIPHO, FROM, TO);
    expect(current.inForce).toBe(true);
    expect(current.totals.overtimeHours).toBe(6);
    expect(current.versionLabel).toMatch(/^Correction 1, accepted/u);
    const original = await loadTimesheetDocument(harness.as(master), SIPHO, FROM, TO, 'original');
    expect(original.totals.overtimeHours).toBe(3.5);
    expect(original.comment).toBe('Week of the Vaal shutdown');
    expect(original.inForce).toBe(false);
    expect(original.versionLabel).toMatch(/superseded/u);
    expect(original.submittedAt).toBe(period.submittedAt);

    const text = await pdfPlainText(renderTimesheetPdf(current, { generatedAt: '2026-10-29T08:00:00.000Z' }).bytes);
    expect(text).toContain('Version');
    expect(text).toContain('Correction 1, accepted');

    const csv = await exportTimesheet(harness.as(master), SIPHO, FROM, TO);
    expect(csv.columns.at(-1)).toBe('Sent version');
    expect(csv.csv).toContain('Sent — correction 1 accepted');

    // The sent row is exactly as it was.
    expect(await harness.repos.attendance.findPeriod(SIPHO, FROM, TO)).toEqual(period);
    expect(await events('timesheet_correction_accepted')).toHaveLength(1);
    const told = (await harness.repos.notifications.list(SIPHO)).filter((n) => n.type === 'timesheet_correction_decided');
    expect(told).toHaveLength(1);
    expect(told[0]?.title).toMatch(/accepted/u);
  });

  it('rejecting needs a note, changes nothing in force, and a new correction can then be asked for', async () => {
    const { first, second } = await sendPeriod();
    const correction = await ask(correctedLines(first, second));
    await expect(decideTimesheetCorrection(harness.as(master), SIPHO, correction.id, { decision: 'reject' })).rejects.toMatchObject({ violations: [{ code: 'rejection_note_required' }] });
    const rejected = await decideTimesheetCorrection(harness.as(master), SIPHO, correction.id, { decision: 'reject', note: 'The workshop morning was the 4th' });
    expect(rejected.status).toBe('rejected');
    const sheet = await loadTimesheet(harness.as(master), SIPHO, FROM, TO);
    expect(sheet.totals.overtimeHours).toBe(3.5);
    expect(sheet.period.versionInForce).toBe('Original submission');
    const second2 = await ask(correctedLines(first, second), { reason: 'Again, with the date checked' });
    expect(second2.sequence).toBe(2);
    expect(await events('timesheet_correction_rejected')).toHaveLength(1);
  });

  it('a decision is taken once: a retry or the other office user is refused, and it is never reversed', async () => {
    const { first, second } = await sendPeriod();
    const correction = await ask(correctedLines(first, second));
    await decideTimesheetCorrection(harness.as(master), SIPHO, correction.id, { decision: 'accept' });
    await expect(decideTimesheetCorrection(harness.as(master), SIPHO, correction.id, { decision: 'accept' })).rejects.toMatchObject({ violations: [{ code: 'correction_decided' }] });
    await expect(decideTimesheetCorrection(harness.as(coordinator), SIPHO, correction.id, { decision: 'reject', note: 'no' })).rejects.toMatchObject({ violations: [{ code: 'correction_decided' }] });
    expect(await events('timesheet_correction_accepted')).toHaveLength(1);
    expect(await events('timesheet_correction_rejected')).toHaveLength(0);
  });

  it('technicians cannot decide — not even on their own; nor can a decision name the wrong technician', async () => {
    const { first, second } = await sendPeriod();
    const correction = await ask(correctedLines(first, second));
    for (const actor of [sipho, riaan]) {
      await expect(decideTimesheetCorrection(harness.as(actor), SIPHO, correction.id, { decision: 'accept' })).rejects.toMatchObject({ violations: [{ code: 'not_permitted' }] });
    }
    await expect(decideTimesheetCorrection(harness.as(master), riaan.id, correction.id, { decision: 'accept' })).rejects.toMatchObject({ violations: [{ code: 'correction_not_found' }] });
  });

  it('the person who asked cannot decide it (the repository refuses it too)', async () => {
    const { first, second } = await sendPeriod();
    await ask(correctedLines(first, second));
    const period = await harness.repos.attendance.findPeriod(SIPHO, FROM, TO);
    const [pending] = await harness.repos.attendance.listCorrections(period!.id);
    await expect(
      harness.repos.attendance.decideCorrection({ id: pending!.id, status: 'accepted', decidedBy: SIPHO, decidedAt: '2026-10-29T08:00:00.000Z', decisionNote: '' }),
    ).rejects.toThrow(/somebody other/u);
  });

  it('a second accepted correction is corrected from the first, and each version stays previewable', async () => {
    const { first, second } = await sendPeriod();
    const one = await ask(correctedLines(first, second));
    await decideTimesheetCorrection(harness.as(master), SIPHO, one.id, { decision: 'accept' });
    const sheet = await loadTimesheet(harness.as(sipho), SIPHO, FROM, TO);
    const inForce = sheet.days.flatMap((d) => d.entries);
    expect(inForce).toHaveLength(3);
    const two = await requestTimesheetCorrection(harness.as(sipho), SIPHO, {
      from: FROM,
      to: TO,
      reason: 'Vaal Steel km were wrong',
      comment: sheet.period.comment,
      lines: inForce.map((entry) => ({
        entryId: entry.id,
        date: entry.date,
        customerId: entry.customerId,
        customerName: entry.customerName,
        workshop: entry.workshop,
        overtimeHours: entry.overtimeHours,
        doubleHours: entry.doubleHours,
        calloutAmount: entry.calloutAmount,
        calloutShared: entry.calloutShared,
        internalKm: entry.internalKm,
        customerKm: entry.customerName === 'Vaal Steel' ? 80 : entry.customerKm,
      })),
    });
    expect(two.before.entries).toHaveLength(3);
    expect(two.changes).toHaveLength(2);
    await decideTimesheetCorrection(harness.as(coordinator), SIPHO, two.id, { decision: 'accept' });
    const v1 = await loadTimesheetDocument(harness.as(master), SIPHO, FROM, TO, 1);
    expect(v1.inForce).toBe(false);
    expect(v1.versionLabel).toMatch(/superseded by a later/u);
    const now = await loadTimesheetDocument(harness.as(master), SIPHO, FROM, TO);
    expect(now.totals.customerKm).toBe(40 + 80);
    expect(now.versionLabel).toMatch(/^Correction 2/u);
  });

  it("the office's pending list shows waiting corrections only, to the office only", async () => {
    const { first, second } = await sendPeriod();
    const correction = await ask(correctedLines(first, second));
    expect(await listPendingTimesheetCorrections(harness.as(sipho))).toEqual([]);
    const listed = await listPendingTimesheetCorrections(harness.as(master));
    expect(listed).toMatchObject([{ id: correction.id, technicianId: SIPHO, from: FROM, to: TO, sequence: 1 }]);
    await decideTimesheetCorrection(harness.as(master), SIPHO, correction.id, { decision: 'accept' });
    expect(await listPendingTimesheetCorrections(harness.as(coordinator))).toEqual([]);
  });

  it('a technician reads only their own corrections', async () => {
    const { first, second } = await sendPeriod();
    await ask(correctedLines(first, second));
    await expect(loadTimesheet(harness.as(riaan), SIPHO, FROM, TO)).rejects.toMatchObject({ violations: [{ code: 'not_permitted' }] });
    await expect(loadTimesheetDocument(harness.as(riaan), SIPHO, FROM, TO, 1)).rejects.toMatchObject({ violations: [{ code: 'not_permitted' }] });
  });
});
