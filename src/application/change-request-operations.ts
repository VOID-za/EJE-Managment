import {
  can,
  CHANGE_REQUEST_DETAILS_LIMIT,
  changeRequestSubjectLabel,
  machineDisplayName,
  userFullName,
  type ChangeRequest,
  type ChangeRequestState,
  type ChangeRequestSubject,
  type CustomerId,
  type MachineId,
  type SiteId,
} from '@/domain';
import type { OperationContext } from './context';
import { audit, notifyMasters } from './audit';
import { WorkflowError } from './errors';

/**
 * A TECHNICIAN REPORTS THAT THE REGISTER IS WRONG, AND THE OFFICE DECIDES.
 * MASTER SCOPE CUST-CR.
 *
 * THE REFUSAL PROMISED THIS MONTHS AGO. `assertManages` turns a technician's
 * customer edit away with "Technicians can view customers and raise change
 * requests, but not edit them", and `updateMachine` says "Technicians can raise
 * a change request instead". Both sentences shipped long before there was
 * anywhere to raise one — so a technician standing in front of a machine whose
 * serial number is wrong read that they may report it and had no way to. The
 * notification type (`customer_change_request`) and a seeded example existed
 * too. This is the mechanism those three things already described.
 *
 * WHAT IT IS: a message about a record, addressed to the office, that outlives
 * the telephone call it would otherwise have been — who noticed, what they say
 * is wrong, which record, and what the office decided.
 *
 * WHAT IT IS NOT, AND THIS IS THE PART THAT IS A DECISION RATHER THAN AN
 * OMISSION: it does not apply itself. There is no proposed-value field and no
 * approval that writes to the register. An automatic apply needs EJE to answer
 * questions nobody has put to them — may a technician's wording become the
 * official serial number of an asset; does an approved change reach the jobs
 * already carried out on that machine (MACH-HIST, #28); who may approve what —
 * and inventing answers to those in code is exactly what this batch is not for.
 * So resolving a request records the office's DECISION, and the office then
 * edits the register themselves through the screens that already authorise it.
 *
 * WHO MAY DO WHAT. Raising needs only `customers.view`, which every role that
 * can see the register has, because the whole point is that the person who
 * cannot edit a record can still report it. Resolving needs
 * `customers.manage` — the same capability as editing the register, because
 * resolving is the office saying what they did about it.
 */

export interface NewChangeRequestInput {
  readonly subject: ChangeRequestSubject;
  readonly customerId: CustomerId;
  readonly siteId?: SiteId | null;
  readonly machineId?: MachineId | null;
  readonly details: string;
}

const refuse = (message: string, code: string, detail: string): WorkflowError =>
  new WorkflowError(message, [{ code, message: detail }]);

/**
 * RAISING ONE, with the record checked rather than believed.
 *
 * Every identifier comes from a browser, so each is resolved and the pair is
 * checked the same way `createMachine` checks it: a report about "this machine
 * at this customer" that names another customer's machine would file a problem
 * against a record nobody can act on.
 */
export const raiseChangeRequest = async (
  context: OperationContext,
  input: NewChangeRequestInput,
): Promise<ChangeRequest> => {
  if (!can(context.actor.role, 'customers.view')) {
    throw refuse(
      'You cannot report a problem with the register.',
      'not_permitted',
      'Your role does not read the customer register.',
    );
  }

  const details = input.details.trim();
  if (details.length === 0) {
    throw refuse(
      'Say what is wrong with the record.',
      'details_required',
      'A report with nothing in it is a telephone call nobody made.',
    );
  }
  if (details.length > CHANGE_REQUEST_DETAILS_LIMIT) {
    throw refuse(
      'That report is too long.',
      'details_too_long',
      `Keep it under ${CHANGE_REQUEST_DETAILS_LIMIT} characters — it is a report, not a document.`,
    );
  }

  const customer = await context.repos.customers.findById(input.customerId);
  if (customer === null) {
    throw refuse(
      'That customer is not on the register.',
      'unknown_customer',
      'A report is raised against a customer EJE actually has.',
    );
  }

  /*
   * Archived records are deliberately reportable: "this site should not have
   * been withdrawn" is a legitimate report, and so is a correction to a
   * machine that was taken out of service by mistake.
   */
  const site =
    input.siteId === undefined || input.siteId === null
      ? null
      : (await context.repos.customers.listSites(customer.id, { includeArchived: true })).find(
          (candidate) => candidate.id === input.siteId,
        ) ?? null;
  if ((input.siteId ?? null) !== null && site === null) {
    throw refuse(
      `That site is not one of ${customer.name}’s.`,
      'site_not_of_customer',
      'A report about a site is raised against the customer whose site it is.',
    );
  }

  const machine =
    input.machineId === undefined || input.machineId === null
      ? null
      : await context.repos.machines.findById(input.machineId);
  if ((input.machineId ?? null) !== null && machine === null) {
    throw refuse(
      'That machine is not on the register.',
      'unknown_machine',
      'A report about a machine is raised against a machine that exists.',
    );
  }
  if (machine !== null && machine.customerId !== customer.id) {
    throw refuse(
      `${machineDisplayName(machine)} does not belong to ${customer.name}.`,
      'machine_not_of_customer',
      'A report is filed against the customer whose machine it is.',
    );
  }

  const now = context.services.clock.now();
  const request: ChangeRequest = {
    id: context.services.ids.next('chg'),
    subject: input.subject,
    customerId: customer.id,
    // The site a reported machine stands at, so the office can find it without
    // a second lookup. Taken from the MACHINE rather than from the request.
    siteId: machine !== null ? machine.siteId : (site?.id ?? null),
    machineId: machine?.id ?? null,
    details,
    raisedBy: context.actor.id,
    raisedAt: now,
    state: 'open',
    resolvedBy: null,
    resolvedAt: null,
    resolutionNote: '',
  };

  const saved = await context.repos.changeRequests.save(request);

  const about =
    machine !== null
      ? `${machineDisplayName(machine)} at ${customer.name}`
      : site !== null
        ? `${site.name} (${customer.name})`
        : customer.name;

  /*
   * THE OFFICE IS TOLD, because a report nobody sees is a report nobody acts
   * on — which is the state this feature replaces. It goes to the Masters, the
   * same route a refused signature takes.
   */
  await notifyMasters(context, {
    type: 'customer_change_request',
    title: `${changeRequestSubjectLabel(saved.subject)} — ${about}`,
    body: `${userFullName(context.actor)} reports: ${details}`,
    link: `/customers/${customer.id}`,
  });

  await audit(context, {
    jobId: null,
    type: 'customer_change_requested',
    summary: `Change requested: ${about}`,
    detail: `${userFullName(context.actor)} reported a problem with the ${saved.subject} record: ${details}`,
  });

  return saved;
};

/** What the office has to deal with. Open first, longest-waiting first. */
export const listChangeRequests = async (
  context: OperationContext,
  filter: { readonly state?: ChangeRequestState } = {},
): Promise<readonly ChangeRequest[]> => {
  if (!can(context.actor.role, 'customers.manage')) {
    throw refuse(
      'The register’s change requests are an office screen.',
      'not_permitted',
      'Your role does not administer the customer register.',
    );
  }
  return context.repos.changeRequests.list(filter);
};

/**
 * Everything raised about one customer, for the customer's own screen.
 *
 * Office-only, like the screen it is on. A technician sees their OWN reports
 * through `listMyChangeRequests`, which is the honest scope: the fact that
 * somebody else complained about a record is not theirs to read.
 */
export const listChangeRequestsForCustomer = async (
  context: OperationContext,
  customerId: CustomerId,
): Promise<readonly ChangeRequest[]> => {
  if (!can(context.actor.role, 'customers.manage')) {
    throw refuse(
      'The register’s change requests are an office screen.',
      'not_permitted',
      'Your role does not administer the customer register.',
    );
  }
  return context.repos.changeRequests.listForCustomer(customerId);
};

/** A person's own reports, so they can see what became of them. */
export const listMyChangeRequests = (
  context: OperationContext,
): Promise<readonly ChangeRequest[]> =>
  context.repos.changeRequests.listForRaiser(context.actor.id);

export interface ResolveChangeRequestInput {
  readonly outcome: Extract<ChangeRequestState, 'applied' | 'declined'>;
  readonly note: string;
}

/**
 * THE OFFICE SAYS WHAT THEY DID ABOUT IT.
 *
 * `applied` means they made the change — by hand, through the register screens
 * — and `declined` means they decided not to. Neither outcome writes to the
 * register from here, and that is the boundary this operation exists to keep:
 * see the header.
 *
 * A note is required on BOTH outcomes. "Declined" with no reason is the shape
 * that makes a technician stop reporting things, and "applied" with no note
 * leaves nobody able to tell what was actually changed.
 */
export const resolveChangeRequest = async (
  context: OperationContext,
  requestId: string,
  input: ResolveChangeRequestInput,
): Promise<ChangeRequest> => {
  if (!can(context.actor.role, 'customers.manage')) {
    throw refuse(
      'You cannot resolve a change request.',
      'not_permitted',
      'Only the office administers the customer register.',
    );
  }

  const note = input.note.trim();
  if (note.length === 0) {
    throw refuse(
      'Say what you did about it.',
      'note_required',
      'A decision with no words leaves nobody able to tell what changed, and a declined report ' +
        'with no reason is how people stop reporting things.',
    );
  }

  const existing = await context.repos.changeRequests.findById(requestId);
  if (existing === null) {
    throw refuse(
      'That change request does not exist.',
      'unknown_change_request',
      'It may have been dealt with and removed.',
    );
  }
  if (existing.state !== 'open') {
    throw refuse(
      'That change request has already been dealt with.',
      'already_resolved',
      `It was ${existing.state === 'applied' ? 'applied' : 'declined'} already, and the first ` +
        'decision stands.',
    );
  }

  const resolved = await context.repos.changeRequests.resolve({
    ...existing,
    state: input.outcome,
    resolvedBy: context.actor.id,
    resolvedAt: context.services.clock.now(),
    resolutionNote: note,
  });

  /*
   * Null means somebody else resolved it between the read and the write. The
   * first decision stands — the same answer as a referral, and for the same
   * reason: two office users deciding at once must not produce one decision
   * silently overwriting another.
   */
  if (resolved === null) {
    throw refuse(
      'That change request was dealt with a moment ago.',
      'already_resolved',
      'Somebody else recorded a decision while this screen was open. Reload to see theirs.',
    );
  }

  await audit(context, {
    jobId: null,
    type: 'customer_change_resolved',
    summary: `Change request ${input.outcome}`,
    detail:
      `${userFullName(context.actor)} ${input.outcome} the ${existing.subject} change request: ` +
      `${note}` +
      (input.outcome === 'applied'
        ? ' The register itself is edited through its own screens; this records the decision.'
        : ''),
  });

  return resolved;
};
