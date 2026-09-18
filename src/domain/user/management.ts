import type { User, UserRole } from '../types/user';

/**
 * Who this person may administer.
 *
 * A Master runs the business and may administer anyone except another Master:
 * Master accounts are peers, and one quietly disabling another's is not a
 * change the system should allow. Anyone may edit their own record; that is
 * self-service, not administration of somebody else.
 *
 * A Coordinator runs the office and may administer TECHNICIANS only. She may
 * not touch a Master or another Coordinator — promoting, demoting or disabling
 * an office administrator is a Master's decision, and without that rule a
 * Coordinator could simply make herself a Master.
 */
export const canManageUser = (actor: Pick<User, 'id' | 'role'>, target: User): boolean => {
  if (target.id === actor.id) return true;
  if (actor.role === 'master') return target.role !== 'master';
  if (actor.role === 'coordinator') return target.role === 'technician';
  return false;
};

/** Why this account cannot be edited, phrased for the screen. */
export const manageUserRefusal = (
  actor: Pick<User, 'id' | 'role'>,
  target: User,
): string | null => {
  if (canManageUser(actor, target)) return null;
  if (actor.role === 'technician') return 'Only the office can manage user accounts.';
  if (actor.role === 'coordinator') {
    return 'A Coordinator can manage technicians. Master and Coordinator accounts are managed by a Master.';
  }
  return 'Master accounts cannot be edited by another Master.';
};

/**
 * The roles this person may assign.
 *
 * A Master may create a Coordinator or a technician, but never another Master.
 * A Coordinator may only create technicians — otherwise she could promote
 * herself by creating an account and signing in as it.
 */
export const assignableRoles = (actorRole: UserRole): readonly UserRole[] => {
  if (actorRole === 'master') return ['coordinator', 'technician'];
  if (actorRole === 'coordinator') return ['technician'];
  return [];
};

export const roleLabel = (role: UserRole): string => {
  switch (role) {
    case 'master':
      return 'Master';
    case 'coordinator':
      return 'Coordinator';
    case 'technician':
      return 'Technician';
  }
};

/**
 * The people currently working at EJE.
 *
 * Disabled users are never deleted — historical jobs and the audit trail keep
 * naming them — but they should not clutter the lists used for day-to-day work.
 */
export const activeUsers = (users: readonly User[]): readonly User[] =>
  users.filter((user) => user.active);

export const disabledUsers = (users: readonly User[]): readonly User[] =>
  users.filter((user) => !user.active);

/** An email already in use by another account, or null. */
export const findEmailClash = (
  users: readonly User[],
  email: string,
  excludingId?: string,
): User | null => {
  const needle = email.trim().toLowerCase();
  return (
    users.find(
      (user) => user.id !== excludingId && user.email.trim().toLowerCase() === needle,
    ) ?? null
  );
};

/** Initials derived from a name, used when the Master does not supply them. */
export const deriveInitials = (firstName: string, lastName: string): string =>
  `${firstName.trim().charAt(0)}${lastName.trim().charAt(0)}`.toUpperCase();
