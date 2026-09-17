import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptJob,
  addPart,
  captureSignature,
  startCompletion,
  startSignature,
  submitForMasterReview,
  submitJobCard,
} from './job-operations';
import { loadJobView } from './job-view';
import type { OperationContext } from './context';
import { createDemoRepositories } from '@/data/demo/repositories';
import { DemoStore } from '@/data/demo/demo-store';
import { SimulatedEmailService } from '@/services/simulated/email';
import { SimulatedOutbox } from '@/services/simulated/outbox';
import { SimulatedPdfService } from '@/services/simulated/pdf';
import { SimulatedStorageService } from '@/services/simulated/storage';
import { SequentialIdGenerator, SystemClock } from '@/services/simulated/system';
import { SimulatedWhatsAppService } from '@/services/simulated/whatsapp';
import { seedUsers } from '@/data/seed';
import {
  PARTS_COLLECTION_DECLARATION,
  buildPartsDocument,
  checkReadyForSignature,
  getJobTypeDefinition,
  type Job,
  type User,
} from '@/domain';
import type { RepositoryBundle } from '@/data/repositories';

/**
 * A parts collection is a different event from a site visit: goods handed over,
 * acknowledged by whoever collected them. No hours, no kilometres, no call-out —
 * and, for a courier, no prices on the paperwork.
 */
const technician: User = seedUsers.find((user) => user.id === 'user-tech-lerato')!;
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
    storage: new SimulatedStorageService(),
  };

  return {
    repos,
    outbox,
    tech: { repos, services, actor: technician },
    master: { repos, services, actor: master },
  };
};

const loadJob = async (harness: Harness, jobNumber: string): Promise<Job> => {
  const view = await loadJobView(harness.repos, jobNumber);
  if (view === null) throw new Error(`${jobNumber} is not seeded`);
  return view.job;
};

describe('the Parts job type', () => {
  it('captures neither labour nor travel', () => {
    expect(getJobTypeDefinition('parts').capturesLabourAndTravel).toBe(false);
  });

  it('needs at least one part line, not labour, before it can be signed for', () => {
    const empty = {
      ...({} as Job),
      jobType: 'parts' as const,
      parts: [],
      labour: [],
      completionReport: {
        faultFindings: '',
        diagnosis: '',
        workPerformed: '',
        recommendations: '',
        generalNotes: '',
      },
      checklist: null,
      photos: [],
    } as unknown as Job;

    const readiness = checkReadyForSignature(empty);
    expect(readiness.allowed).toBe(false);
    expect(readiness.violations.map((violation) => violation.code)).toEqual(['parts_required']);
    // A parts collection is never blocked for missing hours or a write-up.
    expect(readiness.violations.map((violation) => violation.code)).not.toContain(
      'labour_required',
    );
  });
});

describe('collecting parts', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = build();
  });

  it('records the collector against the collection declaration, not the work declaration', async () => {
    // EJE-1063 is the seeded courier collection, still awaiting review.
    const courier = await loadJob(harness, 'EJE-1063');
    expect(courier.signature?.declaration).toBe(PARTS_COLLECTION_DECLARATION);
  });

  it('stores the collection declaration when a collector signs', async () => {
    let job = await loadJob(harness, 'EJE-1048');
    // Turn the flagship job into a parts collection to prove the declaration is
    // chosen from the job type rather than hard-coded at the signature step.
    job = await harness.repos.jobs.save({ ...job, jobType: 'parts', machineId: null });
    job = await acceptJob(harness.tech, job);
    job = await addPart(harness.tech, job, {
      partNumber: 'FAN-24V-80',
      description: 'Spindle drive cooling fan',
      quantity: 1,
      unitPrice: 48500,
    });
    job = await startCompletion(harness.tech, job);
    job = await startSignature(harness.tech, job);
    const signed = await captureSignature(harness.tech, job, {
      customerName: 'Johan',
      customerSurname: 'Mokoena',
      strokeData: 'M0,0 L1,1',
    });

    expect(signed.signature?.declaration).toBe(PARTS_COLLECTION_DECLARATION);
    expect(signed.signature?.customerName).toBe('Johan');

    const trail = await harness.repos.activity.list(signed.id);
    expect(trail.some((event) => event.summary === 'Collector signed for the parts')).toBe(true);
  });
});

describe('the courier collection document', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = build();
  });

  it('withholds prices from the courier document but keeps them on the job', async () => {
    const courier = await loadJob(harness, 'EJE-1063');
    expect(courier.courierCollection).toBe(true);

    const document = buildPartsDocument(courier);
    expect(document.showsPrices).toBe(false);
    expect(document.subtotal).toBeNull();
    expect(document.lines.every((line) => line.unitPrice === null)).toBe(true);

    // The prices are withheld from the document, never deleted from the job.
    expect(courier.parts.every((part) => part.unitPrice > 0)).toBe(true);
    expect(JSON.stringify(document)).not.toContain('1240000');
  });

  it('shows prices when the customer collects in person', async () => {
    const collected = await loadJob(harness, 'EJE-1062');
    expect(collected.courierCollection).toBe(false);

    const document = buildPartsDocument(collected);
    expect(document.showsPrices).toBe(true);
    expect(document.subtotal).toBe(
      collected.parts.reduce((total, part) => total + part.quantity * part.unitPrice, 0),
    );
  });

  it('still routes through Master review before the customer is emailed', async () => {
    const courier = await loadJob(harness, 'EJE-1063');
    const handed = await submitForMasterReview(harness.tech, courier);
    expect(handed.status).toBe('submitted');
    expect(harness.outbox.listSync().filter((entry) => entry.channel === 'email')).toHaveLength(0);

    const issued = await submitJobCard(
      harness.master,
      handed,
      'buyer@kruger-demo.co.za',
      'Kruger Engineering',
    );
    expect(issued.job.status).toBe('closed');
    expect(issued.emailedTo).toBe('buyer@kruger-demo.co.za');
    expect(harness.outbox.listSync().filter((entry) => entry.channel === 'email')).toHaveLength(1);
  });
});
