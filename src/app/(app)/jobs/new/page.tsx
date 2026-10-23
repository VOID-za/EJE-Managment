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
import {
  JOB_MEDIA_ACCEPT_ATTRIBUTE,
  JOB_MEDIA_TYPES_SENTENCE,
} from '@/lib/upload-limits';

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
  /*
   * UNSET UNTIL SOMEBODY CHOOSES, where the job type allows that. §3B.
   *
   * It used to start at 'urgent' — the breakdown default — so every job
   * carried a grading nobody had made, and the office had no way to say "we do
   * not know yet". It now starts null and is defaulted only when the chosen
   * job type REQUIRES one (see the job-type effect below), which is the only
   * case where a pre-selection is a convenience rather than an invention.
   */
  const [priority, setPriority] = useState<JobPriority | null>(null);
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
  const [deliveryNote, setDeliveryNote] = useState('');
  /*
   * THE TEST & REPAIR FIELDS. Test & Repair §4.
   *
   * The quantity is held as a STRING because that is what an input gives, and
   * because "" has to stay distinguishable from 0 — blank means nobody
   * counted, and the server is sent null rather than a number nobody chose.
   */
  const [repairPartNumber, setRepairPartNumber] = useState('');
  const [repairDescription, setRepairDescription] = useState('');
  const [repairQuantity, setRepairQuantity] = useState('');
  const [quoteNumber, setQuoteNumber] = useState('');
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

  /*
   * SAVING A DRAFT ASKS LESS, AND NOTHING ELSE IS RELAXED. DRAFT-1.
   *
   * The two facts a draft may omit are the ones the TECHNICIAN or the customer
   * still has to supply — what the work is, and which machine. Everything else
   * is still required, because a draft addressed to nobody is not a draft of a
   * job card. The SERVER applies the identical rule, and re-asks both of them
   * when the draft is released.
   */
  const submit = async (asDraft = false) => {
    const next: Record<string, string> = {};
    if (customerId.length === 0) next.customerId = 'Select a customer.';
    if (siteId.length === 0) next.siteId = 'Select a site.';
    if (contactId.length === 0) next.contactId = 'Select a site contact.';
    /*
     * A MACHINE ONLY WHERE THE JOB TYPE NEEDS ONE. Create New Job §3A / §4.
     *
     * `requiresMachine` rather than `capturesLabourAndTravel`: a breakdown is
     * telephoned in before anybody knows which machine it is, and a
     * test-and-repair unit may not be on the register at all. The SERVER
     * applies the identical rule.
     */
    if (!asDraft && definition.requiresMachine && machineId.length === 0) {
      next.machineId = 'Select the machine this job is for.';
    }
    // And a priority only where the job type needs one. §3B / §4.
    if (!asDraft && definition.requiresPriority && priority === null) {
      next.priority = 'Choose how urgent this job is.';
    }
    // Only where the job type requires one. CR-13, and Test & Repair §4: a
    // workshop repair is booked in before the fault is diagnosed.
    if (!asDraft && definition.requiresFaultDescription && faultDescription.trim().length === 0) {
      next.faultDescription = 'Describe the fault or the work requested.';
    }
    /*
     * A QUANTITY THAT WAS TYPED IS A REAL ONE. Test & Repair §4.
     *
     * Blank is fine and means nobody counted. Anything else has to be a whole
     * number above zero, which is what the schema and the database both say —
     * so the person is told here rather than by a 400.
     */
    if (repairQuantity.trim() !== '') {
      const parsed = Number(repairQuantity);
      if (!Number.isInteger(parsed) || parsed < 1) {
        next.repairQuantity = 'Enter a whole number of units, or leave it blank.';
      }
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
        /*
         * ALWAYS FALSE FROM THIS SCREEN. Job completion §6.
         *
         * Sent explicitly rather than omitted, because the field is part of
         * the request contract and a screen that leaves it out would be relying
         * on a schema default. The SERVER writes false at creation whatever
         * arrives, which is where the rule actually lives.
         */
        courierCollection: false,
        deliveryNote,
        /*
         * THE TEST & REPAIR FIELDS. Test & Repair §4.
         *
         * Sent flat, as a form posts them; the server groups the three
         * received-item values and clears all four on a job type that does not
         * capture them. A blank quantity is sent as NULL rather than as 0,
         * because nobody counted.
         */
        repairPartNumber,
        repairDescription,
        repairQuantity: repairQuantity.trim() === '' ? null : Number(repairQuantity),
        quoteNumber,
        asDraft,
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
                label={definition.requiresMachine ? 'Machine' : 'Machine (optional)'}
                required={definition.requiresMachine}
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
                    /*
                     * THE DEFAULT IS OFFERED ONLY WHERE A PRIORITY IS REQUIRED.
                     * Create New Job §3B / §4.
                     *
                     * Switching to an installation or a service pre-selects the
                     * type's usual grading, which is a convenience on planned
                     * work the office grades as it books it. Switching to a
                     * breakdown or a test-and-repair job clears it instead, so
                     * the field says "Not graded yet" rather than quietly
                     * carrying "Urgent" from the default.
                     */
                    const chosen = getJobTypeDefinition(code);
                    setPriority(chosen.requiresPriority ? chosen.defaultPriority : null);
                    // Only service work is booked across a range.
                    if (!getJobTypeDefinition(code).schedulesDateRange) setScheduledEndDate('');
                    /*
                     * Nothing a collection does not carry survives the switch.
                     *
                     * Left behind, these would be sent on the request and
                     * refused by the server — or worse, silently dropped, and
                     * the office would go on believing it had booked a date.
                     */
                    /*
                     * Nothing a job type does not capture survives the switch.
                     * Test & Repair §4, and the same reasoning as the
                     * collection fields below: left behind, these would be sent
                     * on the request and cleared by the server anyway — and the
                     * office would be looking at a field it believed it had
                     * filled in.
                     */
                    if (!chosen.capturesRepairItem) {
                      setRepairPartNumber('');
                      setRepairDescription('');
                      setRepairQuantity('');
                    }
                    if (!chosen.capturesQuoteNumber) setQuoteNumber('');
                    if (getJobTypeDefinition(code).officeProcessed) {
                      setScheduledDate('');
                      setTechnicianId('');
                      setAdditionalIds([]);
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
                    {/*
                      NOT GRADED IS AN ANSWER. Create New Job §3B / §4.

                      Where the job type does not require a priority the list
                      carries an explicit "Not graded yet" and starts there, so
                      the office can raise a breakdown without grading it. The
                      empty option is absent where a priority IS required, so an
                      installation cannot be left ungraded by accident.
                    */}
                    <SelectField
                      label={definition.requiresPriority ? 'Priority' : 'Priority (optional)'}
                      required={definition.requiresPriority}
                      value={priority ?? ''}
                      error={errors.priority}
                      onChange={(event) =>
                        setPriority(
                          event.target.value === '' ? null : (event.target.value as JobPriority),
                        )
                      }
                      options={[
                        ...(definition.requiresPriority
                          ? []
                          : [{ value: '', label: 'Not graded yet' }]),
                        ...PRIORITY_ORDER.map((value) => ({
                          value,
                          label: priorityLabel(value),
                        })),
                      ]}
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
                WHO IS COLLECTING IS NOT ASKED HERE. Job completion §6.

                This used to carry a "Courier Collection" tick box on a
                workshop repair, and the owner has asked for it to be gone until
                the job is finished. The reasoning was already written down one
                job type over, for a parts collection, and is the same here: who
                was EXPECTED and who TURNS UP are not the same question. A
                customer who said they would collect sends a driver often enough
                that an answer recorded at creation is a guess — and the
                consequence of a wrong guess is a courier holding a document
                with the customer's prices on it.

                It is asked in the close-out wizard, at the collection, with
                whoever actually turned up standing at the counter. The server
                agrees: creation writes `false` whatever the request sends, and
                `setCollectionMethod` refuses before the job reaches
                `completion`.
              */}

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
                  label={
                    definition.requiresFaultDescription
                      ? 'Fault description / work requested'
                      : 'Fault description / work requested (optional)'
                  }
                  required={definition.requiresFaultDescription}
                  rows={4}
                  value={faultDescription}
                  error={errors.faultDescription}
                  onChange={(event) => setFaultDescription(event.target.value)}
                  placeholder="e.g. Machine stopped during operation. Spindle fault reported."
                  hint={
                    definition.requiresFaultDescription
                      ? 'Record what the customer reported, in their words where possible.'
                      : 'Optional on a workshop repair — the unit is booked in before it is diagnosed. Record what the customer reported if they said.'
                  }
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
                    label="Delivery note / waybill number"
                    value={deliveryNote}
                    onChange={(event) => setDeliveryNote(event.target.value)}
                    placeholder="e.g. DN-12345"
                    hint="Optional. The customer’s own delivery note number, printed on the collection document."
                  />
                )}
                {/*
                  THE CUSTOMER'S QUOTE NUMBER. Test & Repair §4.

                  Test & Repair only. The owner struck it out on a parts
                  collection, which is reconciled by its order number — and
                  that one is already required there.
                */}
                {definition.capturesQuoteNumber && (
                  <TextField
                    label="Quote number"
                    value={quoteNumber}
                    onChange={(event) => setQuoteNumber(event.target.value)}
                    placeholder="e.g. Q-20451"
                    hint="Optional. The quote this repair was accepted against."
                  />
                )}
              </div>

              {/*
                WHAT WAS BOOKED IN. Test & Repair §4.

                The unit on the counter: its part number, what it is, and how
                many. NOT the parts consumed in repairing it — those are priced
                lines captured on the job as the work is done, and a customer
                who sends in three sensors may have one connector fitted to
                each.

                All three optional. A unit can be booked in while somebody is
                still looking for the part number on the casting.
              */}
              {definition.capturesRepairItem && (
                <div className="mt-4 rounded-[var(--radius-control)] border border-violet-eje-200 bg-violet-eje-50 p-4">
                  <p className="text-sm font-semibold text-violet-eje-700">
                    Unit booked in for test &amp; repair
                  </p>
                  <p className="mt-1 text-sm text-steel-700">
                    What arrived on the counter. Optional — fill in what is known now.
                  </p>
                  <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
                    <TextField
                      label="Part number"
                      value={repairPartNumber}
                      onChange={(event) => setRepairPartNumber(event.target.value)}
                      placeholder="As it reads on the unit"
                    />
                    <TextField
                      label="Description"
                      value={repairDescription}
                      onChange={(event) => setRepairDescription(event.target.value)}
                      placeholder="e.g. Proximity sensor assembly"
                    />
                    <TextField
                      label="Quantity"
                      type="number"
                      min={1}
                      step={1}
                      value={repairQuantity}
                      error={errors.repairQuantity}
                      onChange={(event) => setRepairQuantity(event.target.value)}
                      placeholder="e.g. 3"
                      hint="Leave blank if nobody has counted."
                    />
                  </div>
                </div>
              )}
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
            {/*
              PHOTOGRAPHS AND VIDEOS, AND NO DOCUMENTS. Create New Job §3C.

              What gets attached while a job is being RAISED is what the caller
              sent in — a photograph of the fault, a clip of the noise the
              machine is making. A document belongs where documents are kept and
              read: the Technical Library, or the customer's or the machine's own
              register, each of which still takes a PDF.

              `accept` only narrows the picker. The SERVER sniffs the bytes
              (`validateJobMediaUpload`), so a PDF renamed `fault.jpg` is
              refused on what it is.
            */}
            <CardHeader
              title="Photographs and videos"
              description={`What the caller sent in, or what the fault looks like. ${JOB_MEDIA_TYPES_SENTENCE}`}
            />
            <input
              type="file"
              multiple
              className="mt-4 block w-full text-sm text-steel-700 file:mr-3 file:rounded-[var(--radius-control)] file:border-0 file:bg-steel-100 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-steel-700 hover:file:bg-steel-200"
              accept={JOB_MEDIA_ACCEPT_ATTRIBUTE}
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
            {/*
              DRAFT-1. A Master's only, and the server refuses anybody else —
              this decides whether the button is DRAWN, not whether the act is
              allowed.
            */}
            {can(user.role, 'jobs.manageDrafts') && (
              <Button
                variant="secondary"
                size="lg"
                onClick={() => submit(true)}
                loading={saving}
                data-testid="save-draft"
              >
                Save as draft
              </Button>
            )}
            <Button size="lg" onClick={() => submit()} loading={saving}>
              Create job
            </Button>
          </div>
          {can(user.role, 'jobs.manageDrafts') && (
            <p className="text-right text-xs text-steel-500">
              A draft is not open, nobody is assigned it and no technician is told. It can be
              saved without the fault description or the machine, and both are asked for again
              when it is released.
            </p>
          )}
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
