'use client';

import Link from 'next/link';
import { useState } from 'react';
import { can, formatAddress, isAddressEmpty, type Customer } from '@/domain';
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
 * here — a contact belongs to a site and is managed on the Sites & Contacts
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
            { label: 'Customer since', value: formatDate(customer.createdAt) },
            {
              label: 'Office address',
              value: isAddressEmpty(customer.officeAddress)
                ? 'Not recorded'
                : formatAddress(customer.officeAddress),
            },
          ]}
        />
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
