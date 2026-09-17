'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  can,
  contactFullName,
  getJobTypeDefinition,
  jobScheduleWindow,
  machineDisplayName,
  userFullName,
  type User,
} from '@/domain';
import { addAdditionalTechnician, assignPrimaryTechnician } from '@/application/job-operations';
import type { JobView } from '@/application/job-view';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardHeader,
  DefinitionGrid,
  Icon,
  Modal,
  PriorityBadge,
  SelectField,
} from '@/components/ui';
import { JobCostSummary } from './JobCostSummary';
import { useOperation } from '@/hooks/useOperation';
import { useCurrentUser } from '@/providers/AppProvider';
import { formatDate, formatDateTime, isOverdue } from '@/lib/format';

export const JobOverviewPanel = ({
  view,
  users,
  editable,
  onChanged,
}: {
  readonly view: JobView;
  readonly users: readonly User[];
  readonly editable: boolean;
  readonly onChanged: () => void;
}) => {
  const { job, customer, site, contact, machine } = view;
  const currentUser = useCurrentUser();
  const operation = useOperation();
  const [assignOpen, setAssignOpen] = useState(false);
  const [selectedTechnician, setSelectedTechnician] = useState('');
  const [assignMode, setAssignMode] = useState<'primary' | 'additional'>('primary');

  const definition = getJobTypeDefinition(job.jobType);
  const canAssign = can(currentUser.role, 'jobs.assign') && editable;
  const technicians = users.filter((user) => user.role === 'technician' && user.active);

  const overdue = isOverdue(job.scheduledDate) && job.status !== 'closed';
  const scheduleWindow = jobScheduleWindow(job);

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
      <div className="space-y-5 xl:col-span-2">
        <Card>
          <CardHeader
            title="Reported fault"
            description={`${definition.label} — ${definition.description}`}
          />
          <p className="mt-4 rounded-[var(--radius-control)] bg-steel-50 p-4 text-sm leading-relaxed whitespace-pre-line text-steel-700">
            {job.faultDescription.length > 0
              ? job.faultDescription
              : 'No fault description was recorded when this job was created.'}
          </p>

          {job.status === 'awaiting_spares' && job.awaitingSparesReason.length > 0 && (
            <div className="mt-4 rounded-[var(--radius-control)] border border-amber-eje-200 bg-amber-eje-50 p-4">
              <p className="flex items-center gap-2 text-sm font-semibold text-amber-eje-700">
                <Icon name="box" className="size-4" />
                Awaiting spares
              </p>
              <p className="mt-1.5 text-sm text-steel-700">{job.awaitingSparesReason}</p>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Job details" />
          <DefinitionGrid
            className="mt-4"
            columns={3}
            items={[
              { label: 'Job number', value: <span className="font-mono">{job.jobNumber}</span> },
              { label: 'Job type', value: definition.label },
              { label: 'Priority', value: <PriorityBadge priority={job.priority} size="sm" /> },
              {
                label: scheduleWindow !== null && scheduleWindow.days > 1
                  ? 'Scheduled'
                  : 'Scheduled date',
                value:
                  scheduleWindow !== null && scheduleWindow.days > 1 ? (
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className={overdue ? 'font-semibold text-signal-600' : undefined}>
                        {formatDate(scheduleWindow.start)} – {formatDate(scheduleWindow.end)}
                      </span>
                      <Badge tone="blue" size="sm">
                        {scheduleWindow.days} days
                      </Badge>
                    </span>
                  ) : (
                    <span className={overdue ? 'font-semibold text-signal-600' : undefined}>
                      {formatDate(job.scheduledDate)}
                      {overdue && ' (overdue)'}
                    </span>
                  ),
              },
              {
                label: 'Order number',
                value: job.orderNumber.length > 0 ? job.orderNumber : '—',
              },
              {
                label: 'Reference number',
                value: job.referenceNumber.length > 0 ? job.referenceNumber : '—',
              },
              { label: 'Created', value: formatDateTime(job.createdAt) },
              { label: 'Accepted', value: formatDateTime(job.acceptedAt) },
              { label: 'Completed', value: formatDateTime(job.completedAt) },
            ]}
          />
        </Card>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader
              title="Customer"
              action={
                <Link href={`/customers/${customer.id}`}>
                  <Button variant="ghost" size="sm" trailingIcon={<Icon name="chevronRight" className="size-4" />}>
                    Open
                  </Button>
                </Link>
              }
            />
            <div className="mt-4 space-y-3 text-sm">
              <p className="font-semibold text-steel-900">{customer.name}</p>
              <div>
                <p className="text-xs font-semibold tracking-wide text-steel-500 uppercase">
                  Site
                </p>
                <p className="mt-0.5 text-steel-700">
                  {site.name}
                  <br />
                  {site.addressLine1}
                  {site.addressLine2.length > 0 && (
                    <>
                      <br />
                      {site.addressLine2}
                    </>
                  )}
                  <br />
                  {site.city}, {site.province} {site.postalCode}
                </p>
                {site.accessNotes.length > 0 && (
                  <p className="mt-2 rounded-[var(--radius-control)] bg-eje-50 px-3 py-2 text-xs text-eje-800">
                    <span className="font-semibold">Site access: </span>
                    {site.accessNotes}
                  </p>
                )}
              </div>
              {contact !== null && (
                <div>
                  <p className="text-xs font-semibold tracking-wide text-steel-500 uppercase">
                    Contact
                  </p>
                  <p className="mt-0.5 text-steel-700">
                    <span className="font-medium text-steel-900">{contactFullName(contact)}</span>
                    <br />
                    {contact.position}
                    <br />
                    {contact.phone}
                    <br />
                    {contact.email}
                  </p>
                </div>
              )}
            </div>
          </Card>

          {machine !== null && (
            <Card>
              <CardHeader
                title="Machine"
                action={
                  <Link href={`/machines/${machine.id}`}>
                    <Button
                      variant="ghost"
                      size="sm"
                      trailingIcon={<Icon name="chevronRight" className="size-4" />}
                    >
                      Open
                    </Button>
                  </Link>
                }
              />
              <p className="mt-4 text-sm font-semibold text-steel-900">
                {machineDisplayName(machine)}
              </p>
              <DefinitionGrid
                className="mt-3"
                columns={1}
                items={[
                  {
                    label: 'Serial number',
                    value: <span className="font-mono">{machine.serialNumber}</span>,
                  },
                  { label: 'Machine type', value: machine.machineType },
                  { label: 'Control system', value: machine.controlSystem },
                  { label: 'Year', value: String(machine.year) },
                  { label: 'Installed', value: formatDate(machine.installationDate) },
                ]}
              />
              {machine.notes.length > 0 && (
                <p className="mt-3 rounded-[var(--radius-control)] bg-steel-50 px-3 py-2 text-xs text-steel-600">
                  {machine.notes}
                </p>
              )}
            </Card>
          )}
        </div>
      </div>

      <div className="space-y-5">
        <Card>
          <CardHeader
            title="Technicians"
            action={
              canAssign ? (
                <Button
                  variant="ghost"
                  size="sm"
                  leadingIcon={<Icon name="plus" className="size-4" />}
                  onClick={() => {
                    setAssignMode(job.primaryTechnicianId === null ? 'primary' : 'additional');
                    setAssignOpen(true);
                  }}
                >
                  Assign
                </Button>
              ) : undefined
            }
          />
          <ul className="mt-4 space-y-2">
            {view.primaryTechnician === null ? (
              <li className="rounded-[var(--radius-control)] border border-dashed border-steel-300 px-3 py-3 text-sm text-steel-500">
                No technician assigned yet.
              </li>
            ) : (
              <li className="flex items-center gap-3 rounded-[var(--radius-control)] bg-steel-50 px-3 py-2.5">
                <Avatar initials={view.primaryTechnician.initials} size="md" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-steel-900">
                    {userFullName(view.primaryTechnician)}
                  </p>
                  <p className="text-xs text-steel-500">{view.primaryTechnician.jobTitle}</p>
                </div>
                <Badge tone="blue" size="sm">
                  Primary
                </Badge>
              </li>
            )}

            {view.additionalTechnicians.map((technician) => (
              <li
                key={technician.id}
                className="flex items-center gap-3 rounded-[var(--radius-control)] px-3 py-2.5"
              >
                <Avatar initials={technician.initials} size="md" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-steel-900">
                    {userFullName(technician)}
                  </p>
                  <p className="text-xs text-steel-500">{technician.jobTitle}</p>
                </div>
                <Badge tone="outline" size="sm">
                  Assisting
                </Badge>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <CardHeader title="Job value" description="Calculated from captured work." />
          <JobCostSummary job={job} settings={view.settings} className="mt-4" />
        </Card>

        <Card>
          <CardHeader title="Requirements" description="Set by the job type." />
          <ul className="mt-4 space-y-2 text-sm">
            <RequirementRow
              label="Mandatory checklist"
              met={!definition.checklistRequired || job.checklist?.completedAt !== null}
              required={definition.checklistRequired}
            />
            <RequirementRow
              label="Photographs required"
              met={!definition.photosRequired || job.photos.length > 0}
              required={definition.photosRequired}
            />
            <RequirementRow
              label="Labour captured"
              met={job.labour.length > 0}
              required
            />
            <RequirementRow
              label="Work performed recorded"
              met={job.completionReport.workPerformed.trim().length > 0}
              required
            />
          </ul>
        </Card>
      </div>

      <Modal
        open={assignOpen}
        title={assignMode === 'primary' ? 'Assign primary technician' : 'Add technician'}
        onClose={() => setAssignOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setAssignOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={operation.running}
              disabled={selectedTechnician.length === 0}
              onClick={async () => {
                const technician = technicians.find(
                  (candidate) => candidate.id === selectedTechnician,
                );
                if (technician === undefined) return;

                const ok = await operation.run((context) =>
                  assignMode === 'primary'
                    ? assignPrimaryTechnician(
                        context,
                        job,
                        technician.id,
                        userFullName(technician),
                      )
                    : addAdditionalTechnician(
                        context,
                        job,
                        technician.id,
                        userFullName(technician),
                      ),
                );
                if (ok) {
                  setAssignOpen(false);
                  setSelectedTechnician('');
                  onChanged();
                }
              }}
            >
              Assign
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <SelectField
            label="Role on this job"
            value={assignMode}
            onChange={(event) => setAssignMode(event.target.value as 'primary' | 'additional')}
            options={[
              { value: 'primary', label: 'Primary technician' },
              { value: 'additional', label: 'Additional technician' },
            ]}
          />
          <SelectField
            label="Technician"
            value={selectedTechnician}
            onChange={(event) => setSelectedTechnician(event.target.value)}
            placeholder="Select a technician"
            options={technicians.map((technician) => ({
              value: technician.id,
              label: `${userFullName(technician)} — ${technician.jobTitle}`,
            }))}
          />
        </div>
      </Modal>
    </div>
  );
};

const RequirementRow = ({
  label,
  met,
  required,
}: {
  readonly label: string;
  readonly met: boolean;
  readonly required: boolean;
}) => (
  <li className="flex items-center gap-2.5">
    <span
      className={
        met
          ? 'flex size-5 items-center justify-center rounded-full bg-verdant-100 text-verdant-700'
          : 'flex size-5 items-center justify-center rounded-full bg-steel-100 text-steel-400'
      }
    >
      <Icon name={met ? 'check' : 'close'} className="size-3" />
    </span>
    <span className={met ? 'text-steel-600' : 'text-steel-800'}>{label}</span>
    {!required && (
      <Badge tone="outline" size="sm">
        Not required
      </Badge>
    )}
  </li>
);
