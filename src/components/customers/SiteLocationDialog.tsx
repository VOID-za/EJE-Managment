'use client';

import { useState } from 'react';
import { checkCoordinates, type Site } from '@/domain';
import { Button, Modal, TextField } from '@/components/ui';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { customers } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';

const asText = (value: number | null): string => (value === null ? '' : String(value));

/** '' is "not given"; anything else must be a plain decimal number. */
const parse = (text: string): number | null | 'invalid' => {
  const trimmed = text.trim().replace(',', '.');
  if (trimmed.length === 0) return null;
  if (!/^-?\d{1,3}(\.\d+)?$/u.test(trimmed)) return 'invalid';
  return Number(trimmed);
};

/**
 * PINS — OR CLEARS — THE SITE'S LOCATION. SITE-3.
 *
 * Office only, like every other change to the register. The two numbers are
 * typed (or pasted from Google Maps: right-click a place, and the first line of
 * the menu is "lat, lng", which the latitude box splits). Nothing is looked up
 * or guessed; the server validates the pair again.
 */
export const SiteLocationDialog = ({
  open,
  site,
  onClose,
  onSaved,
}: {
  readonly open: boolean;
  readonly site: Site;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) => {
  const operation = useOperation();
  const [latitude, setLatitude] = useState(asText(site.latitude));
  const [longitude, setLongitude] = useState(asText(site.longitude));
  const [problem, setProblem] = useState<string | null>(null);

  // Mounted fresh each time it opens (see CustomerLocationCard), so the
  // initial state above is always the site as it stands.

  const changeLatitude = (value: string): void => {
    // "-26.1076, 28.0567" pasted from Google Maps fills both boxes.
    const pair = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/u.exec(value);
    if (pair !== null) {
      setLatitude(pair[1]!);
      setLongitude(pair[2]!);
      return;
    }
    setLatitude(value);
  };

  const close = (): void => {
    operation.clearError();
    onClose();
  };

  const save = async (lat: number | null, lng: number | null): Promise<void> => {
    const ok = await operation.run(async () => {
      await customers.updateSite(site.id, {
        name: site.name,
        addressLine1: site.addressLine1,
        addressLine2: site.addressLine2,
        city: site.city,
        province: site.province,
        postalCode: site.postalCode,
        accessNotes: site.accessNotes,
        latitude: lat,
        longitude: lng,
      });
    });
    if (ok) onSaved();
  };

  const submit = async (): Promise<void> => {
    const lat = parse(latitude);
    const lng = parse(longitude);
    if (lat === 'invalid' || lng === 'invalid') {
      setProblem('Enter each coordinate as a decimal number, for example -26.107600.');
      return;
    }
    const check = checkCoordinates(lat, lng);
    if (!check.ok) {
      setProblem(check.message);
      return;
    }
    setProblem(null);
    await save(check.latitude, check.longitude);
  };

  const pinned = site.latitude !== null && site.longitude !== null;

  return (
    <Modal
      open={open}
      title="Site location"
      description={`Pins ${site.name} on the map. Without a pin, the map searches the address.`}
      onClose={close}
      size="sm"
      footer={
        <>
          {pinned && (
            <Button
              variant="ghost"
              onClick={() => void save(null, null)}
              disabled={operation.running}
              data-testid="clear-site-location"
            >
              Clear pin
            </Button>
          )}
          <Button variant="secondary" onClick={close} disabled={operation.running}>
            Cancel
          </Button>
          <Button onClick={submit} loading={operation.running} data-testid="save-site-location">
            Save location
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {(problem !== null || operation.error !== null) && (
          <RuleViolationNotice
            title="The location could not be saved"
            message={problem ?? operation.error ?? ''}
            violations={problem === null ? operation.violations : []}
          />
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            label="Latitude"
            inputMode="decimal"
            value={latitude}
            onChange={(event) => changeLatitude(event.target.value)}
            placeholder="-26.107600"
            hint="South is negative."
          />
          <TextField
            label="Longitude"
            inputMode="decimal"
            value={longitude}
            onChange={(event) => setLongitude(event.target.value)}
            placeholder="28.056700"
          />
        </div>
        <p className="text-xs text-steel-500">
          Tip: in Google Maps, right-click the gate and click the coordinates at the top of the
          menu to copy them, then paste both into Latitude.
        </p>
      </div>
    </Modal>
  );
};
