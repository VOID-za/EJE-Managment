'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  activeUsers,
  assignableRoles,
  canManageUser,
  disabledUsers,
  manageUserRefusal,
  roleLabel,
  userFullName,
  type User,
  type UserRole,
} from '@/domain';
import {
  createUser,
  sendPasswordReset,
  setUserActive,
  updateUser,
} from '@/application/user-operations';
import {
  Avatar,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  EmptyState,
  Icon,
  Modal,
  SelectField,
  Tabs,
  TextField,
  type Column,
} from '@/components/ui';
import { AdminNotice } from './AdminNotice';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { useOperation } from '@/hooks/useOperation';
import { useCurrentUser } from '@/providers/AppProvider';
import { formatDate } from '@/lib/format';

/**
 * User administration.
 *
 * Two rules from the domain decide what this screen offers, rather than the
 * screen deciding for itself:
 *
 * - `canManageUser` — a Master manages technicians and their own account, never
 *   another Master. Where it says no, no edit controls are rendered at all.
 * - `activeUsers` / `disabledUsers` — a leaver is disabled, never deleted, and
 *   is moved out of the default list rather than cluttering it. Their past jobs
 *   and audit entries still name them.
 */
type ListId = 'active' | 'disabled';

interface EditorState {
  readonly user: User | null;
  readonly mode: 'create' | 'edit';
}

export const UsersPanel = ({
  users,
  onChanged,
}: {
  readonly users: readonly User[];
  readonly onChanged: () => void;
}) => {
  const actor = useCurrentUser();
  const operation = useOperation();
  const [list, setList] = useState<ListId>('active');
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [confirming, setConfirming] = useState<{ user: User; enable: boolean } | null>(null);
  const [resetting, setResetting] = useState<User | null>(null);
  const [resetSentTo, setResetSentTo] = useState<string | null>(null);

  const active = activeUsers(users);
  const disabled = disabledUsers(users);
  const rows = list === 'active' ? active : disabled;

  const columns: Column<User>[] = [
    {
      key: 'name',
      header: 'User',
      render: (row) => (
        <Link href={`/technicians/${row.id}`} className="flex items-center gap-3 hover:underline">
          <Avatar initials={row.initials} size="md" />
          <div className="min-w-0">
            <p className="truncate font-semibold text-steel-900">{userFullName(row)}</p>
            <p className="truncate text-xs text-steel-500">{row.jobTitle}</p>
          </div>
        </Link>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      render: (row) => (
        <Badge tone={row.role === 'master' ? 'blue' : 'neutral'} size="sm">
          {roleLabel(row.role)}
        </Badge>
      ),
    },
    { key: 'email', header: 'Email', secondary: true, render: (row) => row.email },
    { key: 'mobile', header: 'Mobile', secondary: true, render: (row) => row.mobile },
    {
      key: 'since',
      header: 'On record since',
      secondary: true,
      render: (row) => <span className="tabular">{formatDate(row.createdAt)}</span>,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) => {
        const refusal = manageUserRefusal(actor, row);
        if (refusal !== null) {
          // No edit controls at all for an account this Master may not manage.
          return <span className="text-xs text-steel-400">{refusal}</span>;
        }
        return (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {row.role !== 'master' && (
              <Link href={`/technicians/${row.id}`}>
                <Button size="sm" variant="ghost">
                  Availability
                </Button>
              </Link>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setEditor({ user: row, mode: 'edit' })}
            >
              Edit
            </Button>
            {row.active && (
              <Button size="sm" variant="ghost" onClick={() => setResetting(row)}>
                Reset password
              </Button>
            )}
            <Button
              size="sm"
              variant={row.active ? 'ghost' : 'secondary'}
              onClick={() => setConfirming({ user: row, enable: !row.active })}
            >
              {row.active ? 'Disable' : 'Reactivate'}
            </Button>
          </div>
        );
      },
    },
  ];

  return (
    <div className="space-y-4">
      <AdminNotice
        title="User management"
        body="Masters add users, set roles, disable leavers and reactivate returners. A Master cannot edit another Master — those accounts show no controls. Disabling never deletes: past job cards and the audit trail keep naming the person who did the work. Open a technician to record their availability."
      />

      {operation.error !== null && (
        <RuleViolationNotice
          title="That change was not made"
          message={operation.error}
          violations={operation.violations}
        />
      )}

      {resetSentTo !== null && (
        <Card className="border-verdant-200 bg-verdant-50">
          <p className="text-sm font-semibold text-verdant-700">
            Password reset queued to {resetSentTo}. In demo mode it appears in the Simulated
            Outbox rather than being delivered.
          </p>
        </Card>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          tabs={[
            { id: 'active', label: `Active users (${active.length})` },
            { id: 'disabled', label: `Disabled users (${disabled.length})` },
          ]}
          activeId={list}
          onChange={(id) => setList(id as ListId)}
        />
        <Button
          leadingIcon={<Icon name="plus" className="size-4" />}
          onClick={() => setEditor({ user: null, mode: 'create' })}
        >
          Add user
        </Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title={list === 'active' ? 'No active users' : 'No disabled users'}
          description={
            list === 'active'
              ? 'Add a user to get started.'
              : 'Nobody has been disabled. Leavers appear here rather than in the active list.'
          }
          icon={<Icon name="customers" />}
        />
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} />
      )}

      {editor !== null && (
        <UserEditor
          state={editor}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            onChanged();
          }}
        />
      )}

      <ConfirmDialog
        open={confirming !== null}
        title={confirming?.enable === true ? 'Reactivate this user?' : 'Disable this user?'}
        message={
          confirming === null
            ? ''
            : confirming.enable
              ? `${userFullName(confirming.user)} will be able to sign in again and will reappear in the active user list.`
              : `${userFullName(confirming.user)} will no longer be able to sign in. Nothing is deleted — their past jobs and audit entries still name them.`
        }
        confirmLabel={confirming?.enable === true ? 'Reactivate user' : 'Disable user'}
        confirmVariant={confirming?.enable === true ? 'primary' : 'danger'}
        busy={operation.running}
        onConfirm={async () => {
          if (confirming === null) return;
          const ok = await operation.run((context) =>
            setUserActive(context, confirming.user, confirming.enable),
          );
          setConfirming(null);
          if (ok) onChanged();
        }}
        onCancel={() => setConfirming(null)}
      />

      <ConfirmDialog
        open={resetting !== null}
        title="Send a password reset?"
        message={
          resetting === null
            ? ''
            : `A reset link will be sent to ${resetting.email}. Their current password keeps working until they use it.`
        }
        confirmLabel="Send reset link"
        busy={operation.running}
        onConfirm={async () => {
          if (resetting === null) return;
          const target = resetting;
          const ok = await operation.run((context) => sendPasswordReset(context, target));
          setResetting(null);
          if (ok) {
            setResetSentTo(target.email);
            onChanged();
          }
        }}
        onCancel={() => setResetting(null)}
      />
    </div>
  );
};

/** Add or edit a user. The role selector offers non-Master roles only. */
const UserEditor = ({
  state,
  onClose,
  onSaved,
}: {
  readonly state: EditorState;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) => {
  const actor = useCurrentUser();
  const operation = useOperation();
  const existing = state.user;

  const [firstName, setFirstName] = useState(existing?.firstName ?? '');
  const [lastName, setLastName] = useState(existing?.lastName ?? '');
  const [email, setEmail] = useState(existing?.email ?? '');
  const [mobile, setMobile] = useState(existing?.mobile ?? '');
  const [jobTitle, setJobTitle] = useState(existing?.jobTitle ?? 'Field Service Technician');
  // What this actor is allowed to create. A Master may add an office
  // Coordinator or a technician; a Coordinator may add technicians only, so she
  // cannot promote herself by creating an account and signing in as it.
  const creatable = assignableRoles(actor.role);
  const [role, setRole] = useState<UserRole>(creatable[0] ?? 'technician');

  // Guard in depth: the operations refuse this too, but an unmanageable account
  // should never have reached an editor in the first place.
  if (existing !== null && !canManageUser(actor, existing)) return null;

  const submit = async (): Promise<void> => {
    const ok = await operation.run((context) =>
      existing === null
        ? createUser(context, {
            firstName,
            lastName,
            email,
            mobile,
            jobTitle,
            role,
          })
        : updateUser(context, {
            ...existing,
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            email: email.trim(),
            mobile: mobile.trim(),
            jobTitle: jobTitle.trim(),
          }),
    );
    if (ok) onSaved();
  };

  return (
    <Modal
      open
      title={existing === null ? 'Add user' : `Edit ${userFullName(existing)}`}
      description={
        existing === null
          ? 'Creates an account. Master accounts are not created from here.'
          : undefined
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={operation.running}>
            Cancel
          </Button>
          <Button onClick={submit} loading={operation.running}>
            {existing === null ? 'Create user' : 'Save changes'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {operation.error !== null && (
          <RuleViolationNotice
            title="The user could not be saved"
            message={operation.error}
            violations={operation.violations}
          />
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            label="First name"
            required
            value={firstName}
            onChange={(event) => setFirstName(event.target.value)}
          />
          <TextField
            label="Surname"
            required
            value={lastName}
            onChange={(event) => setLastName(event.target.value)}
          />
          <TextField
            label="Email"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            hint="Used to sign in. Each user needs their own."
            containerClassName="sm:col-span-2"
          />
          <TextField
            label="Mobile"
            type="tel"
            value={mobile}
            onChange={(event) => setMobile(event.target.value)}
          />
          <TextField
            label="Job title"
            value={jobTitle}
            onChange={(event) => setJobTitle(event.target.value)}
          />
        </div>

        {existing === null &&
          (creatable.length > 1 ? (
            <SelectField
              label="Role"
              value={role}
              onChange={(event) => setRole(event.target.value as UserRole)}
              options={creatable.map((candidate) => ({
                value: candidate,
                label: roleLabel(candidate),
              }))}
              hint="A Master account cannot be created from this screen."
            />
          ) : (
            <div className="rounded-[var(--radius-control)] border border-steel-200 bg-steel-50 px-4 py-3 text-sm text-steel-600">
              <span className="font-semibold text-steel-800">
                Role: {roleLabel(creatable[0] ?? 'technician')}.
              </span>{' '}
              Office and Master accounts are created by a Master.
            </div>
          ))}
        {existing !== null && existing.role === 'master' && (
          <div className="rounded-[var(--radius-control)] border border-eje-200 bg-eje-50 px-4 py-3 text-sm text-eje-800">
            This is your own Master account. The role itself cannot be changed here.
          </div>
        )}
      </div>
    </Modal>
  );
};
