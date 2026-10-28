import type { DeliveryNoteModel } from '@/lib/job-card/delivery-note';
import { SignatureDisplay } from './SignaturePad';

/**
 * THE DELIVERY NOTE, DRAWN BY THE BROWSER. PARTS-04.
 *
 * The same `DeliveryNoteModel` the PDF is drawn from — no price exists in it to
 * show. Used where the browser cannot display a PDF (the tablets), and printed
 * from there.
 */
export const DeliveryNoteDocument = ({ model }: { readonly model: DeliveryNoteModel }) => (
  <article className="eje-document mx-auto max-w-[210mm] bg-white p-6 text-[12px] text-steel-900 shadow-sm" data-testid="delivery-note-document">
    <header className="flex items-start justify-between gap-4">
      <div>
        <p className="text-base font-bold">{model.company.name}</p>
        <p className="text-[11px] text-steel-500">{model.company.address}</p>
        <p className="text-[11px] text-steel-500">{model.company.contactLine}</p>
      </div>
      <div className="text-right">
        <p className="text-xl font-bold tracking-[0.15em]">DELIVERY NOTE</p>
        <p className="text-base font-bold">{model.jobNumber}</p>
      </div>
    </header>
    <section className="mt-5">
      <p className="text-[10px] font-bold tracking-wide text-steel-500 uppercase">Deliver to</p>
      {model.deliverTo.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </section>
    <dl className="mt-4 grid grid-cols-[13rem_1fr] gap-y-1">
      {model.details.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-steel-500">{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
    <table className="mt-4 w-full border-collapse">
      <thead>
        <tr className="bg-steel-50 text-left">
          <th className="px-1.5 py-1">Item</th>
          <th className="px-1.5 py-1">Part number</th>
          <th className="px-1.5 py-1">Description</th>
          <th className="px-1.5 py-1 text-right">Quantity</th>
        </tr>
      </thead>
      <tbody>
        {model.items.map((item, index) => (
          <tr key={`${item.partNumber}-${index}`} className="border-t border-steel-100" data-testid="delivery-note-item">
            <td className="px-1.5 py-1 text-steel-500">{item.kind}</td>
            <td className="px-1.5 py-1 font-mono">{item.partNumber}</td>
            <td className="px-1.5 py-1">{item.description}</td>
            <td className="px-1.5 py-1 text-right tabular-nums">{item.quantity}</td>
          </tr>
        ))}
        <tr className="border-t-2 border-steel-300 font-bold">
          <td colSpan={3} className="px-1.5 py-1 text-right">Total items</td>
          <td className="px-1.5 py-1 text-right tabular-nums">{model.totalQuantity}</td>
        </tr>
      </tbody>
    </table>
    <p className="mt-3 text-[11px] text-steel-500">{model.priceNote}</p>
    {model.signature !== null ? (
      <section className="mt-6" data-testid="delivery-note-signature">
        <p className="text-[10px] font-bold tracking-wide text-steel-500 uppercase">Courier acceptance</p>
        <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <p>{model.signature.declaration}</p>
            <p><span className="text-steel-500">Name </span>{model.signature.name}</p>
            <p><span className="text-steel-500">Signed </span>{model.signature.signedAt}</p>
            <p><span className="text-steel-500">Signature reference </span>{model.signature.reference}</p>
          </div>
          <div>
            <SignatureDisplay pathData={model.signature.signatureData} />
            <p className="mt-1 text-[10px] text-steel-500">Courier signature — the same signature is on the priced job card</p>
          </div>
        </div>
      </section>
    ) : (
      <div className="mt-10 grid grid-cols-2 gap-8 text-[11px] text-steel-500">
        <p className="border-t border-steel-300 pt-1">Collected by (courier) — name, signature, date</p>
        <p className="border-t border-steel-300 pt-1">Released by (EJE) — name, signature, date</p>
      </div>
    )}
  </article>
);
