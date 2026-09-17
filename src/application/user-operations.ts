import {
  asUserId,
  deriveInitials,
  findEmailClash,
  manageUserRefusal,
  userFullName,
  type User,
  type UserRole,
} from '@/domain';
import type { OperationContext } from './context';
import { audit } from './audit';
import { WorkflowError } from './errors';

/**
 * User administration.
 *
 * Two rules shape everything here. A Master manages technicians and other
 * non-Master accounts but never another Master. And a user who leaves EJE is
 * disabled, never deleted: historical job cards and the audit trail must keep
 * naming the person who actually did the work.
 */
export interface NewUserInput {
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly mobile: string;
  readonly jobTitle: string;
  readonly role: UserRole;
}

const assertMaster = (context: OperationContext): void => {
  if (context.actor.role === 'master') return;
  throw new WorkflowError('Only a Master can manage user accounts.', [
    { code: 'not_permitted', message: 'User administration is a Master function.' },
  ]);
};

const assertManages = (context: OperationContext, target: User): void => {
  const refusal = manageUserRefusal(context.actor, target);
  if (refusal === null) return;
  throw new WorkflowError(refusal, [
    {
      code: 'master_not_editable',
      message: `${userFullName(target)} is a Master account and is not editable from here.`,
    },
  ]);
};

const required = (value: string, code: string, message: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new WorkflowError(message, [{ code, message }]);
  return trimmed;
};

const assertEmailFree = async (
  context: OperationContext,
  email: string,
  excludingId?: string,
): Promise<void> => {
  const users = await context.repos.users.list();
  const clash = findEmailClash(users, email, excludingId);
  if (clash === null) return;
  throw new WorkflowError(`${clash.email} is already used by ${userFullName(clash)}.`, [
    { code: 'duplicate_email', message: 'Each user needs their own email address to sign in.' },
  ]);
};

export const createUser = async (
  context: OperationContext,
  input: NewUserInput,
): Promise<User> => {
  assertMaster(context);

  // A Master cannot mint another Master: that is a change to the office itself.
  if (input.role === 'master') {
    throw new WorkflowError('A Master account cannot be created from here.', [
      {
        code: 'master_not_assignable',
        message: 'Masters can create technician and office accounts only.',
      },
    ]);
  }

  const firstName = required(input.firstName, 'first_name_required', 'A first name is required.');
  const lastName = required(input.lastName, 'last_name_required', 'A surname is required.');
  const email = required(input.email, 'email_required', 'An email address is required to sign in.');
  await assertEmailFree(context, email);

  const user: User = {
    id: asUserId(context.services.ids.next('user')),
    firstName,
    lastName,
    initials: deriveInitials(firstName, lastName),
    email,
    mobile: input.mobile.trim(),
    role: input.role,
    jobTitle: input.jobTitle.trim(),
    active: true,
    createdAt: context.services.clock.now(),
  };

  const saved = await context.repos.users.save(user);
  await audit(context, {
    jobId: null,
    type: 'user_created',
    summary: `User added: ${userFullName(saved)}`,
    detail: `${saved.jobTitle || 'Technician'} · ${saved.email}.`,
  });
  return saved;
};

export const updateUser = async (context: OperationContext, user: User): Promise<User> => {
  assertMaster(context);
  const existing = await context.repos.users.findById(user.id);
  if (existing === null) throw new WorkflowError('That user no longer exists.');
  assertManages(context, existing);

  // The role of an existing Master cannot be changed from here either.
  if (existing.role === 'master' && user.role !== 'master') {
    throw new WorkflowError('A Master account cannot be demoted from here.', [
      { code: 'master_not_editable', message: 'Master accounts are managed outside this screen.' },
    ]);
  }
  await assertEmailFree(context, user.email, user.id);

  const saved = await context.repos.users.save({
    ...user,
    initials:
      user.initials.trim().length > 0
        ? user.initials.trim()
        : deriveInitials(user.firstName, user.lastName),
  });
  await audit(context, {
    jobId: null,
    type: 'user_updated',
    summary: `User updated: ${userFullName(saved)}`,
    detail: `Account details amended by ${userFullName(context.actor)}.`,
  });
  return saved;
};

export const setUserActive = async (
  context: OperationContext,
  user: User,
  active: boolean,
): Promise<User> => {
  assertMaster(context);
  assertManages(context, user);
  if (user.id === context.actor.id && !active) {
    throw new WorkflowError('You cannot disable your own account.', [
      { code: 'self_disable', message: 'Ask another Master to disable this account.' },
    ]);
  }

  // Disabling is a status change, never a delete: the account keeps its history.
  const saved = await context.repos.users.save({ ...user, active });
  await audit(context, {
    jobId: null,
    type: active ? 'user_reactivated' : 'user_disabled',
    summary: `${active ? 'User reactivated' : 'User disabled'}: ${userFullName(saved)}`,
    detail: active
      ? 'The account can sign in again and appears in the active user list.'
      : 'The account can no longer sign in. Past jobs and audit entries still name this user.',
  });
  return saved;
};

export interface PasswordResetResult {
  readonly user: User;
  readonly sentTo: string;
  readonly simulated: boolean;
}

/**
 * Sends a password-reset link.
 *
 * The demo has no password store, so no password is changed here: the reset
 * email is queued into the simulated outbox exactly as the production system
 * would queue it, and the audit trail records that it was sent.
 */
export const sendPasswordReset = async (
  context: OperationContext,
  user: User,
): Promise<PasswordResetResult> => {
  assertMaster(context);
  assertManages(context, user);
  if (!user.active) {
    throw new WorkflowError('A disabled account cannot be sent a reset link.', [
      { code: 'user_disabled', message: 'Reactivate the account first.' },
    ]);
  }

  await context.services.email.send({
    to: [user.email],
    subject: 'EJE Industrial Electronics — password reset',
    body:
      `Good day ${user.firstName},\n\n` +
      'A password reset was requested for your EJE job card account. ' +
      'Follow the link in this message to choose a new password.\n\n' +
      'Kind regards\nEJE Industrial Electronics',
    attachments: [],
  });

  await audit(context, {
    jobId: null,
    type: 'password_reset_sent',
    summary: `Password reset sent: ${userFullName(user)}`,
    detail: `Reset link queued to ${user.email} by ${userFullName(context.actor)}. Simulated in demo mode.`,
  });

  return { user, sentTo: user.email, simulated: true };
};

