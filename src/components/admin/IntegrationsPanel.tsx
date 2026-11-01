'use client';

import Link from 'next/link';
import { useState } from 'react';
import { siteLocationLabel, siteLocationOf } from '@/domain';
import { Badge, Button, Card, CardHeader, LoadingPanel, QueryFailure, SelectField, TextField, type BadgeTone } from '@/components/ui';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { AdminNotice } from './AdminNotice';
import { integrations as api, type IntegrationStatusView } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';
import { useQuery } from '@/hooks/useQuery';
import { formatDateTime } from '@/lib/format';

/**
 * ADMINISTRATION → INTEGRATIONS. INT-ADMIN-1.
 *
 * Email, WhatsApp and Google Maps: what is configured (by variable NAME —
 * never a secret), whether it has been seen to work, and safe tests that go
 * only to the test recipients the server's configuration names. Credentials
 * are set on the server (docs/integrations-setup.md), never in this screen.
 */

const STATE: Record<string, { label: string; tone: BadgeTone }> = {
  not_configured: { label: 'Not configured', tone: 'neutral' },
  incomplete: { label: 'Configuration incomplete', tone: 'amber' },
  configured: { label: 'Configured — not yet verified', tone: 'blue' },
  connected: { label: 'Connected', tone: 'green' },
  authentication_failed: { label: 'Authentication failed', tone: 'red' },
  service_unavailable: { label: 'Service unavailable', tone: 'amber' },
  action_required: { label: 'Action required', tone: 'red' },
  simulated: { label: 'Demonstration (simulated)', tone: 'violet' },
};

export const IntegrationsPanel = () => {
  const query = useQuery('admin:integrations', () => api.status());
  const operation = useOperation();
  const [result, setResult] = useState<{ service: string; ok: boolean; detail: string } | null>(null);
  const [emailIndex, setEmailIndex] = useState('0');
  const [whatsappIndex, setWhatsappIndex] = useState('0');
  const [address, setAddress] = useState('');

  if (query.error !== null) return <QueryFailure code={query.errorCode} message={query.error} onRetry={query.refetch} />;
  const data = query.data;
  if (query.loading || data === null || data === undefined) return <LoadingPanel rows={4} label="Loading integrations" />;

  const run = async (service: string, input: Parameters<typeof api.action>[0]) => {
    setResult(null);
    const outcome = await operation.runFor(() => api.action(input));
    if (outcome !== null) {
      setResult({
        service,
        ok: outcome.ok,
        detail:
          outcome.detail ??
          (outcome.answer === undefined
            ? ''
            : `${outcome.answer.outcome}: ${outcome.answer.formattedAddress || outcome.answer.error} ${outcome.answer.latitude === null ? '' : `(${outcome.answer.latitude}, ${outcome.answer.longitude})`}`),
      });
      query.refetch();
    }
  };

  const tests = (status: IntegrationStatusView) => {
    if (status.service === 'email') {
      return data.testRecipients.email.length === 0 ? (
        <p className="text-sm text-steel-600">No test recipient is configured (EMAIL_TEST_RECIPIENTS), so no test can be sent.</p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <SelectField
            label="Test recipient"
            value={emailIndex}
            options={data.testRecipients.email.map((value, index) => ({ value: String(index), label: value }))}
            onChange={(event) => setEmailIndex(event.target.value)}
          />
          <Button data-testid="integration-test-email" loading={operation.running} onClick={() => void run('email', { action: 'test_email', recipientIndex: Number(emailIndex) })}>
            Send test email
          </Button>
        </div>
      );
    }
    if (status.service === 'whatsapp') {
      return data.testRecipients.whatsapp.length === 0 ? (
        <p className="text-sm text-steel-600">No test recipient is configured (WHATSAPP_TEST_RECIPIENTS), so no test can be sent.</p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <SelectField
            label="Test number"
            value={whatsappIndex}
            options={data.testRecipients.whatsapp.map((value, index) => ({ value: String(index), label: value }))}
            onChange={(event) => setWhatsappIndex(event.target.value)}
          />
          <Button data-testid="integration-test-whatsapp" loading={operation.running} onClick={() => void run('whatsapp', { action: 'test_whatsapp', recipientIndex: Number(whatsappIndex) })}>
            Send test message
          </Button>
        </div>
      );
    }
    return (
      <div className="flex flex-wrap items-end gap-2">
        <TextField label="Test address" placeholder="3 Wadeville Boulevard, Germiston" value={address} maxLength={300} onChange={(event) => setAddress(event.target.value)} />
        <Button
          data-testid="integration-test-geocode"
          variant="secondary"
          disabled={address.trim().length < 3}
          loading={operation.running}
          onClick={() => void run('maps', { action: 'test_geocode', address })}
        >
          Look up
        </Button>
        <Button data-testid="integration-find-unpinned" variant="secondary" loading={operation.running} onClick={() => void run('maps', { action: 'find_unpinned' })}>
          Find pins for unpinned sites
        </Button>
      </div>
    );
  };

  return (
    <div className="space-y-5" data-testid="integrations-panel">
      <AdminNotice
        title="Integrations"
        body="Credentials are set on the server, never here, and are never shown. Tests go only to the test recipients the server names. WhatsApp uses a new, dedicated EJE number (WHATSAPP_DEDICATED_NUMBER) — never the office's WhatsApp — and sends job notifications only after a test from here has passed. Google's coordinates are kept at most 30 days, as its terms require; pins the office enters are kept. Setup steps: docs/integrations-setup.md."
      />
      {operation.error !== null && <RuleViolationNotice title="The test was not run" message={operation.error} violations={operation.violations} />}

      {data.statuses.map((status) => {
        const badge = STATE[status.state] ?? { label: status.state, tone: 'neutral' as BadgeTone };
        return (
          <Card key={status.service} data-testid={`integration-${status.service}`}>
            <CardHeader title={status.title} description={status.summary} action={<Badge tone={badge.tone}>{badge.label}</Badge>} />
            <ul className="mt-3 divide-y divide-steel-100">
              {status.checks.map((check) => (
                <li key={`${check.label}:${check.detail}`} className="flex flex-wrap items-start justify-between gap-2 py-2 text-sm">
                  <span className="font-medium text-ink">{check.label}</span>
                  <span className={`break-words text-right ${check.ok ? 'text-steel-600' : 'text-amber-eje-700'}`}>{check.detail}</span>
                </li>
              ))}
            </ul>
            <div className="mt-4">{tests(status)}</div>
            {result !== null && result.service === status.service && (
              <p className={`mt-3 break-words text-sm ${result.ok ? 'text-verdant-700' : 'text-signal-700'}`} data-testid={`integration-result-${status.service}`}>
                {result.ok ? 'Done: ' : 'Failed: '}
                {result.detail}
              </p>
            )}
          </Card>
        );
      })}

      <Card data-testid="integration-recent-emails">
        <CardHeader title="Recent customer emails" description="Sent means Microsoft 365 accepted it — not that the customer has read it." />
        {data.recentEmails.length === 0 ? (
          <p className="mt-3 text-sm text-steel-600">None yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-steel-100">
            {data.recentEmails.map((email) => (
              <li key={email.id} className="py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="break-words font-medium text-ink">{email.subject || '(not composed)'}</span>
                  <Badge tone={email.state === 'sent' ? 'green' : email.state === 'failed' || email.state === 'attention' ? 'red' : 'blue'}>{email.state}</Badge>
                </div>
                <p className="break-words text-xs text-steel-600">
                  {email.recipient || 'no recipient'} · {formatDateTime(email.createdAt as never)} · attempts {email.attempts}
                  {email.failureReason.length > 0 ? ` · ${email.failureReason}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card data-testid="integration-sites">
        <CardHeader title="Site pins that need the office" description="Unpinned, unsure, not found, or changed since they were verified." />
        {data.sites.length === 0 ? (
          <p className="mt-3 text-sm text-steel-600">Every site pin is settled.</p>
        ) : (
          <ul className="mt-3 divide-y divide-steel-100">
            {data.sites.map(({ site, customerName }) => (
              <li key={site.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="min-w-0 break-words">
                  <Link className="font-medium text-eje-700 underline" href={`/customers/${site.customerId}`}>
                    {customerName || 'Customer'}
                  </Link>{' '}
                  · {site.name}
                </span>
                <Badge tone="amber">{siteLocationLabel(siteLocationOf(site).status)}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
};
