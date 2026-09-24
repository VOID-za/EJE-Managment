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
import { inMemoryFileStore, DemoStorageService } from '@/services/simulated/storage';
import { SequentialIdGenerator, SystemClock } from '@/services/simulated/system';
import { SimulatedWhatsAppService } from '@/services/simulated/whatsapp';
import { historicalMasterReview } from './test-harness';
import { seedUsers } from '@/data/seed';
import {
  calculateJobTotals,
  canEditJob,
  canEditJobRecord,
  isFinalized,
  type Job,
  type User,
} from '@/domain';
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
    storage: new DemoStorageService(inMemoryFileStore()),
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

/**
 * A JOB LEFT IN MASTER REVIEW IS STILL A SIGNED JOB. MASTER SCOPE CR-01.
 *
 * This block asserted the opposite — that a Master could keep editing one —
 * because that was the requirement when the retired stage was built: the whole
 * point of Master Review was that the office corrected the card before issuing
 * it. The business has since ruled that a customer-signed job card is legally
 * final, so the historical stage no longer carries an editing right. Being old
 * data does not make it less signed.
 *
 * What is preserved, and still asserted below, is everything else about
 * compatibility: such a job stays readable, keeps the rates it was signed at,
 * and can still be issued, sent and closed.
 */
describe('a job left in Master Review is final, because the customer signed it', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = build();
  });

  it('still answers the STATUS question the same way', () => {
    // `canEditJob` is the status half of the rule and is unchanged. It is no
    // longer the whole rule: `canEditJobRecord` adds the signature.
    expect(canEditJob('master', 'submitted')).toBe(true);
    expect(canEditJob('technician', 'submitted')).toBe(false);
    expect(canEditJob('master', 'closed')).toBe(false);
    expect(canEditJob('technician', 'in_progress')).toBe(true);
  });

  it('is closed to editing once the signature is taken into account', async () => {
    const signed = await workAndSign(harness);
    const handed = await historicalMasterReview(harness.repos, signed, '2026-09-17T15:00:00.000Z');

    expect(isFinalized(handed)).toBe(true);
    expect(canEditJobRecord('master', handed)).toBe(false);
    expect(canEditJobRecord('coordinator', handed)).toBe(false);
    expect(canEditJobRecord('technician', handed)).toBe(false);
  });

  it('REFUSES a Master adding a part the technician missed', async () => {
    const signed = await workAndSign(harness);
    const handed = await historicalMasterReview(harness.repos, signed, '2026-09-17T15:00:00.000Z');

    await expect(
      addPart(harness.master, handed, {
        partNumber: 'FAN-24V-80',
        description: 'Spindle drive cooling fan',
        quantity: 1,
        unitPrice: 48500,
      }),
    ).rejects.toThrow(/final and cannot be changed/i);

    // Refused, and nothing was written.
    const reloaded = await harness.repos.jobs.findByJobNumber('EJE-1048');
    expect(reloaded?.parts).toHaveLength(0);
  });

  it('REFUSES a Master adding a note during review', async () => {
    const signed = await workAndSign(harness);
    const handed = await historicalMasterReview(harness.repos, signed, '2026-09-17T15:00:00.000Z');

    await expect(
      addNote(harness.master, handed, 'Checked against the PO.', true),
    ).rejects.toThrow(/final and cannot be changed/i);
  });

  it('refuses the same edit from a technician', async () => {
    const signed = await workAndSign(harness);
    const handed = await historicalMasterReview(harness.repos, signed, '2026-09-17T15:00:00.000Z');

    await expect(
      addNote(harness.tech, handed, 'Technician trying to edit.', false),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('keeps the rates it was signed at when the office raises them', async () => {
    /*
     * The pricing rule this case has always been about is unchanged and still
     * matters — it is what stops a rate rise re-pricing a job the customer has
     * already agreed to. What changed is that it is no longer demonstrated by
     * AMENDING the signed job, because that is now refused. The frozen
     * snapshot is asserted directly instead.
     */
    const signed = await workAndSign(harness);
    const rates = await harness.repos.settings.get();
    const handed = await historicalMasterReview(harness.repos, signed, '2026-09-17T15:00:00.000Z');

    await harness.repos.settings.save({
      ...rates,
      labourRates: { normal: 500000, overtime: 500000, double: 500000 },
    });

    const totals = calculateJobTotals(handed, await harness.repos.settings.get());
    expect(totals.pricing.labourRates.normal).toBe(rates.labourRates.normal);
    expect(totals.labourTotal).toBe(rates.labourRates.normal * 3);
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

  it('issues exactly what the customer signed, with nothing added to it', async () => {
    /*
     * This asserted that a Master's amendment reached the issued document —
     * which was right while the office could amend a signed card, and is the
     * precise thing CR-01 now prohibits. Inverted: the amendment is refused,
     * and the document that goes to the customer carries the work they signed
     * for and no more.
     */
    const signed = await workAndSign(harness);
    const handed = await historicalMasterReview(harness.repos, signed, '2026-09-17T15:00:00.000Z');

    await expect(
      addPart(harness.master, handed, {
        partNumber: 'FAN-24V-80',
        description: 'Spindle drive cooling fan',
        quantity: 1,
        unitPrice: 48500,
      }),
    ).rejects.toThrow(/final and cannot be changed/i);

    const result = await submitJobCard(
      harness.master,
      handed,
      'customer@example-demo.co.za',
      'Pieter Nel',
    );

    expect(result.job.parts).toHaveLength(0);
    expect(result.job.labour).toHaveLength(1);
  });
});
