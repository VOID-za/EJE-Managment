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
  const field: readonly Capability[] = ['jobs.issueFinal'];

  it('has every capability that is not the field technician’s own', () => {
    const everything = new Set<Capability>(ROLES.flatMap((role) => capabilitiesFor(role)));
    for (const capability of everything) {
      if (field.includes(capability)) continue;
      expect(can('master', capability)).toBe(true);
    }
  });

  it.each(field)('does NOT hold %s — the technician submits their own job', (capability) => {
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

  it('cannot change the commercial terms', () => {
    expect(can('coordinator', 'settings.manage')).toBe(false);
  });
});

describe('the technician', () => {
  const allowed: readonly Capability[] = [
    'jobs.acceptField',
    'jobs.captureWork',
    // CR-07: the person who did the work makes the final submission.
    'jobs.issueFinal',
    'jobs.processParts',
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
    // The CR-08 takeover is the OFFICE's exception. No calendar entry and no
    // amount of seniority in the field makes it a technician's.
    'jobs.takeOverSubmission',
    'jobs.captureAdministratively',
    'customers.manage',
    'machines.manage',
    'library.manage',
    'availability.manage',
    'admin.access',
    'users.manageTechnicians',
    'users.manageMasters',
    'settings.manage',
    'activity.viewAll',
  ];

  it.each(refused)('cannot %s', (capability) => {
    expect(can('technician', capability)).toBe(false);
  });
});
