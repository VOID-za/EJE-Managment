import { describe, expect, it } from 'vitest';
import {
  canEditJob,
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
import { emptyCompletionReport, type Job, type JobTypeCode } from '../types/job';

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
  faultDescription: 'Machine stopped during operation. Spindle fault reported.',
  attachments: [],
  primaryTechnicianId: technicianId,
  additionalTechnicianIds: [],
  labour: [],
  travel: [],
  parts: [],
  photos: [],
  videos: [],
  notes: [],
  completionReport: emptyCompletionReport(),
  checklist: null,
  signature: null,
  awaitingSparesReason: '',
  calloutApplied: false,
  courierCollection: false,
  pricingSnapshot: null,
  finalDocument: null,
  delivery: null,
  cancellation: null,
  deletedAt: null,
  deletedBy: null,
  deletionReason: '',
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
