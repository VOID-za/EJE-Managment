import { buildJobCardModel } from '@/lib/job-card/model';
import type { JobView } from '@/application/job-view';
import { SignatureDisplay } from './SignaturePad';

/**
 * The EJE parts collection / delivery note.
 *
 * A different LAYOUT from the job card, because it records a different event:
 * goods handed over, acknowledged by whoever collected them. It is not
 * different CONTENT, and it used to be — this component read the job record
 * directly and built its own header, its own details block and its own parts
 * table, while the issued PDF was built from `buildJobCardModel`. The two
 * drifted exactly as two renderers of one document always do: the screen
 * omitted the waybill and the customer's delivery note, and the courier's PDF
 * omitted the goods.
 *
 * So it consumes the same model the PDF does. Every value below — the title,
 * the collection details, whether prices appear, the goods, the declaration the
 * collector signed — is decided in `buildJobCardModel` and merely drawn here.
 * Nothing about the document is decided in this file.
 */
export const PartsCollectionNote = ({ view }: { readonly view: JobView }) => {
  const model = buildJobCardModel({
    job: view.job,
    customer: view.customer,
    site: view.site,
    contact: view.contact,
    machine: view.machine,
    settings: view.settings,
    checklistTemplate: view.checklistTemplate,
    users: view.users,
    /*
     * A closed job's document was produced when it was issued.
     *
     * Falling back to "now" only for a job still in the workflow, where this is
     * a live preview of a document that has not been issued yet.
     */
    generatedAt: view.job.finalDocument?.generatedAt ?? new Date().toISOString(),
  });

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
                {model.company.name}
              </p>
              <p className="text-xs text-steel-500">{model.company.address}</p>
            </div>
          </div>
          <p className="mt-3 text-xs text-steel-500">
            {model.company.contactLine}
            <br />
            {model.company.registrationLine}
          </p>
        </div>

        <div className="text-right">
          <p className="text-xs font-semibold tracking-[0.18em] text-steel-500 uppercase">
            {model.documentTitle}
          </p>
          <p className="font-mono text-2xl font-bold text-steel-900">{model.jobNumber}</p>
        </div>
      </header>

      <section className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
        <div>
          <h3 className="mb-2 text-xs font-bold tracking-[0.12em] text-steel-500 uppercase">
            Customer
          </h3>
          <p className="font-semibold text-steel-900">{model.customer.name}</p>
          <p className="text-steel-600">
            {model.customer.addressLines.map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
          </p>
          {model.customer.contact !== null && (
            <p className="mt-2 text-steel-600">
              <span className="font-medium text-steel-800">{model.customer.contact.name}</span>
              <br />
              {model.customer.contact.contactLine}
            </p>
          )}
        </div>

        <div>
          <h3 className="mb-2 text-xs font-bold tracking-[0.12em] text-steel-500 uppercase">
            Collection details
          </h3>
          {/* The SAME rows the PDF prints, in the same order — including the
              collection method, the waybill and the customer's delivery note,
              all three of which this screen used to leave off. */}
          <dl className="space-y-0.5 text-steel-600">
            {model.jobDetails.map((row) => (
              <div key={row.label} className="flex gap-2">
                <dt className="w-28 shrink-0 text-steel-500">{row.label}</dt>
                <dd className={row.mono === true ? 'font-mono text-steel-800' : 'text-steel-800'}>
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* Only if something was written. A collection raised under CR-13 has
          no notes at all; one raised before it keeps what it was given. */}
      {model.faultDescription !== null && (
        <section className="mt-6">
          <h3 className="mb-2 text-xs font-bold tracking-[0.12em] text-steel-500 uppercase">
            Notes
          </h3>
          <p className="rounded border border-steel-200 bg-steel-50 p-3 text-steel-700">
            {model.faultDescription}
          </p>
        </section>
      )}

      {/*
        The goods.

        Two shapes, one decision, and the decision is the model's: a customer
        collection carries the priced charge rows, a courier collection carries
        the `collection` block, which has no money on it at all. A price cannot
        reach a courier's copy through this component, because when prices are
        withheld there is no price in the data it is given.
      */}
      {model.charges !== null ? (
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
                <th className="w-24 py-2 text-right font-semibold">Unit price</th>
                <th className="w-28 py-2 text-right font-semibold">Total</th>
              </tr>
            </thead>
            <tbody>
              {model.charges.rows.map((row, index) => (
                <tr key={`${row.description}-${index}`} className="border-b border-steel-100">
                  <td className="py-2 pr-2 font-mono">{row.description}</td>
                  <td className="py-2 pr-2">{row.detail}</td>
                  <td className="tabular py-2 text-right">{row.quantity}</td>
                  <td className="tabular py-2 text-right">{row.rate}</td>
                  <td className="tabular py-2 text-right font-medium">{row.amount}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-steel-900">
                <td colSpan={3} className="py-2 font-bold text-steel-900">
                  Subtotal
                </td>
                <td />
                <td className="tabular py-2 text-right font-bold text-steel-900">
                  {model.charges.subtotal}
                </td>
              </tr>
              <tr>
                <td colSpan={3} className="py-1 text-steel-600">
                  {model.charges.vatLabel}
                </td>
                <td />
                <td className="tabular py-1 text-right text-steel-700">{model.charges.vat}</td>
              </tr>
              <tr className="border-t border-steel-300">
                <td colSpan={3} className="py-2 font-bold text-steel-900">
                  Total
                </td>
                <td />
                <td className="tabular py-2 text-right text-base font-bold text-steel-900">
                  {model.charges.total}
                </td>
              </tr>
            </tfoot>
          </table>
        </section>
      ) : model.collection !== null ? (
        <section className="mt-6">
          <h3 className="mb-2 text-xs font-bold tracking-[0.12em] text-steel-500 uppercase">
            {model.collection.heading}
          </h3>
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-y border-steel-300 bg-steel-50 text-left">
                <th className="w-32 py-2 pr-2 font-semibold">Part number</th>
                <th className="py-2 pr-2 font-semibold">Description</th>
                <th className="w-24 py-2 text-right font-semibold">Quantity</th>
              </tr>
            </thead>
            <tbody>
              {model.collection.lines.map((line, index) => (
                <tr key={`${line.partNumber}-${index}`} className="border-b border-steel-100">
                  <td className="py-2 pr-2 font-mono">{line.partNumber}</td>
                  <td className="py-2 pr-2">{line.description}</td>
                  <td className="tabular py-2 text-right">{line.quantity}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-steel-900">
                <td colSpan={2} className="py-2 font-bold text-steel-900">
                  {model.collection.totalLabel}
                </td>
                <td className="tabular py-2 text-right font-bold text-steel-900">
                  {model.collection.totalQuantity}
                </td>
              </tr>
            </tfoot>
          </table>
          <p className="mt-2 text-[11px] text-steel-500 italic">{model.collection.priceNote}</p>
        </section>
      ) : null}

      {model.notes.length > 0 && (
        <section className="mt-6">
          <h3 className="mb-2 text-xs font-bold tracking-[0.12em] text-steel-500 uppercase">
            Additional notes
          </h3>
          <ul className="space-y-1">
            {model.notes.map((note) => (
              <li key={note.byline} className="text-steel-700">
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

        {model.acceptance === null ? (
          /* A refused collection says so, exactly as the PDF does, and carries
             no signature box of any kind. */
          model.refusal === null ? (
            <p className="text-steel-500 italic">Not yet collected.</p>
          ) : (
            <div>
              <p className="font-semibold text-steel-900">{model.refusal.heading}</p>
              <p className="mt-1 text-steel-700">{model.refusal.reason}</p>
              <dl className="mt-2 space-y-0.5 text-steel-600">
                {model.refusal.rows.map((row) => (
                  <div key={row.label} className="flex gap-2">
                    <dt className="w-28 shrink-0 text-steel-500">{row.label}</dt>
                    <dd className="text-steel-800">{row.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )
        ) : (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <div>
              <p className="mb-2 text-steel-700">{model.acceptance.declaration}</p>
              <dl className="space-y-0.5 text-steel-600">
                {model.acceptance.rows.map((row) => (
                  <div key={row.label} className="flex gap-2">
                    <dt className="w-28 shrink-0 text-steel-500">{row.label}</dt>
                    <dd className="font-medium text-steel-900">{row.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <div>
              <SignatureDisplay pathData={model.acceptance.signatureData} />
              <p className="mt-1 border-t border-steel-300 pt-1 text-[11px] text-steel-500">
                {model.acceptance.caption}
              </p>
            </div>
          </div>
        )}
      </section>

      <footer className="mt-8 border-t border-steel-200 pt-3 text-[11px] text-steel-400">
        {model.footerLines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </footer>
    </article>
  );
};
