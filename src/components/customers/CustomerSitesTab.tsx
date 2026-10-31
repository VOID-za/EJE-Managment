'use client';

import { useState } from 'react';
import {
  can,
  contactFullName,
  siteMapUrl,
  type Contact,
  type Customer,
  type Machine,
  type Site,
  type SiteId,
} from '@/domain';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  Icon,
} from '@/components/ui';
import { ContactDialog } from './ContactDialog';
import { SiteDialog } from './SiteDialog';
import { customers } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';
import { useCurrentUser } from '@/providers/AppProvider';

type Pending =
  | { readonly kind: 'site'; readonly site: Site }
  | { readonly kind: 'contact'; readonly contact: Contact }
  /** SITE-2: keep this one as the customer's site; archive the others. */
  | { readonly kind: 'keep'; readonly site: Site };

/**
 * Sites and the people at them.
 *
 * Both are managed here rather than on separate screens because that is how the
 * office thinks about them: a contact is somebody AT a site, and a site with
 * nobody to ask for is not much use. Head office contacts sit above the sites,
 * since they belong to the company rather than to any one address.
 */
export const CustomerSitesTab = ({
  customer,
  sites,
  contacts,
  machines,
  jobSiteIds = [],
  onChanged,
}: {
  readonly customer: Customer;
  readonly sites: readonly Site[];
  readonly contacts: readonly Contact[];
  readonly machines: readonly Machine[];
  /** The site each of the customer's jobs was recorded at, for the consolidation preview. */
  readonly jobSiteIds?: readonly string[];
  readonly onChanged: () => void;
}) => {
  const currentUser = useCurrentUser();
  const operation = useOperation();
  const canManage = can(currentUser.role, 'customers.manage');

  const [siteDialog, setSiteDialog] = useState<{ open: boolean; site: Site | null }>({
    open: false,
    site: null,
  });
  const [contactDialog, setContactDialog] = useState<{
    open: boolean;
    contact: Contact | null;
    siteId: SiteId | null;
  }>({ open: false, contact: null, siteId: null });
  const [pending, setPending] = useState<Pending | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const headOffice = contacts.filter((contact) => contact.siteId === null);
  /*
   * ONE SITE PER CUSTOMER. SITE-1. A second site is never offered; the server
   * refuses one regardless. A customer recorded with several BEFORE the rule is
   * shown exactly as it is, and the office chooses which site is the customer's.
   */
  const legacy = sites.length > 1;

  const confirmRemoval = async (): Promise<void> => {
    if (pending === null) return;
    const result = await operation.runFor(() =>
      pending.kind === 'site'
        ? customers.removeSite(pending.site.id)
        : pending.kind === 'keep'
          ? customers.consolidateSites(customer.id, pending.site.id)
          : customers.removeContact(pending.contact.id),
    );
    if (result === null) return;
    setPending(null);
    setOutcome(result.message);
    onChanged();
  };

  const contactRow = (contact: Contact, size: 'sm' | 'md') => (
    <li key={contact.id} className="flex items-start gap-2.5">
      <Avatar
        initials={`${contact.firstName[0] ?? ''}${contact.lastName[0] ?? ''}`}
        size={size}
      />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium text-steel-900">
          {contactFullName(contact)}
          {contact.isPrimary && (
            <Badge tone="blue" size="sm" className="ml-2">
              Primary
            </Badge>
          )}
        </p>
        <p className="text-xs text-steel-500">{contact.position || 'Role not recorded'}</p>
        <p className="text-xs text-steel-600">
          {contact.phone || 'No number'} · {contact.email || 'No email'}
        </p>
      </div>
      {canManage && (
        <div className="flex shrink-0 gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              setContactDialog({ open: true, contact, siteId: contact.siteId })
            }
          >
            Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setPending({ kind: 'contact', contact })}
          >
            Remove
          </Button>
        </div>
      )}
    </li>
  );

  return (
    <div className="space-y-5">
      {operation.error !== null && (
        <p role="alert" className="text-sm font-medium text-signal-600">
          {operation.error}
        </p>
      )}
      {outcome !== null && (
        <div
          role="status"
          className="flex items-start justify-between gap-3 rounded-[var(--radius-control)] border border-steel-200 bg-steel-50 px-4 py-3 text-sm text-steel-700"
        >
          <span>{outcome}</span>
          <Button size="sm" variant="ghost" onClick={() => setOutcome(null)}>
            Dismiss
          </Button>
        </div>
      )}

      <Card>
        <CardHeader
          title="Head office contacts"
          description="People who act for the company rather than for one site."
          action={
            canManage && (
              <Button
                size="sm"
                variant="secondary"
                leadingIcon={<Icon name="plus" className="size-4" />}
                onClick={() => setContactDialog({ open: true, contact: null, siteId: null })}
              >
                Add contact
              </Button>
            )
          }
        />
        {headOffice.length === 0 ? (
          <p className="mt-3 text-sm text-steel-500">No head office contact recorded.</p>
        ) : (
          <ul className="mt-4 space-y-3">{headOffice.map((contact) => contactRow(contact, 'md'))}</ul>
        )}
      </Card>

      {legacy && (
        <div
          role="note"
          data-testid="legacy-sites-notice"
          className="rounded-[var(--radius-control)] border border-amber-eje-200 bg-amber-eje-50 px-4 py-3 text-sm text-amber-eje-700"
        >
          <p className="font-semibold">
            This customer has {sites.length} sites, recorded before the one-site rule.
          </p>
          <p className="mt-1">
            A customer now has one site. {canManage
              ? 'Choose which site is the customer’s with “Keep as the customer’s site”: its machines and contacts stay, the others’ move to it, and the other sites are archived — kept so the jobs done there still read correctly. No job is changed.'
              : 'The office will choose which one is the customer’s.'}
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-steel-500">
          {sites.length === 0
            ? 'No site on this account yet.'
            : legacy
              ? `${sites.length} sites on this account (recorded before the one-site rule).`
              : 'The customer’s site.'}
        </p>
        {canManage && sites.length === 0 && (
          <Button
            variant="secondary"
            leadingIcon={<Icon name="plus" className="size-4" />}
            onClick={() => setSiteDialog({ open: true, site: null })}
          >
            Add site
          </Button>
        )}
      </div>

      {sites.length === 0 ? (
        <EmptyState
          title="No sites recorded"
          description="A customer needs at least one site before a job can be raised against them."
          icon={<Icon name="pin" />}
        />
      ) : (
        sites.map((site) => {
          const siteContacts = contacts.filter((contact) => contact.siteId === site.id);
          const siteMachines = machines.filter((machine) => machine.siteId === site.id);

          return (
            <Card key={site.id}>
              <CardHeader
                title={site.name}
                description={`${site.city}, ${site.province}`}
                action={
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="outline">
                      {siteMachines.length} {siteMachines.length === 1 ? 'machine' : 'machines'}
                    </Badge>
                    {canManage && (
                      <>
                        {legacy && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setPending({ kind: 'keep', site })}
                            data-testid="keep-site"
                          >
                            Keep as the customer’s site
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setSiteDialog({ open: true, site })}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setPending({ kind: 'site', site })}
                        >
                          Remove
                        </Button>
                      </>
                    )}
                  </div>
                }
              />

              <div className="mt-4 grid grid-cols-1 gap-5 lg:grid-cols-2">
                <div>
                  <p className="text-xs font-semibold tracking-wide text-steel-500 uppercase">
                    Address
                  </p>
                  <p className="mt-1 text-sm text-steel-700">
                    {site.addressLine1}
                    {site.addressLine2.length > 0 && (
                      <>
                        <br />
                        {site.addressLine2}
                      </>
                    )}
                    <br />
                    {site.city}, {site.province} {site.postalCode}
                  </p>
                  <a
                    href={siteMapUrl(site)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 inline-flex min-h-9 pointer-coarse:min-h-11 items-center gap-1 text-xs font-medium text-eje-700 hover:underline"
                  >
                    <Icon name="pin" className="size-3.5" />
                    Open in Google Maps
                  </a>
                  {site.accessNotes.length > 0 && (
                    <p className="mt-3 rounded-[var(--radius-control)] bg-eje-50 px-3 py-2 text-xs text-eje-800">
                      <span className="font-semibold">Site access: </span>
                      {site.accessNotes}
                    </p>
                  )}
                </div>

                <div>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold tracking-wide text-steel-500 uppercase">
                      Site contacts
                    </p>
                    {canManage && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setContactDialog({ open: true, contact: null, siteId: site.id })
                        }
                      >
                        Add contact
                      </Button>
                    )}
                  </div>
                  {siteContacts.length === 0 ? (
                    <p className="mt-1 text-sm text-steel-500">
                      No site-specific contact. Head office contact applies.
                    </p>
                  ) : (
                    <ul className="mt-2 space-y-2">
                      {siteContacts.map((contact) => contactRow(contact, 'sm'))}
                    </ul>
                  )}
                </div>
              </div>
            </Card>
          );
        })
      )}

      {canManage && (
        <>
          <SiteDialog
            open={siteDialog.open}
            customerId={customer.id}
            site={siteDialog.site}
            onClose={() => setSiteDialog({ open: false, site: null })}
            onSaved={() => {
              setSiteDialog({ open: false, site: null });
              onChanged();
            }}
          />
          <ContactDialog
            open={contactDialog.open}
            customerId={customer.id}
            sites={sites}
            contact={contactDialog.contact}
            defaultSiteId={contactDialog.siteId}
            onClose={() => setContactDialog({ open: false, contact: null, siteId: null })}
            onSaved={() => {
              setContactDialog({ open: false, contact: null, siteId: null });
              onChanged();
            }}
          />
          <ConfirmDialog
            open={pending !== null}
            title={
              pending?.kind === 'keep'
                ? 'Make this the customer’s site?'
                : pending?.kind === 'site'
                  ? 'Remove this site?'
                  : 'Remove this contact?'
            }
            confirmLabel={pending?.kind === 'keep' ? 'Keep this site' : 'Remove'}
            confirmVariant={pending?.kind === 'keep' ? 'primary' : 'danger'}
            busy={operation.running}
            onCancel={() => {
              operation.clearError();
              setPending(null);
            }}
            onConfirm={confirmRemoval}
            message={
              pending === null ? null : pending.kind === 'keep' ? (
                <>
                  <p>
                    <strong>{pending.site.name}</strong> becomes {customer.name}’s one site.
                  </p>
                  <p className="mt-2">
                    Every machine and contact at the other{' '}
                    {sites.length - 1 === 1 ? 'site moves' : `${sites.length - 1} sites move`} to it,
                    and each move is recorded. The other{' '}
                    {sites.length - 1 === 1 ? 'site is' : 'sites are'} archived, not deleted: jobs
                    done there keep their address and their history.
                  </p>
                  {/* Exactly what moves, site by site, before anybody confirms. */}
                  <ul className="mt-2 space-y-1 text-sm" data-testid="consolidation-preview">
                    {sites
                      .filter((site) => site.id !== pending.site.id)
                      .map((site) => {
                        const machineCount = machines.filter((machine) => machine.siteId === site.id).length;
                        const contactCount = contacts.filter((contact) => contact.siteId === site.id).length;
                        const jobCount = jobSiteIds.filter((siteId) => siteId === site.id).length;
                        return (
                          <li key={site.id}>
                            <strong>{site.name}</strong>: {machineCount}{' '}
                            {machineCount === 1 ? 'machine' : 'machines'} and {contactCount}{' '}
                            {contactCount === 1 ? 'contact' : 'contacts'} move; {jobCount}{' '}
                            {jobCount === 1 ? 'job stays' : 'jobs stay'} recorded at {site.name}; the
                            site is archived.
                          </li>
                        );
                      })}
                  </ul>
                  <p className="mt-2">No job is changed. This cannot be undone from this screen.</p>
                </>
              ) : pending.kind === 'site' ? (
                <>
                  <p>
                    <strong>{pending.site.name}</strong> will be taken off this customer, together
                    with the contacts that belong to it.
                  </p>
                  <p className="mt-2">
                    If work has ever been carried out there, the site is kept and simply withdrawn
                    from the register, so those job cards still read correctly. If not, it is
                    deleted. You will be told which happened.
                  </p>
                  <p className="mt-2">
                    A site that still has machines on it cannot be removed — move them first.
                  </p>
                </>
              ) : (
                <>
                  <p>
                    <strong>{contactFullName(pending.contact)}</strong> will be taken off this
                    customer.
                  </p>
                  <p className="mt-2">
                    If a job has ever named them, the record is kept and simply withdrawn, so those
                    job cards still read correctly. If not, it is deleted. You will be told which
                    happened.
                  </p>
                </>
              )
            }
          />
        </>
      )}
    </div>
  );
};
