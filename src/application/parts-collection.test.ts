import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptJob,
  addPart,
  captureSignature,
  startCompletion,
  startSignature,
  submitForMasterReview,
  submitJobCard,
  issueJobCard,
  confirmJobCardDelivery,
} from './job-operations';
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
import { seedUsers } from '@/data/seed';
import {
  asLineItemId,
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
    storage: new SimulatedStorageService(inMemoryFileStore()),
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
      orderNumber: 'PO-88410',
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

  it('requires an order number before the collector signs', () => {
    const withoutOrder = {
      ...({} as Job),
      jobType: 'parts' as const,
      orderNumber: '   ',
      parts: [
        {
          id: asLineItemId('p1'),
          partNumber: 'FAN-24V-80',
          description: 'Fan',
          quantity: 1,
          unitPrice: 48500,
          capturedAt: '2026-09-17T10:00:00.000Z',
        },
      ],
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

    const readiness = checkReadyForSignature(withoutOrder);
    expect(readiness.allowed).toBe(false);
    expect(readiness.violations.map((violation) => violation.code)).toContain(
      'order_number_required',
    );
  });

  it('requires an order number on parts jobs only', () => {
    expect(getJobTypeDefinition('parts').requiresOrderNumber).toBe(true);
    expect(getJobTypeDefinition('breakdown').requiresOrderNumber).toBe(false);
    expect(getJobTypeDefinition('service').requiresOrderNumber).toBe(false);
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
    // Unassigned, because a collection is taken by whoever is at the counter —
    // and because capturing work on somebody else's job is now refused, which
    // is a separate rule with its own tests.
    job = await harness.repos.jobs.save({
      ...job,
      jobType: 'parts',
      machineId: null,
      primaryTechnicianId: null,
    });
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

  it('is issued by whoever submits it, and closes only on confirmed delivery', async () => {
    const courier = await loadJob(harness, 'EJE-1063');
    expect(harness.outbox.listSync().filter((entry) => entry.channel === 'email')).toHaveLength(0);

    // No Master Review: the submission issues the collection note itself.
    const issued = await issueJobCard(
      harness.tech,
      courier,
      'buyer@kruger-demo.co.za',
      'Kruger Engineering',
    );
    expect(issued.job.status).toBe('awaiting_delivery');
    expect(issued.emailedTo).toBe('buyer@kruger-demo.co.za');
    expect(issued.delivery.state).toBe('pending_delivery');
    expect(harness.outbox.listSync().filter((entry) => entry.channel === 'email')).toHaveLength(1);

    harness.outbox.setDelivery(issued.delivery.messageId, 'delivered');
    const closed = await confirmJobCardDelivery(harness.tech, issued.job);
    expect(closed.status).toBe('closed');
  });
});

describe('the parts delivery note document', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = build();
  });

  it('issues a collection note rather than a job card', async () => {
    const collected = await loadJob(harness, 'EJE-1062');
    // EJE-1062 is closed, so re-open it to Master review to exercise issuing.
    const inReview = await harness.repos.jobs.save({ ...collected, status: 'submitted' });

    const issued = await submitJobCard(
      harness.master,
      inReview,
      'buyer@abc-demo.co.za',
      'ABC Engineering',
    );
    expect(issued.documentFileName).toContain('Parts-Collection-Note');
    expect(issued.documentFileName).not.toContain('Job-Card');
  });

  it('titles a courier document a delivery note', async () => {
    const courier = await loadJob(harness, 'EJE-1063');
    const handed = await submitForMasterReview(harness.tech, courier);
    const issued = await submitJobCard(
      harness.master,
      handed,
      'buyer@kruger-demo.co.za',
      'Kruger Engineering',
    );
    expect(issued.documentFileName).toContain('Delivery-Note');
  });

  it('emails the customer about a collection note, not a job card', async () => {
    const courier = await loadJob(harness, 'EJE-1063');
    const handed = await submitForMasterReview(harness.tech, courier);
    await submitJobCard(harness.master, handed, 'buyer@kruger-demo.co.za', 'Kruger Engineering');

    const email = harness.outbox.listSync().find((entry) => entry.channel === 'email');
    expect(email?.subject).toContain('Delivery Note');
    expect(email?.body).toContain('collection note');
  });
});
