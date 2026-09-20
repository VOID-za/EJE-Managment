'use client';

import { useEffect, useRef, useState } from 'react';
import type { CustomerId, Site } from '@/domain';
import { Button, Modal, TextAreaField, TextField } from '@/components/ui';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { customers } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';

interface Draft {
  readonly name: string;
  readonly addressLine1: string;
  readonly addressLine2: string;
  readonly city: string;
  readonly province: string;
  readonly postalCode: string;
  readonly accessNotes: string;
}

const EMPTY: Draft = {
  name: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  province: 'Gauteng',
  postalCode: '',
  accessNotes: '',
};

const draftFrom = (site: Site): Draft => ({
  name: site.name,
  addressLine1: site.addressLine1,
  addressLine2: site.addressLine2,
  city: site.city,
  province: site.province,
  postalCode: site.postalCode,
  accessNotes: site.accessNotes,
});

/**
 * Add or edit a site.
 *
 * A site is where a technician is sent, so the address is required and the
 * access notes matter: an induction requirement or a gate number that is not
 * recorded here is a wasted trip.
 */
export const SiteDialog = ({
  open,
  customerId,
  site = null,
  onClose,
  onSaved,
}: {
  readonly open: boolean;
  readonly customerId: CustomerId;
  /** The site being edited, or null to add a new one. */
  readonly site?: Site | null;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) => {
  const operation = useOperation();
  const editing = site !== null;

  const [draft, setDraft] = useState<Draft>(() => (site === null ? EMPTY : draftFrom(site)));

  /* Reloaded only on open, or on a different site. See `ContactDialog`. */
  const siteId = site?.id ?? null;
  const latest = useRef(site);
  useEffect(() => {
    latest.current = site;
  });

  useEffect(() => {
    if (!open) return;
    setDraft(latest.current === null ? EMPTY : draftFrom(latest.current));
  }, [open, siteId]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void =>
    setDraft((current) => ({ ...current, [key]: value }));

  const close = (): void => {
    operation.clearError();
    onClose();
  };

  const submit = async (): Promise<void> => {
    const ok = await operation.run(async () => {
      if (site !== null) {
        await customers.updateSite(site.id, {
          name: draft.name.trim(),
          addressLine1: draft.addressLine1.trim(),
          addressLine2: draft.addressLine2.trim(),
          city: draft.city.trim(),
          province: draft.province.trim(),
          postalCode: draft.postalCode.trim(),
          accessNotes: draft.accessNotes.trim(),
        });
        return;
      }
      await customers.addSite(customerId, draft);
    });
    if (ok) onSaved();
  };

  return (
    <Modal
      open={open}
      title={editing ? 'Edit site' : 'Add site'}
      description={
        editing
          ? 'Amends the site on the customer record. Jobs already carried out there keep their history.'
          : 'Where the work happens. A technician is navigated to this address.'
      }
      onClose={close}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={operation.running}>
            Cancel
          </Button>
          <Button onClick={submit} loading={operation.running}>
            {editing ? 'Save changes' : 'Add site'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {operation.error !== null && (
          <RuleViolationNotice
            title={editing ? 'The site could not be saved' : 'The site could not be added'}
            message={operation.error}
            violations={operation.violations}
          />
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            label="Site name"
            required
            value={draft.name}
            onChange={(event) => set('name', event.target.value)}
            placeholder="e.g. Germiston"
            containerClassName="sm:col-span-2"
          />
          <TextField
            label="Street address"
            required
            value={draft.addressLine1}
            onChange={(event) => set('addressLine1', event.target.value)}
            containerClassName="sm:col-span-2"
          />
          <TextField
            label="Address line 2"
            value={draft.addressLine2}
            onChange={(event) => set('addressLine2', event.target.value)}
            containerClassName="sm:col-span-2"
          />
          <TextField
            label="City or town"
            required
            value={draft.city}
            onChange={(event) => set('city', event.target.value)}
          />
          <TextField
            label="Province"
            value={draft.province}
            onChange={(event) => set('province', event.target.value)}
          />
          <TextField
            label="Postal code"
            value={draft.postalCode}
            onChange={(event) => set('postalCode', event.target.value)}
          />
          <TextAreaField
            label="Site access"
            rows={3}
            value={draft.accessNotes}
            onChange={(event) => set('accessNotes', event.target.value)}
            hint="Gate numbers, induction requirements, PPE — anything a technician needs before arriving."
            containerClassName="sm:col-span-2"
          />
        </div>
      </div>
    </Modal>
  );
};
