'use client';

import { useState } from 'react';
import {
  can,
  JOB_TYPE_CODES,
  labourRateLabel,
  listJobTypeDefinitions,
  PRIORITY_ORDER,
  priorityLabel,
  type LabourRateType,
  type SystemSettings,
} from '@/domain';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Icon,
  LoadingPanel,
  Tabs,
  TextField,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { AdminNotice } from '@/components/admin/AdminNotice';
import { ChecklistAdminPanel } from '@/components/admin/ChecklistAdminPanel';
import { LibraryAdminPanel } from '@/components/admin/LibraryAdminPanel';
import { UsersPanel } from '@/components/admin/UsersPanel';
import { SIMULATED_CAPABILITIES } from '@/config/demo';
import { useOperation } from '@/hooks/useOperation';
import { useQuery } from '@/hooks/useQuery';
import { updateSettings } from '@/application/settings-operations';
import { useApp, useCurrentUser } from '@/providers/AppProvider';
import { formatCurrency } from '@/lib/format';
import type { TemplateUsage } from '@/domain';

type TabId =
  | 'users'
  | 'jobTypes'
  | 'rates'
  | 'checklists'
  | 'library'
  | 'system';

/**
 * Master administration.
 *
 * The purpose of this area in the demonstration is to show management that the
 * things they will want to change — rates, VAT, job types, checklists, users —
 * are configuration, not code. Editing is enabled where it is safe to
 * demonstrate (rates and system settings) and clearly marked as read-only
 * elsewhere.
 */
const AdminPage = () => {
  const user = useCurrentUser();
  const [tab, setTab] = useState<TabId>('users');

  const query = useQuery('admin:data', async (repos) => {
    const [users, settings, templates, documents, customers, machines, jobs] = await Promise.all([
      repos.users.list(),
      repos.settings.get(),
      repos.checklistTemplates.list(),
      repos.documents.list(),
      repos.customers.list(),
      repos.machines.list(),
      repos.jobs.list(),
    ]);
    // Which template versions jobs have actually completed against. This is what
    // makes a version immutable, so it is read here rather than guessed at.
    const usage: TemplateUsage[] = jobs
      .map((job) => job.checklist)
      .filter((checklist) => checklist !== null)
      .map((checklist) => ({
        templateId: checklist.templateId,
        templateVersion: checklist.templateVersion,
      }));
    return { users, settings, templates, documents, customers, machines, usage };
  });

  if (!can(user.role, 'admin.access')) {
    return (
      <EmptyState
        title="Administration is restricted"
        description="System administration is reached by the office."
        icon={<Icon name="settings" />}
      />
    );
  }

  if (query.error !== null) {
    return <ErrorState message={query.error} onRetry={query.refetch} />;
  }

  const data = query.data;

  /*
   * Which sections this role administers.
   *
   * The commercial terms and the standard of work are a Master's; the office
   * administers people and the library. Every operation behind these tabs
   * enforces the same capability itself — this only decides what is worth
   * showing, because a tab that would refuse every action is just a trap.
   */
  const tabs = [
    { id: 'users', label: 'Users' },
    { id: 'jobTypes', label: 'Job Types & Priorities' },
    ...(can(user.role, 'settings.manage')
      ? [
          { id: 'rates', label: 'Rates & VAT' },
          { id: 'checklists', label: 'Checklists' },
        ]
      : []),
    ...(can(user.role, 'library.manage') ? [{ id: 'library', label: 'Technical Library' }] : []),
    { id: 'system', label: 'System' },
  ];

  return (
    <>
      <PageHeader
        title="Administration"
        breadcrumbs={[{ label: 'Administration' }]}
        description="System configuration. In the production system Masters maintain all of this without developer involvement."
      />

      <Tabs
        tabs={tabs}
        activeId={tab}
        onChange={(id) => setTab(id as TabId)}
        className="mb-5"
      />

      {query.loading || data === null || data === undefined ? (
        <LoadingPanel rows={5} label="Loading administration" />
      ) : (
        <>
          {tab === 'users' && <UsersPanel users={data.users} onChanged={query.refetch} />}
          {tab === 'jobTypes' && <JobTypesPanel />}
          {tab === 'rates' && can(user.role, 'settings.manage') && (
            <RatesPanel settings={data.settings} onSaved={query.refetch} />
          )}
          {tab === 'checklists' && can(user.role, 'settings.manage') && (
            <ChecklistAdminPanel
              templates={data.templates}
              usage={data.usage}
              onChanged={query.refetch}
            />
          )}
          {tab === 'library' && can(user.role, 'library.manage') && (
            <LibraryAdminPanel documents={data.documents} onChanged={query.refetch} />
          )}
          {tab === 'system' && (
            <SystemPanel
              settings={data.settings}
              counts={{
                customers: data.customers.length,
                machines: data.machines.length,
                users: data.users.length,
              }}
            />
          )}
        </>
      )}
    </>
  );
};

const JobTypesPanel = () => (
  <div className="space-y-5">
    <AdminNotice
      title="Job types are behaviour, not labels"
      body="Each job type carries its own requirements. The workflow enforces them, so adding a job type in production is a configuration change rather than new code."
    />

    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {listJobTypeDefinitions().map((definition) => (
        <Card key={definition.code}>
          <CardHeader
            title={definition.label}
            description={definition.description}
            action={<Badge tone="outline" size="sm">{definition.code}</Badge>}
          />
          <ul className="mt-4 space-y-2 text-sm">
            <li className="flex items-center gap-2.5">
              <Icon
                name={definition.checklistRequired ? 'check' : 'close'}
                className={`size-4 ${definition.checklistRequired ? 'text-verdant-600' : 'text-steel-400'}`}
              />
              <span className="text-steel-700">
                {definition.checklistRequired ? 'Checklist required' : 'No checklist'}
              </span>
            </li>
            <li className="flex items-center gap-2.5">
              <Icon
                name={definition.photosRequired ? 'check' : 'close'}
                className={`size-4 ${definition.photosRequired ? 'text-verdant-600' : 'text-steel-400'}`}
              />
              <span className="text-steel-700">
                {definition.photosRequired ? 'Photographs required' : 'Photographs optional'}
              </span>
            </li>
            <li className="flex items-center gap-2.5">
              <Icon name="warning" className="size-4 text-steel-400" />
              <span className="text-steel-700">
                Default priority: {priorityLabel(definition.defaultPriority)}
              </span>
            </li>
          </ul>
        </Card>
      ))}
    </div>

    <Card>
      <CardHeader
        title="Priorities"
        description="Urgent is deliberately the loudest signal in the system."
      />
      <ul className="mt-4 flex flex-wrap gap-3">
        {PRIORITY_ORDER.map((priority) => (
          <li
            key={priority}
            className="flex items-center gap-2 rounded-[var(--radius-control)] border border-steel-200 px-3 py-2"
          >
            <span className="text-sm font-medium text-steel-800">{priorityLabel(priority)}</span>
            <Badge tone="outline" size="sm">
              {priority}
            </Badge>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-xs text-steel-500">
        {JOB_TYPE_CODES.length} job types and {PRIORITY_ORDER.length} priorities are defined. Both
        become database-backed and Master-editable in the production system.
      </p>
    </Card>
  </div>
);

const RatesPanel = ({
  settings,
  onSaved,
}: {
  readonly settings: SystemSettings;
  readonly onSaved: () => void;
}) => {
  const operation = useOperation();
  const [draft, setDraft] = useState(() => ({
    normal: (settings.labourRates.normal / 100).toFixed(2),
    overtime: (settings.labourRates.overtime / 100).toFixed(2),
    double: (settings.labourRates.double / 100).toFixed(2),
    callout: (settings.calloutRate / 100).toFixed(2),
    kilometre: (settings.kilometreRate / 100).toFixed(2),
    vat: String(settings.vatPercentage),
  }));
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const toCents = (value: string): number => Math.round(Number.parseFloat(value) * 100);
  const valid =
    ['normal', 'overtime', 'double', 'callout', 'kilometre'].every((key) =>
      Number.isFinite(Number.parseFloat(draft[key as keyof typeof draft])),
    ) && Number.isFinite(Number.parseFloat(draft.vat));

  const save = async () => {
    setSaving(true);
    // Through the operation, which is where the Master-only rule is enforced
    // and where the change is recorded on the audit trail.
    const ok = await operation.run((context) =>
      updateSettings(context, {
        ...settings,
        labourRates: {
          normal: toCents(draft.normal),
          overtime: toCents(draft.overtime),
          double: toCents(draft.double),
        },
        calloutRate: toCents(draft.callout),
        kilometreRate: toCents(draft.kilometre),
        vatPercentage: Number.parseFloat(draft.vat),
      }),
    );
    setSaving(false);
    setConfirmOpen(false);
    if (!ok) return;
    setSaved(true);
    onSaved();
  };

  return (
    <div className="space-y-5">
      {operation.error !== null && (
        <p role="alert" className="text-sm font-medium text-signal-600">
          {operation.error}
        </p>
      )}

      <AdminNotice
        title="Changing rates affects every open job"
        body="A rate change re-prices open work immediately. It cannot reach a job the customer has already signed: every job freezes a full copy of the rates at signature and is priced from that copy for the rest of its life."
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Labour rates" description="Charged per hour, excluding VAT." />
          <div className="mt-4 space-y-4">
            {(['normal', 'overtime', 'double'] as const).map((key) => (
              <TextField
                key={key}
                label={labourRateLabel(key as LabourRateType)}
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={draft[key]}
                onChange={(event) => {
                  setSaved(false);
                  setDraft((current) => ({ ...current, [key]: event.target.value }));
                }}
                hint={`Currently ${formatCurrency(settings.labourRates[key])} per hour`}
              />
            ))}
          </div>
        </Card>

        <Card>
          <CardHeader title="Call-out, travel and VAT" />
          <div className="mt-4 space-y-4">
            <TextField
              label="Call-out fee"
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={draft.callout}
              onChange={(event) => {
                setSaved(false);
                setDraft((current) => ({ ...current, callout: event.target.value }));
              }}
              hint={`Currently ${formatCurrency(settings.calloutRate)}. Charged once, on jobs where the office applies it.`}
            />
            <TextField
              label="Kilometre rate"
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={draft.kilometre}
              onChange={(event) => {
                setSaved(false);
                setDraft((current) => ({ ...current, kilometre: event.target.value }));
              }}
              hint={`Currently ${formatCurrency(settings.kilometreRate)} per km. Travel is charged on distance only.`}
            />
            <TextField
              label="VAT percentage"
              type="number"
              min="0"
              max="100"
              step="0.5"
              inputMode="decimal"
              value={draft.vat}
              onChange={(event) => {
                setSaved(false);
                setDraft((current) => ({ ...current, vat: event.target.value }));
              }}
              hint={`Currently ${settings.vatPercentage}%`}
            />
          </div>

          <div className="mt-6 flex items-center justify-end gap-2 border-t border-steel-100 pt-4">
            {saved && (
              <Badge tone="green" size="sm">
                Saved
              </Badge>
            )}
            <Button onClick={() => setConfirmOpen(true)} disabled={!valid}>
              Save rates
            </Button>
          </div>
        </Card>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Update charge-out rates?"
        message="Open jobs will be re-priced at the new rates. Jobs the customer has already signed keep the rates that were frozen onto them at signature, so signed job cards and their totals do not move."
        confirmLabel="Update rates"
        busy={saving}
        onConfirm={save}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
};

const SystemPanel = ({
  settings,
  counts,
}: {
  readonly settings: SystemSettings;
  readonly counts: { customers: number; machines: number; users: number };
}) => {
  const { resetDemoData } = useApp();
  const [confirmReset, setConfirmReset] = useState(false);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Company details" description="Printed on every job card." />
          <dl className="mt-4 space-y-2.5 text-sm">
            {[
              ['Company name', settings.companyName],
              ['Registration number', settings.companyRegistration],
              ['VAT number', settings.companyVatNumber],
              ['Telephone', settings.companyPhone],
              ['Email', settings.companyEmail],
              ['Address', settings.companyAddress],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4 border-b border-steel-100 pb-2">
                <dt className="text-steel-500">{label}</dt>
                <dd className="text-right font-medium text-steel-800">{value}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card>
          <CardHeader title="Job numbering and notifications" />
          <dl className="mt-4 space-y-2.5 text-sm">
            {[
              ['Job number prefix', settings.jobNumberPrefix],
              ['Next job number', `${settings.jobNumberPrefix}${settings.nextJobSequence}`],
              ['Quiet hours', `${settings.quietHoursStart} – ${settings.quietHoursEnd}`],
              ['Customers on file', String(counts.customers)],
              ['Machines on file', String(counts.machines)],
              ['Users', String(counts.users)],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4 border-b border-steel-100 pb-2">
                <dt className="text-steel-500">{label}</dt>
                <dd className="text-right font-medium text-steel-800">{value}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>

      {/* Which build is actually being served. A stale server answering on the
          port looks exactly like missing code; this is how you tell. */}
      <Card>
        <CardHeader
          title="This build"
          description="What the browser is currently being served. If a route 404s that should work, check this first — a previously started server, or a .next directory from an older commit, is the usual cause."
        />
        <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
          {[
            ['Commit', process.env.EJE_BUILD_COMMIT ?? 'unknown'],
            ['Built', process.env.EJE_BUILD_TIME ?? 'unknown'],
            ['Mode', process.env.NODE_ENV],
          ].map(([label, value]) => (
            <div key={label} className="rounded-[var(--radius-control)] border border-steel-200 p-3">
              <dt className="text-xs font-semibold tracking-wide text-steel-500 uppercase">
                {label}
              </dt>
              <dd className="mt-1 font-mono text-xs break-all text-steel-800">{value}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card>
        <CardHeader
          title="Integrations"
          description="Every integration sits behind a service interface. Connecting the real service in Phase 2 replaces the adapter only."
        />
        <ul className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
          {SIMULATED_CAPABILITIES.map((capability) => (
            <li
              key={capability.id}
              className="rounded-[var(--radius-control)] border border-steel-200 p-4"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-steel-900">{capability.name}</span>
                <Badge tone="amber" size="sm">
                  Simulated
                </Badge>
              </div>
              <p className="mt-1.5 text-sm text-steel-600">{capability.explanation}</p>
              <p className="mt-1.5 text-xs text-steel-500">
                <span className="font-semibold">In production: </span>
                {capability.productionPlan}
              </p>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="border-signal-200">
        <CardHeader
          title="Reset demonstration data"
          description="Returns every job, customer and setting to the seeded state. Use this between demonstrations."
          action={
            <Button variant="danger" onClick={() => setConfirmReset(true)}>
              Reset demo data
            </Button>
          }
        />
      </Card>

      <ConfirmDialog
        open={confirmReset}
        title="Reset all demonstration data?"
        message={
          <>
            <p>
              Every change made during this demonstration — accepted jobs, captured labour,
              signatures and submitted job cards — will be discarded and the seeded data restored.
            </p>
            <p className="mt-2 font-semibold text-signal-600">This cannot be undone.</p>
          </>
        }
        confirmLabel="Reset demo data"
        confirmVariant="danger"
        onConfirm={() => {
          resetDemoData();
          setConfirmReset(false);
        }}
        onCancel={() => setConfirmReset(false)}
      />
    </div>
  );
};

export default AdminPage;
