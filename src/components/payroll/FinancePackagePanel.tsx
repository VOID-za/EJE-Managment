'use client';

import { useState } from 'react';
import { Badge, Button, Card, ConfirmDialog, LoadingPanel, QueryFailure } from '@/components/ui';
import { DownloadFileButton } from '@/components/exports/DownloadFileButton';
import { payroll } from '@/api/endpoints';
import type { FinancePackageView, PayrollMonthRow } from '@/application/finance-packages';
import { useQuery } from '@/hooks/useQuery';
import { useOperation } from '@/hooks/useOperation';
import { formatDateTime } from '@/lib/format';

const STATUS: Record<PayrollMonthRow['status'], { label: string; tone: 'amber' | 'green' | 'red' | 'blue' | 'outline' }> = {
  not_submitted: { label: 'Not submitted', tone: 'amber' },
  ready: { label: 'Ready', tone: 'green' },
  correction_pending: { label: 'Correction waiting', tone: 'red' },
  sent: { label: 'Sent to Finance', tone: 'outline' },
  corrected_after_sent: { label: 'Corrected after sending', tone: 'blue' },
};

const PACKAGE_STATUS: Record<FinancePackageView['status'], string> = {
  prepared: 'Prepared — not sent',
  sending: 'Sending…',
  sent: 'Sent',
  failed: 'NOT sent — failed',
  discarded: 'Discarded — not sent',
};

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;

/**
 * THE OFFICE'S MONTHLY PAYROLL PACKAGE FOR FINANCE. PAY-05…PAY-08.
 *
 * Every technician's status for the month; tick the ones whose forms are ready;
 * Prepare shows the exact attachments — file names, pages, sizes, the total
 * against the one-email limit — before anything goes; Send to Finance sends
 * them all in ONE email, once. Every package stays listed with who prepared
 * and sent it, when, to whom, the provider's answer and its files.
 */
export const FinancePackagePanel = ({ month, onOpenForms }: { readonly month: string; readonly onOpenForms: (userId: string) => void }) => {
  const operation = useOperation();
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [confirmSend, setConfirmSend] = useState<FinancePackageView | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const view = useQuery(`payroll:month:${month}`, () => payroll.month(month));

  if (view.error !== null) return <QueryFailure code={view.errorCode} message={view.error} onRetry={view.refetch} />;
  if (view.loading || view.data === null || view.data === undefined) return <LoadingPanel rows={4} label="Loading the month" />;
  const data = view.data;
  const open = data.packages.find((financePackage) => ['prepared', 'failed', 'sending'].includes(financePackage.status)) ?? null;
  const selectable = data.rows.filter((row) => row.selectable).map((row) => row.technician.id);

  const prepare = async () => {
    setResult(null);
    const ok = await operation.run(async () => {
      await payroll.prepare(month, selected);
    });
    if (ok) {
      setSelected([]);
      view.refetch();
    }
  };
  const send = async (financePackage: FinancePackageView) => {
    setConfirmSend(null);
    let outcome: FinancePackageView | null = null;
    const ok = await operation.run(async () => {
      outcome = (await payroll.send(financePackage.id)).package;
    });
    const sent = outcome as FinancePackageView | null;
    if (ok && sent !== null) {
      setResult(
        sent.status === 'sent'
          ? `Sent: one email to ${sent.recipient} with ${sent.attachments.length} attachments. The provider answered “${sent.providerState ?? ''}” — accepted for delivery, which is not proof the mailbox received it.`
          : `NOT sent: ${sent.failureReason}. Nothing reached Finance; you can send it again.`,
      );
    }
    view.refetch();
  };
  const discard = async (financePackage: FinancePackageView) => {
    const ok = await operation.run(async () => {
      await payroll.discard(financePackage.id);
    });
    if (ok) view.refetch();
  };

  return (
    <Card className="mb-5" data-testid="finance-package">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-semibold text-steel-900">Finance package — {data.monthLabel}</p>
        <p className="text-xs text-steel-600" data-testid="finance-recipient">
          Finance recipient: <strong>{data.recipient || 'not set'}</strong>
          {data.recipient === '' ? ' — a Master sets it in Administration → Settings.' : ''}
        </p>
      </div>
      <p className={`mt-1 text-xs ${data.email.ready ? 'text-steel-500' : 'font-medium text-signal-600'}`} data-testid="finance-email-readiness">
        {data.email.detail}
      </p>

      <div className="eje-scrollbar mt-3 overflow-x-auto">
        <table className="min-w-full text-sm" data-testid="finance-rows">
          <thead>
            <tr className="text-left text-xs text-steel-500 uppercase">
              <th className="py-1 pr-2">
                <input
                  type="checkbox"
                  aria-label="Select every ready technician"
                  checked={selectable.length > 0 && selectable.every((id) => selected.includes(id))}
                  disabled={selectable.length === 0 || open !== null}
                  onChange={(event) => setSelected(event.target.checked ? selectable : [])}
                />
              </th>
              <th className="py-1 pr-3">Technician</th>
              <th className="py-1 pr-3">Status</th>
              <th className="py-1 pr-3">Files</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.technician.id} className="border-t border-steel-100 align-top" data-testid="finance-row" data-status={row.status}>
                <td className="py-1.5 pr-2">
                  <input
                    type="checkbox"
                    aria-label={`Include ${row.technician.name}`}
                    checked={selected.includes(row.technician.id)}
                    disabled={!row.selectable || open !== null}
                    onChange={(event) =>
                      setSelected(event.target.checked ? [...selected, row.technician.id] : selected.filter((id) => id !== row.technician.id))
                    }
                    data-testid="finance-select"
                  />
                </td>
                <td className="py-1.5 pr-3 font-medium text-steel-900">{row.technician.name}</td>
                <td className="py-1.5 pr-3">
                  <Badge tone={STATUS[row.status].tone} size="sm">{STATUS[row.status].label}</Badge>
                  <p className="mt-0.5 text-xs text-steel-500">{row.detail}</p>
                </td>
                <td className="py-1.5 pr-3 text-xs text-steel-600">
                  {row.fileNames.timesheet}
                  <br />
                  {row.fileNames.attendance}
                </td>
                <td className="py-1.5 text-right">
                  <Button size="sm" variant="ghost" onClick={() => onOpenForms(row.technician.id)}>
                    View forms
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {open === null && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button disabled={selected.length === 0} loading={operation.running} onClick={() => void prepare()} data-testid="finance-prepare">
            Prepare package ({selected.length} technician{selected.length === 1 ? '' : 's'}, {selected.length * 2} PDFs)
          </Button>
          <p className="text-xs text-steel-500">Preparing renders and stores the files and shows them to you. Nothing is sent until you press Send.</p>
        </div>
      )}

      {result !== null && <p role="status" className="mt-3 text-sm text-verdant-700" data-testid="finance-result">{result}</p>}
      {operation.error !== null && <p role="alert" className="mt-3 text-sm font-medium text-signal-600" data-testid="finance-error">{operation.error}</p>}

      {data.packages.length > 0 && (
        <div className="mt-4 space-y-3">
          {data.packages.map((financePackage) => (
            <div
              key={financePackage.id}
              className={`rounded-[var(--radius-control)] border p-3 text-sm ${financePackage.status === 'sent' ? 'border-steel-200' : financePackage.status === 'failed' ? 'border-signal-300' : 'border-eje-200 bg-eje-50/40'}`}
              data-testid="finance-package-item"
              data-status={financePackage.status}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-steel-900">{PACKAGE_STATUS[financePackage.status]}</span>
                <span className="text-xs text-steel-500">
                  {financePackage.attachments.length} attachments · {kb(financePackage.totalBytes)} of {kb(data.maxBytes)} · to {financePackage.recipient} · reference {financePackage.id}
                </span>
              </div>
              <p className="mt-1 text-xs text-steel-600">
                Prepared {formatDateTime(financePackage.preparedAt)}{financePackage.preparedByName ? ` by ${financePackage.preparedByName}` : ''}
                {financePackage.sentAt !== null ? ` · sent ${formatDateTime(financePackage.sentAt)}${financePackage.sentByName ? ` by ${financePackage.sentByName}` : ''}` : ''}
                {financePackage.providerState !== null ? ` · provider: ${financePackage.providerState}${financePackage.providerMessageId ? ` (${financePackage.providerMessageId})` : ''}` : ''}
                {financePackage.attempts > 0 ? ` · attempts ${financePackage.attempts}` : ''}
              </p>
              {financePackage.status === 'failed' && (
                <p className="mt-1 text-xs font-medium text-signal-600">Not sent: {financePackage.failureReason}</p>
              )}
              <div className="eje-scrollbar mt-2 overflow-x-auto">
                <table className="min-w-full text-xs" data-testid="finance-attachments">
                  <thead>
                    <tr className="text-left text-steel-500">
                      <th className="py-0.5 pr-3">File</th>
                      <th className="py-0.5 pr-3">Technician</th>
                      <th className="py-0.5 pr-3">Version</th>
                      <th className="py-0.5 pr-3 text-right">Pages</th>
                      <th className="py-0.5 pr-3 text-right">Size</th>
                      <th className="py-0.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {financePackage.attachments.map((attachment) => (
                      <tr key={attachment.fileName} className="border-t border-steel-100" data-testid="finance-attachment">
                        <td className="py-0.5 pr-3 font-medium text-steel-900">{attachment.fileName}</td>
                        <td className="py-0.5 pr-3">{attachment.technicianName}</td>
                        <td className="py-0.5 pr-3">{attachment.versionLabel}</td>
                        <td className="py-0.5 pr-3 text-right tabular-nums" data-testid="finance-attachment-pages">{attachment.pageCount}</td>
                        <td className="py-0.5 pr-3 text-right tabular-nums">{kb(attachment.sizeBytes)}</td>
                        <td className="py-0.5 text-right">
                          <DownloadFileButton href={payroll.fileUrl(financePackage.id, attachment.fileName)} fallbackName={attachment.fileName} label="Open" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {(financePackage.status === 'prepared' || financePackage.status === 'failed') && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    disabled={!data.email.ready}
                    loading={operation.running}
                    onClick={() => setConfirmSend(financePackage)}
                    data-testid="finance-send"
                  >
                    {financePackage.status === 'failed' ? 'Send again' : 'Send to Finance'} — one email, {financePackage.attachments.length} attachments
                  </Button>
                  <Button variant="ghost" loading={operation.running} onClick={() => void discard(financePackage)} data-testid="finance-discard">
                    Discard
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirmSend !== null}
        title={`Send ${data.monthLabel}'s payroll forms to Finance?`}
        message={
          confirmSend === null
            ? ''
            : `ONE email to ${confirmSend.recipient} with ${confirmSend.attachments.length} attachments (${kb(confirmSend.totalBytes)}): ${confirmSend.technicianNames.join(', ')}. It is sent once; it cannot be unsent.`
        }
        confirmLabel="Send one email"
        busy={operation.running}
        onConfirm={() => confirmSend !== null && void send(confirmSend)}
        onCancel={() => setConfirmSend(null)}
      />
    </Card>
  );
};
