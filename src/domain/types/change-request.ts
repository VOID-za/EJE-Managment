import type {
  ContactId,
  CustomerId,
  IsoDateTime,
  JobId,
  MachineId,
  SiteId,
  UserId,
} from './common';

/**
 * A TECHNICIAN REPORTS THAT THE REGISTER IS WRONG. CUST-CR.
 *
 * The register is the office's: `assertManages` refuses a technician's edit
 * with "Technicians can view customers and raise change requests, but not edit
 * them", and the machine register says the same thing — "Technicians can raise
 * a change request instead". Both sentences have been in the code since the
 * register was written, and until now there was nowhere to raise one. A
 * technician standing in front of a machine whose serial number is wrong could
 * read that they may report it and had no way to.
 *
 * WHAT A CHANGE REQUEST IS, AND WHAT IT IS DELIBERATELY NOT.
 *
 * It is a MESSAGE ABOUT A RECORD, addressed to the office, that outlives the
 * telephone call it would otherwise have been: who noticed, what they say is
 * wrong, which record it is about, and what the office decided. The office then
 * edits the register themselves, by hand, through the same screens and the same
 * authorisation as any other edit.
 *
 * IT DOES NOT APPLY ITSELF, and that is the part that is a business decision
 * rather than a convenience. An automatic apply would need EJE to answer
 * several questions nobody has asked them: may a technician's wording become
 * the official serial number of an asset; does an approved change propagate to
 * the jobs already carried out on that machine (MACH-HIST, #28); who may
 * approve what. None of that is settled, so none of it is built — the request
 * carries a technician's words and the office's decision, and nothing else.
 *
 * WHAT IT CANNOT DO: change a record, approve anything, alter a job, or reach a
 * customer. It is read by the office and resolved by the office.
 */

/**
 * Which record is being reported on.
 *
 * The first three are REGISTER records and the report comes from somebody at
 * EJE who may read them but not edit them. `job` is the other half of CUST-CR
 * (#27) and is a different thing in one important way: the person asking is
 * the CUSTOMER, and somebody at EJE is writing down what they asked for.
 */
export type ChangeRequestSubject = 'customer' | 'site' | 'machine' | 'job';

/**
 * Open until the office has dealt with it.
 *
 * `applied` means the office made the change; `declined` means they decided not
 * to. Both are the office's words about their own action — neither is the
 * system claiming to have changed anything.
 *
 * Text rather than an enum in the database, following `capture_referrals` and
 * `machine_approvals`: a third outcome is a business decision and must not need
 * a migration to record.
 */
export type ChangeRequestState = 'open' | 'applied' | 'declined';

export interface ChangeRequest {
  readonly id: string;
  readonly subject: ChangeRequestSubject;
  /** Always present: a site and a machine both belong to a customer. */
  readonly customerId: CustomerId;
  /** Set when the request is about a site, or about a machine standing at one. */
  readonly siteId: SiteId | null;
  readonly machineId: MachineId | null;
  /**
   * The job a CUSTOMER has asked for something on. CUST-CR, the job half.
   *
   * Set on a `job` request and null on every other subject, which the database
   * enforces both ways.
   */
  readonly jobId: JobId | null;
  /**
   * WHO AT THE CUSTOMER ASKED. CUST-CR, the job half.
   *
   * A customer has no account in this system — there is no customer portal and
   * no customer role — so a customer's request reaches EJE by telephone, and
   * somebody at EJE writes it down. `raisedBy` is therefore the EJE person who
   * TOOK the call and this is the customer contact who MADE it, chosen from
   * that customer's own contacts.
   *
   * Nullable, because the office does not always know which of four contacts
   * telephoned — and a required field that people fill in with "the customer"
   * is worse than an empty one.
   */
  readonly requestedByContactId: ContactId | null;
  /** What the technician says is wrong, in their own words. */
  readonly details: string;
  readonly raisedBy: UserId;
  readonly raisedAt: IsoDateTime;
  readonly state: ChangeRequestState;
  readonly resolvedBy: UserId | null;
  readonly resolvedAt: IsoDateTime | null;
  /** What the office did about it, in theirs. */
  readonly resolutionNote: string;
}

export const isChangeRequestOpen = (request: ChangeRequest): boolean => request.state === 'open';

/** The heading a screen shows for one. Never invented twice. */
export const changeRequestSubjectLabel = (subject: ChangeRequestSubject): string => {
  switch (subject) {
    case 'customer':
      return 'Customer record';
    case 'site':
      return 'Site record';
    case 'machine':
      return 'Machine record';
    case 'job':
      return 'Customer’s request about a job';
  }
};

export const changeRequestStateLabel = (state: ChangeRequestState): string => {
  switch (state) {
    case 'open':
      return 'Waiting for the office';
    case 'applied':
      return 'Applied by the office';
    case 'declined':
      return 'Declined by the office';
  }
};

/**
 * What the longest useful report is.
 *
 * Long enough for a serial number, a model and a sentence explaining what is
 * actually on the machine's plate; short enough that it is a report rather than
 * a document.
 */
export const CHANGE_REQUEST_DETAILS_LIMIT = 2000;
