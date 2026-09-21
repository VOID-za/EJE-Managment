'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import {
  checkSchedule,
  daysBetween,
  can,
  contactFullName,
  getJobTypeDefinition,
  JOB_TYPE_CODES,
  jobTypeLabel,
  machineLabel,
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
  Icon,
  LoadingPanel,
  QueryFailure,
  SelectField,
  TextAreaField,
  TextField,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { jobs as api, reads } from '@/api/endpoints';
import { useQuery } from '@/hooks/useQuery';
import { useCurrentUser } from '@/providers/AppProvider';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { useOperation } from '@/hooks/useOperation';

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
  const operation = useOperation();

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
  const [deliveryNote, setDeliveryNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const dataQuery = useQuery('jobs:new:data', () => reads.jobForm());

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
        description="Jobs are raised by the office. Ask them to raise a job card for you."
        icon={<Icon name="warning" />}
      />
    );
  }

  if (dataQuery.error !== null) {
    return <QueryFailure code={dataQuery.errorCode} message={dataQuery.error} onRetry={dataQuery.refetch} />;
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

    let created: Job | null = null;
    const ok = await operation.run(async () => {
      created = await api.create({
        customerId,
        siteId,
        contactId,
        machineId: machineId.length > 0 ? machineId : null,
        jobType,
        priority,
        scheduledDate: scheduledDate.length > 0 ? scheduledDate : null,
        scheduledEndDate: scheduledEndDate.length > 0 ? scheduledEndDate : null,
        orderNumber,
        referenceNumber,
        faultDescription,
        primaryTechnicianId: technicianId.length > 0 ? technicianId : null,
        courierCollection,
        deliveryNote,
      });
    });

    setSaving(false);
    if (!ok || created === null) return;

    router.push(`/jobs/${(created as Job).jobNumber}`);
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
                  // The customer's own machine number leads where they use one:
                  // the caller says "STM2 is down", not the serial number.
                  label: `${machineLabel(machine)} — ${machine.serialNumber}`,
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

              {/* Offered wherever the work is collected from the counter: a
                  repaired unit leaves on the same kind of trip a box of parts
                  does, and a courier must not see the customer's prices on
                  either document. */}
              {definition.collectedOnCompletion && (
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
                      : 'The customer is collecting themselves, so prices may be shown on the collection document. Whoever actually turns up is confirmed again at the collection.'}
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
                {/* Optional, always. Some customers reconcile parts and
                    workshop repairs against a delivery note rather than an
                    order number, and a document that cannot quote it back is
                    one their accounts department cannot match. */}
                {definition.capturesDeliveryNote && (
                  <TextField
                    label="Delivery note"
                    value={deliveryNote}
                    onChange={(event) => setDeliveryNote(event.target.value)}
                    placeholder="e.g. DN-12345"
                    hint="Optional. The customer’s own delivery note number, printed on the collection document."
                  />
                )}
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

          {operation.error !== null && (
            <RuleViolationNotice
              title="The job could not be raised"
              message={operation.error}
              violations={operation.violations}
            />
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
