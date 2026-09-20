'use client';

import { useEffect, useRef, useState } from 'react';
import {
  CONTACT_ROLE_SUGGESTIONS,
  type Contact,
  type CustomerId,
  type Site,
  type SiteId,
} from '@/domain';
import { Button, Modal, SelectField, TextField } from '@/components/ui';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { customers } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';

const ROLE_LIST_ID = 'contact-role-suggestions';
const HEAD_OFFICE = 'head-office';

interface Draft {
  readonly firstName: string;
  readonly lastName: string;
  readonly position: string;
  readonly email: string;
  readonly phone: string;
  readonly siteId: string;
  readonly isPrimary: boolean;
}

const emptyDraft = (siteId: SiteId | null): Draft => ({
  firstName: '',
  lastName: '',
  position: '',
  email: '',
  phone: '',
  siteId: siteId ?? HEAD_OFFICE,
  isPrimary: false,
});

const draftFrom = (contact: Contact): Draft => ({
  firstName: contact.firstName,
  lastName: contact.lastName,
  position: contact.position,
  email: contact.email,
  phone: contact.phone,
  siteId: contact.siteId ?? HEAD_OFFICE,
  isPrimary: contact.isPrimary,
});

/**
 * Add or edit a customer contact.
 *
 * Role is free text with suggestions rather than a fixed list: the titles
 * people actually hold vary by customer, and forcing the office to pick the
 * nearest wrong one would put a wrong name on a job card.
 */
export const ContactDialog = ({
  open,
  customerId,
  sites,
  contact = null,
  defaultSiteId = null,
  onClose,
  onSaved,
}: {
  readonly open: boolean;
  readonly customerId: CustomerId;
  readonly sites: readonly Site[];
  /** The contact being edited, or null to add a new one. */
  readonly contact?: Contact | null;
  /** Which site a newly added contact belongs to. Null means head office. */
  readonly defaultSiteId?: SiteId | null;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) => {
  const operation = useOperation();
  const editing = contact !== null;

  const [draft, setDraft] = useState<Draft>(() =>
    contact === null ? emptyDraft(defaultSiteId) : draftFrom(contact),
  );

  /*
   * Reloaded only when the dialog opens, or opens on a different contact.
   *
   * The record and the site list are read through a ref so that a parent which
   * rebuilds them on every render cannot re-run this effect between keystrokes
   * and wipe the field being typed into.
   */
  const contactId = contact?.id ?? null;
  const latest = useRef({ contact, defaultSiteId });
  useEffect(() => {
    latest.current = { contact, defaultSiteId };
  });

  useEffect(() => {
    if (!open) return;
    const { contact: current, defaultSiteId: site } = latest.current;
    setDraft(current === null ? emptyDraft(site) : draftFrom(current));
  }, [open, contactId]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void =>
    setDraft((current) => ({ ...current, [key]: value }));

  const close = (): void => {
    operation.clearError();
    onClose();
  };

  const submit = async (): Promise<void> => {
    const siteId = draft.siteId === HEAD_OFFICE ? null : (draft.siteId as SiteId);
    const ok = await operation.run(async () => {
      if (contact !== null) {
        await customers.updateContact(contact.id, {
          firstName: draft.firstName.trim(),
          lastName: draft.lastName.trim(),
          position: draft.position.trim(),
          email: draft.email.trim(),
          phone: draft.phone.trim(),
          isPrimary: draft.isPrimary,
        });
        return;
      }
      await customers.addContact(customerId, {
        siteId,
        firstName: draft.firstName,
        lastName: draft.lastName,
        position: draft.position,
        email: draft.email,
        phone: draft.phone,
        isPrimary: draft.isPrimary,
      });
    });
    if (ok) onSaved();
  };

  return (
    <Modal
      open={open}
      title={editing ? 'Edit contact' : 'Add contact'}
      description={
        editing
          ? 'Amends the customer record. Job cards already issued keep the name they were signed with.'
          : 'The person the office and the technician deal with at this customer.'
      }
      onClose={close}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={operation.running}>
            Cancel
          </Button>
          <Button onClick={submit} loading={operation.running}>
            {editing ? 'Save changes' : 'Add contact'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {operation.error !== null && (
          <RuleViolationNotice
            title={editing ? 'The contact could not be saved' : 'The contact could not be added'}
            message={operation.error}
            violations={operation.violations}
          />
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            label="First name"
            required
            value={draft.firstName}
            onChange={(event) => set('firstName', event.target.value)}
          />
          <TextField
            label="Surname"
            required
            value={draft.lastName}
            onChange={(event) => set('lastName', event.target.value)}
          />
          <TextField
            label="Role"
            value={draft.position}
            onChange={(event) => set('position', event.target.value)}
            list={ROLE_LIST_ID}
            placeholder="e.g. Maintenance Manager"
            hint="Free text. The suggestions are the roles that come up most often."
          />
          <SelectField
            label="Site"
            value={draft.siteId}
            onChange={(event) => set('siteId', event.target.value)}
            options={[
              { value: HEAD_OFFICE, label: 'Head office (no specific site)' },
              ...sites.map((site) => ({ value: site.id, label: site.name })),
            ]}
          />
          <TextField
            label="Email"
            type="email"
            value={draft.email}
            onChange={(event) => set('email', event.target.value)}
            hint="Where this person's copy of a job card is sent."
          />
          <TextField
            label="Contact number"
            value={draft.phone}
            onChange={(event) => set('phone', event.target.value)}
            placeholder="+27 82 555 0000"
          />
        </div>

        <datalist id={ROLE_LIST_ID}>
          {CONTACT_ROLE_SUGGESTIONS.map((role) => (
            <option key={role} value={role} />
          ))}
        </datalist>

        <label className="flex items-start gap-2.5 text-sm text-steel-700">
          <input
            type="checkbox"
            checked={draft.isPrimary}
            onChange={(event) => set('isPrimary', event.target.checked)}
            className="mt-0.5 size-4 rounded border-steel-300"
          />
          <span>
            Primary contact
            <span className="block text-xs text-steel-500">
              The person the office deals with by default when raising a job.
            </span>
          </span>
        </label>
      </div>
    </Modal>
  );
};
