import type { UserRole } from './types/user';

/**
 * Capability-based access rules.
 *
 * Components ask `can(role, 'jobs.create')` rather than testing
 * `role === 'master'`. When Phase 2 introduces finer-grained roles or per-user
 * overrides, only this module changes.
 */
export type Capability =
  | 'jobs.viewAll'
  | 'jobs.create'
  | 'jobs.assign'
  | 'jobs.accept'
  | 'jobs.captureWork'
  | 'jobs.submit'
  | 'customers.view'
  | 'customers.manage'
  | 'machines.manage'
  | 'library.view'
  | 'library.manage'
  | 'admin.access'
  | 'activity.viewAll';

const MASTER_CAPABILITIES: readonly Capability[] = [
  'jobs.viewAll',
  'jobs.create',
  'jobs.assign',
  'jobs.accept',
  'jobs.captureWork',
  'jobs.submit',
  'customers.view',
  'customers.manage',
  'machines.manage',
  'library.view',
  'library.manage',
  'admin.access',
  'activity.viewAll',
];

const TECHNICIAN_CAPABILITIES: readonly Capability[] = [
  'jobs.accept',
  'jobs.captureWork',
  'jobs.submit',
  'customers.view',
  'library.view',
];

export const capabilitiesFor = (role: UserRole): readonly Capability[] =>
  role === 'master' ? MASTER_CAPABILITIES : TECHNICIAN_CAPABILITIES;

export const can = (role: UserRole, capability: Capability): boolean =>
  capabilitiesFor(role).includes(capability);
