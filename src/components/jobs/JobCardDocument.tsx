import type { JobView } from "@/application/job-view";
import {
  buildJobCardModel,
  type ChargeRow,
  type LabelValue,
} from "@/lib/job-card/model";
import { SignatureDisplay } from "./SignaturePad";

/**
 * The EJE job card document, on screen.
 *
 * Content, order and labels come from `buildJobCardModel` — the single
 * definition this and the PDF renderer share, so the file a customer keeps and
 * the document they were shown cannot say different things. This file decides
 * only how to draw that model in HTML.
 */
export const JobCardDocument = ({ view }: { readonly view: JobView }) => {
  const model = buildJobCardModel({
    job: view.job,
    customer: view.customer,
    site: view.site,
    contact: view.contact,
    machine: view.machine,
    settings: view.settings,
    checklistTemplate: view.checklistTemplate,
    users: view.users,
    // A closed job's document was produced when it was issued; anything else is
    // a live preview, generated now.
    generatedAt:
      view.job.finalDocument?.generatedAt ?? new Date().toISOString(),
  });

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
          <p className="font-mono text-2xl font-bold text-steel-900">
            {model.jobNumber}
          </p>
          <p className="mt-1 text-xs text-steel-500">{model.jobMeta}</p>
          <p className="text-xs text-steel-500">{model.statusLine}</p>
        </div>
      </header>

      <section className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
        <div>
          <SectionTitle>Customer</SectionTitle>
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
              <span className="font-medium text-steel-800">
                {model.customer.contact.name}
              </span>
              <br />
              {model.customer.contact.position}
              <br />
              {model.customer.contact.contactLine}
            </p>
          )}
        </div>

        <div>
          {model.machine !== null && (
            <>
              <SectionTitle>Machine</SectionTitle>
              <p className="font-semibold text-steel-900">
                {model.machine.title}
              </p>
              <dl className="mt-1 space-y-0.5 text-steel-600">
                {model.machine.rows.map((row) => (
                  <Row key={row.label} {...row} />
                ))}
              </dl>
            </>
          )}

          <div className="mt-4">
            <SectionTitle>Job details</SectionTitle>
            <dl className="space-y-0.5 text-steel-600">
              {model.jobDetails.map((row) => (
                <Row key={row.label} {...row} />
              ))}
            </dl>
          </div>
        </div>
      </section>

      <section className="mt-6">
        <SectionTitle>Reported fault</SectionTitle>
        <p className="rounded border border-steel-200 bg-steel-50 p-3 text-steel-700">
          {model.faultDescription}
        </p>
      </section>

      {model.workBlocks.length > 0 && (
        <section className="mt-6 space-y-4">
          <SectionTitle>Work carried out</SectionTitle>
          {model.workBlocks.map((block) => (
            <div key={block.label}>
              <p className="text-xs font-bold tracking-wide text-steel-600 uppercase">
                {block.label}
              </p>
              <p className="mt-1 whitespace-pre-line text-steel-700">
                {block.value === "Not recorded" ? (
                  <span className="text-steel-400 italic">{block.value}</span>
                ) : (
                  block.value
                )}
              </p>
            </div>
          ))}
        </section>
      )}

      {model.notes.length > 0 && (
        <section className="mt-6">
          <SectionTitle>Job notes</SectionTitle>
          <ul className="space-y-2">
            {model.notes.map((note) => (
              <li
                key={note.byline}
                className="border-b border-steel-100 pb-2 last:border-b-0"
              >
                <p className="whitespace-pre-line text-steel-700">
                  {note.body}
                </p>
                <p className="mt-0.5 text-[11px] text-steel-500">
                  {note.byline}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {model.charges !== null && (
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
              {model.charges.rows.map((row, index) => (
                <ChargeLine key={`${row.description}-${index}`} row={row} />
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2} />
                <td className="py-1.5 text-right text-steel-600">Subtotal</td>
                <td className="tabular py-1.5 text-right font-medium">
                  {model.charges.subtotal}
                </td>
              </tr>
              <tr>
                <td colSpan={2} />
                <td className="py-1.5 text-right text-steel-600">
                  {model.charges.vatLabel}
                </td>
                <td className="tabular py-1.5 text-right">
                  {model.charges.vat}
                </td>
              </tr>
              <tr className="border-t-2 border-steel-900">
                <td colSpan={2} />
                <td className="py-2 text-right font-bold text-steel-900">
                  Total
                </td>
                <td className="tabular py-2 text-right text-base font-bold text-steel-900">
                  {model.charges.total}
                </td>
              </tr>
            </tfoot>
          </table>
        </section>
      )}

      {model.checklist !== null && (
        <section className="mt-6">
          <SectionTitle>{model.checklist.title}</SectionTitle>
          <p className="mb-2 text-xs text-steel-500">
            {model.checklist.summary}
          </p>

          {model.checklist.sections.map((section) => (
            <div key={section.title} className="mb-3">
              <p className="border-b border-steel-200 pb-1 text-xs font-bold tracking-wide text-steel-700 uppercase">
                {section.title}
              </p>
              <ul className="mt-1">
                {section.items.map((item) => (
                  <li
                    key={item.text}
                    className="border-b border-steel-100 py-1.5 text-xs"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="flex-1 text-steel-700">{item.text}</span>
                      <span className="shrink-0 font-semibold">
                        {item.answer}
                      </span>
                    </div>
                    {item.note.length > 0 && (
                      <p className="mt-0.5 text-[11px] text-steel-500">
                        Note: {item.note}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {model.photos.length > 0 && (
        <section className="mt-6">
          <SectionTitle>Photographs</SectionTitle>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {model.photos.map((photo) => (
              <li key={photo.caption}>
                <div className="flex aspect-4/3 items-center justify-center rounded border border-steel-200 bg-steel-100 text-[10px] text-steel-400">
                  Photograph
                </div>
                <p className="mt-1 text-[11px] text-steel-600">
                  {photo.caption}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-8 border-t-2 border-steel-900 pt-5">
        <SectionTitle>Customer acceptance</SectionTitle>
        {/* A refusal replaces the acceptance outright. No signature box is
            drawn, because there is no signature and an empty box beside a
            declaration reads as an omission rather than as the answer the
            customer gave. */}
        {model.refusal !== null ? (
          <div>
            <p className="text-sm font-bold tracking-wide text-steel-900 uppercase">
              {model.refusal.heading}
            </p>
            <p className="mt-2 text-[11px] font-bold tracking-[0.12em] text-steel-500 uppercase">
              Reason
            </p>
            <p className="mt-0.5 whitespace-pre-wrap text-steel-800">{model.refusal.reason}</p>
            <dl className="mt-2 space-y-0.5 text-steel-600">
              {model.refusal.rows.map((row) => (
                <Row key={row.label} {...row} />
              ))}
            </dl>
          </div>
        ) : model.acceptance === null ? (
          <p className="text-steel-500 italic">Not yet signed.</p>
        ) : (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <div>
              <p className="mb-2 text-steel-700">
                {model.acceptance.declaration}
              </p>
              <dl className="space-y-0.5 text-steel-600">
                {model.acceptance.rows.map((row) => (
                  <Row key={row.label} {...row} />
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
          <span key={line} className="block">
            {line}
          </span>
        ))}
      </footer>
    </article>
  );
};

const SectionTitle = ({ children }: { readonly children: React.ReactNode }) => (
  <h3 className="mb-2 text-xs font-bold tracking-[0.12em] text-steel-500 uppercase">
    {children}
  </h3>
);

const Row = ({ label, value, mono = false }: LabelValue) => (
  <div className="flex gap-2">
    <dt className="w-28 shrink-0 text-steel-500">{label}</dt>
    <dd className={mono ? "font-mono text-steel-800" : "text-steel-800"}>
      {value}
    </dd>
  </div>
);

const ChargeLine = ({ row }: { readonly row: ChargeRow }) => (
  <tr className="border-b border-steel-100">
    <td className="py-2 pr-2">
      <span className={row.mono === true ? "font-mono" : undefined}>
        {row.description}
      </span>
      {row.detail.length > 0 && (
        <span className="text-steel-500"> — {row.detail}</span>
      )}
    </td>
    <td className="tabular py-2 text-right">{row.quantity}</td>
    <td className="tabular py-2 text-right">{row.rate}</td>
    <td className="tabular py-2 text-right font-medium">{row.amount}</td>
  </tr>
);
