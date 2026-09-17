import {
  calculateJobTotals,
  contactFullName,
  customerFacingNotes,
  evaluateChecklist,
  getJobTypeDefinition,
  jobScheduleWindow,
  jobStatusLabel,
  labourRateLabel,
  machineDisplayName,
  priorityLabel,
  userFullName,
  type ChecklistItem,
  type ChecklistResponse,
} from '@/domain';
import type { JobView } from '@/application/job-view';
import { formatCurrency, formatDate, formatDateTime } from '@/lib/format';
import { SignatureDisplay } from './SignaturePad';

/**
 * The EJE job card document.
 *
 * This is rendered from the live job record — the same model the production PDF
 * renderer will consume — rather than being a picture of a job card. When the
 * real PdfService is introduced it renders this same data server-side, so the
 * layout work done here is not thrown away.
 */
export const JobCardDocument = ({ view }: { readonly view: JobView }) => {
  const { job, customer, site, contact, machine, settings, checklistTemplate } = view;
  const totals = calculateJobTotals(job, settings);
  const definition = getJobTypeDefinition(job.jobType);
  const scheduleWindow = jobScheduleWindow(job);

  // Internal notes are EJE-only and must never reach this document. The rule
  // lives in the domain so every surface applies the same one.
  const visibleNotes = customerFacingNotes(job.notes);

  const authorName = (authorId: string): string => {
    const author = view.users.find((candidate) => candidate.id === authorId);
    return author === undefined ? 'EJE' : userFullName(author);
  };

  const responses = new Map<string, ChecklistResponse>(
    (job.checklist?.responses ?? []).map((response) => [response.itemId, response]),
  );

  return (
    <article
      // Pinned to the light palette in both themes: this is a preview of the
      // document the customer receives, and it must look the way it will print.
      data-theme="light"
      className="eje-document mx-auto max-w-[820px] bg-white p-8 text-[13px] leading-relaxed text-steel-800 shadow-[var(--shadow-card)] sm:p-10"
    >
      <header className="flex flex-wrap items-start justify-between gap-6 border-b-2 border-steel-900 pb-5">
        <div>
          <div className="flex items-center gap-3">
            <span className="flex size-11 items-center justify-center rounded-[0.55rem] bg-steel-900 text-[13px] font-black tracking-tighter text-white">
              EJE
            </span>
            <div>
              <p className="text-lg leading-tight font-bold text-steel-900">
                {settings.companyName}
              </p>
              <p className="text-xs text-steel-500">{settings.companyAddress}</p>
            </div>
          </div>
          <p className="mt-3 text-xs text-steel-500">
            Tel {settings.companyPhone} · {settings.companyEmail}
            <br />
            Reg. {settings.companyRegistration} · VAT {settings.companyVatNumber}
          </p>
        </div>

        <div className="text-right">
          <p className="text-xs font-semibold tracking-[0.18em] text-steel-500 uppercase">
            Job Card
          </p>
          <p className="font-mono text-2xl font-bold text-steel-900">{job.jobNumber}</p>
          <p className="mt-1 text-xs text-steel-500">
            {definition.label} · {priorityLabel(job.priority)}
          </p>
          <p className="text-xs text-steel-500">Status: {jobStatusLabel(job.status)}</p>
        </div>
      </header>

      <section className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
        <div>
          <SectionTitle>Customer</SectionTitle>
          <p className="font-semibold text-steel-900">{customer.name}</p>
          <p className="text-steel-600">
            {site.name}
            <br />
            {site.addressLine1}
            {site.addressLine2.length > 0 && (
              <>
                <br />
                {site.addressLine2}
              </>
            )}
            <br />
            {site.city}, {site.province} {site.postalCode}
          </p>
          {contact !== null && (
            <p className="mt-2 text-steel-600">
              <span className="font-medium text-steel-800">{contactFullName(contact)}</span>
              <br />
              {contact.position}
              <br />
              {contact.phone} · {contact.email}
            </p>
          )}
        </div>

        <div>
          {machine !== null && (
            <>
              <SectionTitle>Machine</SectionTitle>
              <p className="font-semibold text-steel-900">{machineDisplayName(machine)}</p>
              <dl className="mt-1 space-y-0.5 text-steel-600">
                <Row label="Serial number" value={machine.serialNumber} mono />
                <Row label="Machine type" value={machine.machineType} />
                <Row label="Control" value={machine.controlSystem} />
                <Row label="Year" value={String(machine.year)} />
              </dl>
            </>
          )}

          <div className="mt-4">
            <SectionTitle>Job details</SectionTitle>
            <dl className="space-y-0.5 text-steel-600">
              <Row
                label="Scheduled"
                value={
                  scheduleWindow !== null && scheduleWindow.days > 1
                    ? `${formatDate(scheduleWindow.start)} – ${formatDate(scheduleWindow.end)} (${scheduleWindow.days} days)`
                    : formatDate(job.scheduledDate)
                }
              />
              <Row label="Order number" value={job.orderNumber.length > 0 ? job.orderNumber : '—'} />
              <Row
                label="Reference"
                value={job.referenceNumber.length > 0 ? job.referenceNumber : '—'}
              />
              <Row
                label="Technician"
                value={
                  view.primaryTechnician === null
                    ? 'Unassigned'
                    : userFullName(view.primaryTechnician)
                }
              />
            </dl>
          </div>
        </div>
      </section>

      <section className="mt-6">
        <SectionTitle>Reported fault</SectionTitle>
        <p className="rounded border border-steel-200 bg-steel-50 p-3 text-steel-700">
          {job.faultDescription.length > 0 ? job.faultDescription : 'No fault description recorded.'}
        </p>
      </section>

      <section className="mt-6 space-y-4">
        <SectionTitle>Work carried out</SectionTitle>
        <Block label="Fault findings" value={job.completionReport.faultFindings} />
        <Block label="Diagnosis" value={job.completionReport.diagnosis} />
        <Block label="Work performed" value={job.completionReport.workPerformed} />
        <Block label="Recommendations" value={job.completionReport.recommendations} />
        {job.completionReport.generalNotes.trim().length > 0 && (
          <Block label="General notes" value={job.completionReport.generalNotes} />
        )}
      </section>

      {visibleNotes.length > 0 && (
        <section className="mt-6">
          <SectionTitle>Job notes</SectionTitle>
          <ul className="space-y-2">
            {visibleNotes.map((note) => (
              <li key={note.id} className="border-b border-steel-100 pb-2 last:border-b-0">
                <p className="whitespace-pre-line text-steel-700">{note.body}</p>
                <p className="mt-0.5 text-[11px] text-steel-500">
                  {authorName(note.authorId)} · {formatDateTime(note.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(job.labour.length > 0 ||
        job.travel.length > 0 ||
        job.parts.length > 0 ||
        job.calloutApplied) && (
        <section className="mt-6">
          <SectionTitle>Labour, travel and parts</SectionTitle>
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-y border-steel-300 bg-steel-50 text-left">
                <th className="py-2 pr-2 font-semibold">Description</th>
                <th className="w-16 py-2 text-right font-semibold">Qty</th>
                <th className="w-24 py-2 text-right font-semibold">Rate</th>
                <th className="w-28 py-2 text-right font-semibold">Amount</th>
              </tr>
            </thead>
            <tbody>
              {job.labour.map((entry, index) => (
                <tr key={entry.id} className="border-b border-steel-100">
                  <td className="py-2 pr-2">
                    {labourRateLabel(entry.rateType)}
                    {entry.description.length > 0 && (
                      <span className="text-steel-500"> — {entry.description}</span>
                    )}
                  </td>
                  <td className="tabular py-2 text-right">{entry.hours.toFixed(2)} hrs</td>
                  <td className="tabular py-2 text-right">
                    {formatCurrency(totals.labourLines[index]?.unitPrice ?? 0)}
                  </td>
                  <td className="tabular py-2 text-right font-medium">
                    {formatCurrency(totals.labourLines[index]?.total ?? 0)}
                  </td>
                </tr>
              ))}
              {job.calloutApplied && (
                <tr className="border-b border-steel-100">
                  <td className="py-2 pr-2">
                    Call-out<span className="text-steel-500"> — fixed call-out fee</span>
                  </td>
                  <td className="tabular py-2 text-right">1</td>
                  <td className="tabular py-2 text-right">
                    {formatCurrency(totals.pricing.calloutRate)}
                  </td>
                  <td className="tabular py-2 text-right font-medium">
                    {formatCurrency(totals.calloutTotal)}
                  </td>
                </tr>
              )}
              {job.travel.map((entry, index) => (
                <tr key={entry.id} className="border-b border-steel-100">
                  <td className="py-2 pr-2">
                    Travel
                    {entry.description.length > 0 && (
                      <span className="text-steel-500"> — {entry.description}</span>
                    )}
                  </td>
                  <td className="tabular py-2 text-right">{entry.kilometres.toFixed(1)} km</td>
                  <td className="tabular py-2 text-right">
                    {formatCurrency(totals.pricing.kilometreRate)}
                  </td>
                  <td className="tabular py-2 text-right font-medium">
                    {formatCurrency(totals.travelLines[index]?.total ?? 0)}
                  </td>
                </tr>
              ))}
              {job.parts.map((entry, index) => (
                <tr key={entry.id} className="border-b border-steel-100">
                  <td className="py-2 pr-2">
                    <span className="font-mono">{entry.partNumber}</span>
                    <span className="text-steel-500"> — {entry.description}</span>
                  </td>
                  <td className="tabular py-2 text-right">{entry.quantity}</td>
                  <td className="tabular py-2 text-right">{formatCurrency(entry.unitPrice)}</td>
                  <td className="tabular py-2 text-right font-medium">
                    {formatCurrency(totals.partLines[index]?.total ?? 0)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2} />
                <td className="py-1.5 text-right text-steel-600">Subtotal</td>
                <td className="tabular py-1.5 text-right font-medium">
                  {formatCurrency(totals.subtotal)}
                </td>
              </tr>
              <tr>
                <td colSpan={2} />
                <td className="py-1.5 text-right text-steel-600">
                  VAT @ {totals.pricing.vatPercentage}%
                </td>
                <td className="tabular py-1.5 text-right">{formatCurrency(totals.vat)}</td>
              </tr>
              <tr className="border-t-2 border-steel-900">
                <td colSpan={2} />
                <td className="py-2 text-right font-bold text-steel-900">Total</td>
                <td className="tabular py-2 text-right text-base font-bold text-steel-900">
                  {formatCurrency(totals.total)}
                </td>
              </tr>
            </tfoot>
          </table>
        </section>
      )}

      {checklistTemplate !== null && job.checklist !== null && (
        <section className="mt-6">
          <SectionTitle>
            {checklistTemplate.name} (version {job.checklist.templateVersion} — as completed)
          </SectionTitle>
          {(() => {
            const progress = evaluateChecklist(checklistTemplate, job.checklist);
            return (
              <p className="mb-2 text-xs text-steel-500">
                {progress.answered} of {progress.total} items answered
                {progress.failedItems > 0 && ` · ${progress.failedItems} failed`}
                {job.checklist?.completedAt !== null &&
                  ` · completed ${formatDateTime(job.checklist?.completedAt ?? null)}`}
              </p>
            );
          })()}

          {checklistTemplate.sections.map((section) => (
            <div key={section.id} className="mb-3">
              <p className="border-b border-steel-200 pb-1 text-xs font-bold tracking-wide text-steel-700 uppercase">
                {section.title}
              </p>
              <ul className="mt-1">
                {section.items.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-start justify-between gap-3 border-b border-steel-100 py-1.5 text-xs"
                  >
                    <span className="flex-1 text-steel-700">{item.text}</span>
                    <span className="shrink-0 font-semibold">
                      {renderAnswer(item, responses.get(item.id))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {job.photos.length > 0 && (
        <section className="mt-6">
          <SectionTitle>Photographs</SectionTitle>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {job.photos.map((photo) => (
              <li key={photo.id}>
                <div className="flex aspect-4/3 items-center justify-center rounded border border-steel-200 bg-steel-100 text-[10px] text-steel-400">
                  Photograph
                </div>
                <p className="mt-1 text-[11px] text-steel-600">{photo.caption}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-8 border-t-2 border-steel-900 pt-5">
        <SectionTitle>Customer acceptance</SectionTitle>
        {job.signature === null ? (
          <p className="text-steel-500 italic">Not yet signed.</p>
        ) : (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <div>
              <p className="mb-2 text-steel-700">{job.signature.declaration}</p>
              <dl className="space-y-0.5 text-steel-600">
                <Row
                  label="Name"
                  value={`${job.signature.customerName} ${job.signature.customerSurname}`}
                />
                <Row label="Signed" value={formatDateTime(job.signature.signedAt)} />
              </dl>
            </div>
            <div>
              <SignatureDisplay pathData={job.signature.strokeData} />
              <p className="mt-1 border-t border-steel-300 pt-1 text-[11px] text-steel-500">
                Customer signature
              </p>
            </div>
          </div>
        )}
      </section>

      <footer className="mt-8 border-t border-steel-200 pt-3 text-[11px] text-steel-400">
        {settings.companyName} · {job.jobNumber} · Generated{' '}
        {formatDateTime(new Date().toISOString())} · Demonstration document, fictional data
        {job.pricingSnapshot !== null && (
          <>
            <br />
            Priced at the rates in force on{' '}
            {formatDateTime(job.pricingSnapshot.capturedAt)}, when the customer signed.
          </>
        )}
      </footer>
    </article>
  );
};

const SectionTitle = ({ children }: { readonly children: React.ReactNode }) => (
  <h3 className="mb-2 text-xs font-bold tracking-[0.12em] text-steel-500 uppercase">{children}</h3>
);

const Row = ({
  label,
  value,
  mono = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}) => (
  <div className="flex gap-2">
    <dt className="w-28 shrink-0 text-steel-500">{label}</dt>
    <dd className={mono ? 'font-mono text-steel-800' : 'text-steel-800'}>{value}</dd>
  </div>
);

const Block = ({ label, value }: { readonly label: string; readonly value: string }) => (
  <div>
    <p className="text-xs font-bold tracking-wide text-steel-600 uppercase">{label}</p>
    <p className="mt-1 whitespace-pre-line text-steel-700">
      {value.trim().length > 0 ? value : <span className="text-steel-400 italic">Not recorded</span>}
    </p>
  </div>
);

const renderAnswer = (item: ChecklistItem, response: ChecklistResponse | undefined): string => {
  if (response === undefined) return '—';
  switch (item.responseType) {
    case 'pass_fail_na':
      return response.choice === null ? '—' : response.choice.toUpperCase();
    case 'yes_no':
      return response.yesNo === null ? '—' : response.yesNo ? 'YES' : 'NO';
    case 'measurement':
      return response.measurement === null
        ? '—'
        : `${response.measurement}${item.unit === null ? '' : ` ${item.unit}`}`;
    case 'text':
      return response.text.length > 0 ? response.text : '—';
  }
};
