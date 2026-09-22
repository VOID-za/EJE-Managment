import { describe, expect, it } from 'vitest';
import {
  asCustomerId,
  asJobId,
  asMachineId,
  asSiteId,
  asUserId,
  type Job,
  type PricingSnapshot,
  type User,
} from '../index';
import {
  canSeeJob,
  emptyTechnicianHistory,
  isReadOnlyAt,
  jobVisibilityFor,
  participantJobIds,
  showsPricesAt,
  technicianHistoryFrom,
  summariesVisibleTo,
  visibleJobsFor,
  withoutPrices,
  type JobSummary,
} from './visibility';

/**
 * DECISION 5: which jobs a technician may see, and how much of one.
 *
 * EJE settled this after the audit raised it. A technician sees the open pool,
 * their current assignments, the work they have ever participated in, and the
 * finished history of machines they have worked on. Another technician's live
 * job is not theirs to read, and knowing the job number does not change that.
 *
 * The rule is a predicate over a job and a history, so the same answer comes
 * back from a list, from a search, from a job screen and from an API handler.
 */

const SIPHO = asUserId('user-tech-sipho');
const LERATO = asUserId('user-tech-lerato');
const MACHINE = asMachineId('machine-abc-lv40');
const OTHER_MACHINE = asMachineId('machine-kruger-vf2');

const technician = (id: string): Pick<User, 'id' | 'role'> => ({
  id: asUserId(id),
  role: 'technician',
});
const coordinator: Pick<User, 'id' | 'role'> = {
  id: asUserId('user-coord-christene'),
  role: 'coordinator',
};
const master: Pick<User, 'id' | 'role'> = {
  id: asUserId('user-master-elmarie'),
  role: 'master',
};

type Candidate = Pick<
  Job,
  'id' | 'status' | 'primaryTechnicianId' | 'additionalTechnicianIds' | 'machineId'
>;

const job = (over: Partial<Candidate> = {}): Candidate => ({
  id: asJobId(`job-${Math.random().toString(36).slice(2)}`),
  status: 'in_progress',
  primaryTechnicianId: LERATO,
  additionalTechnicianIds: [],
  machineId: MACHINE,
  ...over,
});

describe('who may see a job', () => {
  it('shows the office everything, whatever its state', () => {
    for (const viewer of [master, coordinator]) {
      expect(jobVisibilityFor(viewer, job(), emptyTechnicianHistory)).toBe('office');
      expect(
        jobVisibilityFor(viewer, job({ status: 'cancelled' }), emptyTechnicianHistory),
      ).toBe('office');
    }
  });

  it('shows a technician the job they are on', () => {
    const mine = job({ primaryTechnicianId: SIPHO });
    expect(jobVisibilityFor(technician(SIPHO), mine, emptyTechnicianHistory)).toBe('assigned');
  });

  it('shows a technician a job they are on as an extra pair of hands', () => {
    const shared = job({ primaryTechnicianId: LERATO, additionalTechnicianIds: [SIPHO] });
    expect(jobVisibilityFor(technician(SIPHO), shared, emptyTechnicianHistory)).toBe('assigned');
  });

  it('shows a technician the open pool, which is where work comes from', () => {
    const pooled = job({ status: 'open', primaryTechnicianId: null });
    expect(jobVisibilityFor(technician(SIPHO), pooled, emptyTechnicianHistory)).toBe('open_pool');
  });

  it('withholds another technician’s live job', () => {
    expect(jobVisibilityFor(technician(SIPHO), job(), emptyTechnicianHistory)).toBeNull();
    expect(canSeeJob(technician(SIPHO), job(), emptyTechnicianHistory)).toBe(false);
  });

  it('withholds a job already taken, even while it is still "open"', () => {
    // An accepted job that has not started is not the pool; somebody has it.
    const taken = job({ status: 'open', primaryTechnicianId: LERATO });
    expect(jobVisibilityFor(technician(SIPHO), taken, emptyTechnicianHistory)).toBeNull();
  });

  describe('work a technician has done and no longer holds', () => {
    /**
     * The case the rule exists for.
     *
     * A technician captures half a job on Tuesday and it is reassigned on
     * Wednesday. `primaryTechnicianId` has forgotten her; the participation
     * history has not, and she keeps access to her own work.
     */
    const reassigned = job({ primaryTechnicianId: LERATO });
    const history = technicianHistoryFrom([{ id: reassigned.id, machineId: MACHINE }]);

    it('keeps it open to her after the reassignment', () => {
      expect(jobVisibilityFor(technician(SIPHO), reassigned, history)).toBe('participated');
    });

    it('is read-only, because it is no longer hers to change', () => {
      expect(isReadOnlyAt('participated')).toBe(true);
    });

    it('still shows her what it cost, because she did the work', () => {
      expect(showsPricesAt('participated')).toBe(true);
    });
  });

  describe('the history of a machine the technician has worked', () => {
    const history = technicianHistoryFrom([
      { id: asJobId('job-mine'), machineId: MACHINE },
    ]);

    it('opens finished work on that machine, whoever did it', () => {
      const closed = job({ status: 'closed', primaryTechnicianId: LERATO });
      expect(jobVisibilityFor(technician(SIPHO), closed, history)).toBe('machine_history');
    });

    it('opens a cancelled job on it too — knowing it was cancelled is the history', () => {
      const cancelled = job({ status: 'cancelled', primaryTechnicianId: LERATO });
      expect(jobVisibilityFor(technician(SIPHO), cancelled, history)).toBe('machine_history');
    });

    it('does NOT open live work on that machine', () => {
      expect(jobVisibilityFor(technician(SIPHO), job(), history)).toBeNull();
    });

    it('does not open a machine she has never worked', () => {
      const elsewhere = job({ status: 'closed', machineId: OTHER_MACHINE });
      expect(jobVisibilityFor(technician(SIPHO), elsewhere, history)).toBeNull();
    });

    it('does not open a job that is against no machine at all', () => {
      const parts = job({ status: 'closed', machineId: null });
      expect(jobVisibilityFor(technician(SIPHO), parts, history)).toBeNull();
    });

    it('withholds the prices, and is read-only', () => {
      expect(showsPricesAt('machine_history')).toBe(false);
      expect(isReadOnlyAt('machine_history')).toBe(true);
    });
  });
});

describe('suppressing the commercial figures', () => {
  const snapshot: PricingSnapshot = {
    labourRates: { normal: 95_000, overtime: 142_500, double: 190_000 },
    calloutRate: 85_000,
    kilometreRate: 1_850,
    vatPercentage: 15,
    capturedAt: '2026-09-20T15:00:00.000Z',
    reason: 'customer_signature',
  };

  const priced = {
    ...job({ status: 'closed' }),
    parts: [
      {
        id: 'part-1',
        partNumber: 'ENC-INC-1024',
        description: 'Incremental encoder',
        quantity: 2,
        unitPrice: 386_000,
        capturedAt: '2026-09-20T10:00:00.000Z',
        capturedBy: LERATO,
      },
    ],
    pricingSnapshot: snapshot,
    calloutApplied: true,
  } as unknown as Job;

  it('removes them rather than hiding them', () => {
    const redacted = withoutPrices(priced);

    // Nothing to render, export or reach by typing a URL.
    expect(JSON.stringify(redacted)).not.toContain('386000');
    expect(redacted.pricingSnapshot).toBeNull();
    expect(redacted.calloutApplied).toBe(false);
  });

  it('keeps what a technician actually needs: what was fitted, and how many', () => {
    const redacted = withoutPrices(priced);
    expect(redacted.parts[0]?.partNumber).toBe('ENC-INC-1024');
    expect(redacted.parts[0]?.quantity).toBe(2);
    expect(redacted.parts[0]?.unitPrice).toBe(0);
  });

  it('applies the price rule and the visibility rule in one call', () => {
    const history = technicianHistoryFrom([{ id: asJobId('job-mine'), machineId: MACHINE }]);
    const mine = { ...priced, id: asJobId('job-mine'), primaryTechnicianId: SIPHO } as Job;
    const theirs = priced;

    const visible = visibleJobsFor(technician(SIPHO), [mine, theirs], history);

    expect(visible).toHaveLength(2);
    // Her own job keeps its figures; the machine-history one does not.
    expect(visible.find((entry) => entry.id === mine.id)?.parts[0]?.unitPrice).toBe(386_000);
    expect(visible.find((entry) => entry.id === theirs.id)?.parts[0]?.unitPrice).toBe(0);
  });
});

describe('the history a repository is asked to resolve', () => {
  it('collects the jobs and the machines behind them', () => {
    const history = technicianHistoryFrom([
      { id: asJobId('job-a'), machineId: MACHINE },
      { id: asJobId('job-b'), machineId: MACHINE },
      { id: asJobId('job-c'), machineId: null },
    ]);

    expect([...participantJobIds(history)].sort()).toEqual(['job-a', 'job-b', 'job-c']);
    // One machine, seen twice, and the parts job that had none.
    expect([...history.workedMachineIds]).toEqual([MACHINE as string]);
  });

  it('starts empty, which withholds everything but the pool', () => {
    expect(participantJobIds(emptyTechnicianHistory)).toEqual([]);
    expect(canSeeJob(technician(SIPHO), job(), emptyTechnicianHistory)).toBe(false);
    expect(
      canSeeJob(
        technician(SIPHO),
        job({ status: 'open', primaryTechnicianId: null }),
        emptyTechnicianHistory,
      ),
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */

/**
 * The same rule, applied to a LIST ROW instead of a whole job.
 *
 * `summariesVisibleTo` exists so the Jobs screen stops hydrating complete job
 * aggregates to draw a table. It is Decision 5 on a narrower record, and the
 * risk of a narrower record is that it quietly becomes a wider RULE — so the
 * equivalence is asserted here rather than assumed.
 */
const summary = (over: Partial<JobSummary> = {}): JobSummary => ({
  id: asJobId(`job-${Math.random().toString(36).slice(2)}`),
  jobNumber: 'EJE-1000',
  status: 'in_progress',
  jobType: 'breakdown',
  priority: 'normal',
  scheduledDate: null,
  closedAt: null,
  submittedAt: null,
  referenceNumber: '',
  orderNumber: '',
  faultDescription: 'Fictional fault',
  customerId: asCustomerId('customer-1'),
  siteId: asSiteId('site-1'),
  machineId: MACHINE,
  primaryTechnicianId: LERATO,
  additionalTechnicianIds: [],
  createdAt: '2026-01-05T08:00:00.000Z',
  completedAt: null,
  scheduledEndDate: null,
  signatureRefusals: [],
  finalDocument: null,
  ...over,
});

describe('Decision 5 over summaries', () => {
  it('shows the office every row', () => {
    const rows = [summary(), summary({ status: 'cancelled' }), summary({ status: 'closed' })];
    expect(summariesVisibleTo(master, rows, emptyTechnicianHistory)).toHaveLength(3);
  });

  it('shows a technician theirs, the pool, and nothing else', () => {
    const mine = summary({ primaryTechnicianId: SIPHO });
    const shared = summary({ primaryTechnicianId: LERATO, additionalTechnicianIds: [SIPHO] });
    const pooled = summary({ status: 'open', primaryTechnicianId: null });
    const somebodyElses = summary({ primaryTechnicianId: LERATO, machineId: null });

    const visible = summariesVisibleTo(
      technician(SIPHO),
      [mine, shared, pooled, somebodyElses],
      emptyTechnicianHistory,
    );

    expect(visible.map((row) => row.id)).toEqual([mine.id, shared.id, pooled.id]);
  });

  it('decides exactly as the full-job rule decides, row for row', () => {
    // The guard that matters: a narrower record must not become a wider rule.
    const rows = [
      summary({ primaryTechnicianId: SIPHO }),
      summary({ primaryTechnicianId: LERATO, additionalTechnicianIds: [SIPHO] }),
      summary({ status: 'open', primaryTechnicianId: null }),
      summary({ primaryTechnicianId: LERATO, machineId: null }),
      summary({ status: 'closed', primaryTechnicianId: LERATO }),
      summary({ status: 'cancelled', primaryTechnicianId: SIPHO }),
    ];

    for (const viewer of [master, coordinator, technician(SIPHO), technician(LERATO)]) {
      for (const history of [emptyTechnicianHistory, technicianHistoryFrom([])]) {
        const bySummary = summariesVisibleTo(viewer, rows, history).map((row) => row.id);
        const byRule = rows
          .filter((row) => jobVisibilityFor(viewer, row, history) !== null)
          .map((row) => row.id);
        expect(bySummary).toEqual(byRule);
      }
    }
  });

  it('carries no price to suppress', () => {
    /*
     * The price half of Decision 5, satisfied by construction rather than by
     * remembering to call `withoutPrices`. If somebody widens `JobSummary` to
     * include parts or a pricing snapshot, this fails — and it should, because
     * the list would then be carrying prices a technician must not read.
     */
    const [row] = summariesVisibleTo(technician(SIPHO), [summary({ primaryTechnicianId: SIPHO })], emptyTechnicianHistory);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('parts');
    expect(row).not.toHaveProperty('pricingSnapshot');
    expect(row).not.toHaveProperty('calloutApplied');
    expect(row).not.toHaveProperty('labour');
  });
});
