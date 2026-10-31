import { describe, expect, it } from 'vitest';
import {
  canEditJob,
  cancelJobRefusal,
  deleteJobRefusal,
  isJobWorkable,
  canTransition,
  checkReadyForSignature,
  checkReadyForSubmission,
  isJobEditable,
} from './workflow';
import {
  asContactId,
  asCustomerId,
  asJobId,
  asLineItemId,
  asMachineId,
  asSiteId,
  asUserId,
} from '../types/common';
import {
  emptyCompletionReport,
  emptyRepairItem,
  type Job,
  type JobTypeCode,
} from '../types/job';

const technicianId = asUserId('user-tech-1');

const buildJob = (overrides: Partial<Job> = {}, jobType: JobTypeCode = 'breakdown'): Job => ({
  id: asJobId('job-1'),
  jobNumber: 'EJE-1048',
  customerId: asCustomerId('cust-1'),
  siteId: asSiteId('site-1'),
  contactId: asContactId('contact-1'),
  machineId: asMachineId('machine-1'),
  jobType,
  priority: 'urgent',
  status: 'completion',
  scheduledDate: '2026-09-15',
  scheduledEndDate: null,
  orderNumber: 'PO-88123',
  referenceNumber: 'REF-2291',
  repairItem: emptyRepairItem(),
  moreRepairItems: [],
  quoteNumber: '',
  dateReceived: null,
  faultDescription: 'Machine stopped during operation. Spindle fault reported.',
  attachments: [],
  primaryTechnicianId: technicianId,
  additionalTechnicianIds: [],
  labour: [],
  travel: [],
  parts: [],
  additionalCharges: [],
  discount: null,
  photos: [],
  videos: [],
  notes: [],
  completionReport: emptyCompletionReport(),
  checklist: null,
  signature: null,
  signatureRefusals: [],
  sparesRequest: null,
  calloutApplied: false,
  testBenchApplied: false,
  courierCollection: false,
  waybillNumber: '',
  deliveryNote: '',
  pricingSnapshot: null,
  finalDocument: null,
  delivery: null,
  cancellation: null,

  officeHandling: null,

  invoice: null,
  createdAt: '2026-09-15T06:00:00.000Z',
  createdBy: asUserId('user-master-1'),
  acceptedAt: null,
  completedAt: null,
  submittedAt: null,
  closedAt: null,
  ...overrides,
});

const withWork = (overrides: Partial<Job> = {}, jobType: JobTypeCode = 'breakdown'): Job =>
  buildJob(
    {
      completionReport: { ...emptyCompletionReport(), workPerformed: 'Replaced spindle drive.' },
      labour: [
        {
          id: asLineItemId('l1'),
          technicianId,
          date: '2026-09-15',
          rateType: 'normal',
          hours: 3,
          description: 'Fault finding and repair',
          capturedAt: '2026-09-15T09:00:00.000Z',
          capturedBy: technicianId,
        },
      ],
      ...overrides,
    },
    jobType,
  );

describe('job workflow transitions', () => {
  it('allows acceptance to move an open job straight into progress', () => {
    expect(canTransition('open', 'in_progress')).toBe(true);
  });

  it('does not allow an open job to skip to completion', () => {
    expect(canTransition('open', 'completion')).toBe(false);
  });

  it('allows awaiting spares to be entered and left repeatedly', () => {
    expect(canTransition('in_progress', 'awaiting_spares')).toBe(true);
    expect(canTransition('awaiting_spares', 'in_progress')).toBe(true);
  });

  it('treats only a closed job as final', () => {
    expect(isJobEditable('closed')).toBe(false);
    // Master Review is deliberately still editable — that is its purpose.
    expect(isJobEditable('submitted')).toBe(true);
    expect(isJobEditable('in_progress')).toBe(true);
  });

  it('restricts Master Review to Masters', () => {
    expect(canEditJob('master', 'submitted')).toBe(true);
    expect(canEditJob('technician', 'submitted')).toBe(false);
    expect(canEditJob('master', 'closed')).toBe(false);
    expect(canEditJob('technician', 'closed')).toBe(false);
    expect(canEditJob('technician', 'completion')).toBe(true);
  });

  it('lets a Master capture work during Master Review, but not a technician', () => {
    expect(isJobWorkable('master', 'submitted')).toBe(true);
    expect(isJobWorkable('technician', 'submitted')).toBe(false);
    expect(isJobWorkable('technician', 'in_progress')).toBe(true);
    expect(isJobWorkable('master', 'closed')).toBe(false);
  });
});

describe('checkReadyForSignature', () => {
  it('blocks signature when work performed and labour are missing', () => {
    const check = checkReadyForSignature(buildJob());
    expect(check.allowed).toBe(false);
    expect(check.violations.map((v) => v.code)).toEqual([
      'work_performed_required',
      'labour_required',
    ]);
  });

  it('allows signature on a breakdown once work and labour are captured', () => {
    expect(checkReadyForSignature(withWork()).allowed).toBe(true);
  });

  it('requires a completed checklist for service jobs', () => {
    const check = checkReadyForSignature(withWork({}, 'service'));
    expect(check.violations.map((v) => v.code)).toContain('checklist_missing');
  });

  it('requires photos as well as a checklist for installation jobs', () => {
    const check = checkReadyForSignature(withWork({}, 'installation'));
    const codes = check.violations.map((v) => v.code);
    expect(codes).toContain('checklist_missing');
    expect(codes).toContain('photos_required');
  });
});

describe('checkReadyForSubmission', () => {
  it('requires a customer signature', () => {
    const check = checkReadyForSubmission(withWork());
    expect(check.allowed).toBe(false);
    expect(check.violations.map((v) => v.code)).toContain('signature_required');
  });

  it('passes once the customer has signed a complete job', () => {
    const job = withWork({
      signature: {
        customerName: 'Pieter',
        customerSurname: 'Nel',
        strokeData: 'demo-signature',
        signedAt: '2026-09-15T14:30:00.000Z',
        declaration: 'I confirm that the work described above has been completed.',
      },
    });
    expect(checkReadyForSubmission(job).allowed).toBe(true);
  });
});

/**
 * WHY ENDING A JOB WAS REFUSED. AUD-9.
 *
 * The kind is decided here and nowhere else, so this is where it is tested.
 * The API turns `permission` into a 403 whose presentation REPLACES the
 * server's sentence, and `state` into a 422 that keeps it — so a kind decided
 * wrongly here shows the wrong thing to a real person, which is what AUD-9
 * turned out to be.
 */
describe('ending a job: why it was refused', () => {
  const openUnassigned = (): Job =>
    buildJob({ status: 'open', primaryTechnicianId: null, additionalTechnicianIds: [], acceptedAt: null });

  it('allows the office on an Open unassigned job — no refusal at all', () => {
    expect(cancelJobRefusal('master', openUnassigned())).toBeNull();
    expect(deleteJobRefusal('master', openUnassigned())).toBeNull();
    expect(cancelJobRefusal('coordinator', openUnassigned())).toBeNull();
    expect(deleteJobRefusal('coordinator', openUnassigned())).toBeNull();
  });

  it('calls a TECHNICIAN a permission refusal, on both actions', () => {
    // True whatever the job does next, so "speak to the office" is the honest
    // advice and a 403 is the honest code.
    expect(cancelJobRefusal('technician', openUnassigned())).toEqual({
      kind: 'permission',
      message: 'Only the office can cancel a job.',
    });
    expect(deleteJobRefusal('technician', openUnassigned())).toEqual({
      kind: 'permission',
      message: 'Only the office can delete a job.',
    });
  });

  it('calls the JOB a state refusal, and keeps the sentence that explains it', () => {
    const assigned = buildJob({ status: 'open', acceptedAt: null });
    expect(cancelJobRefusal('master', assigned)?.kind).toBe('state');
    expect(deleteJobRefusal('master', assigned)?.kind).toBe('state');

    // The one with somewhere else to go still says so — and now that sentence
    // survives, because a state refusal is a 422 rather than a 403.
    const inProgress = buildJob({ status: 'in_progress', acceptedAt: '2026-09-20T07:00:00.000Z' });
    const refusal = deleteJobRefusal('master', inProgress);
    expect(refusal?.kind).toBe('state');
    expect(refusal?.message).toMatch(/Cancel it instead/u);
  });

  it('calls a SIGNED job a state refusal, not a permission one', () => {
    /*
     * The case that was wrong, and the reason it mattered: nobody may delete a
     * signed job card, so telling the office their role is the problem was both
     * false and a dead end.
     */
    for (const status of ['review', 'submitted', 'closed'] as const) {
      const signed = buildJob({ status, acceptedAt: '2026-09-20T07:00:00.000Z' });
      expect(deleteJobRefusal('master', signed)?.kind, status).toBe('state');
      expect(cancelJobRefusal('master', signed)?.kind, status).toBe('state');
    }
  });

  it('calls an already cancelled job a state refusal', () => {
    const cancelled = buildJob({ status: 'cancelled' });
    expect(cancelJobRefusal('master', cancelled)).toEqual({
      kind: 'state',
      message: 'This job is already cancelled.',
    });
  });

  it('answers the role first when BOTH would refuse', () => {
    // A technician on a signed job is refused for who they are: that is
    // permanent, where the state is merely the state of one job.
    const signed = buildJob({ status: 'review', acceptedAt: '2026-09-20T07:00:00.000Z' });
    expect(deleteJobRefusal('technician', signed)?.kind).toBe('permission');
    expect(cancelJobRefusal('technician', signed)?.kind).toBe('permission');
  });
});
