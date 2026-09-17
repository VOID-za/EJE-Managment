'use client';

import { useState } from 'react';
import {
  can,
  JOB_TYPE_CODES,
  labourRateLabel,
  listJobTypeDefinitions,
  PRIORITY_ORDER,
  priorityLabel,
  userFullName,
  type LabourRateType,
  type SystemSettings,
} from '@/domain';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  Icon,
  LoadingPanel,
  Tabs,
  TextField,
  type Column,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { SIMULATED_CAPABILITIES } from '@/config/demo';
import { useQuery } from '@/hooks/useQuery';
import { useApp, useCurrentUser } from '@/providers/AppProvider';
import { formatCurrency, formatDate } from '@/lib/format';
import type { ChecklistTemplate, TechnicalDocument, User } from '@/domain';

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
    const [users, settings, templates, documents, customers, machines] = await Promise.all([
      repos.users.list(),
      repos.settings.get(),
      repos.checklistTemplates.list(),
      repos.documents.list(),
      repos.customers.list(),
      repos.machines.list(),
    ]);
    return { users, settings, templates, documents, customers, machines };
  });

  if (!can(user.role, 'admin.access')) {
    return (
      <EmptyState
        title="Administration is restricted"
        description="Only Masters can access system administration."
        icon={<Icon name="settings" />}
      />
    );
  }

  if (query.error !== null) {
    return <ErrorState message={query.error} onRetry={query.refetch} />;
  }

  const data = query.data;

  return (
    <>
      <PageHeader
        title="Administration"
        breadcrumbs={[{ label: 'Administration' }]}
        description="System configuration. In the production system Masters maintain all of this without developer involvement."
      />

      <Tabs
        tabs={[
          { id: 'users', label: 'Users' },
          { id: 'jobTypes', label: 'Job Types & Priorities' },
          { id: 'rates', label: 'Rates & VAT' },
          { id: 'checklists', label: 'Checklists' },
          { id: 'library', label: 'Technical Library' },
          { id: 'system', label: 'System' },
        ]}
        activeId={tab}
        onChange={(id) => setTab(id as TabId)}
        className="mb-5"
      />

      {query.loading || data === null || data === undefined ? (
        <LoadingPanel rows={5} label="Loading administration" />
      ) : (
        <>
          {tab === 'users' && <UsersPanel users={data.users} />}
          {tab === 'jobTypes' && <JobTypesPanel />}
          {tab === 'rates' && <RatesPanel settings={data.settings} onSaved={query.refetch} />}
          {tab === 'checklists' && <ChecklistsPanel templates={data.templates} />}
          {tab === 'library' && <LibraryAdminPanel documents={data.documents} />}
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

const UsersPanel = ({ users }: { readonly users: readonly User[] }) => {
  const columns: Column<User>[] = [
    {
      key: 'name',
      header: 'User',
      render: (row) => (
        <div className="flex items-center gap-3">
          <Avatar initials={row.initials} size="md" />
          <div className="min-w-0">
            <p className="truncate font-semibold text-steel-900">{userFullName(row)}</p>
            <p className="truncate text-xs text-steel-500">{row.jobTitle}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      render: (row) => (
        <Badge tone={row.role === 'master' ? 'blue' : 'neutral'} size="sm">
          {row.role === 'master' ? 'Master' : 'Technician'}
        </Badge>
      ),
    },
    { key: 'email', header: 'Email', secondary: true, render: (row) => row.email },
    { key: 'mobile', header: 'Mobile', secondary: true, render: (row) => row.mobile },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <Badge tone={row.active ? 'green' : 'neutral'} size="sm" dot>
          {row.active ? 'Active' : 'Disabled'}
        </Badge>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <AdminNotice
        title="User management"
        body="Masters will add users, set roles and disable leavers here. Roles drive what each user can see and do throughout the system, through the capability rules in the domain layer."
      />
      <DataTable columns={columns} rows={users} rowKey={(row) => row.id} />
    </div>
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
  const { repositories } = useApp();
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
    await repositories.settings.save({
      ...settings,
      labourRates: {
        normal: toCents(draft.normal),
        overtime: toCents(draft.overtime),
        double: toCents(draft.double),
      },
      calloutRate: toCents(draft.callout),
      kilometreRate: toCents(draft.kilometre),
      vatPercentage: Number.parseFloat(draft.vat),
    });
    setSaving(false);
    setConfirmOpen(false);
    setSaved(true);
    onSaved();
  };

  return (
    <div className="space-y-5">
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

const ChecklistsPanel = ({
  templates,
}: {
  readonly templates: readonly ChecklistTemplate[];
}) => (
  <div className="space-y-5">
    <AdminNotice
      tone="amber"
      title="Demonstration checklist content"
      body="The checklists below are representative content written for this demonstration. The production system will preserve the exact wording of the approved EJE / WD Hearn source documents. Replacing them is a data change: transcribe the approved wording, bump the version and archive the previous template. A completed checklist records the version it was answered against, and the job card is rendered from that stored version — so revising a checklist never rewrites a job card the customer already signed."
    />

    {templates.map((template) => (
      <Card key={template.id}>
        <CardHeader
          title={template.name}
          description={template.description}
          action={
            <div className="flex items-center gap-2">
              <Badge tone="outline" size="sm">
                {template.version}
              </Badge>
              <Badge tone={template.status === 'current' ? 'green' : 'neutral'} size="sm" dot>
                {template.status === 'current' ? 'Current' : 'Archived'}
              </Badge>
            </div>
          }
        />

        <ul className="mt-4 divide-y divide-steel-100">
          {template.sections.map((section, index) => (
            <li key={section.id} className="flex items-center gap-3 py-2.5">
              <span className="tabular flex size-6 items-center justify-center rounded-full bg-steel-100 text-xs font-bold text-steel-600">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-steel-800">
                {section.title}
              </span>
              <span className="tabular text-xs text-steel-400">
                {section.items.length} items
              </span>
            </li>
          ))}
        </ul>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-steel-100 pt-3 text-xs text-steel-500">
          <span>
            Mandatory for: <span className="font-semibold text-steel-700">{template.jobTypeCode}</span>
          </span>
          <span>Last updated {formatDate(template.updatedAt)}</span>
        </div>
        <p className="mt-2 text-xs text-amber-eje-700">Source: {template.sourceDocument}</p>
      </Card>
    ))}
  </div>
);

const LibraryAdminPanel = ({
  documents,
}: {
  readonly documents: readonly TechnicalDocument[];
}) => {
  const pending = documents.filter((document) => document.status === 'pending_approval');

  const columns: Column<TechnicalDocument>[] = [
    {
      key: 'name',
      header: 'Document',
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-steel-900">{row.name}</p>
          <p className="truncate text-xs text-steel-500">
            {row.manufacturer} · {row.machineModel}
          </p>
        </div>
      ),
    },
    { key: 'version', header: 'Version', render: (row) => row.version },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <Badge
          tone={
            row.status === 'current' ? 'green' : row.status === 'archived' ? 'neutral' : 'amber'
          }
          size="sm"
          dot
        >
          {row.status === 'current'
            ? 'Current'
            : row.status === 'archived'
              ? 'Archived'
              : 'Pending approval'}
        </Badge>
      ),
    },
    {
      key: 'uploaded',
      header: 'Uploaded',
      secondary: true,
      render: (row) => <span className="tabular">{formatDate(row.uploadedAt)}</span>,
    },
  ];

  return (
    <div className="space-y-4">
      <AdminNotice
        title="Document control"
        body="Masters approve new documents and archive superseded versions. Technicians only ever see current documents, so a superseded manual cannot be followed by accident."
      />
      {pending.length > 0 && (
        <Card className="border-amber-eje-200 bg-amber-eje-50">
          <p className="text-sm font-semibold text-amber-eje-700">
            {pending.length} {pending.length === 1 ? 'document is' : 'documents are'} waiting for
            approval
          </p>
        </Card>
      )}
      <DataTable columns={columns} rows={documents} rowKey={(row) => row.id} />
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

const AdminNotice = ({
  title,
  body,
  tone = 'blue',
}: {
  readonly title: string;
  readonly body: string;
  readonly tone?: 'blue' | 'amber';
}) => (
  <div
    className={
      tone === 'amber'
        ? 'rounded-[var(--radius-card)] border border-amber-eje-200 bg-amber-eje-50 p-4'
        : 'rounded-[var(--radius-card)] border border-eje-200 bg-eje-50 p-4'
    }
  >
    <p
      className={
        tone === 'amber'
          ? 'flex items-center gap-2 text-sm font-semibold text-amber-eje-700'
          : 'flex items-center gap-2 text-sm font-semibold text-eje-800'
      }
    >
      <Icon name={tone === 'amber' ? 'warning' : 'settings'} className="size-4" />
      {title}
    </p>
    <p className="mt-1.5 text-sm leading-relaxed text-steel-700">{body}</p>
  </div>
);

export default AdminPage;
