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
  const [additionalIds, setAdditionalIds] = useState<readonly string[]>([]);
  /** The real files, held until the job exists to attach them to. */
  const [attachments, setAttachments] = useState<readonly File[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
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
  /** Who may be given field work. The same rule the server enforces. */
  const fieldTechnicians = useMemo(
    () => (data?.users ?? []).filter((user) => user.role === 'technician' && user.active),
    [data?.users],
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
    // Only where the job type collects one. CR-13.
    if (!definition.officeProcessed && faultDescription.trim().length === 0) {
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
        faultDescription: definition.officeProcessed ? '' : faultDescription,
        primaryTechnicianId: technicianId.length > 0 ? technicianId : null,
        additionalTechnicianIds: technicianId.length > 0 ? [...additionalIds] : [],
        courierCollection,
        deliveryNote,
      });
    });

    if (!ok || created === null) {
      setSaving(false);
      return;
    }

    /*
     * The documents, now that there is a job to hang them on.
     *
     * A failure here is NOT a failed job: the job is raised and keeps its
     * number. It is reported plainly and the person is still taken to the job,
     * where they can attach the file again — which beats rolling back a job
     * number over an upload.
     */
    const job = created as Job;
    const failed: string[] = [];
    for (const file of attachments) {
      try {
        await api.attach(job.id, file);
      } catch {
        failed.push(file.name);
      }
    }

    setSaving(false);
    if (failed.length > 0) {
      setAttachmentError(
        `${job.jobNumber} was raised, but ${failed.join(', ')} could not be attached. Open the job and try again.`,
      );
      return;
    }

    /*
     * A COLLECTION CONTINUES STRAIGHT INTO ITS CLOSE-OUT. CR-12.
     *
     * Raising a parts job and processing it are one act at the counter: the
     * customer is standing there. Sending the office back to the Jobs list to
     * find the job it had just raised — and then to accept it — was the whole
     * of the old sequence, and there is nothing left of it to return to.
     *
     * A field job still lands on the job, because the work is somebody else's
     * and happens later.
     */
    router.push(
      definition.officeProcessed
        ? `/jobs/${job.jobNumber}?continue=1`
        : `/jobs/${job.jobNumber}`,
    );
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
              {/* The customer's copy goes HERE, and the office chooses it.
                  Named for what it does rather than "Site contact": the address
                  is shown because that is the fact being decided. */}
              <SelectField
                label="Customer email recipient"
                required
                value={contactId}
                error={errors.contactId}
                hint="Who receives the signed job card. Changeable later, before it is issued."
                placeholder={siteId.length === 0 ? 'Select a site first' : 'Select a contact'}
                disabled={siteId.length === 0}
                onChange={(event) => setContactId(event.target.value)}
                options={contacts.map((contact) => ({
                  value: contact.id,
                  label: `${contactFullName(contact)} — ${contact.position}${contact.email.length > 0 ? ` (${contact.email})` : ' (no email address)'}`,
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
              {/*
                PRIORITY AND A DATE DESCRIBE SENDING SOMEBODY SOMEWHERE. CR-12.

                A parts collection is served at the counter by whoever raised
                it, in the same sitting — there is no queue to prioritise and no
                day to book — so neither field is asked for. The server forces
                both regardless of what a client sends, so this is the rule
                being reflected rather than the rule itself.
              */}
              <div
                className={
                  definition.officeProcessed
                    ? 'grid grid-cols-1 gap-4'
                    : 'grid grid-cols-1 gap-4 sm:grid-cols-3'
                }
              >
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
                    /*
                     * Nothing a collection does not carry survives the switch.
                     *
                     * Left behind, these would be sent on the request and
                     * refused by the server — or worse, silently dropped, and
                     * the office would go on believing it had booked a date.
                     */
                    if (getJobTypeDefinition(code).officeProcessed) {
                      setScheduledDate('');
                      setTechnicianId('');
                      setAdditionalIds([]);
                      setCourierCollection(false);
                      setFaultDescription('');
                    }
                  }}
                  options={JOB_TYPE_CODES.map((code) => ({
                    value: code,
                    label: jobTypeLabel(code),
                  }))}
                />
                {!definition.officeProcessed && (
                  <>
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
                      label={
                        definition.schedulesDateRange ? 'Scheduled start date' : 'Scheduled date'
                      }
                      type="date"
                      value={scheduledDate}
                      onChange={(event) => setScheduledDate(event.target.value)}
                    />
                  </>
                )}
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

              {/*
                Offered wherever the work is collected from the counter: a
                repaired unit leaves on the same kind of trip a box of parts
                does, and a courier must not see the customer's prices on
                either document.

                NOT ON A PARTS COLLECTION. CR-12: who is collecting is asked at
                the COLLECTION step, with whoever actually turned up standing at
                the counter — asking it days earlier only records a guess, and
                asking it twice is how the two answers come to disagree. A
                workshop repair keeps it here, because it is booked in advance
                and the office plans the return leg when it takes the job in.
              */}
              {definition.collectedOnCompletion && !definition.officeProcessed && (
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

              {/*
                A COLLECTION IS NOT RAISED ON A DESCRIPTION. CR-13.

                It used to be asked for here, labelled "Collection details" on a
                parts job. The goods are the record: they are listed on the note
                with their quantities and prices, and a second free-text field
                above them said the same thing again in worse words. The
                document omits the section entirely rather than printing a
                heading over nothing.
              */}
              {!definition.officeProcessed && (
                <TextAreaField
                  label="Fault description / work requested"
                  required
                  rows={4}
                  value={faultDescription}
                  error={errors.faultDescription}
                  onChange={(event) => setFaultDescription(event.target.value)}
                  placeholder="e.g. Machine stopped during operation. Spindle fault reported."
                  hint="Record what the customer reported, in their words where possible."
                />
              )}

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

          {/*
            NOBODY IS "DOING THE WORK" ON A COLLECTION. CR-12.

            A parts collection is handed over at the counter by whoever raised
            it. There is no technician on it at any point — the server refuses
            a request that names one — so the office is not asked to pick one.
          */}
          {!definition.officeProcessed && (
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
              hint="The person who attends the machine, and who is recorded as having attended it."
              onChange={(event) => {
                setTechnicianId(event.target.value);
                // Somebody cannot assist themselves. Changing the primary drops
                // them from the assistants rather than leaving a contradiction
                // the server would have to refuse.
                setAdditionalIds((current) =>
                  current.filter((id) => id !== event.target.value),
                );
              }}
              options={fieldTechnicians.map((technician) => ({
                value: technician.id,
                label: `${userFullName(technician)} — ${technician.jobTitle}`,
              }))}
            />

            {/* Assistants. Only offered once there is somebody to assist —
                the server refuses additional technicians without a primary,
                and a form that lets you build a refusal is a form that wastes
                somebody's afternoon. */}
            {technicianId.length > 0 && (
              <fieldset className="mt-4">
                <legend className="mb-1.5 text-sm font-semibold text-steel-700">
                  Attending with them
                </legend>
                <p className="mb-2.5 text-xs text-steel-500">
                  Optional. Additional technicians see the job and can capture work on it.
                </p>
                <div className="space-y-2">
                  {fieldTechnicians
                    .filter((candidate) => candidate.id !== technicianId)
                    .map((candidate) => (
                      <label
                        key={candidate.id}
                        className="flex cursor-pointer items-center gap-3 rounded-[var(--radius-control)] border border-steel-200 px-3 py-2.5 text-sm hover:border-steel-400 hover:bg-steel-50"
                      >
                        <input
                          type="checkbox"
                          className="size-4 rounded border-steel-300 text-eje-600 focus:ring-eje-500"
                          checked={additionalIds.includes(candidate.id)}
                          onChange={(event) =>
                            setAdditionalIds((current) =>
                              event.target.checked
                                ? [...current, candidate.id]
                                : current.filter((id) => id !== candidate.id),
                            )
                          }
                        />
                        <span className="text-steel-800">
                          {userFullName(candidate)}
                          <span className="text-steel-500"> — {candidate.jobTitle}</span>
                        </span>
                      </label>
                    ))}
                </div>
              </fieldset>
            )}

            {/* What actually happens on Create. Stated, because "assigned" and
                "started" are different things here and the office has to know
                the technician is not on the clock yet. */}
            <p className="mt-4 rounded-[var(--radius-control)] bg-steel-50 px-3 py-2.5 text-xs leading-relaxed text-steel-600">
              The job will be created <strong>Open</strong>
              {technicianId.length > 0
                ? ' and the technician will be notified. It starts — and moves to In Progress — when they accept it, not when it is assigned.'
                : ' and unassigned, in the pool for any technician to accept.'}
            </p>
          </Card>
          )}

          <Card>
            <CardHeader
              title="Attachments"
              description="Quotes, customer orders or drawings the technician needs on site."
            />
            <input
              type="file"
              multiple
              className="mt-4 block w-full text-sm text-steel-700 file:mr-3 file:rounded-[var(--radius-control)] file:border-0 file:bg-steel-100 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-steel-700 hover:file:bg-steel-200"
              accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff,.webp"
              onChange={(event) => {
                /*
                 * READ THE FILES FIRST.
                 *
                 * `event.target.files` is live: clearing the input below empties
                 * it. Reading it inside the state updater — which React runs
                 * later — hands the updater a list that has already been reset,
                 * and the file silently never appears.
                 */
                const chosen = Array.from(event.target.files ?? []);
                setAttachments((current) => [...current, ...chosen]);
                // Lets the same file be chosen again after being removed.
                event.target.value = '';
              }}
            />

            {attachments.length > 0 && (
              <ul className="mt-3 space-y-2">
                {attachments.map((file, index) => (
                  <li
                    key={`${file.name}-${index}`}
                    className="flex items-center justify-between gap-3 rounded-[var(--radius-control)] border border-steel-200 px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate text-steel-800">{file.name}</span>
                    <span className="shrink-0 text-xs text-steel-500">
                      {Math.max(1, Math.round(file.size / 1024))} KB
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setAttachments((current) =>
                          current.filter((_, position) => position !== index),
                        )
                      }
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            {attachmentError !== null && (
              <p
                role="alert"
                className="mt-3 rounded-[var(--radius-control)] bg-danger-50 px-3 py-2.5 text-sm font-medium text-danger-700"
              >
                {attachmentError}
              </p>
            )}

            {/*
              The files go up AFTER the job exists, one request each.

              A job is created by a JSON request that carries no bytes, so
              there is nothing to attach to until it has an id. The server
              stores each file before it records it, so a failure here leaves
              the job raised and the document simply not attached — which is
              what the message says, rather than leaving somebody to guess.
            */}
            <p className="mt-3 text-xs leading-relaxed text-steel-500">
              PDFs and images up to 25 MB. Uploaded once the job is raised, and available to the
              technician on the job card.
            </p>
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
