'use client';

import { useState } from 'react';
import {
  AVAILABILITY_TYPES,
  availabilityTypeLabel,
  userFullName,
  type AvailabilityRecord,
  type AvailabilityType,
  type Job,
  type ChatMessage,
  type User,
} from '@/domain';
import { Badge, Button, Modal, SelectField, TextAreaField, TextField } from '@/components/ui';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { availability, conversations } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';
import { formatDate } from '@/lib/format';
import { businessToday } from '@/lib/business-time';

/**
 * Mark a technician unavailable.
 *
 * Handles all three shapes the office actually uses: a part day (09:00–11:00),
 * a full day, and a multi-day block. A time window only makes sense on a single
 * day, so choosing a later end date switches the form to all-day rather than
 * accepting a window that would mean nothing.
 *
 * When a Master opens this from a technician's message, the resulting record is
 * linked back to that message so the thread shows what was done about it.
 */
export const AvailabilityDialog = ({
  technician,
  existing,
  fromMessage,
  onClose,
  onSaved,
}: {
  readonly technician: User;
  readonly existing?: AvailabilityRecord | null;
  readonly fromMessage?: ChatMessage | null;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) => {
  const operation = useOperation();
  const [type, setType] = useState<AvailabilityType>(existing?.type ?? 'appointment');
  const [startDate, setStartDate] = useState(existing?.startDate ?? businessToday());
  const [endDate, setEndDate] = useState(existing?.endDate ?? businessToday());
  const [allDay, setAllDay] = useState(existing?.allDay ?? false);
  const [startTime, setStartTime] = useState(existing?.startTime ?? '09:00');
  const [endTime, setEndTime] = useState(existing?.endTime ?? '11:00');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [affected, setAffected] = useState<readonly Job[] | null>(null);

  const multiDay = endDate > startDate;

  const input = () => ({
    userId: technician.id,
    type,
    startDate,
    endDate,
    allDay: multiDay ? true : allDay,
    startTime: multiDay || allDay ? null : startTime,
    endTime: multiDay || allDay ? null : endTime,
    description,
  });

  const submit = async (): Promise<void> => {
    let affectedJobs: readonly Job[] = [];
    const ok = await operation.run(async () => {
      const result =
        existing === undefined || existing === null
          ? await availability.create(input())
          : await availability.update(existing.id, input());
      affectedJobs = result.affectedJobs;

      /*
       * Linking the request that prompted it.
       *
       * A second call rather than one: the record and the link are separate
       * facts, and the office may record an absence nobody asked for. Both run
       * server-side, each in its own transaction.
       */
      if (fromMessage !== undefined && fromMessage !== null) {
        await conversations.attachAvailability(
          fromMessage.conversationId,
          fromMessage.id,
          result.record.id,
        );
      }
    });

    if (!ok) return;
    if (affectedJobs.length > 0) {
      // Never resolved automatically: the Master decides what happens to work
      // already booked inside the period.
      setAffected(affectedJobs);
      return;
    }
    onSaved();
  };

  if (affected !== null) {
    return (
      <Modal
        open
        title="Availability recorded — but there is work booked"
        onClose={onSaved}
        size="md"
        footer={<Button onClick={onSaved}>I&rsquo;ll deal with these</Button>}
      >
        <div className="space-y-3">
          <p className="text-sm text-steel-700">
            {userFullName(technician)} has {affected.length}{' '}
            {affected.length === 1 ? 'job' : 'jobs'} scheduled during this period. Nothing has been
            changed — reassign or reschedule them yourself.
          </p>
          <ul className="divide-y divide-steel-100 rounded-[var(--radius-control)] border border-steel-200">
            {affected.map((job) => (
              <li key={job.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="font-mono text-sm font-semibold text-steel-900">{job.jobNumber}</p>
                  <p className="truncate text-xs text-steel-500">
                    {job.scheduledDate === null ? 'Unscheduled' : formatDate(job.scheduledDate)}
                  </p>
                </div>
                <Badge tone="amber" size="sm">
                  Needs attention
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      title={
        existing === undefined || existing === null
          ? `Mark ${userFullName(technician)} unavailable`
          : `Edit availability — ${userFullName(technician)}`
      }
      description={
        fromMessage === undefined || fromMessage === null
          ? undefined
          : 'Recorded against the message this came from.'
      }
      onClose={onClose}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={operation.running}>
            Cancel
          </Button>
          <Button onClick={submit} loading={operation.running}>
            {existing === undefined || existing === null ? 'Record availability' : 'Save changes'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {operation.error !== null && (
          <RuleViolationNotice
            title="That period was not recorded"
            message={operation.error}
            violations={operation.violations}
          />
        )}

        {fromMessage !== undefined && fromMessage !== null && (
          <blockquote className="rounded-[var(--radius-control)] border-l-4 border-eje-400 bg-eje-50 px-3 py-2.5 text-sm text-eje-900">
            {fromMessage.body}
          </blockquote>
        )}

        <SelectField
          label="Type"
          value={type}
          onChange={(event) => setType(event.target.value as AvailabilityType)}
          options={AVAILABILITY_TYPES.map((candidate) => ({
            value: candidate,
            label: availabilityTypeLabel(candidate),
          }))}
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            label="Start date"
            type="date"
            required
            value={startDate}
            onChange={(event) => {
              setStartDate(event.target.value);
              if (endDate < event.target.value) setEndDate(event.target.value);
            }}
          />
          <TextField
            label="End date"
            type="date"
            required
            value={endDate}
            onChange={(event) => setEndDate(event.target.value)}
          />
        </div>

        <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm font-medium text-steel-700">
          <input
            type="checkbox"
            checked={multiDay || allDay}
            disabled={multiDay}
            onChange={(event) => setAllDay(event.target.checked)}
            className="size-4.5 rounded border-steel-300 text-eje-600 focus:ring-eje-500"
          />
          All day
          {multiDay && (
            <span className="text-xs font-normal text-steel-500">
              — a period across more than one day is always all-day
            </span>
          )}
        </label>

        {!multiDay && !allDay && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <TextField
              label="From"
              type="time"
              required
              value={startTime}
              onChange={(event) => setStartTime(event.target.value)}
            />
            <TextField
              label="To"
              type="time"
              required
              value={endTime}
              onChange={(event) => setEndTime(event.target.value)}
            />
          </div>
        )}

        <TextAreaField
          label="Description"
          required={type === 'other'}
          rows={2}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          hint={
            type === 'other'
              ? 'Required: "Other" says nothing on its own.'
              : 'Optional. Anything the office should know.'
          }
        />

        <p className="rounded-[var(--radius-control)] border border-amber-eje-200 bg-amber-eje-50 px-3 py-2.5 text-xs text-amber-eje-700">
          While this period is recorded, {technician.firstName} cannot be assigned to a job
          scheduled on those days. Work already booked is never moved automatically — you will be
          shown anything that clashes.
        </p>
      </div>
    </Modal>
  );
};
