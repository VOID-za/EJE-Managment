'use client';

import { useState } from 'react';
import { can, type SystemSettings, type User } from '@/domain';
import { Button, Card, CardHeader, TextField } from '@/components/ui';
import { settings as settingsApi } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';

/**
 * THE FINANCE RECIPIENT. PAY-05 (29 October 2026).
 *
 * The one address the monthly payroll package goes to. Every technician's
 * forms go there, so a Master sets it (the server refuses anybody else), and
 * the change is audited from-and-to. Empty: not configured — nothing can be
 * sent. Shown to the office; editable by a Master.
 */
export const FinanceRecipientCard = ({ user, settings, onSaved }: { readonly user: User; readonly settings: SystemSettings; readonly onSaved: () => void }) => {
  const operation = useOperation();
  const [value, setValue] = useState(settings.financeEmail ?? '');
  const [saved, setSaved] = useState(false);
  const editable = can(user.role, 'settings.manage');

  const save = async () => {
    setSaved(false);
    const ok = await operation.run(() =>
      settingsApi.update({
        companyName: settings.companyName,
        companyRegistration: settings.companyRegistration,
        companyVatNumber: settings.companyVatNumber,
        companyPhone: settings.companyPhone,
        companyEmail: settings.companyEmail,
        companyAddress: settings.companyAddress,
        jobNumberPrefix: settings.jobNumberPrefix,
        quietHoursStart: settings.quietHoursStart,
        quietHoursEnd: settings.quietHoursEnd,
        labourRates: settings.labourRates,
        calloutRate: settings.calloutRate,
        testBenchFee: settings.testBenchFee,
        kilometreRate: settings.kilometreRate,
        vatPercentage: settings.vatPercentage,
        financeEmail: value.trim(),
      }),
    );
    if (ok) {
      setSaved(true);
      onSaved();
    }
  };

  return (
    <Card data-testid="finance-recipient-card">
      <CardHeader
        title="Finance recipient"
        description="The one address the monthly payroll package (every selected technician's timesheet and attendance PDFs, in one email) is sent to. Empty: nothing can be sent."
      />
      {editable ? (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <TextField
            label="Finance email"
            type="email"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            containerClassName="w-80"
            data-testid="finance-email-input"
          />
          <Button loading={operation.running} onClick={() => void save()} data-testid="finance-email-save">
            Save recipient
          </Button>
        </div>
      ) : (
        <p className="mt-4 text-sm font-medium text-steel-800">{settings.financeEmail || 'Not set — a Master sets it.'}</p>
      )}
      {saved && <p role="status" className="mt-2 text-sm text-verdant-700">Saved. The change is on the audit trail.</p>}
      {operation.error !== null && <p role="alert" className="mt-2 text-sm font-medium text-signal-600">{operation.error}</p>}
    </Card>
  );
};
