'use client';

import { useState } from 'react';
import {
  can,
  contactFullName,
  getJobTypeDefinition,
  repairItemsOf,
  jobDetailLabel,
  jobScheduleWindow,
  machineDisplayName,
  userFullName,
  type User,
  isFinishedStatus,
  isIssuedStatus,
} from '@/domain';
import type { JobView } from '@/application/job-view';
import {
  Avatar,
  Badge,
  Button, ButtonLink,
  Card,
  CardHeader,
  DefinitionGrid,
  Icon,
  Modal,
  PriorityBadge,
  SelectField,
} from '@/components/ui';
import { MachinePhotoFromJob } from '@/components/machines/MachinePhotoFromJob';
import { JobCostSummary } from './JobCostSummary';
import { JobDetailsEditDialog } from './JobDetailsEditDialog';
import { RepairItemsDialog } from './RepairItemsEditor';
import { RuleViolationNotice } from './RuleViolationNotice';
import { jobs } from '@/api/endpoints';
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

  /*
   * A job whose document has gone out. From here on the register is the
   * PRESENT DAY and the customer's copy is the history, so the two are
   * labelled apart — see the note in the Machine card. MACH-HIST (#28).
   */
  const historicalJob =
    job.status === 'closed' || isIssuedStatus(job.status) || job.submittedAt !== null;
  const currentUser = useCurrentUser();
  const operation = useOperation();
  const [assignOpen, setAssignOpen] = useState(false);
  const [selectedTechnician, setSelectedTechnician] = useState('');
  const [assignMode, setAssignMode] = useState<'primary' | 'additional'>('primary');

  const definition = getJobTypeDefinition(job.jobType);
  const canAssign = can(currentUser.role, 'jobs.assign') && editable;
  /*
   * JOB-EDIT-1. The office, on a job still open to changes — `editable` is
   * `canEditJobRecord`, the screen's copy of the server's `assertEditable`, so
   * the button disappears at signature exactly where the server starts
   * refusing.
   */
  const canEditDetails = can(currentUser.role, 'jobs.editDetails') && editable;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [partsOpen, setPartsOpen] = useState(false);
  const technicians = users.filter((user) => user.role === 'technician' && user.active);

  const overdue =
    isOverdue(job.scheduledDate) && !isFinishedStatus(job.status) && !isIssuedStatus(job.status);
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

          {job.status === 'awaiting_spares' && job.sparesRequest !== null && (
            <div className="mt-4 rounded-[var(--radius-control)] border border-amber-eje-200 bg-amber-eje-50 p-4">
              <p className="flex items-center gap-2 text-sm font-semibold text-amber-eje-700">
                <Icon name="box" className="size-4" />
                Awaiting spares
              </p>
              <p className="mt-1.5 text-sm font-medium text-steel-800">
                {job.sparesRequest.description}
              </p>
              {job.sparesRequest.notes.length > 0 && (
                <p className="mt-1.5 text-sm text-steel-700">{job.sparesRequest.notes}</p>
              )}
              {/*
                HOW LONG, not only what. SPARE-2.
                The first thing the office is asked about a held-up job is how
                long it has been standing, and until now nothing recorded it.
              */}
              <p className="mt-2 text-xs text-steel-600">
                Requested {formatDateTime(job.sparesRequest.requestedAt)}
              </p>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Job details"
            action={
              canEditDetails ? (
                <span className="flex flex-wrap justify-end gap-1">
                  {definition.capturesRepairItem && (
                    <Button
                      variant="ghost"
                      size="sm"
                      leadingIcon={<Icon name="box" className="size-4" />}
                      onClick={() => setPartsOpen(true)}
                      data-testid="edit-repair-items"
                    >
                      Edit parts
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    leadingIcon={<Icon name="edit" className="size-4" />}
                    onClick={() => setDetailsOpen(true)}
                    data-testid="edit-job-details"
                  >
                    Edit details
                  </Button>
                </span>
              ) : undefined
            }
          />
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
              /*
               * THE TEST & REPAIR FIELDS, ONLY WHERE THE TYPE CARRIES THEM.
               * Test & Repair §4.
               *
               * Spread in rather than always present, so a breakdown's detail
               * grid does not grow four rows of em-dashes for fields its job
               * type never offered.
               */
              ...(definition.capturesQuoteNumber
                ? [
                    {
                      label: 'Quote number',
                      value: job.quoteNumber.length > 0 ? job.quoteNumber : '—',
                    },
                  ]
                : []),
              /*
               * THE DELIVERY NOTE, where the type captures one. It was recorded
               * at creation and shown nowhere on the job screen — which JOB-EDIT-1
               * makes untenable, since a field that can be corrected has to be
               * visible to be found wrong.
               */
              ...(definition.capturesDeliveryNote
                ? [
                    {
                      label: jobDetailLabel('deliveryNote', job.jobType),
                      value: job.deliveryNote.length > 0 ? job.deliveryNote : '—',
                    },
                  ]
                : []),
              ...(definition.capturesRepairItem
                ? [
                    {
                      label: 'Date received',
                      value: job.dateReceived ?? '—',
                    },
                    {
                      // TR-PARTS-1: every part booked in, each with its quantity.
                      label: repairItemsOf(job).length > 1 ? `Parts booked in (${repairItemsOf(job).length})` : 'Parts booked in',
                      value:
                        repairItemsOf(job).length === 0 ? (
                          '—'
                        ) : (
                          <ol className="list-decimal space-y-0.5 pl-5" data-testid="repair-items-list">
                            {repairItemsOf(job).map((item, index) => (
                              <li key={index} data-testid="repair-items-list-row">
                                {[item.description, item.partNumber, item.quantity === null ? '' : `× ${item.quantity}`]
                                  .filter((part) => part.length > 0)
                                  .join(' · ')}
                              </li>
                            ))}
                          </ol>
                        ),
                    },
                  ]
                : []),
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
                <ButtonLink href={`/customers/${customer.id}`} variant="ghost" size="sm" trailingIcon={<Icon name="chevronRight" className="size-4" />}>Open</ButtonLink>
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
                {historicalJob && (
                  <p
                    className="mt-3 rounded-[var(--radius-control)] border border-steel-200 bg-steel-50 px-3 py-2 text-xs text-steel-600"
                    data-testid="register-is-present-day-site"
                  >
                    Shown as the register has it today. The issued job card
                    holds what was recorded when the work was done.
                  </p>
                )}
                {site.accessNotes.length > 0 && (
                  <p className="mt-2 rounded-[var(--radius-control)] bg-eje-50 px-3 py-2 text-xs text-eje-800">
                    <span className="font-semibold">Site access: </span>
                    {site.accessNotes}
                  </p>
                )}
              </div>
              {contact !== null && (
                <div>
                  {/* Named for what it decides. This contact is not merely "the
                      person at the site": they are who the signed job card is
                      emailed to, chosen when the job was raised. */}
                  <p className="text-xs font-semibold tracking-wide text-steel-500 uppercase">
                    Contact · receives the job card
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

          {job.attachments.length > 0 && (
            <Card>
              <CardHeader
                title="Attachments"
                description="Photographs and videos attached when the job was raised."
              />
              <ul className="mt-4 space-y-2">
                {job.attachments.map((file) => (
                  <li
                    key={file.id}
                    className="flex items-start gap-2.5 rounded-[var(--radius-control)] border border-steel-200 px-3 py-2.5 text-sm"
                  >
                    <Icon name="document" className="mt-0.5 size-4 shrink-0 text-steel-400" />
                    <span className="min-w-0 flex-1">
                      {/*
                        An ordinary link to an authorised route.
                        
                        No storage key, no signed URL, nothing that works for
                        somebody who is not signed in: the server decides on
                        every request whether this person may read this job
                        before it reads a byte.
                      */}
                      <a
                        href={jobs.attachmentUrl(job.id, file.id)}
                        className="block truncate font-medium text-eje-700 underline-offset-2 hover:underline"
                      >
                        {file.fileName}
                      </a>
                      {file.caption.length > 0 && (
                        <span className="block text-xs text-steel-500">{file.caption}</span>
                      )}
                    </span>
                    <span className="shrink-0 text-xs text-steel-500">
                      {Math.max(1, Math.round(file.sizeBytes / 1024))} KB
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {machine !== null && (
            <Card>
              <CardHeader
                title="Machine"
                action={
                  <ButtonLink href={`/machines/${machine.id}`}
                      variant="ghost"
                      size="sm"
                      trailingIcon={<Icon name="chevronRight" className="size-4" />}>Open</ButtonLink>
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
                  ...(machine.machineNumber.trim().length > 0
                    ? [{ label: 'Machine number', value: machine.machineNumber.trim() }]
                    : []),
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
              {/*
                WHAT THIS PANEL IS, ON A JOB THAT IS FINISHED. MACH-HIST (#28).

                The machine and the site are resolved from the register as it
                stands TODAY, not as it stood when the work was done — the job
                carries identifiers, and the register is a living record. On an
                open job that is exactly right: a technician needs today's
                control system and today's access notes.

                On a job that has been issued or closed it can mislead, because
                the panel reads like a record of where the work happened. The
                document the customer holds is the historical record and cannot
                change (its bytes are frozen); this says so rather than letting
                a present-day address be mistaken for a past one.

                It is a LABEL, not a movement history. Whether EJE record a
                machine's moves, and what a job screen should then show, is
                MACH-HIST and is open — so nothing here invents an effective
                date or a previous location.
              */}
              {/*
                WHERE THE MACHINE STOOD WHEN THE WORK WAS DONE. BD-20, answered.

                The owner answered on 23 October 2026: a CLOSED job shows the
                location at the time of the work; a job in progress shows the
                current register. So on a finished job this states the
                HISTORICAL site from the recorded movement history — and when
                the history cannot answer it SAYS SO, rather than letting
                today's register be read as a record of where the work happened.

                That last case is the common one today, because
                `machine_movements` records only moves made from now on. Saying
                "not known" is the honest answer and the one the owner asked
                for; the alternative is a screen that quietly misreports where
                a customer's machine was.
              */}
              {view.machineLocationAtWork !== null &&
                (view.machineLocationAtWork.known ? (
                  <p
                    className="mt-3 rounded-[var(--radius-control)] border border-eje-200 bg-eje-50 px-3 py-2 text-xs text-eje-800"
                    data-testid="machine-location-at-work"
                  >
                    <span className="font-semibold">When this work was done </span>
                    ({formatDate(view.machineLocationAtWork.asAt)}) the machine stood at{' '}
                    <span className="font-semibold">{view.machineLocationAtWork.siteName}</span>,{' '}
                    {view.machineLocationAtWork.customerName}.
                    {view.machineLocationAtWork.movedSince
                      ? ' It has been moved since — the register above is where it stands today.'
                      : ' It has not been moved since.'}
                  </p>
                ) : (
                  <p
                    className="mt-3 rounded-[var(--radius-control)] border border-steel-200 bg-steel-50 px-3 py-2 text-xs text-steel-600"
                    data-testid="machine-location-at-work-unknown"
                  >
                    <span className="font-semibold">
                      Where the machine stood when this work was done is not known.{' '}
                    </span>
                    {view.machineLocationAtWork.reason} The job card issued to the customer still
                    shows what was recorded then — that document cannot change.
                  </p>
                ))}
              {/* BD-14: the technician at the machine photographs it from the
                  job that put them there. The register itself stays the
                  office's screen and the record stays unchanged. */}
              <MachinePhotoFromJob job={job} machine={machine} onChanged={onChanged} />
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
            {/*
              WHAT THIS JOB TYPE ACTUALLY REQUIRES. Issue #73, Batch 2. These
              two were shown as required on every job — a parts collection
              included, which needs neither. The rows now follow the same rule
              `checkReadyForSignature` applies: a collection needs parts lines
              and an order number, nothing else.
            */}
            {definition.capturesLabourAndTravel && (
              <RequirementRow label="Labour captured" met={job.labour.length > 0} required />
            )}
            {definition.capturesCompletionWriteUp && (
              <RequirementRow
                label="Work performed recorded"
                met={job.completionReport.workPerformed.trim().length > 0}
                required
              />
            )}
            {!definition.capturesLabourAndTravel && (
              <RequirementRow label="Parts listed" met={job.parts.length > 0} required />
            )}
            {definition.requiresOrderNumber && (
              <RequirementRow
                label="Customer order number"
                met={job.orderNumber.trim().length > 0}
                required
              />
            )}
          </ul>
        </Card>
      </div>

      {partsOpen && <RepairItemsDialog job={job} onClose={() => setPartsOpen(false)} onSaved={onChanged} />}

      {detailsOpen && (
        <JobDetailsEditDialog
          job={job}
          open
          onClose={() => setDetailsOpen(false)}
          onSaved={onChanged}
        />
      )}

      <Modal
        open={assignOpen}
        title={assignMode === 'primary' ? 'Assign primary technician' : 'Add technician'}
        onClose={() => setAssignOpen(false)}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                operation.clearError();
                setAssignOpen(false);
              }}
            >
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

                const ok = await operation.run(() =>
                  assignMode === 'primary'
                    ? jobs.assignPrimary(job.id, technician.id)
                    : jobs.addTechnician(job.id, technician.id),
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
          {/* An availability clash is refused by the domain; without this the
              refusal would be invisible and the Assign button would just look
              broken. */}
          {operation.error !== null && (
            <RuleViolationNotice
              title={
                operation.error === 'Technician unavailable'
                  ? 'Technician unavailable'
                  : 'That technician was not assigned'
              }
              message={operation.error === 'Technician unavailable' ? undefined : operation.error}
              violations={operation.violations}
            />
          )}

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
