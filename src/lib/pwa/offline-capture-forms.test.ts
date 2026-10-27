import { describe, expect, it } from 'vitest';
import { buildOfflineCapture, emptyOfflineCaptureFields } from './offline-capture-forms';
import { isRowForJob } from './pending-work';
import { SYNC_LABEL, syncStateOf } from './sync-state';

/**
 * OFF-2 and OFF-8, completed 27 October 2026. The forms hold only what the
 * server's command schemas would accept; the five sync states are named once.
 */
const blank = emptyOfflineCaptureFields('2026-10-27');

describe('capturing on the tablet’s copy of a job (OFF-2)', () => {
  it('shapes labour exactly as add_labour takes it', () => {
    const built = buildOfflineCapture('labour', { ...blank, hours: '2,5', rateType: 'overtime', description: ' Fan ' });
    expect(built).toEqual({
      ok: true,
      action: 'add_labour',
      payload: { date: '2026-10-27', rateType: 'overtime', hours: 2.5, description: 'Fan' },
      summary: '2.5 h overtime — Fan',
    });
  });

  it('refuses labour the server would refuse: no hours, more than 24, no date', () => {
    for (const hours of ['', '0', '25', 'abc']) {
      const built = buildOfflineCapture('labour', { ...blank, hours });
      expect(built.ok, hours).toBe(false);
    }
    expect(buildOfflineCapture('labour', { ...blank, hours: '1', date: '27/10/2026' }).ok).toBe(false);
  });

  it('shapes travel, a part in whole cents, and a note', () => {
    expect(buildOfflineCapture('travel', { ...blank, kilometres: '42' })).toMatchObject({
      ok: true,
      action: 'add_travel',
      payload: { date: '2026-10-27', kilometres: 42, description: '' },
    });
    expect(
      buildOfflineCapture('part', { ...blank, partNumber: 'FAN-220', quantity: '2', unitPrice: '485.50' }),
    ).toMatchObject({ ok: true, action: 'add_part', payload: { partNumber: 'FAN-220', quantity: 2, unitPrice: 48_550 } });
    expect(buildOfflineCapture('note', { ...blank, body: 'Gate 4', internal: true })).toMatchObject({
      ok: true,
      action: 'add_note',
      payload: { body: 'Gate 4', internal: true },
    });
  });

  it('refuses a part with no number, a fractional quantity or no price, and an empty note', () => {
    expect(buildOfflineCapture('part', { ...blank, partNumber: '', unitPrice: '1' }).ok).toBe(false);
    expect(buildOfflineCapture('part', { ...blank, partNumber: 'X', quantity: '1.5', unitPrice: '1' }).ok).toBe(false);
    expect(buildOfflineCapture('part', { ...blank, partNumber: 'X', unitPrice: '' }).ok).toBe(false);
    expect(buildOfflineCapture('note', { ...blank, body: '   ' }).ok).toBe(false);
  });

  it('matches a row held against the job number to the same job', () => {
    expect(isRowForJob({ jobId: 'EJE-1048' }, 'job-uuid', 'EJE-1048')).toBe(true);
    expect(isRowForJob({ jobId: 'job-uuid' }, 'job-uuid', 'EJE-1048')).toBe(true);
    expect(isRowForJob({ jobId: 'EJE-1049' }, 'job-uuid', 'EJE-1048')).toBe(false);
    expect(isRowForJob({ jobId: 'EJE-1048' }, 'job-uuid')).toBe(false);
  });
});

describe('the five sync states (OFF-8)', () => {
  it('names every state a held row can be in, and keeps "Not sent" on the held ones', () => {
    expect(syncStateOf({ state: 'pending', sending: false, online: false })).toBe('saved_locally');
    expect(syncStateOf({ state: 'pending', sending: false, online: true })).toBe('waiting');
    expect(syncStateOf({ state: 'pending', sending: true, online: true })).toBe('syncing');
    expect(syncStateOf({ state: 'conflict', sending: false, online: true })).toBe('action_required');
    expect(syncStateOf({ state: 'referred', sending: false, online: true })).toBe('with_office');
    expect(SYNC_LABEL.saved_locally).toContain('Not sent');
    expect(SYNC_LABEL.waiting).toContain('Not sent');
    expect(SYNC_LABEL.action_required).toContain('Refused');
  });
});
