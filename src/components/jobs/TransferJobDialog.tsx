'use client';

import { useState } from 'react';
import {
  TRANSFER_REASONS,
  transferReasonLabel,
  userFullName,
  type Job,
  type TransferReason,
  type User,
} from '@/domain';
import {
  returnJobToOpen,
  transferJobToTechnician,
  type TransferInput,
} from '@/application/job-operations';
import { Button, Modal, SelectField, TextAreaField } from '@/components/ui';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { useOperation } from '@/hooks/useOperation';

/**
 * Transfer a job.
 *
 * Two destinations, because they are genuinely different decisions: back to the
 * Open pool for whoever can take it, or to a named colleague. Both keep every
 * piece of work already captured, which is what the confirmation says — a
 * technician handing over mid-job needs to know nothing is being thrown away.
 *
 * A transfer to a technician who is unavailable for the job's scheduled period
 * is refused by the domain; the refusal is shown here with the reason.
 */
type Destination = 'open' | 'technician';

export const TransferJobDialog = ({
  job,
  technicians,
  onClose,
  onTransferred,
}: {
  readonly job: Job;
  readonly technicians: readonly User[];
  readonly onClose: () => void;
  readonly onTransferred: () => void;
}) => {
  const operation = useOperation();
  const [destination, setDestination] = useState<Destination>('open');
  const [technicianId, setTechnicianId] = useState('');
  const [reason, setReason] = useState<TransferReason>('unable_to_attend');
  const [description, setDescription] = useState('');

  const candidates = technicians.filter(
    (candidate) => candidate.active && candidate.id !== job.primaryTechnicianId,
  );

  const input = (): TransferInput => ({ reason, description });

  const submit = async (): Promise<void> => {
    const ok = await operation.run((context) =>
      destination === 'open'
        ? returnJobToOpen(context, job, input())
        : transferJobToTechnician(
            context,
            job,
            candidates.find((candidate) => candidate.id === technicianId)!.id,
            input(),
          ),
    );
    if (ok) onTransferred();
  };

  const receiving = candidates.find((candidate) => candidate.id === technicianId);

  return (
    <Modal
      open
      title={`Transfer ${job.jobNumber}`}
      onClose={onClose}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={operation.running}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            loading={operation.running}
            disabled={destination === 'technician' && receiving === undefined}
          >
            {destination === 'open'
              ? 'Return to Open Jobs'
              : receiving === undefined
                ? 'Transfer job'
                : `Transfer to ${receiving.firstName}`}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {operation.error !== null && (
          <RuleViolationNotice
            title={
              operation.error === 'Technician unavailable'
                ? 'Technician unavailable'
                : 'The job was not transferred'
            }
            message={operation.error === 'Technician unavailable' ? undefined : operation.error}
            violations={operation.violations}
          />
        )}

        <fieldset>
          <legend className="mb-2 text-sm font-semibold text-steel-700">Transfer to</legend>
          <div className="space-y-2">
            {(
              [
                {
                  value: 'open' as const,
                  title: 'Open Jobs',
                  body: 'Any technician can pick it up. All work already recorded stays on the job.',
                },
                {
                  value: 'technician' as const,
                  title: 'A specific technician',
                  body: 'They become responsible for this job and are notified.',
                },
              ] satisfies readonly { value: Destination; title: string; body: string }[]
            ).map((option) => (
              <label
                key={option.value}
                className="flex cursor-pointer items-start gap-3 rounded-[var(--radius-control)] border border-steel-200 p-3 hover:border-steel-300"
              >
                <input
                  type="radio"
                  name="transfer-destination"
                  checked={destination === option.value}
                  onChange={() => setDestination(option.value)}
                  className="mt-0.5 size-4 border-steel-300 text-eje-600 focus:ring-eje-500"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-steel-900">
                    {option.title}
                  </span>
                  <span className="block text-xs text-steel-500">{option.body}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {destination === 'technician' && (
          <SelectField
            label="Technician"
            required
            value={technicianId}
            onChange={(event) => setTechnicianId(event.target.value)}
            placeholder="Choose a technician"
            options={candidates.map((candidate) => ({
              value: candidate.id,
              label: userFullName(candidate),
            }))}
          />
        )}

        <SelectField
          label="Reason"
          required
          value={reason}
          onChange={(event) => setReason(event.target.value as TransferReason)}
          options={TRANSFER_REASONS.map((candidate) => ({
            value: candidate,
            label: transferReasonLabel(candidate),
          }))}
        />

        <TextAreaField
          label="Description"
          required={reason === 'other'}
          rows={2}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          hint={
            reason === 'other'
              ? 'Required when the reason is Other.'
              : 'Optional. Anything the next technician or the office should know.'
          }
        />

        <p className="rounded-[var(--radius-control)] border border-eje-200 bg-eje-50 px-3 py-2.5 text-xs text-eje-800">
          {destination === 'open'
            ? 'This makes the job available for another technician. Labour, travel, parts, photos, notes and checklist progress all stay on the job.'
            : `${receiving === undefined ? 'The technician you choose' : receiving.firstName} will become responsible for this job. All existing job work remains available.`}
        </p>
      </div>
    </Modal>
  );
};
