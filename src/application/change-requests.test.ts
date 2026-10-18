import { beforeEach, describe, expect, it } from 'vitest';
import {
  listChangeRequests,
  listChangeRequestsForCustomer,
  listMyChangeRequests,
  raiseChangeRequest,
  resolveChangeRequest,
} from './change-request-operations';
import { WorkflowError } from './errors';
import { buildHarness, seedUser, type Harness } from './test-harness';
import { asCustomerId, asMachineId, asSiteId } from '@/domain';

/**
 * A TECHNICIAN REPORTS THAT THE REGISTER IS WRONG, AND THE OFFICE DECIDES.
 * CUST-CR.
 *
 * The refusal promised this months ago — "Technicians can view customers and
 * raise change requests, but not edit them" — and there was nowhere to raise
 * one. These tests cover the mechanism and, as carefully, the boundary: **it
 * does not change the register**. An automatic apply needs EJE to answer who
 * may approve what, and whether an approved change reaches the jobs already
 * carried out on that machine (MACH-HIST, #28). Neither is settled, so what is
 * built records a report and a decision and nothing else.
 */
const technician = seedUser('user-tech-sipho');
const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');

const CUSTOMER = asCustomerId('cust-abc');
const SITE = asSiteId('site-abc-jhb');

const refusal = async (work: Promise<unknown>): Promise<WorkflowError> => {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowError);
    return error as WorkflowError;
  }
  throw new Error('it was accepted');
};

describe('raising a report that the register is wrong', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('lets a TECHNICIAN report a record they cannot edit', async () => {
    const raised = await raiseChangeRequest(harness.as(technician), {
      subject: 'customer',
      customerId: CUSTOMER,
      details: 'The accounts email on this customer bounces — it should be accounts@abc.co.za.',
    });

    expect(raised.state).toBe('open');
    expect(raised.raisedBy).toBe(technician.id);
    expect(raised.details).toMatch(/bounces/u);
    expect(raised.resolvedAt).toBeNull();
  });

  it('tells the OFFICE about it, because a report nobody sees is the state this replaces', async () => {
    await raiseChangeRequest(harness.as(technician), {
      subject: 'customer',
      customerId: CUSTOMER,
      details: 'Wrong telephone number.',
    });

    const notifications = await harness.repos.notifications.list(master.id);
    const notice = notifications.find((entry) => entry.type === 'customer_change_request');
    expect(notice).toBeDefined();
    expect(notice?.body).toMatch(/Wrong telephone number/u);
  });

  it('records it on the audit trail as a REQUEST, not as a change', async () => {
    // The demonstration data has a history of its own, so what this asserts is
    // what RAISING added — not what the trail happens to contain.
    const before = (await harness.repos.activity.list(undefined)).length;

    await raiseChangeRequest(harness.as(technician), {
      subject: 'customer',
      customerId: CUSTOMER,
      details: 'Account number is a digit short.',
    });

    const everything = await harness.repos.activity.list(undefined);
    const types = everything.slice(0, everything.length - before).map((event) => event.type);
    expect(types).toContain('customer_change_requested');
    // The one thing it must not say: that the register changed.
    expect(types).not.toContain('customer_updated');
  });

  it('keeps a machine report attached to the site the machine stands at', async () => {
    const machine = (await harness.repos.machines.list()).find(
      (candidate) => candidate.customerId === CUSTOMER,
    );
    expect(machine).toBeDefined();

    const raised = await raiseChangeRequest(harness.as(technician), {
      subject: 'machine',
      customerId: CUSTOMER,
      machineId: machine!.id,
      details: 'The serial plate reads MZ-QT200-11903.',
    });

    expect(raised.machineId).toBe(machine!.id);
    // Taken from the MACHINE rather than from the request, so the office can
    // find it without a second lookup and a browser cannot misfile it.
    expect(raised.siteId).toBe(machine!.siteId);
  });

  it('REFUSES a report with nothing in it', async () => {
    const empty = await refusal(
      raiseChangeRequest(harness.as(technician), {
        subject: 'customer',
        customerId: CUSTOMER,
        details: '   ',
      }),
    );
    expect(empty.violations[0]?.code).toBe('details_required');
  });

  it('REFUSES a report against a customer nobody has', async () => {
    const unknown = await refusal(
      raiseChangeRequest(harness.as(technician), {
        subject: 'customer',
        customerId: asCustomerId('cust-invented'),
        details: 'Anything.',
      }),
    );
    expect(unknown.violations[0]?.code).toBe('unknown_customer');
  });

  it('REFUSES a report that files another customer’s site against this one', async () => {
    const wrong = await refusal(
      raiseChangeRequest(harness.as(technician), {
        subject: 'site',
        customerId: CUSTOMER,
        siteId: asSiteId('site-kruger-main'),
        details: 'Access notes are out of date.',
      }),
    );
    expect(wrong.violations[0]?.code).toBe('site_not_of_customer');
  });

  it('REFUSES a report against another customer’s machine', async () => {
    const machine = (await harness.repos.machines.list()).find(
      (candidate) => candidate.customerId !== CUSTOMER,
    );
    expect(machine).toBeDefined();

    const wrong = await refusal(
      raiseChangeRequest(harness.as(technician), {
        subject: 'machine',
        customerId: CUSTOMER,
        machineId: machine!.id,
        details: 'Wrong control system.',
      }),
    );
    expect(wrong.violations[0]?.code).toBe('machine_not_of_customer');
  });

  it('REFUSES a machine nobody has', async () => {
    const unknown = await refusal(
      raiseChangeRequest(harness.as(technician), {
        subject: 'machine',
        customerId: CUSTOMER,
        machineId: asMachineId('machine-invented'),
        details: 'Anything.',
      }),
    );
    expect(unknown.violations[0]?.code).toBe('unknown_machine');
  });

  /*
   * ARCHIVED RECORDS ARE REPORTABLE ON PURPOSE. "This site should not have been
   * withdrawn" is a legitimate report, and so is a machine taken out of service
   * by mistake — refusing those would leave the only way to fix them a
   * telephone call, which is what this feature replaces.
   */
  it('lets somebody report a site that has been WITHDRAWN from the register', async () => {
    const site = (await harness.repos.customers.listSites(CUSTOMER)).find(
      (candidate) => candidate.id === SITE,
    );
    await harness.repos.customers.saveSite({
      ...site!,
      archivedAt: '2026-10-01T06:00:00.000Z',
    });

    const raised = await raiseChangeRequest(harness.as(technician), {
      subject: 'site',
      customerId: CUSTOMER,
      siteId: SITE,
      details: 'This site is still trading — it should not have been withdrawn.',
    });
    expect(raised.siteId).toBe(SITE);
  });
});

describe('who may read which reports', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = buildHarness();
    await raiseChangeRequest(harness.as(technician), {
      subject: 'customer',
      customerId: CUSTOMER,
      details: 'Reported by Sipho.',
    });
  });

  it('gives the office every report, oldest open first', async () => {
    const rows = await listChangeRequests(harness.as(master));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('open');
  });

  it('gives the office one customer’s reports on that customer’s screen', async () => {
    const rows = await listChangeRequestsForCustomer(harness.as(coordinator), CUSTOMER);
    expect(rows).toHaveLength(1);
  });

  /**
   * A TECHNICIAN READS THEIR OWN AND NOBODY ELSE'S. That somebody complained
   * about a record is not theirs to know; what became of their own report is.
   */
  it('REFUSES a technician the office’s list', async () => {
    const refused = await refusal(listChangeRequests(harness.as(technician)));
    expect(refused.violations[0]?.code).toBe('not_permitted');

    const refusedForCustomer = await refusal(
      listChangeRequestsForCustomer(harness.as(technician), CUSTOMER),
    );
    expect(refusedForCustomer.violations[0]?.code).toBe('not_permitted');
  });

  it('gives a technician their own reports, and not another technician’s', async () => {
    const other = seedUser('user-tech-riaan');
    await raiseChangeRequest(harness.as(other), {
      subject: 'customer',
      customerId: CUSTOMER,
      details: 'Reported by Riaan.',
    });

    const mine = await listMyChangeRequests(harness.as(technician));
    expect(mine).toHaveLength(1);
    expect(mine[0]?.details).toBe('Reported by Sipho.');
  });
});

describe('the office deciding what to do about one', () => {
  let harness: Harness;
  let requestId: string;

  beforeEach(async () => {
    harness = buildHarness();
    const raised = await raiseChangeRequest(harness.as(technician), {
      subject: 'customer',
      customerId: CUSTOMER,
      details: 'The VAT number has a transposed digit.',
    });
    requestId = raised.id;
  });

  it('records that the office made the change, with what they did', async () => {
    const resolved = await resolveChangeRequest(harness.as(master), requestId, {
      outcome: 'applied',
      note: 'Corrected the VAT number on the customer record.',
    });

    expect(resolved.state).toBe('applied');
    expect(resolved.resolvedBy).toBe(master.id);
    expect(resolved.resolvedAt).not.toBeNull();
    expect(resolved.resolutionNote).toMatch(/Corrected the VAT number/u);
  });

  /**
   * THE BOUNDARY THIS FEATURE IS BUILT AROUND. "Applied" is the office saying
   * they made the change; the system changes nothing. If it did, EJE would have
   * to have decided whether a technician's wording becomes an official record
   * and what that means for the jobs already done — and they have not.
   */
  it('does NOT touch the register when a report is applied', async () => {
    const before = await harness.repos.customers.findById(CUSTOMER);
    const existing = (await harness.repos.activity.list(undefined)).length;

    await resolveChangeRequest(harness.as(master), requestId, {
      outcome: 'applied',
      note: 'Fixed by hand on the customer tab.',
    });

    const after = await harness.repos.customers.findById(CUSTOMER);
    expect(after).toEqual(before);

    // And the trail says a decision was recorded, not that a record changed.
    // Only the events this action added are examined: the demonstration data
    // has its own history, including edits the office made months ago.
    const everything = await harness.repos.activity.list(undefined);
    const added = everything.slice(0, everything.length - existing);
    const types = added.map((event) => event.type);
    expect(types).toContain('customer_change_resolved');
    expect(types).not.toContain('customer_updated');
  });

  it('records a decline, which needs a reason like any other decision', async () => {
    const declined = await resolveChangeRequest(harness.as(master), requestId, {
      outcome: 'declined',
      note: 'The VAT number matches the customer’s own invoice — no change needed.',
    });
    expect(declined.state).toBe('declined');
    expect(declined.resolutionNote).toMatch(/invoice/u);
  });

  it('REFUSES a decision with no note, on either outcome', async () => {
    for (const outcome of ['applied', 'declined'] as const) {
      const bare = await refusal(
        resolveChangeRequest(harness.as(master), requestId, { outcome, note: '  ' }),
      );
      expect(bare.violations[0]?.code, outcome).toBe('note_required');
    }
    // And it is still open for somebody to deal with properly.
    const rows = await listChangeRequests(harness.as(master), { state: 'open' });
    expect(rows).toHaveLength(1);
  });

  it('REFUSES a technician resolving anything, including their own report', async () => {
    const refused = await refusal(
      resolveChangeRequest(harness.as(technician), requestId, {
        outcome: 'applied',
        note: 'I fixed it myself.',
      }),
    );
    expect(refused.violations[0]?.code).toBe('not_permitted');
  });

  /**
   * TWO OFFICE USERS DECIDING AT ONCE. The first decision stands — a second
   * that silently overwrote it would lose the record of what was actually done.
   */
  it('REFUSES a second decision on a report already dealt with', async () => {
    await resolveChangeRequest(harness.as(master), requestId, {
      outcome: 'applied',
      note: 'Corrected.',
    });

    const second = await refusal(
      resolveChangeRequest(harness.as(coordinator), requestId, {
        outcome: 'declined',
        note: 'Actually no.',
      }),
    );
    expect(second.violations[0]?.code).toBe('already_resolved');

    const rows = await listChangeRequests(harness.as(master));
    expect(rows[0]?.state).toBe('applied');
    expect(rows[0]?.resolutionNote).toBe('Corrected.');
  });

  it('REFUSES a report that does not exist', async () => {
    const missing = await refusal(
      resolveChangeRequest(harness.as(master), 'chg-nonexistent', {
        outcome: 'applied',
        note: 'Something.',
      }),
    );
    expect(missing.violations[0]?.code).toBe('unknown_change_request');
  });
});
