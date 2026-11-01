'use client';

import {
  siteLocationLabel,
  siteLocationNeedsAttention,
  siteLocationOf,
  type Site,
  type SiteLocationStatus,
} from '@/domain';
import { Badge, Button, type BadgeTone } from '@/components/ui';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { customers as api } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';

/**
 * THE AUTOMATIC PIN, FOR THE OFFICE. INT-MAP-2.
 *
 * What the geocoder made of the address, how sure it was, and the office's
 * three answers: the pin is right (verify), take the suggestion, or look it up
 * again. Typing the coordinates is the existing "Edit location" dialog — what
 * is typed there is verified by definition. A pin is never replaced silently:
 * a verified one whose address changed is shown as "re-check", and a new match
 * waits as a suggestion beside it.
 */

const TONE: Record<SiteLocationStatus, BadgeTone> = {
  not_requested: 'neutral',
  pending: 'blue',
  resolved: 'amber',
  ambiguous: 'amber',
  not_found: 'red',
  failed: 'red',
  not_configured: 'neutral',
  verified: 'green',
  stale: 'amber',
};

export const SitePinStatus = ({ site, canManage, onChanged }: { readonly site: Site; readonly canManage: boolean; readonly onChanged: () => void }) => {
  const operation = useOperation();
  const location = siteLocationOf(site);
  const pinned = site.latitude !== null && site.longitude !== null;
  const suggestion = location.suggestedLatitude !== null && location.suggestedLongitude !== null;

  const act = async (work: () => Promise<unknown>) => {
    if (await operation.run(work)) onChanged();
  };

  return (
    <div className="mt-2 space-y-1.5" data-testid="site-pin-status">
      <p className="flex flex-wrap items-center gap-2 text-xs text-steel-600">
        <Badge tone={TONE[location.status]} size="sm">
          <span data-testid="site-pin-label">{siteLocationLabel(location.status)}</span>
        </Badge>
        {location.provider === 'simulated' && <Badge tone="violet" size="sm">Simulated geocoder</Badge>}
        {location.source !== null && pinned && (
          <span>{location.source === 'manual' ? 'Set by hand' : `Found from the address${location.precision === null ? '' : ` (${location.precision.toLowerCase().replace(/_/g, ' ')})`}`}</span>
        )}
      </p>
      {location.formattedAddress.length > 0 && (
        <p className="break-words text-xs text-steel-600" data-testid="site-pin-match">
          Matched to: {location.formattedAddress}
        </p>
      )}
      {suggestion && (
        <p className="break-words text-xs text-steel-600" data-testid="site-pin-suggestion">
          Suggested pin: <span className="font-mono">{location.suggestedLatitude}, {location.suggestedLongitude}</span>{' '}
          <a
            className="text-eje-700 underline"
            target="_blank"
            rel="noopener noreferrer"
            href={`https://www.google.com/maps/search/?api=1&query=${location.suggestedLatitude}%2C${location.suggestedLongitude}`}
          >
            view
          </a>
        </p>
      )}
      {location.error.length > 0 && siteLocationNeedsAttention(location.status) && (
        <p className="break-words text-xs text-signal-700" data-testid="site-pin-error">{location.error}</p>
      )}
      {location.status === 'stale' && (
        <p className="text-xs text-amber-eje-700">The address changed after this pin was verified. Technicians get an address search until it is checked again.</p>
      )}
      {operation.error !== null && <RuleViolationNotice title="The pin was not changed" message={operation.error} violations={operation.violations} />}
      {canManage && (
        <div className="flex flex-wrap gap-2">
          {pinned && location.status !== 'verified' && (
            <Button size="sm" variant="secondary" data-testid="site-pin-verify" loading={operation.running} onClick={() => void act(() => api.verifySiteLocation(site.id, { kind: 'current' }))}>
              The pin is correct
            </Button>
          )}
          {suggestion && (
            <Button size="sm" variant="secondary" data-testid="site-pin-use-suggestion" loading={operation.running} onClick={() => void act(() => api.verifySiteLocation(site.id, { kind: 'suggested' }))}>
              Use the suggested pin
            </Button>
          )}
          {location.status !== 'pending' && (
            <Button size="sm" variant="ghost" data-testid="site-pin-find" loading={operation.running} onClick={() => void act(() => api.findSiteLocation(site.id))}>
              Find the pin from the address
            </Button>
          )}
        </div>
      )}
    </div>
  );
};
