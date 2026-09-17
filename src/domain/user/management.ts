import type { User, UserRole } from '../types/user';

/**
 * Who a Master may administer.
 *
 * A Master runs the office: they create and manage technicians and other
 * non-Master accounts. They may NOT edit another Master — Master accounts are
 * peers, and one office administrator quietly disabling another's account is
 * not a change the system should allow. A Master may still edit their own
 * record; that is a self-service change, not administration of a peer.
 */
export const canManageUser = (actor: Pick<User, 'id' | 'role'>, target: User): boolean => {
  if (actor.role !== 'master') return false;
  if (target.id === actor.id) return true;
  return target.role !== 'master';
};

/** Why a Master cannot edit this account, phrased for the screen. */
export const manageUserRefusal = (
  actor: Pick<User, 'id' | 'role'>,
  target: User,
): string | null => {
  if (canManageUser(actor, target)) return null;
  if (actor.role !== 'master') return 'Only a Master can manage user accounts.';
  return 'Master accounts cannot be edited by another Master.';
};

/** Roles a Master may assign. A Master cannot mint another Master. */
export const ASSIGNABLE_ROLES: readonly UserRole[] = ['technician'];

export const roleLabel = (role: UserRole): string =>
  role === 'master' ? 'Master' : 'Technician';

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
