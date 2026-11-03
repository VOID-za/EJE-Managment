import { describe, expect, it } from 'vitest';
import { can, capabilitiesFor, type Capability } from './access';
import type { UserRole } from './types/user';

/**
 * The capability table, stated as facts rather than as a copy of itself.
 *
 * These assertions are deliberately written out one by one. A test that looped
 * over the same constant the implementation uses would pass whatever that
 * constant said, which is worth nothing.
 */

const ROLES: readonly UserRole[] = ['master', 'coordinator', 'technician'];

describe('the Master', () => {
  /*
   * THE MASTER IS NO LONGER A SUPERSET OF EVERYONE, AND THAT IS THE POINT.
   *
   * This asserted that the Master holds every capability any role holds. It
   * was true, and it encoded seniority as the axis the table turns on. CR-07
   * (confirmed 25 September 2026) replaced that with WHERE THE PERSON WORKS:
   * the final submission of a signed job card is the technician's, because
   * they are the person who attended the machine and took the signature, and
   * the office has no step in the normal journey at all.
   *
   * So the assertion is now the honest one — everything EXCEPT the field
   * capabilities, named individually — and the exceptions are asserted in
   * their own case below rather than quietly dropped.
   */
  /*
   * `standby.requestSwap` too (STANDBY-5, 2 November 2026): a swap is offered
   * by the person who holds the standby place, and only a technician account
   * can be on the standby roster. The office changes the calendar directly
   * (`standby.manage`), so it has nothing to ask for.
   *
   * STANDBY-ELIG-2 (the owner, 3 November 2026): a Senior Tech may be on the
   * roster (main and helper places), so a Senior Tech holds it too; the Office
   * still does not (asserted in the Coordinator's block and in standby.test.ts).
   */
  const field: readonly Capability[] = ['jobs.issueFinal'];

  it('STANDBY-ELIG-2: holds standby.requestSwap, as somebody who may be on the roster', () => {
    expect(can('master', 'standby.requestSwap')).toBe(true);
    expect(can('coordinator', 'standby.requestSwap')).toBe(false);
  });

  it('has every capability that is not the field technician’s own', () => {
    const everything = new Set<Capability>(ROLES.flatMap((role) => capabilitiesFor(role)));
    for (const capability of everything) {
      if (field.includes(capability)) continue;
      expect(can('master', capability)).toBe(true);
    }
  });

  it.each(field)('does NOT hold %s — it is the field technician’s own', (capability) => {
    expect(can('master', capability)).toBe(false);
    expect(can('technician', capability)).toBe(true);
  });
});

describe('the Coordinator', () => {
  const allowed: readonly Capability[] = [
    'jobs.viewAll',
    'jobs.create',
    'jobs.assign',
    'jobs.captureWork',
    // CR-08: the exceptional takeover. Not a submission right — it unlocks
    // only when the people who could submit the job are provably unavailable.
    'jobs.takeOverSubmission',
    'jobs.processParts',
    'jobs.captureAdministratively',
    // JOB-EDIT-1 (#72): the office corrects a job's recorded details.
    'jobs.editDetails',
    'customers.view',
    'customers.manage',
    'machines.manage',
    'library.view',
    'library.manage',
    'availability.manage',
    'admin.access',
    'users.manageTechnicians',
    'activity.viewAll',
  ];

  it.each(allowed)('can %s', (capability) => {
    expect(can('coordinator', capability)).toBe(true);
  });

  it('cannot accept a field job: she does not attend the machine', () => {
    expect(can('coordinator', 'jobs.acceptField')).toBe(false);
  });

  it('cannot submit an ordinary signed job card — CR-07', () => {
    expect(can('coordinator', 'jobs.issueFinal')).toBe(false);
  });

  it('cannot administer Masters, so she cannot promote herself', () => {
    expect(can('coordinator', 'users.manageMasters')).toBe(false);
  });

  /*
   * THE RATES AND THE CHECKLISTS ARE HERS; NOTHING ELSE OF THE SETTINGS IS.
   * The owner asked for the Coordinator to maintain both from Administration.
   * `settings.manage` (the rest of the system settings) and the discount stay a
   * Master's.
   */
  it('maintains the rates and the checklists', () => {
    expect(can('coordinator', 'settings.rates')).toBe(true);
    expect(can('coordinator', 'settings.checklists')).toBe(true);
  });

  it('does not gain the other system settings with them', () => {
    expect(can('coordinator', 'settings.manage')).toBe(false);
    expect(can('coordinator', 'users.manageMasters')).toBe(false);
  });
});

describe('the technician', () => {
  const allowed: readonly Capability[] = [
    'jobs.acceptField',
    'jobs.captureWork',
    // CR-07: the person who did the work makes the final submission.
    'jobs.issueFinal',
    'customers.view',
    'library.view',
  ];

  it.each(allowed)('can %s', (capability) => {
    expect(can('technician', capability)).toBe(true);
  });

  const refused: readonly Capability[] = [
    'jobs.viewAll',
    'jobs.create',
    'jobs.assign',
    /*
     * A PARTS COLLECTION IS COUNTER WORK. MASTER SCOPE CR-12, answering BD-12.
     *
     * > **Superseded, 25 September 2026:** `jobs.processParts` was listed
     * > among the technician's capabilities above. It let a technician accept,
     * > process and issue a collection — which is what left BD-12 open, since
     * > the prose had always described a collection as something the office
     * > hands over at the counter. EJE answered it: a parts job is raised and
     * > processed by a Master or a Coordinator, start to finish.
     */
    'jobs.processParts',
    // The CR-08 takeover is the OFFICE's exception. No calendar entry and no
    // amount of seniority in the field makes it a technician's.
    'jobs.takeOverSubmission',
    'jobs.captureAdministratively',
    // JOB-EDIT-1 (#72): a technician who finds a detail wrong raises a change
    // request; correcting the record is the office's.
    'jobs.editDetails',
    'customers.manage',
    'machines.manage',
    'library.manage',
    'availability.manage',
    'admin.access',
    'users.manageTechnicians',
    'users.manageMasters',
    'settings.manage',
    'settings.rates',
    'settings.checklists',
    'activity.viewAll',
  ];

  it.each(refused)('cannot %s', (capability) => {
    expect(can('technician', capability)).toBe(false);
  });
});
