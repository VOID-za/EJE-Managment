'use client';

import { useState } from 'react';
import {
  can,
  customerSiteState,
  siteHasPinnedLocation,
  siteMapUrl,
  siteNavigationUrl,
  type Customer,
  type Site,
} from '@/domain';
import { Badge, Button, Card, CardHeader, Icon } from '@/components/ui';
import { useCurrentUser } from '@/providers/AppProvider';
import { SiteLocationDialog } from './SiteLocationDialog';

/**
 * WHERE THE CUSTOMER IS. SITE-3.
 *
 * The customer's site address, its pinned location if one was recorded, and a
 * Google Maps link that needs no API key: the pin when there is one, the
 * address otherwise. A coordinate is shown only if somebody entered it — the
 * card never invents one. The office can pin or correct it here.
 *
 * A legacy customer recorded with several sites before SITE-1 is shown as it
 * is, each site with its own map link, and pointed at the Site & Contacts tab
 * where the office chooses which one is the customer's.
 */
export const CustomerLocationCard = ({
  customer,
  sites,
  onChanged,
}: {
  readonly customer: Customer;
  readonly sites: readonly Site[];
  readonly onChanged: () => void;
}) => {
  const currentUser = useCurrentUser();
  const canManage = can(currentUser.role, 'customers.manage');
  const [editing, setEditing] = useState<Site | null>(null);
  const state = customerSiteState(sites, customer.id);
  const shown = state.kind === 'none' ? [] : state.kind === 'single' ? [state.site] : state.sites;

  return (
    <Card data-testid="customer-location">
      <CardHeader
        title="Site and location"
        description={
          state.kind === 'legacy_multiple'
            ? `${state.sites.length} sites recorded before the one-site rule. Choose the customer’s site on the Site & Contacts tab.`
            : 'Where the technician is sent.'
        }
      />
      {shown.length === 0 ? (
        <p className="mt-3 text-sm text-steel-500">
          No site recorded. Add one on the Site &amp; Contacts tab before raising a job.
        </p>
      ) : (
        <ul className="mt-3 space-y-4">
          {shown.map((site) => (
            <li key={site.id} className="text-sm" data-testid="customer-location-site">
              <p className="font-semibold text-steel-900">{site.name}</p>
              <p className="mt-0.5 text-steel-700" data-testid="customer-location-address">
                {site.addressLine1}
                {site.addressLine2.length > 0 && (
                  <>
                    <br />
                    {site.addressLine2}
                  </>
                )}
                <br />
                {[site.city, site.province, site.postalCode].filter((part) => part.length > 0).join(', ')}
              </p>
              <p className="mt-1.5 text-xs text-steel-500">
                {siteHasPinnedLocation(site) ? (
                  <>
                    <Badge tone="green" size="sm">
                      Pinned
                    </Badge>{' '}
                    <span className="font-mono">
                      {site.latitude}, {site.longitude}
                    </span>
                  </>
                ) : (
                  'No pinned location — the map searches the address.'
                )}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <a
                  href={siteMapUrl(site)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-[var(--radius-control)] border border-steel-200 px-2.5 py-1 text-xs font-medium text-eje-700 hover:bg-eje-50"
                  data-testid="customer-map-link"
                >
                  <Icon name="pin" className="size-3.5" />
                  Open in Google Maps
                </a>
                <a
                  href={siteNavigationUrl(site)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-[var(--radius-control)] border border-steel-200 px-2.5 py-1 text-xs font-medium text-steel-700 hover:bg-steel-50"
                >
                  Directions
                </a>
                {canManage && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditing(site)}
                    data-testid="edit-site-location"
                  >
                    {siteHasPinnedLocation(site) ? 'Edit location' : 'Pin location'}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {canManage && editing !== null && (
        <SiteLocationDialog
          key={editing.id}
          open
          site={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
        />
      )}
    </Card>
  );
};
