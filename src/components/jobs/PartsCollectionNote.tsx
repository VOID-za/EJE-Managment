import {
  buildPartsDocument,
  contactFullName,
  customerFacingNotes,
  userFullName,
} from '@/domain';
import type { JobView } from '@/application/job-view';
import { formatCurrency, formatDate, formatDateTime } from '@/lib/format';
import { SignatureDisplay } from './SignaturePad';

/**
 * The EJE parts collection / delivery note.
 *
 * A separate document from the job card because it records a different event:
 * goods handed over, acknowledged by whoever collected them. There is no labour,
 * no travel and no completion write-up.
 *
 * Prices come from `buildPartsDocument`, which withholds them for a courier
 * collection. Suppression happens there rather than here, so a price cannot leak
 * onto a courier's copy by this component forgetting to check a flag.
 */
export const PartsCollectionNote = ({ view }: { readonly view: JobView }) => {
  const { job, customer, site, contact, settings } = view;
  const document = buildPartsDocument(job);
  const notes = customerFacingNotes(job.notes);

  return (
    <article
      // Pinned to the light palette: this represents the printed document.
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
            {job.courierCollection ? 'Delivery Note' : 'Parts Collection Note'}
          </p>
          <p className="font-mono text-2xl font-bold text-steel-900">{job.jobNumber}</p>
          <p className="mt-1 text-xs text-steel-500">
            {job.courierCollection ? 'Courier collection' : 'Customer collection'}
          </p>
        </div>
      </header>

      <section className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
        <div>
          <h3 className="mb-2 text-xs font-bold tracking-[0.12em] text-steel-500 uppercase">
            Customer
          </h3>
          <p className="font-semibold text-steel-900">{customer.name}</p>
          <p className="text-steel-600">
            {site.name}
            <br />
            {site.addressLine1}
            <br />
            {site.city}, {site.province} {site.postalCode}
          </p>
          {contact !== null && (
            <p className="mt-2 text-steel-600">
              <span className="font-medium text-steel-800">{contactFullName(contact)}</span>
              <br />
              {contact.phone}
            </p>
          )}
        </div>

        <div>
          <h3 className="mb-2 text-xs font-bold tracking-[0.12em] text-steel-500 uppercase">
            Collection details
          </h3>
          <dl className="space-y-0.5 text-steel-600">
            <div className="flex gap-2">
              <dt className="w-28 shrink-0 text-steel-500">Order number</dt>
              <dd className="text-steel-800">
                {job.orderNumber.length > 0 ? job.orderNumber : '—'}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-28 shrink-0 text-steel-500">Reference</dt>
              <dd className="text-steel-800">
                {job.referenceNumber.length > 0 ? job.referenceNumber : '—'}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-28 shrink-0 text-steel-500">Date</dt>
              <dd className="text-steel-800">{formatDate(job.scheduledDate ?? job.createdAt)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-28 shrink-0 text-steel-500">Issued by</dt>
              <dd className="text-steel-800">
                {view.primaryTechnician === null
                  ? settings.companyName
                  : userFullName(view.primaryTechnician)}
              </dd>
            </div>
          </dl>
        </div>
      </section>

      {job.faultDescription.length > 0 && (
        <section className="mt-6">
          <h3 className="mb-2 text-xs font-bold tracking-[0.12em] text-steel-500 uppercase">
            Notes
          </h3>
          <p className="rounded border border-steel-200 bg-steel-50 p-3 text-steel-700">
            {job.faultDescription}
          </p>
        </section>
      )}

      <section className="mt-6">
        <h3 className="mb-2 text-xs font-bold tracking-[0.12em] text-steel-500 uppercase">
          Parts supplied
        </h3>

        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-y border-steel-300 bg-steel-50 text-left">
              <th className="w-32 py-2 pr-2 font-semibold">Part number</th>
              <th className="py-2 pr-2 font-semibold">Description</th>
              <th className="w-20 py-2 text-right font-semibold">Quantity</th>
              {document.showsPrices && (
                <>
                  <th className="w-24 py-2 text-right font-semibold">Unit price</th>
                  <th className="w-28 py-2 text-right font-semibold">Total</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {document.lines.map((line, index) => (
              <tr key={`${line.partNumber}-${index}`} className="border-b border-steel-100">
                <td className="py-2 pr-2 font-mono">{line.partNumber}</td>
                <td className="py-2 pr-2">{line.description}</td>
                <td className="tabular py-2 text-right">{line.quantity}</td>
                {document.showsPrices && (
                  <>
                    <td className="tabular py-2 text-right">
                      {formatCurrency(line.unitPrice ?? 0)}
                    </td>
                    <td className="tabular py-2 text-right font-medium">
                      {formatCurrency(line.lineTotal ?? 0)}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-steel-900">
              <td colSpan={2} className="py-2 font-bold text-steel-900">
                Total
              </td>
              <td className="tabular py-2 text-right font-bold text-steel-900">
                {document.totalQuantity}
              </td>
              {document.showsPrices && (
                <>
                  <td />
                  <td className="tabular py-2 text-right text-base font-bold text-steel-900">
                    {formatCurrency(document.subtotal ?? 0)}
                  </td>
                </>
              )}
            </tr>
          </tfoot>
        </table>

        {!document.showsPrices && (
          <p className="mt-2 text-[11px] text-steel-500 italic">
            Prices are not shown on a courier collection note.
          </p>
        )}
      </section>

      {notes.length > 0 && (
        <section className="mt-6">
          <h3 className="mb-2 text-xs font-bold tracking-[0.12em] text-steel-500 uppercase">
            Additional notes
          </h3>
          <ul className="space-y-1">
            {notes.map((note) => (
              <li key={note.id} className="text-steel-700">
                {note.body}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-8 border-t-2 border-steel-900 pt-5">
        <h3 className="mb-2 text-xs font-bold tracking-[0.12em] text-steel-500 uppercase">
          Collected by
        </h3>

        {job.signature === null ? (
          <p className="text-steel-500 italic">Not yet collected.</p>
        ) : (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <div>
              <p className="mb-2 text-steel-700">{job.signature.declaration}</p>
              <dl className="space-y-0.5 text-steel-600">
                <div className="flex gap-2">
                  <dt className="w-28 shrink-0 text-steel-500">Collector</dt>
                  <dd className="font-medium text-steel-900">
                    {job.signature.customerName} {job.signature.customerSurname}
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-28 shrink-0 text-steel-500">Collected</dt>
                  <dd className="text-steel-800">{formatDateTime(job.signature.signedAt)}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-28 shrink-0 text-steel-500">On behalf of</dt>
                  <dd className="text-steel-800">
                    {job.courierCollection ? 'Courier' : customer.name}
                  </dd>
                </div>
              </dl>
            </div>
            <div>
              <SignatureDisplay pathData={job.signature.strokeData} />
              <p className="mt-1 border-t border-steel-300 pt-1 text-[11px] text-steel-500">
                Collector signature
              </p>
            </div>
          </div>
        )}
      </section>

      <footer className="mt-8 border-t border-steel-200 pt-3 text-[11px] text-steel-400">
        {settings.companyName} · {job.jobNumber} · Generated{' '}
        {formatDateTime(new Date().toISOString())} · Demonstration document, fictional data
      </footer>
    </article>
  );
};
