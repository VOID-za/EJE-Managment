'use client';

import Link from 'next/link';
import { useState } from 'react';
import { CUSTOMER_RATE_MODE_LABELS, can, customerRateModeOf, formatAddress, isAddressEmpty, type Customer } from '@/domain';
import { SelectField } from '@/components/ui';
import { customers } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';
import type { JobListRow } from '@/application/job-view';
import { Button, Card, CardHeader, DefinitionGrid, Icon } from '@/components/ui';
import { EditCustomerDialog } from './EditCustomerDialog';
import { useCurrentUser } from '@/providers/AppProvider';
import { formatDate } from '@/lib/format';

/**
 * Company details and open work.
 *
 * What is here is what the office needs when the customer telephones: who they
 * are, how they are billed, and what is running. Contacts are deliberately NOT
 * here — a contact belongs to a site and is managed on the Site & Contacts
 * tab, so there is one place to change one rather than two.
 */
export const CustomerOverviewTab = ({
  customer,
  openJobs,
  onChanged,
}: {
  readonly customer: Customer;
  readonly openJobs: readonly JobListRow[];
  readonly onChanged: () => void;
}) => {
  const currentUser = useCurrentUser();
  const [editing, setEditing] = useState(false);
  const rateOperation = useOperation();
  // CUST-RATES-1: the rate option is the office's to see and change; the customer never chooses it.
  const seesRates = can(currentUser.role, 'customers.manage');
  const setsRates = seesRates && can(currentUser.role, 'settings.rates');
  const changeRateMode = async (mode: 'default' | 'custom') => {
    const ok = await rateOperation.run(() => customers.setRateMode(customer.id, mode));
    if (ok) onChanged();
  };
  const canManage = can(currentUser.role, 'customers.manage');

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader
          title="Company details"
          action={
            canManage && (
              <Button
                size="sm"
                variant="secondary"
                leadingIcon={<Icon name="edit" className="size-4" />}
                onClick={() => setEditing(true)}
              >
                Edit
              </Button>
            )
          }
        />
        <DefinitionGrid
          className="mt-4"
          columns={2}
          items={[
            { label: 'Registered name', value: customer.name },
            { label: 'Account number', value: customer.accountNumber },
            { label: 'Registration number', value: customer.registrationNumber },
            { label: 'VAT number', value: customer.vatNumber },
            { label: 'Office number', value: customer.phone },
            { label: 'Industry', value: customer.industry },
            { label: 'Payment terms', value: customer.paymentTerms },
            ...(seesRates ? [{ label: 'Rates', value: CUSTOMER_RATE_MODE_LABELS[customerRateModeOf(customer)] }] : []),
            { label: 'Customer since', value: formatDate(customer.createdAt) },
            {
              label: 'Office address',
              value: isAddressEmpty(customer.officeAddress)
                ? 'Not recorded'
                : formatAddress(customer.officeAddress),
            },
          ]}
        />
        {setsRates && (
          <div className="mt-4 max-w-sm">
            <SelectField
              label="Price this customer's job cards at"
              value={customerRateModeOf(customer)}
              disabled={rateOperation.running}
              onChange={(event) => void changeRateMode(event.target.value === 'custom' ? 'custom' : 'default')}
              options={[
                { value: 'default', label: 'Default Rates' },
                { value: 'custom', label: 'Custom Rates' },
              ]}
              hint="Signed and issued job cards keep their prices."
              data-testid="customer-rate-mode-edit"
            />
            {rateOperation.error !== null && (
              <p role="alert" className="mt-1 text-sm font-medium text-signal-600">{rateOperation.error}</p>
            )}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Open work" />
        {openJobs.length === 0 ? (
          <p className="mt-3 text-sm text-steel-500">No open jobs for this customer.</p>
        ) : (
          <ul className="mt-3 divide-y divide-steel-100">
            {openJobs.slice(0, 5).map((row) => (
              <li key={row.job.id}>
                <Link
                  href={`/jobs/${row.job.jobNumber}`}
                  className="flex items-center gap-2 py-2.5 text-sm hover:text-eje-700"
                >
                  <span className="font-mono font-semibold text-steel-900">
                    {row.job.jobNumber}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-steel-600">{row.siteName}</span>
                  <Icon name="chevronRight" className="size-4 text-steel-300" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {canManage && (
        <EditCustomerDialog
          open={editing}
          customer={customer}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
        />
      )}
    </div>
  );
};
