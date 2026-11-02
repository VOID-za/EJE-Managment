import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptJob,
  addLabour,
  attachDocument,
  cancelJob,
  captureSignature,
  issueJobCard,
  loadJobAttachmentsArchive,
  saveCompletionReport,
  setCustomerEmailDocument,
  startCompletion,
  startSignature,
} from './job-operations';
import { loadJobView } from './job-view';
import { customerPricingInputs, saveCustomerRates, setCustomerRateMode } from './customer-rates';
import { updateSettings } from './settings-operations';
import { attemptCustomerEmail } from './customer-email';
import { buildHarness, seedUser, type Harness } from './test-harness';
import { WorkflowError } from './errors';
import {
  EMAIL_ATTACHMENTS_MAX_BYTES,
  assignableRoles,
  calculateJobTotals,
  can,
  completesTimesheet,
  isFieldRole,
  roleLabel,
  type Capability,
  type Job,
  type PricingInputs,
  type User,
} from '@/domain';
import { readStoredZip } from '@/lib/zip';
import { sniffJobContainer, validateJobDocumentUpload } from '@/server/api/uploads';
import { jobAttachmentProblem } from '@/lib/upload-limits';

/**
 * THE NEXT CRITICAL BATCH, 2 November 2026 — the rules behind the screens:
 * attachments and the customer email (JOB-ATT-1…3), cancellation by every role
 * (CANCEL-ALL-1), the Apprentice role and the renamed roles (ROLE-APP-1,
 * ROLE-LABEL-1), and customer-specific rates (CUST-RATES-1).
 */
const technician = seedUser('user-tech-sipho');
const otherTech = seedUser('user-tech-riaan');
const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');
const ADDRESS = 'pieter@abc-engineering.example';

let harness: Harness;
beforeEach(() => {
  harness = buildHarness();
});

const codeOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (cause) {
    if (cause instanceof WorkflowError) return cause.violations[0]?.code ?? 'workflow_error';
    throw cause;
  }
  throw new Error('expected the operation to be refused');
};

const job1048 = async (): Promise<Job> => (await harness.repos.jobs.findByJobNumber('EJE-1048'))!;

const workAndSign = async (as: User = technician): Promise<Job> => {
  const context = harness.as(as);
  let job = await acceptJob(context, await job1048());
  job = await addLabour(context, job, { date: '2026-09-17', rateType: 'normal', hours: 3, description: 'Spindle drive repair' });
  job = await saveCompletionReport(context, job, { ...job.completionReport, workPerformed: 'Replaced the fan.' });
  job = await startCompletion(context, job);
  job = await startSignature(context, job);
  return captureSignature(context, job, { customerName: 'Pieter', customerSurname: 'Nel', strokeData: 'M0,0 L1,1' });
};

const PK = (body: string) => new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode(body)]);
const OLE = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3]);
const PDF = (body: string) => new TextEncoder().encode(`%PDF-1.4\n${body}\n%%EOF`);

describe('JOB-ATT-1: a job takes ZIP and office documents, decided by the bytes', () => {
  it('accepts a ZIP and Word/Excel/PowerPoint files, current and older formats', () => {
    expect(sniffJobContainer('Drawings.zip', PK('x'))).toBe('application/zip');
    expect(sniffJobContainer('Quote.docx', PK('x'))).toMatch(/wordprocessingml/u);
    expect(sniffJobContainer('Parts.xlsx', PK('x'))).toMatch(/spreadsheetml/u);
    expect(sniffJobContainer('Slides.pptx', PK('x'))).toMatch(/presentationml/u);
    expect(sniffJobContainer('Old.doc', OLE)).toBe('application/msword');
    expect(sniffJobContainer('Old.xls', OLE)).toBe('application/vnd.ms-excel');
    expect(validateJobDocumentUpload({ fileName: 'a.zip', declaredContentType: 'application/zip', bytes: PK('x') }).contentType).toBe('application/zip');
    expect(validateJobDocumentUpload({ fileName: 'order.pdf', declaredContentType: 'application/pdf', bytes: PDF('o') }).contentType).toBe('application/pdf');
  });

  it('refuses a file merely CALLED .zip, an OLE file with any other name, an empty or oversized file, and video', () => {
    expect(() => validateJobDocumentUpload({ fileName: 'fake.zip', declaredContentType: 'application/zip', bytes: new TextEncoder().encode('not a zip') })).toThrow();
    expect(sniffJobContainer('evil.exe', OLE)).toBeNull();
    expect(() => validateJobDocumentUpload({ fileName: 'x.zip', declaredContentType: '', bytes: new Uint8Array(0) })).toThrow();
    expect(() => validateJobDocumentUpload({ fileName: 'x.zip', declaredContentType: '', bytes: new Uint8Array(25 * 1024 * 1024 + 1).fill(0x50) })).toThrow();
    expect(jobAttachmentProblem({ name: 'clip.mp4', type: 'video/mp4', size: 10 })).toMatch(/video/u);
    expect(jobAttachmentProblem({ name: 'Drawings.zip', type: 'application/x-zip-compressed', size: 10 })).toBeNull();
    expect(jobAttachmentProblem({ name: 'run.exe', type: 'application/x-msdownload', size: 10 })).not.toBeNull();
  });
});

describe('JOB-ATT-2: Download Attachments — one ZIP of the original files', () => {
  it('holds every document byte for byte, with duplicate names numbered, and only this job’s', async () => {
    let job = await acceptJob(harness.as(technician), await job1048());
    const order = PDF('customer order');
    const zip = PK('drawings');
    job = await attachDocument(harness.as(technician), job, { fileName: 'Order.pdf', contentType: 'application/pdf', bytes: order, caption: '' });
    job = await attachDocument(harness.as(technician), job, { fileName: 'Order.pdf', contentType: 'application/pdf', bytes: PDF('second order'), caption: '' });
    job = await attachDocument(harness.as(technician), job, { fileName: 'Drawings.zip', contentType: 'application/zip', bytes: zip, caption: '' });
    expect(job.attachments.length).toBeGreaterThanOrEqual(3);
    const archive = await loadJobAttachmentsArchive(harness.as(technician), job);
    expect(archive?.fileName).toBe('EJE-1048 Attachments.zip');
    const entries = readStoredZip(archive!.bytes);
    const names = entries.map((entry) => entry.name);
    expect(names).toEqual(expect.arrayContaining(['Order.pdf', 'Order (2).pdf', 'Drawings.zip']));
    expect(entries.find((entry) => entry.name === 'Order.pdf')!.bytes).toEqual(order);
    expect(entries.find((entry) => entry.name === 'Drawings.zip')!.bytes).toEqual(zip);
  });

  it('is nothing at all for a job without documents (the button is not drawn)', async () => {
    const job = await job1048();
    const bare: Job = { ...job, attachments: [] };
    expect(await loadJobAttachmentsArchive(harness.as(master), bare)).toBeNull();
  });

  it('names, never silently drops, a document whose file was never stored', async () => {
    let job = await acceptJob(harness.as(technician), await job1048());
    job = await attachDocument(harness.as(technician), job, { fileName: 'Kept.pdf', contentType: 'application/pdf', bytes: PDF('kept'), caption: '' });
    const ghost = { ...job.attachments[job.attachments.length - 1]!, id: 'att-ghost' as never, fileName: 'Lost.pdf', storageKey: 'uploads/never-stored' };
    const archive = await loadJobAttachmentsArchive(harness.as(master), { ...job, attachments: [...job.attachments, ghost] });
    expect(archive?.missing).toEqual(['Lost.pdf']);
    const listing = readStoredZip(archive!.bytes).find((entry) => entry.name === 'Missing files.txt');
    expect(new TextDecoder().decode(listing!.bytes)).toContain('Lost.pdf');
  });
});

describe('JOB-ATT-3: chosen documents travel IN the signed job card email', () => {
  const withChosen = async (bytes: Uint8Array, fileName: string): Promise<Job> => {
    let job = await acceptJob(harness.as(technician), await job1048());
    job = await attachDocument(harness.as(technician), job, { fileName, contentType: 'application/pdf', bytes, caption: '' });
    const chosen = job.attachments[job.attachments.length - 1]!;
    job = await setCustomerEmailDocument(harness.as(technician), job, chosen.id, true);
    expect(job.attachments.find((item) => item.id === chosen.id)?.emailToCustomer).toBe(true);
    const context = harness.as(technician);
    job = await addLabour(context, job, { date: '2026-09-17', rateType: 'normal', hours: 3, description: 'Repair' });
    job = await saveCompletionReport(context, job, { ...job.completionReport, workPerformed: 'Replaced the fan.' });
    job = await startCompletion(context, job);
    job = await startSignature(context, job);
    return captureSignature(context, job, { customerName: 'Pieter', customerSurname: 'Nel', strokeData: 'M0,0 L1,1' });
  };

  it('attaches the final signed PDF AND every chosen document — the files, not links', async () => {
    const signed = await withChosen(PDF('customer order'), 'Customer order.pdf');
    const issued = await issueJobCard(harness.as(technician), signed, ADDRESS, 'Pieter Nel');
    const [email] = await harness.repos.customerEmails.listForJob(issued.job.id);
    expect(email?.state).toBe('sent');
    expect(email?.extraAttachments?.map((extra) => extra.fileName)).toEqual(['Customer order.pdf']);
    const sent = harness.outbox.listSync().filter((entry) => entry.channel === 'email');
    expect(sent[sent.length - 1]?.attachments).toEqual([issued.job.finalDocument!.fileName, 'Customer order.pdf']);
  });

  it('does not send — and says why — when the attachments are larger than one email carries', async () => {
    const big = new Uint8Array(EMAIL_ATTACHMENTS_MAX_BYTES + 10).fill(0x20);
    big.set(new TextEncoder().encode('%PDF-1.4\n'));
    const signed = await withChosen(big, 'Huge drawing.pdf');
    const before = harness.outbox.listSync().filter((entry) => entry.channel === 'email').length;
    const issued = await issueJobCard(harness.as(technician), signed, ADDRESS, 'Pieter Nel');
    const [email] = await harness.repos.customerEmails.listForJob(issued.job.id);
    expect(email).toMatchObject({ state: 'attention', failureKind: 'attachment_too_large' });
    expect(email?.failureReason).toMatch(/at most 3\.0 MB/u);
    expect(harness.outbox.listSync().filter((entry) => entry.channel === 'email')).toHaveLength(before);
    expect(issued.job.delivery?.state).not.toBe('delivered');
    expect(issued.job.delivery?.state).not.toBe('pending_delivery');
  });

  it('fails the attempt, never sending without it, when a chosen file has gone', async () => {
    const signed = await withChosen(PDF('order'), 'Order.pdf');
    const issued = await issueJobCard(harness.as(technician), signed, ADDRESS, 'Pieter Nel');
    const [email] = await harness.repos.customerEmails.listForJob(issued.job.id);
    const outcome = await attemptCustomerEmail(harness.services, {
      ...email!,
      extraAttachments: [{ storageKey: 'uploads/gone', fileName: 'Order.pdf', sha256: null }],
    });
    expect(outcome).toMatchObject({ kind: 'failed', failureKind: 'document_unavailable', retryable: false });
  });
});

describe('CANCEL-ALL-1: every role cancels an accepted job before the signature, with a reason', () => {
  const reason = { reason: 'customer_cancelled', description: 'The customer called it off.' } as const;

  it('the technician on the job cancels it while in progress; another technician may not', async () => {
    const job = await acceptJob(harness.as(technician), await job1048());
    expect(await codeOf(cancelJob(harness.as(otherTech), job, reason))).toBe('cancel_not_permitted');
    const cancelled = await cancelJob(harness.as(technician), job, reason);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancellation).toMatchObject({ cancelledBy: technician.id, description: 'The customer called it off.' });
    const trail = await harness.repos.activity.list(job.id);
    expect(trail.find((event) => event.type === 'job_cancelled')?.actorId).toBe(technician.id);
  });

  it('an Apprentice on the job cancels it exactly as a technician does', async () => {
    const apprentice: User = { ...technician, role: 'apprentice' };
    await harness.repos.users.save(apprentice);
    const job = await acceptJob(harness.as(apprentice), await job1048());
    expect((await cancelJob(harness.as(apprentice), job, reason)).status).toBe('cancelled');
  });

  it('the Senior Tech and the Office cancel at the completion stage', async () => {
    let job = await acceptJob(harness.as(technician), await job1048());
    job = await saveCompletionReport(harness.as(technician), job, { ...job.completionReport, workPerformed: 'x' });
    job = await startCompletion(harness.as(technician), job);
    expect(job.status).toBe('completion');
    expect((await cancelJob(harness.as(coordinator), job, reason)).status).toBe('cancelled');
  });

  it('requires the reason written down, for every role', async () => {
    const job = await acceptJob(harness.as(technician), await job1048());
    for (const who of [technician, master, coordinator]) {
      expect(await codeOf(cancelJob(harness.as(who), job, { reason: 'duplicate', description: '  ' }))).toBe('description_required');
    }
  });

  it('refuses once the job has reached the customer signature, and a second cancellation', async () => {
    const signed = await workAndSign();
    expect(await codeOf(cancelJob(harness.as(master), signed, reason))).toBe('cancel_refused');
    expect(await codeOf(cancelJob(harness.as(technician), signed, reason))).toBe('cancel_refused');
    const job = await acceptJob(harness.as(otherTech), (await harness.repos.jobs.findByJobNumber('EJE-1059'))!);
    const cancelled = await cancelJob(harness.as(master), job, reason);
    expect(await codeOf(cancelJob(harness.as(master), cancelled, reason))).toBe('cancel_refused');
  });

  it('a cancelled job cannot go on into completion, the signature or invoicing, and nothing is emailed', async () => {
    const job = await acceptJob(harness.as(technician), await job1048());
    const cancelled = await cancelJob(harness.as(technician), job, reason);
    await expect(startCompletion(harness.as(technician), cancelled)).rejects.toBeInstanceOf(WorkflowError);
    await expect(startSignature(harness.as(technician), cancelled)).rejects.toBeInstanceOf(WorkflowError);
    expect(await harness.repos.customerEmails.listForJob(job.id)).toHaveLength(0);
  });
});

describe('ROLE-APP-1 / ROLE-LABEL-1: the Apprentice, and the renamed roles', () => {
  const ALL: readonly Capability[] = [
    'jobs.acceptField', 'jobs.captureWork', 'jobs.issueFinal', 'customers.view', 'library.view', 'calendar.view', 'standby.view', 'standby.requestSwap',
    'jobs.viewAll', 'jobs.endUnstartedJob', 'customers.manage', 'settings.rates', 'settings.manage', 'standby.manage', 'payroll.finance', 'admin.access',
  ];

  it('an Apprentice has exactly the Technician’s capabilities — no more, no fewer', () => {
    for (const capability of ALL) expect(can('apprentice', capability), capability).toBe(can('technician', capability));
    expect(can('apprentice', 'jobs.viewAll')).toBe(false);
    expect(can('apprentice', 'settings.rates')).toBe(false);
    expect(can('apprentice', 'standby.manage')).toBe(false);
    expect(isFieldRole('apprentice')).toBe(true);
    expect(completesTimesheet('apprentice')).toBe(true);
  });

  it('the visible names change, the stored values do not', () => {
    expect(roleLabel('master')).toBe('Senior Tech');
    expect(roleLabel('coordinator')).toBe('Office');
    expect(roleLabel('technician')).toBe('Technician');
    expect(roleLabel('apprentice')).toBe('Apprentice');
  });

  it('the Senior Tech and the Office may create apprentices; nobody else creates anyone', () => {
    expect(assignableRoles('master')).toContain('apprentice');
    expect(assignableRoles('coordinator')).toEqual(['technician', 'apprentice']);
    expect(assignableRoles('technician')).toEqual([]);
    expect(assignableRoles('apprentice')).toEqual([]);
  });
});

describe('CUST-RATES-1: customer-specific rates, enforced on the server', () => {
  const CUSTOM: PricingInputs = {
    labourRates: { normal: 120000, overtime: 180000, double: 240000 },
    calloutRate: 99000,
    testBenchFee: 51000,
    kilometreRate: 2500,
    vatPercentage: 15,
  };

  it('a Default Rates customer is priced at Administration’s rates', async () => {
    const job = await job1048();
    const settings = await harness.repos.settings.get();
    expect(await customerPricingInputs(harness.as(master), job)).toMatchObject({ labourRates: settings.labourRates, calloutRate: settings.calloutRate });
  });

  it('a Custom Rates customer without rates is NEVER priced at the defaults — flagged, and the signature refused', async () => {
    const job = await job1048();
    await setCustomerRateMode(harness.as(coordinator), job.customerId, 'custom');
    expect(await codeOf(customerPricingInputs(harness.as(master), job))).toBe('custom_rates_missing');
    const view = await loadJobView(harness.repos, job.jobNumber, master);
    expect(view?.rateSource).toMatchObject({ mode: 'custom', problem: expect.stringMatching(/Custom Rates/u) });
    expect(view?.settings.labourRates.normal).toBe(0);
    const context = harness.as(technician);
    let working = await acceptJob(context, job);
    working = await addLabour(context, working, { date: '2026-09-17', rateType: 'normal', hours: 1, description: 'Repair' });
    working = await saveCompletionReport(context, working, { ...working.completionReport, workPerformed: 'x' });
    working = await startCompletion(context, working);
    working = await startSignature(context, working);
    expect(await codeOf(captureSignature(context, working, { customerName: 'P', customerSurname: 'N', strokeData: 'M0,0 L1,1' }))).toBe('custom_rates_missing');
  });

  it('every rate category comes from the customer’s Custom Rates, and is frozen at the signature', async () => {
    const job = await job1048();
    await setCustomerRateMode(harness.as(coordinator), job.customerId, 'custom');
    await saveCustomerRates(harness.as(coordinator), job.customerId, CUSTOM);
    const view = await loadJobView(harness.repos, job.jobNumber, master);
    expect(view?.rateSource).toEqual({ mode: 'custom', problem: null });
    expect(view?.settings).toMatchObject({ labourRates: CUSTOM.labourRates, calloutRate: CUSTOM.calloutRate, testBenchFee: CUSTOM.testBenchFee, kilometreRate: CUSTOM.kilometreRate });
    const signed = await workAndSign();
    expect(signed.pricingSnapshot).toMatchObject({ ...CUSTOM, reason: 'customer_signature' });
    const totals = calculateJobTotals(signed, await harness.repos.settings.get());
    expect(totals.labourTotal).toBe(3 * CUSTOM.labourRates.normal);
  });

  it('changing the Custom Rates or the defaults afterwards reprices no signed job', async () => {
    const job = await job1048();
    await setCustomerRateMode(harness.as(coordinator), job.customerId, 'custom');
    await saveCustomerRates(harness.as(coordinator), job.customerId, CUSTOM);
    const signed = await workAndSign();
    const frozen = signed.pricingSnapshot;
    await saveCustomerRates(harness.as(coordinator), job.customerId, { ...CUSTOM, labourRates: { normal: 1, overtime: 1, double: 1 } });
    const settings = await harness.repos.settings.get();
    await updateSettings(harness.as(master), { ...settings, labourRates: { normal: 2, overtime: 2, double: 2 } });
    const reread = (await harness.repos.jobs.findByJobNumber('EJE-1048'))!;
    expect(reread.pricingSnapshot).toEqual(frozen);
    expect(calculateJobTotals(reread, await harness.repos.settings.get()).labourTotal).toBe(3 * CUSTOM.labourRates.normal);
  });

  it('only the office sets the option and the rates; never on a Default Rates customer', async () => {
    const job = await job1048();
    expect(await codeOf(setCustomerRateMode(harness.as(technician), job.customerId, 'custom'))).toBe('not_permitted');
    expect(await codeOf(saveCustomerRates(harness.as(master), job.customerId, CUSTOM))).toBe('not_custom_rates');
    await setCustomerRateMode(harness.as(master), job.customerId, 'custom');
    expect(await codeOf(saveCustomerRates(harness.as(technician), job.customerId, CUSTOM))).toBe('not_permitted');
    expect(await codeOf(saveCustomerRates(harness.as(master), job.customerId, { ...CUSTOM, calloutRate: -1 }))).toBe('invalid_rates');
    const trail = (await harness.repos.activity.list()).filter((event) => event.type === 'customer_rates_updated');
    expect(trail.length).toBeGreaterThan(0);
  });
});
