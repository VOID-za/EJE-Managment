import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptJob,
  addLabour,
  addNote,
  addPart,
  captureSignature,
  saveCompletionReport,
  startCompletion,
  startSignature,
  submitJobCard,
  confirmJobCardDelivery,
} from './job-operations';
import { WorkflowError } from './errors';
import { loadJobView } from './job-view';
import type { OperationContext } from './context';
import { createDemoRepositories } from '@/data/demo/repositories';
import { DemoStore } from '@/data/demo/demo-store';
import { SimulatedEmailService } from '@/services/simulated/email';
import { SimulatedOutbox } from '@/services/simulated/outbox';
import { SimulatedPdfService } from '@/services/simulated/pdf';
import { inMemoryFileStore, SimulatedStorageService } from '@/services/simulated/storage';
import { SequentialIdGenerator, SystemClock } from '@/services/simulated/system';
import { SimulatedWhatsAppService } from '@/services/simulated/whatsapp';
import { historicalMasterReview } from './test-harness';
import { seedUsers } from '@/data/seed';
import { calculateJobTotals, canEditJob, type Job, type User } from '@/domain';
import type { RepositoryBundle } from '@/data/repositories';

/**
 * The retired Master Review stage, and issuing from it.
 *
 * Master Review is no longer part of the workflow: a technician's submission
 * issues the job card itself, and nothing transitions a job into `submitted`
 * any more. Jobs that entered it before it was retired still exist, so what is
 * covered here is COMPATIBILITY — such a job stays readable, stays editable by
 * a Master, keeps the rates it was signed at, and can still be issued, sent and
 * closed.
 *
 * The state is therefore built as a fixture, through the repository, exactly as
 * a snapshot saved before the change would present it. There is deliberately no
 * operation that can produce it.
 */
const technician: User = seedUsers.find((user) => user.id === 'user-tech-sipho')!;
const master: User = seedUsers.find((user) => user.id === 'user-master-elmarie')!;

interface Harness {
  readonly tech: OperationContext;
  readonly master: OperationContext;
  readonly repos: RepositoryBundle;
  readonly outbox: SimulatedOutbox;
}

const build = (): Harness => {
  const store = new DemoStore();
  const repos = createDemoRepositories({ read: store.read, commit: store.commit });
  const clock = new SystemClock();
  const ids = new SequentialIdGenerator();
  const outbox = new SimulatedOutbox();

  const services = {
    clock,
    ids,
    email: new SimulatedEmailService(outbox, clock, ids),
    whatsapp: new SimulatedWhatsAppService(outbox, clock, ids),
    pdf: new SimulatedPdfService(clock),
    storage: new SimulatedStorageService(inMemoryFileStore()),
  };

  return {
    repos,
    outbox,
    tech: { repos, services, actor: technician },
    master: { repos, services, actor: master },
  };
};

/** Works EJE-1048 to the point the customer has signed. */
const workAndSign = async (harness: Harness): Promise<Job> => {
  const view = await loadJobView(harness.repos, 'EJE-1048');
  let job = await acceptJob(harness.tech, view!.job);
  job = await addLabour(harness.tech, job, {
    date: '2026-09-17',
    rateType: 'normal',
    hours: 3,
    description: 'Spindle drive repair',
  });
  job = await saveCompletionReport(harness.tech, job, {
    ...job.completionReport,
    workPerformed: 'Replaced the spindle drive cooling fan.',
  });
  job = await startCompletion(harness.tech, job);
  job = await startSignature(harness.tech, job);
  return captureSignature(harness.tech, job, {
    customerName: 'Pieter',
    customerSurname: 'Nel',
    strokeData: 'M0,0 L1,1',
  });
};

/**
 * Stands in for the provider's delivery report.
 *
 * Issuing a job card no longer closes it: the provider has merely accepted the
 * mail. Something has to confirm the customer received it, and in production
 * that is Microsoft 365's delivery report.
 */
const confirmDelivery = async (harness: Harness, job: Job): Promise<Job> => {
  harness.outbox.setDelivery(job.delivery?.messageId ?? '', 'delivered');
  return confirmJobCardDelivery(harness.master, job);
};

const emails = (harness: Harness) =>
  harness.outbox.listSync().filter((entry) => entry.channel === 'email');

describe('a Master can still edit a job left in Master Review', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = build();
  });

  it('permits Master edits and refuses technician edits', () => {
    expect(canEditJob('master', 'submitted')).toBe(true);
    expect(canEditJob('technician', 'submitted')).toBe(false);
    expect(canEditJob('master', 'closed')).toBe(false);
    expect(canEditJob('technician', 'in_progress')).toBe(true);
  });

  it('lets a Master add a part that the technician missed', async () => {
    const signed = await workAndSign(harness);
    const handed = await historicalMasterReview(harness.repos, signed, '2026-09-17T15:00:00.000Z');

    const amended = await addPart(harness.master, handed, {
      partNumber: 'FAN-24V-80',
      description: 'Spindle drive cooling fan',
      quantity: 1,
      unitPrice: 48500,
    });

    expect(amended.parts).toHaveLength(1);
    expect(amended.status).toBe('submitted');
  });

  it('lets a Master add a note during review', async () => {
    const signed = await workAndSign(harness);
    const handed = await historicalMasterReview(harness.repos, signed, '2026-09-17T15:00:00.000Z');

    const amended = await addNote(harness.master, handed, 'Checked against the PO.', true);
    expect(amended.notes.some((note) => note.body === 'Checked against the PO.')).toBe(true);
  });

  it('refuses the same edit from a technician', async () => {
    const signed = await workAndSign(harness);
    const handed = await historicalMasterReview(harness.repos, signed, '2026-09-17T15:00:00.000Z');

    await expect(
      addNote(harness.tech, handed, 'Technician trying to edit.', false),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('prices a Master amendment at the rates frozen at signature', async () => {
    const signed = await workAndSign(harness);
    const rates = await harness.repos.settings.get();
    const handed = await historicalMasterReview(harness.repos, signed, '2026-09-17T15:00:00.000Z');

    // The office raises rates between signature and issue.
    await harness.repos.settings.save({
      ...rates,
      labourRates: { normal: 500000, overtime: 500000, double: 500000 },
    });

    const amended = await addLabour(harness.master, handed, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 1,
      description: 'Master correction',
    });

    const totals = calculateJobTotals(amended, await harness.repos.settings.get());
    // 4 hours total, all at the ORIGINAL frozen rate, not the new one.
    expect(totals.pricing.labourRates.normal).toBe(rates.labourRates.normal);
    expect(totals.labourTotal).toBe(rates.labourRates.normal * 4);
  });

  it('does not let a Master overwrite the customer signature', async () => {
    const signed = await workAndSign(harness);
    const handed = await historicalMasterReview(harness.repos, signed, '2026-09-17T15:00:00.000Z');

    // There is no operation that replaces a signature, and re-signing requires
    // the job to be back at the signature step.
    await expect(
      captureSignature(harness.master, handed, {
        customerName: 'Someone',
        customerSurname: 'Else',
        strokeData: 'M0,0 L1,1',
      }),
    ).rejects.toBeInstanceOf(WorkflowError);

    const reloaded = await harness.repos.jobs.findByJobNumber('EJE-1048');
    expect(reloaded?.signature?.customerName).toBe('Pieter');
    expect(reloaded?.signature?.customerSurname).toBe('Nel');
  });
});

describe('issuing a job left in Master Review', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = build();
  });

  it('emails the customer exactly once', async () => {
    const signed = await workAndSign(harness);
    const handed = await historicalMasterReview(harness.repos, signed, '2026-09-17T15:00:00.000Z');

    const result = await submitJobCard(
      harness.master,
      handed,
      'pieter.nel@abc-engineering-demo.co.za',
      'Pieter Nel',
    );

    const sent = emails(harness);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('pieter.nel@abc-engineering-demo.co.za');
    expect(sent[0]?.attachments).toContain(result.documentFileName);
  });

  it('generates the final document at this point, not before', async () => {
    const signed = await workAndSign(harness);
    const handed = await historicalMasterReview(harness.repos, signed, '2026-09-17T15:00:00.000Z');
    await submitJobCard(harness.master, handed, 'customer@example-demo.co.za', 'Pieter Nel');

    const trail = await harness.repos.activity.list(handed.id);
    const generated = trail.filter((event) => event.type === 'pdf_generated');
    expect(generated).toHaveLength(1);
    expect(generated[0]?.summary).toBe('Final job card document generated');
  });

  it('locks the job as soon as it is issued, before delivery is confirmed', async () => {
    const signed = await workAndSign(harness);
    const handed = await historicalMasterReview(harness.repos, signed, '2026-09-17T15:00:00.000Z');
    const result = await submitJobCard(
      harness.master,
      handed,
      'customer@example-demo.co.za',
      'Pieter Nel',
    );

    // Issued but NOT closed: the provider has the mail, nobody has confirmed
    // the customer received it.
    expect(result.job.status).toBe('awaiting_delivery');
    expect(result.job.closedAt).toBeNull();
    expect(result.delivery.state).toBe('pending_delivery');

    // Already read-only — the document has gone out, so the record must keep
    // matching it.
    expect(canEditJob('master', result.job.status)).toBe(false);
    expect(canEditJob('technician', result.job.status)).toBe(false);
    await expect(
      addNote(harness.master, result.job, 'Too late.', true),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('closes only once delivery is confirmed', async () => {
    const signed = await workAndSign(harness);
    const handed = await historicalMasterReview(harness.repos, signed, '2026-09-17T15:00:00.000Z');
    const result = await submitJobCard(
      harness.master,
      handed,
      'customer@example-demo.co.za',
      'Pieter Nel',
    );
    expect(result.job.status).toBe('awaiting_delivery');

    const closed = await confirmDelivery(harness, result.job);
    expect(closed.status).toBe('closed');
    expect(closed.closedAt).not.toBeNull();
    expect(closed.delivery?.state).toBe('delivered');
    expect(closed.delivery?.confirmedAt).not.toBeNull();
  });

  it('refuses to issue a job that has not reached its customer signature', async () => {
    const view = await loadJobView(harness.repos, 'EJE-1048');
    const open = await acceptJob(harness.tech, view!.job);

    await expect(
      submitJobCard(harness.master, open, 'customer@example-demo.co.za', 'Pieter Nel'),
    ).rejects.toBeInstanceOf(WorkflowError);
    expect(emails(harness)).toHaveLength(0);
  });

  it('includes a Master amendment in the issued document', async () => {
    const signed = await workAndSign(harness);
    const handed = await historicalMasterReview(harness.repos, signed, '2026-09-17T15:00:00.000Z');
    const amended = await addPart(harness.master, handed, {
      partNumber: 'FAN-24V-80',
      description: 'Spindle drive cooling fan',
      quantity: 1,
      unitPrice: 48500,
    });

    const result = await submitJobCard(
      harness.master,
      amended,
      'customer@example-demo.co.za',
      'Pieter Nel',
    );

    expect(result.job.parts).toHaveLength(1);
  });
});
