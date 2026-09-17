'use client';

import { useState } from 'react';
import { createCustomer, type NewCustomerInput } from '@/application/customer-operations';
import { Button, Modal, SectionHeading, TextAreaField, TextField } from '@/components/ui';
import { useOperation } from '@/hooks/useOperation';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';

/**
 * Add Customer.
 *
 * A customer is created together with its first site, because a customer with
 * nowhere to send a technician cannot have a job raised against it. The first
 * contact is optional — the office often has the company before it has a name
 * to ask for.
 */
const EMPTY: NewCustomerInput = {
  name: '',
  accountNumber: '',
  registrationNumber: '',
  vatNumber: '',
  phone: '',
  email: '',
  industry: '',
  paymentTerms: '30 days from statement',
  site: {
    name: 'Head Office',
    addressLine1: '',
    addressLine2: '',
    city: '',
    province: '',
    postalCode: '',
    accessNotes: '',
  },
  contact: {
    firstName: '',
    lastName: '',
    position: '',
    email: '',
    phone: '',
    isPrimary: true,
  },
};

export const NewCustomerDialog = ({
  open,
  onClose,
  onCreated,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onCreated: (customerId: string) => void;
}) => {
  const operation = useOperation();
  const [draft, setDraft] = useState<NewCustomerInput>(EMPTY);
  const [addContact, setAddContact] = useState(true);

  const set = <K extends keyof NewCustomerInput>(key: K, value: NewCustomerInput[K]): void =>
    setDraft((current) => ({ ...current, [key]: value }));

  const setSite = (key: keyof NewCustomerInput['site'], value: string): void =>
    setDraft((current) => ({ ...current, site: { ...current.site, [key]: value } }));

  const setContact = (key: 'firstName' | 'lastName' | 'position' | 'email' | 'phone', value: string): void =>
    setDraft((current) => ({
      ...current,
      contact:
        current.contact === null
          ? null
          : { ...current.contact, [key]: value },
    }));

  const close = (): void => {
    setDraft(EMPTY);
    setAddContact(true);
    operation.clearError();
    onClose();
  };

  const submit = async (): Promise<void> => {
    let createdId: string | null = null;
    const ok = await operation.run(async (context) => {
      const result = await createCustomer(context, {
        ...draft,
        contact: addContact ? draft.contact : null,
      });
      createdId = result.customer.id;
    });
    if (ok && createdId !== null) {
      setDraft(EMPTY);
      setAddContact(true);
      onCreated(createdId);
    }
  };

  return (
    <Modal
      open={open}
      title="Add customer"
      description="Creates the company, its first site and — optionally — a site contact."
      onClose={close}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={operation.running}>
            Cancel
          </Button>
          <Button onClick={submit} loading={operation.running}>
            Create customer
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        {operation.error !== null && (
          <RuleViolationNotice
            title="The customer could not be created"
            message={operation.error}
            violations={operation.violations}
          />
        )}

        <div>
          <SectionHeading title="Company" />
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <TextField
              label="Company name"
              required
              value={draft.name}
              onChange={(event) => set('name', event.target.value)}
              containerClassName="sm:col-span-2"
            />
            <TextField
              label="Account number"
              value={draft.accountNumber}
              onChange={(event) => set('accountNumber', event.target.value)}
              hint="Left blank if the office has not issued one yet."
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
              label="Phone"
              type="tel"
              value={draft.phone}
              onChange={(event) => set('phone', event.target.value)}
            />
            <TextField
              label="Email"
              type="email"
              value={draft.email}
              onChange={(event) => set('email', event.target.value)}
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
            title="First site"
            description="Where the work happens. More sites can be added afterwards."
          />
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <TextField
              label="Site name"
              required
              value={draft.site.name}
              onChange={(event) => setSite('name', event.target.value)}
            />
            <TextField
              label="City / town"
              required
              value={draft.site.city}
              onChange={(event) => setSite('city', event.target.value)}
            />
            <TextField
              label="Street address"
              required
              value={draft.site.addressLine1}
              onChange={(event) => setSite('addressLine1', event.target.value)}
              containerClassName="sm:col-span-2"
            />
            <TextField
              label="Address line 2"
              value={draft.site.addressLine2}
              onChange={(event) => setSite('addressLine2', event.target.value)}
              containerClassName="sm:col-span-2"
            />
            <TextField
              label="Province"
              value={draft.site.province}
              onChange={(event) => setSite('province', event.target.value)}
            />
            <TextField
              label="Postal code"
              value={draft.site.postalCode}
              onChange={(event) => setSite('postalCode', event.target.value)}
            />
            <TextAreaField
              label="Access notes"
              rows={2}
              value={draft.site.accessNotes}
              onChange={(event) => setSite('accessNotes', event.target.value)}
              hint="Gate procedure, induction requirements, parking — anything the technician needs on arrival."
              containerClassName="sm:col-span-2"
            />
          </div>
        </div>

        <div>
          <SectionHeading title="First contact" />
          <label className="mt-2 flex min-h-11 cursor-pointer items-center gap-2.5 text-sm font-medium text-steel-700">
            <input
              type="checkbox"
              checked={addContact}
              onChange={(event) => setAddContact(event.target.checked)}
              className="size-4.5 rounded border-steel-300 text-eje-600 focus:ring-eje-500"
            />
            Add a contact person for this site
          </label>

          {addContact && draft.contact !== null && (
            <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TextField
                label="First name"
                required
                value={draft.contact.firstName}
                onChange={(event) => setContact('firstName', event.target.value)}
              />
              <TextField
                label="Surname"
                required
                value={draft.contact.lastName}
                onChange={(event) => setContact('lastName', event.target.value)}
              />
              <TextField
                label="Position"
                value={draft.contact.position}
                onChange={(event) => setContact('position', event.target.value)}
              />
              <TextField
                label="Phone"
                type="tel"
                value={draft.contact.phone}
                onChange={(event) => setContact('phone', event.target.value)}
              />
              <TextField
                label="Email"
                type="email"
                value={draft.contact.email}
                onChange={(event) => setContact('email', event.target.value)}
                containerClassName="sm:col-span-2"
              />
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
};
