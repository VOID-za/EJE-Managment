# OCR for the technical library: what it would take, and what it would cost

LIB-5 asks for full-text search of the library. **Text-based PDFs are searchable
today** — a first-party extractor reads the content streams, the text goes into
`library_document_text`, and the search is a PostgreSQL `tsvector` with a GIN
index. What is not implemented is **OCR**: a scanned manual is recorded as
`needs_ocr` with the reason, and the library says so against the row rather
than pretending the document is searchable.

The October mandate §3 asks for an investigation of a **local** implementation
and its operational cost **before** choosing a service, and forbids incurring a
paid service or a new ongoing cost without authorisation. This is that
investigation. **Nothing in it has been implemented**, and no dependency has
been added.

---

## 1. What is actually unsearchable

A document becomes `needs_ocr` when the extractor finds no usable text. Two
causes, and they need different things:

| Cause | What OCR would do |
|---|---|
| A **scan** — the page is an image | The whole job. Rasterise, recognise, index the result. |
| Fonts with **no usable encoding** — real text, no character map | OCR works, and so would a better font-encoding reader. The extractor reports this separately for exactly that reason. |

On the demonstration dataset this is zero documents, because every seeded
library record is metadata with no file (see `docs/demonstration-data.md`). The
real number is unknown until EJE upload their manuals, and that matters for the
decision below: **the cost of OCR scales with how many scanned documents EJE
actually hold**, and nobody has counted them yet.

## 2. The three options, with their real costs

### (a) Tesseract on the VPS — recommended if the volume is small

```
apt-get install tesseract-ocr tesseract-ocr-eng poppler-utils
```

`poppler-utils` is **already installed** on this machine (`pdftoppm`,
`pdftotext`); `tesseract-ocr` is not. The pipeline is `pdftoppm -r 300 -gray`
per page, then `tesseract page.png - --psm 1`.

| | |
|---|---|
| Licence / fee | Apache-2.0, none |
| Disk | ~35 MB for the binary and the English model |
| Time | **5–15 seconds per page** on a 300 dpi A4 scan on a shared VPS core |
| A 200-page scanned manual | **15–45 minutes of CPU**, which must not run in a request |
| Accuracy | Good on clean scans; poor on faint photocopies and on the schematics that make up much of a machine manual |

**What it needs that does not exist yet:** a job that runs outside the request.
The upload route currently extracts text inline, which is fine at
milliseconds-per-document and unacceptable at minutes. That is the real work in
this option — a queue, a worker, a state the row can sit in while it waits, and
a way for the office to see that it is waiting. The outbox (`ARCH-2`) is the
pattern this repository already uses for durable background work.

### (b) `tesseract.js` in-process — not recommended

WebAssembly, no system package, same engine. It is slower than the binary
(roughly 2–3×), holds the model in the Node heap (~20 MB per worker), and still
needs the background job from (a). It buys only the `apt-get`, and the VPS is
ours to install on.

### (c) A hosted OCR service — needs EJE's authorisation, and is not free

Azure Document Intelligence, Google Document AI and AWS Textract all read a
scanned manual well — materially better than Tesseract on schematics and faint
photocopies — at roughly **US$1.00–1.50 per 1 000 pages** (read-only tiers,
October 2026 list prices; they change, and that is itself a reason to check
rather than quote). A 200-page manual is therefore a few cents, and a library
of 500 such manuals is a one-off of about **US$100–150** plus whatever arrives
later.

Three things it brings that are not line items:

- **Customer documents leave the building.** A machine manual is a
  manufacturer's document, but EJE's own procedures and certificates are not,
  and some carry customer names. That is a decision about data, not about
  OCR.
- An **account, a credential and a bill** — a new ongoing cost, which the
  mandate says may not be incurred without authorisation.
- A **second availability dependency** for a feature that otherwise degrades
  gracefully.

## 3. Recommendation

1. **Decide nothing until the volume is known.** When EJE's manuals are
   uploaded, `npm run documents:reconcile` and the library's own badges say how
   many documents are `needs_ocr`. If it is a handful, somebody can re-upload
   text-based copies from the manufacturer and OCR is unnecessary.
2. **If the number is tens**, build option (a): Tesseract on the VPS behind a
   durable background job. No licence, no bill, no data leaving the machine,
   and the engineering is the queue rather than the recognition.
3. **If the number is hundreds, or the scans are poor**, ask EJE to authorise
   option (c) for a one-off bulk pass and keep (a) for anything that arrives
   later. The upload path should then be able to use either, which is one
   adapter behind one port — the shape this repository already uses for email,
   WhatsApp and storage.

**What must not happen in any of the three:** a document being recorded as
`indexed` when nothing readable came out. The state means "this text is
searchable", and an OCR pass that produces forty characters of noise from a
wiring diagram has to leave the row saying `needs_ocr` with the reason. The
existing extractor already checks for a plausible proportion of readable
characters before it calls text usable, and an OCR path would use the same test.

## 4. What is true today, so nothing here is overstated

*Rewritten 21 October 2026: the architecture recommended in §3.2 is now built.
The DECISION in §3 is unchanged and is still EJE's — what follows is what the
repository does, not what EJE have agreed to run.*

- Text-based PDFs **are** searchable, and the search is tested on real
  PostgreSQL including that the GIN index serves the query.
- A scanned document is **reported, not hidden**: a badge on the row, a count
  in the search answer, the reason against it for the office, and a retry.
- **The queue and the worker exist.** An upload that finds no text layer records
  the document on `library_ocr_queue`, and `npm run library:ocr` does the work
  afterwards — because recognising a 214-page manual is twenty minutes to an
  hour and cannot happen inside an upload request.
- **No engine is installed, and the application says exactly that.** `EJE_OCR`
  is unset on every deployment, so every job settles as `unavailable` with
  *"Install `tesseract-ocr` and `poppler-utils` and set EJE_OCR=local"* — the
  package names, because "OCR failed" sends somebody to look at the document.
- **Nothing is sent anywhere.** Option (c) is NOT implemented, deliberately: a
  half-built client for a hosted service is a thing somebody switches on, and
  the mandate forbids EJE's drawings leaving the premises without authorisation.
- **Recognised text is labelled as recognised.** `library_document_text.source`
  is `text_layer` or `ocr`, and the library says *"Searchable (recognised
  text)"* for the second with a note that it can contain mistakes. Text out of a
  scan is a machine's reading of a wiring diagram, not the diagram.
- **Nothing is reported searchable unless text was indexed.** There are five
  ways an attempt ends and only one touches the index; the other four leave the
  document saying it is not searchable. Each has a test.

### To turn it on, on a server EJE control

```bash
sudo apt-get install -y tesseract-ocr poppler-utils
# then, in /etc/eje/eje.env:
EJE_OCR=local
# optionally: EJE_OCR_LANGUAGE=eng   EJE_OCR_MAX_PAGES=40

sudo -u eje npm run library:ocr -- --report    # what is waiting
sudo -u eje npm run library:ocr -- --max 5     # read five
```

Jobs that settled as `unavailable` before an engine existed are NOT retried
automatically — nothing about them changed, and the next attempt would say the
same thing. Ask for them again from the library screen once the engine is in
place.

**A cron entry is deliberately not shipped.** How often a library needs reading
depends on how often EJE upload scans, and a timer nobody asked for is a timer
nobody expects. `docs/vps-backups.md` shows the systemd pattern if EJE want one.
