import { beforeEach, describe, expect, it } from 'vitest';
import {
  asActivityId,
  asNotificationId,
  NOTIFICATION_CATEGORY,
  notificationCategory,
  type NotificationType,
} from '@/domain';
import { fitSignatureBox, padToSignature, SIGNATURE_ASPECT, signatureToPad, strokesToPath } from '@/lib/signature';
import { isUsableRange } from '@/lib/remembered-range';
import { pdfPageTexts } from '@/lib/pdf/inspect';
import { renderAttendancePdf } from '@/services/simulated/attendance-pdf';
import { buildHarness, seedUser, type Harness } from './test-harness';
import {
  ACTIVITY_RETENTION_STATE,
  NOTIFICATION_RETENTION_STATE,
  retentionReport,
  runRetention,
} from './retention';
import { loadAttendancePeriodDocument } from './attendance-document';
import { recordAttendance } from './attendance-operations';
import { WorkflowError } from './errors';

/**
 * THE TESTER'S CRITICAL FIXES OF 2 NOVEMBER 2026 that have no older suite to
 * live in: notification and activity retention (RETAIN-1/2), the Inbox
 * subtabs (NOTIF-TABS-1), the signature's shape (SIG-MOBILE-1), the attendance
 * period PDF (ATT-RANGE-1, PDF-NAME-1) and remembered filters (FILTER-MEM-1).
 */
const NOW = '2026-11-02T10:00:00.000Z';
const daysAgo = (days: number, extraMs = 0): string => new Date(Date.parse(NOW) - days * 86_400_000 - extraMs).toISOString();
const master = seedUser('user-master-elmarie');
const sipho = seedUser('user-tech-sipho');

describe('notification and activity retention (RETAIN-1, RETAIN-2)', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = buildHarness({ clock: { now: () => NOW } });
    for (const [id, age] of [['n-old', 20], ['n-15', 15], ['n-14', 14], ['n-new', 0]] as const) {
      await harness.repos.notifications.create({
        id: asNotificationId(id),
        recipientId: master.id,
        type: 'job_assigned',
        title: id,
        body: '',
        jobId: null,
        link: null,
        createdAt: daysAgo(age),
        readAt: null,
        handledAt: null,
        channels: ['in_app'],
      });
    }
    for (const [id, age] of [['a-old', 30], ['a-8', 8], ['a-6', 6]] as const) {
      await harness.repos.activity.append({
        id: asActivityId(id),
        jobId: null,
        type: 'settings_updated',
        summary: id,
        detail: '',
        actorId: master.id,
        occurredAt: daysAgo(age),
        changes: [],
      });
    }
  });

  const titles = async () => (await harness.repos.notifications.list(master.id)).map((n) => n.title);
  const summaries = async () => (await harness.repos.activity.list()).map((event) => event.summary);

  it('deletes notifications 15 days old or older, and activity older than 7 days — nothing else', async () => {
    const jobsBefore = JSON.stringify(await harness.repos.jobs.list());
    const usersBefore = (await harness.repos.users.list()).length;
    const activityBefore = (await harness.repos.activity.list()).length;
    const run = await runRetention(harness.repos, NOW);
    expect(await titles()).toEqual(expect.arrayContaining(['n-14', 'n-new']));
    expect(await titles()).not.toEqual(expect.arrayContaining(['n-old']));
    expect((await titles()).includes('n-15')).toBe(false);
    expect(await summaries()).toEqual(expect.arrayContaining(['a-6']));
    expect((await summaries()).some((summary) => summary === 'a-8' || summary === 'a-old')).toBe(false);
    expect(run.notifications?.deleted).toBeGreaterThanOrEqual(2);
    expect(run.activity?.deleted).toBeGreaterThanOrEqual(2);
    // The business records they referred to are untouched.
    expect(JSON.stringify(await harness.repos.jobs.list())).toBe(jobsBefore);
    expect((await harness.repos.users.list()).length).toBe(usersBefore);
    // The cleanup wrote no activity of its own: the trail only shrank.
    expect((await harness.repos.activity.list()).length).toBeLessThan(activityBefore);
    expect((await harness.repos.activity.list()).some((event) => /retention|cleanup/iu.test(event.summary))).toBe(false);
  });

  it('records each run, and runs activity only every 7 days; a repeat run is harmless', async () => {
    await runRetention(harness.repos, NOW);
    const report = await retentionReport(harness.repos);
    expect(report.notifications?.ranAt).toBe(NOW);
    expect(report.activity?.ranAt).toBe(NOW);
    expect(await harness.repos.integrations.findState(NOTIFICATION_RETENTION_STATE)).not.toBeNull();
    expect(await harness.repos.integrations.findState(ACTIVITY_RETENTION_STATE)).not.toBeNull();

    // An hour later: notifications are due again, activity is not.
    const later = new Date(Date.parse(NOW) + 3_600_000).toISOString();
    const again = await runRetention(harness.repos, later);
    expect(again.notifications).not.toBeNull();
    expect(again.notifications?.deleted).toBe(0);
    expect(again.activity).toBeNull();

    // Seven days on, the activity cleanup runs again.
    const week = new Date(Date.parse(NOW) + 7 * 86_400_000).toISOString();
    expect((await runRetention(harness.repos, week)).activity).not.toBeNull();
  });

  it('keeps read and unread intact for what remains', async () => {
    const kept = (await harness.repos.notifications.list(master.id)).find((n) => n.title === 'n-14')!;
    await harness.repos.notifications.markRead(kept.id);
    await runRetention(harness.repos, NOW);
    const after = await harness.repos.notifications.list(master.id);
    expect(after.find((n) => n.title === 'n-14')?.readAt).not.toBeNull();
    expect(after.find((n) => n.title === 'n-new')?.readAt).toBeNull();
  });
});

describe('the Inbox subtabs (NOTIF-TABS-1)', () => {
  it('classifies every notification type into exactly one of Jobcards, Messages and Forms', () => {
    const types = Object.keys(NOTIFICATION_CATEGORY) as NotificationType[];
    expect(types.length).toBeGreaterThanOrEqual(14);
    for (const type of types) expect(['jobcards', 'messages', 'monthly_forms', 'standby']).toContain(notificationCategory(type));
    expect(notificationCategory('chat_message')).toBe('messages');
    expect(types.filter((type) => notificationCategory(type) === 'messages')).toEqual(['chat_message']);
    for (const type of ['job_assigned', 'job_transferred', 'job_submitted', 'signature_refused'] as const) {
      expect(notificationCategory(type)).toBe('jobcards');
    }
    for (const type of ['timesheet_submitted', 'timesheet_correction_requested', 'timesheet_correction_decided'] as const) {
      expect(notificationCategory(type)).toBe('monthly_forms');
    }
    // NOTIF-TABS-2: every standby notification is in Standby, none in Monthly Forms.
    expect(types.filter((type) => type.startsWith('standby_')).every((type) => notificationCategory(type) === 'standby')).toBe(true);
    expect(types.filter((type) => notificationCategory(type) === 'standby').every((type) => type.startsWith('standby_'))).toBe(true);
  });
});

describe('the signature keeps its shape on every screen (SIG-MOBILE-1)', () => {
  it('maps a phone-shaped pad into the 4:1 signature space without squashing it', () => {
    // A phone pad: 330 × 256. A stroke corner to corner of the pad.
    const top = padToSignature(0, 0, 330, 256);
    const bottom = padToSignature(330, 256, 330, 256);
    // The full HEIGHT of the pad is the full height of the signature: not a thin line.
    expect(top.y).toBeCloseTo(0, 5);
    expect(bottom.y).toBeCloseTo(1, 5);
    // And the width keeps the pad's proportions in a 4:1 space: 330/256 of the height.
    const widthInHeights = (bottom.x - top.x) * SIGNATURE_ASPECT;
    expect(widthInHeights).toBeCloseTo(330 / 256, 5);
  });

  it('uses the whole width of a wide desktop pad, and round-trips back to the pad exactly', () => {
    const left = padToSignature(0, 104, 832, 208);
    const right = padToSignature(832, 104, 832, 208);
    expect(left.x).toBeCloseTo(0, 5);
    expect(right.x).toBeCloseTo(1, 5);
    for (const [w, h] of [[330, 256], [700, 208], [832, 208]] as const) {
      const back = signatureToPad(padToSignature(123, 45, w, h), w, h);
      expect(back.x).toBeCloseTo(123, 5);
      expect(back.y).toBeCloseTo(45, 5);
    }
    expect(strokesToPath([[padToSignature(0, 0, 330, 256), padToSignature(330, 256, 330, 256)]])).toMatch(/^M[\d.]+,0\.000 L[\d.]+,1\.000$/u);
  });

  it('draws a stored signature into a 4:1 box, centred, never stretched', () => {
    const box = fitSignatureBox({ x: 10, y: 7, width: 225, height: 48 });
    expect(box.width / box.height).toBeCloseTo(SIGNATURE_ASPECT, 5);
    expect(box.height).toBe(48);
    expect(box.x).toBeCloseTo(10 + (225 - 192) / 2, 5);
  });
});

describe('the attendance period PDF (ATT-RANGE-1, PDF-NAME-1, PDF-NOTES-OFF-1)', () => {
  it('lists the period oldest first, across months, named for its months, with no Notes column', async () => {
    const harness = buildHarness({ clock: { now: () => '2026-11-20T10:00:00.000Z' } });
    for (const date of ['2026-11-03', '2026-10-28', '2026-10-15']) {
      await recordAttendance(harness.as(sipho), { userId: sipho.id, date, status: 'absent', absenceReason: 'sick_leave', note: 'A private note' });
    }
    const doc = await loadAttendancePeriodDocument(harness.as(sipho), '2026-10-10', '2026-11-10');
    expect(doc.fileName).toBe('SIPHO Atten Oct-Nov.pdf');
    expect(doc.rows.map((row) => row.date)).toEqual(['2026-10-15', '2026-10-28', '2026-11-03']);
    const text = pdfPageTexts(renderAttendancePdf(doc, { generatedAt: '2026-11-20T10:00:00.000Z' }).bytes).join(' ');
    expect(text).toContain('Period');
    expect(text).not.toContain('A private note');
    expect(text).not.toMatch(/\bNote\b/u);
  });

  it('prints a full 92-day period, every day recorded, as one PDF', async () => {
    const harness = buildHarness({ clock: { now: () => '2026-12-31T10:00:00.000Z' } });
    const days: string[] = [];
    for (let at = Date.parse('2026-10-01T00:00:00Z'); at <= Date.parse('2026-12-31T00:00:00Z'); at += 86_400_000) {
      days.push(new Date(at).toISOString().slice(0, 10));
    }
    expect(days).toHaveLength(92);
    for (const date of days) await recordAttendance(harness.as(sipho), { userId: sipho.id, date, status: 'present', note: '' });
    const doc = await loadAttendancePeriodDocument(harness.as(sipho), '2026-10-01', '2026-12-31');
    expect(doc.fileName).toBe('SIPHO Atten Oct-Dec.pdf');
    expect(doc.rows).toHaveLength(92);
    const rendered = renderAttendancePdf(doc, { generatedAt: '2026-12-31T10:00:00.000Z' });
    // One page: the route refuses a form that would not fit on one legible page.
    expect(rendered.pageCount).toBe(1);
  });

  it('refuses a period over 92 days or backwards, and is always one’s own', async () => {
    const harness = buildHarness({ clock: { now: () => NOW } });
    await expect(loadAttendancePeriodDocument(harness.as(sipho), '2026-06-01', '2026-11-01')).rejects.toBeInstanceOf(WorkflowError);
    await expect(loadAttendancePeriodDocument(harness.as(sipho), '2026-11-01', '2026-10-01')).rejects.toBeInstanceOf(WorkflowError);
    const mine = await loadAttendancePeriodDocument(harness.as(master), '2026-10-01', '2026-10-31');
    expect(mine.technicianName).toBe('Elmarie Coetzee');
  });
});

describe('remembered From/To (FILTER-MEM-1)', () => {
  it('accepts only a real, ordered range within the page’s limit', () => {
    expect(isUsableRange({ from: '2026-10-01', to: '2026-11-30' }, 92)).toBe(true);
    expect(isUsableRange({ from: '2026-11-30', to: '2026-10-01' }, 92)).toBe(false);
    expect(isUsableRange({ from: '2026-06-01', to: '2026-11-30' }, 92)).toBe(false);
    expect(isUsableRange({ from: '2026-02-30', to: '2026-03-01' }, 92)).toBe(false);
    expect(isUsableRange('2026-10-01', 92)).toBe(false);
    expect(isUsableRange(null, 92)).toBe(false);
  });
});
