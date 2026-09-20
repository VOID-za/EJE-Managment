'use client';

import { useEffect, useRef, useState } from 'react';
import type { Customer, PostalAddress } from '@/domain';
import { Button, Modal, SectionHeading, TextField } from '@/components/ui';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { customers } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';

interface Draft {
  readonly name: string;
  readonly accountNumber: string;
  readonly registrationNumber: string;
  readonly vatNumber: string;
  readonly phone: string;
  readonly industry: string;
  readonly paymentTerms: string;
  readonly officeAddress: PostalAddress;
  readonly active: boolean;
}

const draftFrom = (customer: Customer): Draft => ({
  name: customer.name,
  accountNumber: customer.accountNumber,
  registrationNumber: customer.registrationNumber,
  vatNumber: customer.vatNumber,
  phone: customer.phone,
  industry: customer.industry,
  paymentTerms: customer.paymentTerms,
  officeAddress: customer.officeAddress,
  active: customer.active,
});

/**
 * Edit the company details shown on the customer overview.
 *
 * Sites, contacts and machines are edited where they live, on their own tabs —
 * this dialog is the company itself: who they are, how they are billed and
 * where their office is.
 */
export const EditCustomerDialog = ({
  open,
  customer,
  onClose,
  onSaved,
}: {
  readonly open: boolean;
  readonly customer: Customer;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) => {
  const operation = useOperation();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(customer));

  /* Reloaded only on open, or on a different customer. See `ContactDialog`. */
  const latest = useRef(customer);
  useEffect(() => {
    latest.current = customer;
  });

  useEffect(() => {
    if (!open) return;
    setDraft(draftFrom(latest.current));
  }, [open, customer.id]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void =>
    setDraft((current) => ({ ...current, [key]: value }));

  const setAddress = (key: keyof PostalAddress, value: string): void =>
    setDraft((current) => ({
      ...current,
      officeAddress: { ...current.officeAddress, [key]: value },
    }));

  const close = (): void => {
    operation.clearError();
    onClose();
  };

  const submit = async (): Promise<void> => {
    const ok = await operation.run(async () => {
      await customers.update(customer.id, {
        name: draft.name.trim(),
        accountNumber: draft.accountNumber.trim(),
        registrationNumber: draft.registrationNumber.trim(),
        vatNumber: draft.vatNumber.trim(),
        phone: draft.phone.trim(),
        industry: draft.industry.trim(),
        paymentTerms: draft.paymentTerms.trim(),
        officeAddress: {
          line1: draft.officeAddress.line1.trim(),
          line2: draft.officeAddress.line2.trim(),
          city: draft.officeAddress.city.trim(),
          province: draft.officeAddress.province.trim(),
          postalCode: draft.officeAddress.postalCode.trim(),
        },
        active: draft.active,
      });
    });
    if (ok) onSaved();
  };

  return (
    <Modal
      open={open}
      title="Edit customer"
      description="The company details shown on the overview."
      onClose={close}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={operation.running}>
            Cancel
          </Button>
          <Button onClick={submit} loading={operation.running}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        {operation.error !== null && (
          <RuleViolationNotice
            title="The customer could not be saved"
            message={operation.error}
            violations={operation.violations}
          />
        )}

        <div>
          <SectionHeading title="Company" />
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <TextField
              label="Registered name"
              required
              value={draft.name}
              onChange={(event) => set('name', event.target.value)}
              containerClassName="sm:col-span-2"
            />
            <TextField
              label="Account number"
              value={draft.accountNumber}
              onChange={(event) => set('accountNumber', event.target.value)}
            />
            <TextField
              label="Industry"
              value={draft.industry}
              onChange={(event) => set('industry', event.target.value)}
            />
            <TextField
              label="Registration number"
              value={draft.registrationNumber}
              onChange={(event) => set('registrationNumber', event.target.value)}
            />
            <TextField
              label="VAT number"
              value={draft.vatNumber}
              onChange={(event) => set('vatNumber', event.target.value)}
            />
            <TextField
              label="Office number"
              type="tel"
              value={draft.phone}
              onChange={(event) => set('phone', event.target.value)}
            />
            <TextField
              label="Payment terms"
              value={draft.paymentTerms}
              onChange={(event) => set('paymentTerms', event.target.value)}
              containerClassName="sm:col-span-2"
            />
          </div>
        </div>

        <div>
          <SectionHeading
            title="Office address"
            description="Head office, which is not necessarily a site where machines stand."
          />
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <TextField
              label="Street address"
              value={draft.officeAddress.line1}
              onChange={(event) => setAddress('line1', event.target.value)}
              containerClassName="sm:col-span-2"
            />
            <TextField
              label="Address line 2"
              value={draft.officeAddress.line2}
              onChange={(event) => setAddress('line2', event.target.value)}
              containerClassName="sm:col-span-2"
            />
            <TextField
              label="City or town"
              value={draft.officeAddress.city}
              onChange={(event) => setAddress('city', event.target.value)}
            />
            <TextField
              label="Province"
              value={draft.officeAddress.province}
              onChange={(event) => setAddress('province', event.target.value)}
            />
            <TextField
              label="Postal code"
              value={draft.officeAddress.postalCode}
              onChange={(event) => setAddress('postalCode', event.target.value)}
            />
          </div>
        </div>

        <label className="flex items-start gap-2.5 text-sm text-steel-700">
          <input
            type="checkbox"
            checked={draft.active}
            onChange={(event) => set('active', event.target.checked)}
            className="mt-0.5 size-4 rounded border-steel-300"
          />
          <span>
            Active account
            <span className="block text-xs text-steel-500">
              Clear this for a customer EJE no longer trades with. Their history is kept.
            </span>
          </span>
        </label>
      </div>
    </Modal>
  );
};
