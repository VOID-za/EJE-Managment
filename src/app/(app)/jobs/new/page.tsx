'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import {
  asActivityId,
  checkSchedule,
  daysBetween,
  asContactId,
  asCustomerId,
  asJobId,
  asMachineId,
  asSiteId,
  asUserId,
  can,
  contactFullName,
  emptyCompletionReport,
  getJobTypeDefinition,
  JOB_TYPE_CODES,
  jobTypeLabel,
  machineDisplayName,
  PRIORITY_ORDER,
  priorityLabel,
  userFullName,
  type Job,
  type JobPriority,
  type JobTypeCode,
} from '@/domain';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Icon,
  LoadingPanel,
  SelectField,
  TextAreaField,
  TextField,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useQuery } from '@/hooks/useQuery';
import { useApp, useCurrentUser } from '@/providers/AppProvider';

/**
 * Job creation.
 *
 * The form is driven by the job type definition: selecting Installation or
 * Service immediately shows the checklist and photo requirements the job will
 * carry, so the office knows what the technician will be held to.
 */
const NewJobPage = () => {
  const router = useRouter();
  const user = useCurrentUser();
  const { repositories, services } = useApp();

  const [customerId, setCustomerId] = useState('');
  const [siteId, setSiteId] = useState('');
  const [contactId, setContactId] = useState('');
  const [machineId, setMachineId] = useState('');
  const [jobType, setJobType] = useState<JobTypeCode>('breakdown');
  const [priority, setPriority] = useState<JobPriority>('urgent');
  const [scheduledDate, setScheduledDate] = useState('');
  const [scheduledEndDate, setScheduledEndDate] = useState('');
  const [orderNumber, setOrderNumber] = useState('');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [faultDescription, setFaultDescription] = useState('');
  const [technicianId, setTechnicianId] = useState('');
  const [courierCollection, setCourierCollection] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const dataQuery = useQuery('jobs:new:data', async (repos) => {
    const [customers, sites, contacts, machines, users, settings] = await Promise.all([
      repos.customers.list(),
      repos.customers.listSites(),
      repos.customers.listContacts(),
      repos.machines.list(),
      repos.users.list(),
      repos.settings.get(),
    ]);
    return { customers, sites, contacts, machines, users, settings };
  });

  const data = dataQuery.data;

  const sites = useMemo(
    () => (data?.sites ?? []).filter((site) => site.customerId === customerId),
    [data?.sites, customerId],
  );
  const contacts = useMemo(
    () =>
      (data?.contacts ?? []).filter(
        (contact) =>
          contact.customerId === customerId && (contact.siteId === null || contact.siteId === siteId),
      ),
    [data?.contacts, customerId, siteId],
  );
  const machines = useMemo(
    () => (data?.machines ?? []).filter((machine) => machine.siteId === siteId),
    [data?.machines, siteId],
  );

  if (!can(user.role, 'jobs.create')) {
    return (
      <EmptyState
        title="Not available for your role"
        description="Only Masters can create jobs. Ask the office to raise a job card for you."
        icon={<Icon name="warning" />}
      />
    );
  }

  if (dataQuery.error !== null) {
    return <ErrorState message={dataQuery.error} onRetry={dataQuery.refetch} />;
  }
  if (dataQuery.loading || data === null || data === undefined) {
    return (
      <>
        <PageHeader title="New job" />
        <LoadingPanel rows={4} label="Loading" />
      </>
    );
  }

  const definition = getJobTypeDefinition(jobType);

  const submit = async () => {
    const next: Record<string, string> = {};
    if (customerId.length === 0) next.customerId = 'Select a customer.';
    if (siteId.length === 0) next.siteId = 'Select a site.';
    if (contactId.length === 0) next.contactId = 'Select a site contact.';
    // A parts collection is a receipt for goods, not work on a machine.
    if (definition.capturesLabourAndTravel && machineId.length === 0) {
      next.machineId = 'Select the machine this job is for.';
    }
    if (faultDescription.trim().length === 0) {
      next.faultDescription = 'Describe the fault or the work requested.';
    }
    // On a parts collection the order number is what ties the goods to what the
    // customer ordered, so it is not optional the way it is on a site visit.
    if (definition.requiresOrderNumber && orderNumber.trim().length === 0) {
      next.orderNumber = 'An order number is required for a parts collection.';
    }

    // Service work is booked across a range, so the dates have to make sense.
    const scheduleViolations = checkSchedule(
      jobType,
      scheduledDate.length > 0 ? scheduledDate : null,
      scheduledEndDate.length > 0 ? scheduledEndDate : null,
    );
    const [scheduleProblem] = scheduleViolations;
    if (scheduleProblem !== undefined) {
      next.scheduledEndDate = scheduleProblem.message;
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setSaving(true);
    setSaveError(null);

    try {
      const settings = data.settings;
      const jobNumber = `${settings.jobNumberPrefix}${settings.nextJobSequence}`;
      const now = services.clock.now();

      const job: Job = {
        id: asJobId(`job-${jobNumber.toLowerCase()}`),
        jobNumber,
        customerId: asCustomerId(customerId),
        siteId: asSiteId(siteId),
        contactId: asContactId(contactId),
        machineId: machineId.length > 0 ? asMachineId(machineId) : null,
        jobType,
        priority,
        status: 'open',
        scheduledDate: scheduledDate.length > 0 ? scheduledDate : null,
        scheduledEndDate:
          definition.schedulesDateRange && scheduledEndDate.length > 0 ? scheduledEndDate : null,
        orderNumber: orderNumber.trim(),
        referenceNumber: referenceNumber.trim(),
        faultDescription: faultDescription.trim(),
        attachments: [],
        primaryTechnicianId: technicianId.length > 0 ? asUserId(technicianId) : null,
        additionalTechnicianIds: [],
        labour: [],
        travel: [],
        parts: [],
        photos: [],
        videos: [],
        notes: [],
        completionReport: emptyCompletionReport(),
        checklist: null,
        signature: null,
        awaitingSparesReason: '',
        // A call-out fee is a per-job commercial decision, applied on the job card.
        calloutApplied: false,
        courierCollection: jobType === 'parts' ? courierCollection : false,
        pricingSnapshot: null,
        finalDocument: null,
        cancellation: null,
        deletedAt: null,
        deletedBy: null,
        deletionReason: '',
        createdAt: now,
        createdBy: user.id,
        acceptedAt: null,
        completedAt: null,
        submittedAt: null,
        closedAt: null,
      };

      await repositories.jobs.save(job);
      await repositories.settings.save({
        ...settings,
        nextJobSequence: settings.nextJobSequence + 1,
      });
      await repositories.activity.append({
        id: asActivityId(services.ids.next('act')),
        jobId: job.id,
        type: 'job_created',
        summary: 'Job created',
        detail: `${definition.label} job raised by ${userFullName(user)}.`,
        actorId: user.id,
        occurredAt: now,
      });

      if (technicianId.length > 0) {
        const technician = data.users.find((candidate) => candidate.id === technicianId);
        await repositories.activity.append({
          id: asActivityId(services.ids.next('act')),
          jobId: job.id,
          type: 'job_assigned',
          summary: `Job assigned to ${technician === undefined ? 'a technician' : userFullName(technician)}`,
          detail: 'Assigned as primary technician.',
          actorId: user.id,
          occurredAt: now,
        });
      }

      router.push(`/jobs/${jobNumber}`);
    } catch (cause: unknown) {
      setSaveError(cause instanceof Error ? cause.message : 'The job could not be created.');
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader
        title="New job"
        breadcrumbs={[{ label: 'Jobs', href: '/jobs' }, { label: 'New job' }]}
        description="Raise a job card against a customer machine. The job type determines what the technician must complete."
      />

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div className="space-y-5 xl:col-span-2">
          <Card>
            <CardHeader title="Where is the work?" />
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <SelectField
                label="Customer"
                required
                value={customerId}
                error={errors.customerId}
                placeholder="Select a customer"
                onChange={(event) => {
                  setCustomerId(event.target.value);
                  setSiteId('');
                  setContactId('');
                  setMachineId('');
                }}
                options={data.customers.map((customer) => ({
                  value: customer.id,
                  label: customer.name,
                }))}
              />
              <SelectField
                label="Site"
                required
                value={siteId}
                error={errors.siteId}
                placeholder={customerId.length === 0 ? 'Select a customer first' : 'Select a site'}
                disabled={customerId.length === 0}
                onChange={(event) => {
                  setSiteId(event.target.value);
                  setContactId('');
                  setMachineId('');
                }}
                options={sites.map((site) => ({
                  value: site.id,
                  label: `${site.name} — ${site.city}`,
                }))}
              />
              <SelectField
                label="Site contact"
                required
                value={contactId}
                error={errors.contactId}
                placeholder={siteId.length === 0 ? 'Select a site first' : 'Select a contact'}
                disabled={siteId.length === 0}
                onChange={(event) => setContactId(event.target.value)}
                options={contacts.map((contact) => ({
                  value: contact.id,
                  label: `${contactFullName(contact)} — ${contact.position}`,
                }))}
              />
              <SelectField
                label={definition.capturesLabourAndTravel ? 'Machine' : 'Machine (optional)'}
                required={definition.capturesLabourAndTravel}
                value={machineId}
                error={errors.machineId}
                placeholder={siteId.length === 0 ? 'Select a site first' : 'Select a machine'}
                disabled={siteId.length === 0}
                onChange={(event) => setMachineId(event.target.value)}
                options={machines.map((machine) => ({
                  value: machine.id,
                  label: `${machineDisplayName(machine)} — ${machine.serialNumber}`,
                }))}
              />
            </div>
          </Card>

          <Card>
            <CardHeader title="What is the job?" />
            <div className="mt-4 space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <SelectField
                  label="Job type"
                  required
                  value={jobType}
                  onChange={(event) => {
                    const code = event.target.value as JobTypeCode;
                    setJobType(code);
                    setPriority(getJobTypeDefinition(code).defaultPriority);
                    // Only service work is booked across a range.
                    if (!getJobTypeDefinition(code).schedulesDateRange) setScheduledEndDate('');
                  }}
                  options={JOB_TYPE_CODES.map((code) => ({
                    value: code,
                    label: jobTypeLabel(code),
                  }))}
                />
                <SelectField
                  label="Priority"
                  required
                  value={priority}
                  onChange={(event) => setPriority(event.target.value as JobPriority)}
                  options={PRIORITY_ORDER.map((value) => ({
                    value,
                    label: priorityLabel(value),
                  }))}
                />
                <TextField
                  label={definition.schedulesDateRange ? 'Scheduled start date' : 'Scheduled date'}
                  type="date"
                  value={scheduledDate}
                  onChange={(event) => setScheduledDate(event.target.value)}
                />
              </div>

              {definition.schedulesDateRange && (
                <div className="grid grid-cols-1 gap-4 rounded-[var(--radius-control)] border border-eje-200 bg-eje-50 p-4 sm:grid-cols-2">
                  <TextField
                    label="Scheduled end date"
                    type="date"
                    value={scheduledEndDate}
                    min={scheduledDate.length > 0 ? scheduledDate : undefined}
                    onChange={(event) => setScheduledEndDate(event.target.value)}
                    error={errors.scheduledEndDate}
                    hint="A service is quoted for a number of days and is booked across a range."
                  />
                  <div className="flex items-end pb-1">
                    <p className="text-sm text-eje-800">
                      {scheduledDate.length > 0 && scheduledEndDate.length > 0 ? (
                        <>
                          Booked for{' '}
                          <span className="font-semibold">
                            {daysBetween(scheduledDate, scheduledEndDate) + 1} days
                          </span>{' '}
                          on the calendar.
                        </>
                      ) : (
                        'Leave the end date blank for a single-day service.'
                      )}
                    </p>
                  </div>
                </div>
              )}

              {jobType === 'parts' && (
                <div className="rounded-[var(--radius-control)] border border-amber-eje-200 bg-amber-eje-50 p-4">
                  <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm font-semibold text-amber-eje-700">
                    <input
                      type="checkbox"
                      checked={courierCollection}
                      onChange={(event) => setCourierCollection(event.target.checked)}
                      className="size-4.5 rounded border-steel-300 text-eje-600 focus:ring-eje-500"
                    />
                    Courier Collection
                  </label>
                  <p className="mt-1.5 text-sm text-steel-700">
                    {courierCollection
                      ? 'Prices will be hidden from the collection document. The courier has no reason to see them; the prices stay on the job for EJE costing.'
                      : 'The customer is collecting the parts themselves, so prices may be shown on the collection document.'}
                  </p>
                </div>
              )}

              <TextAreaField
                label={
                  jobType === 'parts'
                    ? 'Collection details'
                    : 'Fault description / work requested'
                }
                required
                rows={4}
                value={faultDescription}
                error={errors.faultDescription}
                onChange={(event) => setFaultDescription(event.target.value)}
                placeholder={
                  jobType === 'parts'
                    ? 'e.g. Spindle drive spares for collection against PO-88212.'
                    : 'e.g. Machine stopped during operation. Spindle fault reported.'
                }
                hint={
                  jobType === 'parts'
                    ? 'What is being collected, and anything the office should know.'
                    : 'Record what the customer reported, in their words where possible.'
                }
              />

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <TextField
                  label="Customer order number"
                  required={definition.requiresOrderNumber}
                  value={orderNumber}
                  onChange={(event) => setOrderNumber(event.target.value)}
                  error={errors.orderNumber}
                  placeholder="e.g. PO-88123"
                  hint={
                    definition.requiresOrderNumber
                      ? 'Printed on the collection note and used to reconcile against the customer’s order.'
                      : undefined
                  }
                />
                <TextField
                  label="Reference number"
                  value={referenceNumber}
                  onChange={(event) => setReferenceNumber(event.target.value)}
                  placeholder="Internal or customer reference"
                />
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Who is doing the work?"
              description="A job can be created unassigned and picked up later."
            />
            <SelectField
              containerClassName="mt-4"
              label="Primary technician"
              value={technicianId}
              placeholder="Leave unassigned"
              onChange={(event) => setTechnicianId(event.target.value)}
              options={data.users
                .filter((candidate) => candidate.role === 'technician' && candidate.active)
                .map((technician) => ({
                  value: technician.id,
                  label: `${userFullName(technician)} — ${technician.jobTitle}`,
                }))}
            />
          </Card>

          {saveError !== null && (
            <p role="alert" className="text-sm font-medium text-signal-600">
              {saveError}
            </p>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" size="lg" onClick={() => router.push('/jobs')}>
              Cancel
            </Button>
            <Button size="lg" onClick={submit} loading={saving}>
              Create job
            </Button>
          </div>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader
              title={`${definition.label} job`}
              description={definition.description}
            />
            <ul className="mt-4 space-y-2.5 text-sm">
              <li className="flex items-start gap-2.5">
                <Icon
                  name={definition.checklistRequired ? 'check' : 'close'}
                  className={`mt-0.5 size-4 ${definition.checklistRequired ? 'text-verdant-600' : 'text-steel-400'}`}
                />
                <span className="text-steel-700">
                  {definition.checklistRequired
                    ? 'A mandatory checklist must be completed before the customer signs.'
                    : 'No checklist is required for this job type.'}
                </span>
              </li>
              <li className="flex items-start gap-2.5">
                <Icon
                  name={definition.photosRequired ? 'check' : 'close'}
                  className={`mt-0.5 size-4 ${definition.photosRequired ? 'text-verdant-600' : 'text-steel-400'}`}
                />
                <span className="text-steel-700">
                  {definition.photosRequired
                    ? 'At least one photograph is required.'
                    : 'Photographs are optional but encouraged.'}
                </span>
              </li>
            </ul>
            <p className="mt-4 text-xs text-steel-500">
              Job types and their requirements will be configurable by Masters in the production
              system.
            </p>
          </Card>

          <Card>
            <CardHeader title="Next job number" />
            <p className="mt-2 font-mono text-2xl font-bold text-steel-900">
              {data.settings.jobNumberPrefix}
              {data.settings.nextJobSequence}
            </p>
            <Badge tone="neutral" size="sm" className="mt-2">
              Allocated on save
            </Badge>
          </Card>
        </div>
      </div>
    </>
  );
};

export default NewJobPage;
