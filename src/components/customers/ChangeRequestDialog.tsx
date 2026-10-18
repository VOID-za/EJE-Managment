'use client';

import { useState } from 'react';
import {
  CHANGE_REQUEST_DETAILS_LIMIT,
  machineDisplayName,
  type Customer,
  type Machine,
  type Site,
} from '@/domain';
import { Button, Modal, SelectField, TextAreaField } from '@/components/ui';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { changeRequests } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';

/**
 * REPORTING THAT THE REGISTER IS WRONG. CUST-CR.
 *
 * The application has told technicians for months that they may do this —
 * "Technicians can view customers and raise change requests, but not edit
 * them" — and there was nowhere to do it. This is that place.
 *
 * WHAT IT ASKS FOR IS WHAT THE OFFICE NEEDS IN ORDER TO ACT: which record, and
 * what is wrong with it in the reporter's own words. It deliberately does NOT
 * ask for the corrected value as a field the system could apply. That would
 * need EJE to decide whether a technician's wording becomes the official serial
 * number of an asset, and whether an approved correction reaches the jobs
 * already carried out on that machine (MACH-HIST, #28). Neither is settled, so
 * the office reads the report and edits the register themselves.
 *
 * The sites and machines offered are THIS customer's, so the obvious mistake —
 * a report against another customer's machine — is not reachable from here. The
 * server checks it again, because this is a browser.
 */
export const ChangeRequestDialog = ({
  customer,
  sites,
  machines,
  open,
  onClose,
  onRaised,
}: {
  readonly customer: Customer;
  readonly sites: readonly Site[];
  readonly machines: readonly Machine[];
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onRaised: () => void;
}) => {
  const operation = useOperation();
  const [target, setTarget] = useState('customer');
  const [details, setDetails] = useState('');

  const close = (): void => {
    operation.clearError();
    onClose();
  };

  const submit = async (): Promise<void> => {
    const [kind, id] = target.split(':');
    const ok = await operation.run(async () => {
      await changeRequests.raise({
        subject: kind === 'site' ? 'site' : kind === 'machine' ? 'machine' : 'customer',
        customerId: customer.id,
        ...(kind === 'site' ? { siteId: id ?? null } : {}),
        ...(kind === 'machine' ? { machineId: id ?? null } : {}),
        details: details.trim(),
      });
    });
    if (!ok) return;
    setDetails('');
    setTarget('customer');
    onRaised();
    close();
  };

  return (
    <Modal
      open={open}
      title="Report a problem with this record"
      description="The office reads this and decides what to change. Nothing on the register changes by itself."
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            loading={operation.running}
            disabled={details.trim().length === 0}
            data-testid="change-request-submit"
          >
            Send to the office
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <SelectField
          label="Which record"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          data-testid="change-request-target"
          options={[
            { value: 'customer', label: `${customer.name} — the customer’s own details` },
            ...sites.map((site) => ({ value: `site:${site.id}`, label: `Site — ${site.name}` })),
            ...machines.map((machine) => ({
              value: `machine:${machine.id}`,
              label: `Machine — ${machineDisplayName(machine)} (${machine.serialNumber})`,
            })),
          ]}
        />

        <TextAreaField
          label="What is wrong"
          hint="What you can see, and what it should be. The office makes the change."
          rows={5}
          value={details}
          maxLength={CHANGE_REQUEST_DETAILS_LIMIT}
          onChange={(event) => setDetails(event.target.value)}
          placeholder="The serial plate on this machine reads MZ-QT200-11903, not …"
          data-testid="change-request-details"
        />

        <RuleViolationNotice
          title="That report was not sent"
          message={operation.error}
          violations={operation.violations}
        />
      </div>
    </Modal>
  );
};
