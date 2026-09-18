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
  it('has every capability there is', () => {
    const everything = new Set<Capability>(ROLES.flatMap((role) => capabilitiesFor(role)));
    for (const capability of everything) {
      expect(can('master', capability)).toBe(true);
    }
  });
});

describe('the Coordinator', () => {
  const allowed: readonly Capability[] = [
    'jobs.viewAll',
    'jobs.create',
    'jobs.assign',
    'jobs.captureWork',
    'jobs.submit',
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
    'jobs.submit',
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
