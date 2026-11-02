'use client';

import { useState } from 'react';
import { labourRateLabel, type CustomerRates, type PricingInputs } from '@/domain';
import { Button, Card, CardHeader, ConfirmDialog, TextField } from '@/components/ui';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { customers } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';

/**
 * A CUSTOMER'S CUSTOM RATES. CUST-RATES-1 (2 November 2026).
 *
 * The same fields as Administration's Rates & VAT — Normal Time, Overtime,
 * Double Time, call-out, test bench, kilometre rate and VAT — set by a Senior
 * Tech or the Office for this customer only. Shown only for a customer on
 * Custom Rates. Until they are saved, this customer's job cards cannot be
 * priced: nothing falls back to the defaults. Saving reprices nothing already
 * signed or issued.
 */
type Draft = Record<'normal' | 'overtime' | 'double' | 'callout' | 'testBench' | 'kilometre' | 'vat', string>;

const toRand = (cents: number): string => (cents / 100).toFixed(2);

const draftFrom = (rates: PricingInputs): Draft => ({
  normal: toRand(rates.labourRates.normal),
  overtime: toRand(rates.labourRates.overtime),
  double: toRand(rates.labourRates.double),
  callout: toRand(rates.calloutRate),
  testBench: toRand(rates.testBenchFee ?? 0),
  kilometre: toRand(rates.kilometreRate),
  vat: String(rates.vatPercentage),
});

const EMPTY: Draft = { normal: '', overtime: '', double: '', callout: '', testBench: '', kilometre: '', vat: '' };

const FIELDS: readonly { readonly key: keyof Draft; readonly label: string; readonly suffix: string }[] = [
  { key: 'normal', label: labourRateLabel('normal'), suffix: 'per hour' },
  { key: 'overtime', label: labourRateLabel('overtime'), suffix: 'per hour' },
  { key: 'double', label: labourRateLabel('double'), suffix: 'per hour' },
  { key: 'callout', label: 'Call-out fee', suffix: 'per call-out' },
  { key: 'testBench', label: 'Test bench fee', suffix: 'each' },
  { key: 'kilometre', label: 'Kilometre rate', suffix: 'per km' },
  { key: 'vat', label: 'VAT percentage', suffix: '%' },
];

export const CustomerRatesPanel = ({
  customerId,
  customerName,
  rates,
  defaults,
  canEdit,
  onSaved,
}: {
  readonly customerId: string;
  readonly customerName: string;
  readonly rates: CustomerRates | null;
  readonly defaults: PricingInputs;
  readonly canEdit: boolean;
  readonly onSaved: () => void;
}) => {
  const operation = useOperation();
  const [draft, setDraft] = useState<Draft>(() => (rates === null ? EMPTY : draftFrom(rates)));
  const [confirming, setConfirming] = useState(false);
  const toCents = (value: string): number => Math.round(Number.parseFloat(value) * 100);
  const valid = FIELDS.every(({ key }) => {
    const value = Number.parseFloat(draft[key]);
    return draft[key].trim() !== '' && Number.isFinite(value) && value >= 0 && (key !== 'vat' || value <= 100);
  });

  const save = async (): Promise<void> => {
    setConfirming(false);
    const ok = await operation.run(() =>
      customers.saveRates(customerId, {
        labourRates: { normal: toCents(draft.normal), overtime: toCents(draft.overtime), double: toCents(draft.double) },
        calloutRate: toCents(draft.callout),
        testBenchFee: toCents(draft.testBench),
        kilometreRate: toCents(draft.kilometre),
        vatPercentage: Number.parseFloat(draft.vat),
      }),
    );
    if (ok) onSaved();
  };

  return (
    <Card data-testid="customer-custom-rates">
      <CardHeader
        title="Custom Rates"
        description={`${customerName}'s job cards are priced at these rates, never the Default Rates. Job cards already signed or issued keep their prices.`}
      />
      {rates === null && (
        <p role="alert" className="mb-4 rounded-[var(--radius-control)] border border-signal-200 bg-signal-50 px-3 py-2 text-sm font-medium text-signal-700" data-testid="customer-custom-rates-missing">
          No custom rates are set yet. Job cards for {customerName} cannot be priced until they are.
        </p>
      )}
      {operation.error !== null && (
        <div className="mb-4">
          <RuleViolationNotice title="The rates were not saved" message={operation.error} violations={operation.violations} />
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FIELDS.map(({ key, label, suffix }) => (
          <TextField
            key={key}
            label={`${label} (${key === 'vat' ? '%' : `R ${suffix}`})`}
            type="number"
            inputMode="decimal"
            min={0}
            max={key === 'vat' ? 100 : undefined}
            step={key === 'vat' ? 0.5 : 0.01}
            value={draft[key]}
            disabled={!canEdit}
            onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
            hint={`Default: ${key === 'vat' ? `${defaults.vatPercentage}%` : `R ${toRand(
              key === 'normal' ? defaults.labourRates.normal
                : key === 'overtime' ? defaults.labourRates.overtime
                  : key === 'double' ? defaults.labourRates.double
                    : key === 'callout' ? defaults.calloutRate
                      : key === 'testBench' ? (defaults.testBenchFee ?? 0)
                        : defaults.kilometreRate,
            )}`}`}
            data-testid={`customer-rate-${key}`}
          />
        ))}
      </div>
      {canEdit && (
        <div className="mt-5 flex justify-end">
          <Button onClick={() => setConfirming(true)} disabled={!valid} loading={operation.running} data-testid="customer-rates-save">
            Save custom rates
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        title={`Update ${customerName}'s rates?`}
        message="New and unsigned job cards for this customer are priced at these rates from now on. Signed and issued job cards keep the prices they were frozen at."
        confirmLabel="Save custom rates"
        busy={operation.running}
        onConfirm={() => void save()}
        onCancel={() => setConfirming(false)}
      />
    </Card>
  );
};
