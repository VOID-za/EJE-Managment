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
sudo apt-get install -y tesseract-ocr tesseract-ocr-eng poppler-utils
# then, in /etc/eje/eje.env:
EJE_OCR=local

sudo -u eje npm run library:ocr -- --report    # the engine, the limits, what is waiting
sudo -u eje npm run library:ocr -- --max 5     # read five
```

`tesseract-ocr-eng` is listed separately on purpose: the `tesseract-ocr`
package on Debian does not always pull the English trained data, and without it
EVERY page fails. The application reports that case as *"the eng language data
is not installed"* rather than as an unreadable scan — a distinction worth
having, because the second blames the customer's document for an `apt-get`
nobody ran.

### Every dependency and every limit, and what each one is for

All optional. `npm run library:ocr -- --report` prints what this deployment
will actually apply, and says which variables are set — so a 214-page manual
coming back as forty pages has an answer that does not require reading the
source.

| Variable | Default | What it is for |
|---|---|---|
| `EJE_OCR_TESSERACT` | `tesseract` | Full path, where the binary is not on `PATH` — a container, NixOS, or a newer build in `/opt`. Without this, a tesseract that IS installed somewhere else reported as "not installed", which sends somebody to `apt-get` for a binary they have. |
| `EJE_OCR_PDFTOPPM` | `pdftoppm` | The same, for poppler-utils. |
| `EJE_OCR_LANGUAGE` | `eng` | Tesseract language data, e.g. `eng+afr`. It must be installed — see above. |
| `EJE_OCR_MAX_PAGES` | `40` | Pages read per document. At the **measured 23–25 seconds a page** (see §5) this is about sixteen minutes — which is inside the deadline below, but only just. |
| `EJE_OCR_DEADLINE_MINUTES` | `20` | **The whole-document deadline**, and the one that matters most: forty pages at the ten-minute per-page timeout is six and a half HOURS for one job, on the machine that also serves the application. |
| `EJE_OCR_MAX_INPUT_MB` | `40` | Larger than the 25 MB upload limit, so it bounds nothing legitimate. A larger scan rasterised at 300 dpi is hundreds of megabytes of page images. |
| `EJE_OCR_MAX_TEXT_MB` | `2` | What one document may produce. A badly-scanned page can produce a megabyte of noise, and this goes into a database column and a search index. |

**Every limit that bites is reported.** The index records that it is truncated
AND why, and the library says *"Searchable in part"* with the reason — because a
limit that silently truncates cannot be told from a bad scan, and somebody
searching a manual and not finding alarm 414 would conclude it is not in the
book. A bad number (`EJE_OCR_MAX_PAGES=lots`) falls back to the default rather
than to zero, and `--report` still shows the variable as set so the discrepancy
is visible.

Jobs that settled as `unavailable` before an engine existed are NOT retried
automatically — nothing about them changed, and the next attempt would say the
same thing. Ask for them again from the library screen once the engine is in
place.

**A cron entry is deliberately not shipped.** How often a library needs reading
depends on how often EJE upload scans, and a timer nobody asked for is a timer
nobody expects. `docs/vps-backups.md` shows the systemd pattern if EJE want one.

---

## 5. BD-21 answered: the demonstration environment first, and what it measured

*Added 23 October 2026. The owner answered BD-21 (#63): configure local OCR in
the DEMONSTRATION environment first, and measure the performance before any
production decision. This section is that measurement.*

### What was measured, and against what

A representative scanned manual, built for the purpose: **ten A4 pages at 300
dpi, grayscale**, each carrying a section heading, an alarm number and about
thirty-four lines of dense body text in the vocabulary of a machine manual. It
has **no text layer** — the pages were rendered to images and wrapped in a PDF,
confirmed by `pdftotext` returning zero characters — so every character below
came out of recognition.

Run through the real engine (`buildOcr({ EJE_OCR: 'local' }).read(bytes)`), on
the development container: **4 cores, 16 GB, tesseract 5.3.4,
poppler 24.02.0**.

| | Sample 1 | Sample 2 |
|---|---|---|
| Pages read | 10 | 10 |
| Pages failed | 0 | 0 |
| Wall clock | **248.1 s** | **231.6 s** |
| Per page | **24.8 s** | **23.2 s** |
| Text produced | 22 472 bytes | 22 472 bytes |
| Alarm codes found | all 10 | all 10 |

**Recognition is deterministic**: both samples produced byte-identical text, and
each found all ten alarm numbers — so the engine reads what is on the page
rather than approximately.

Peak resident memory of the Node process stayed at **85 MB**; the work happens
in `tesseract` and `pdftoppm` child processes, one page at a time, so memory is
bounded by a single page image rather than by the document.

### The consequence, which is the reason this was measured

**23 to 25 seconds per page is slower than the 5–15 seconds §2(a) estimated**,
and it changes what the defaults do to a real manual:

| Document | Measured / projected |
|---|---|
| 10-page scan | **~4 minutes** (measured) |
| 40 pages (`EJE_OCR_MAX_PAGES`) | ~16 minutes |
| **214-page manual** | **~83–89 minutes** (projected from the per-page figure) |

So **a 214-page manual cannot be read under the shipped defaults.** It meets
`EJE_OCR_MAX_PAGES=40` at about page 40, inside the 20-minute deadline; without
that page cap it would meet `EJE_OCR_DEADLINE_MINUTES=20` at about page 50. The
document is recorded as **"Searchable in part"** with the reason, which is the
honest outcome — but it means **a long manual is partially indexed by default,
and somebody searching it for alarm 414 may not find it.**

That is not a defect to fix silently. Raising either limit is a decision about
how much of EJE's VPS one document may occupy, and it is the decision this
measurement exists to inform.

### Note on the test fixture, so the numbers are not confused

`src/services/__fixtures__/scan-three-pages.pdf` reads **three pages in 1.1
seconds** — 0.37 s/page, about 65× faster than a real scan. It is a small,
sparse, synthetic image, and it is sized for a test suite rather than for
realism. **It is not evidence about performance**, and the figures above should
be quoted instead.

### The demonstration environment, and only it

```bash
# On the VPS, for the STAGING/DEMONSTRATION service only:
sudo apt-get install -y tesseract-ocr tesseract-ocr-eng poppler-utils

# in /etc/eje-staging/eje.env  — NOT /etc/eje/eje.env
EJE_OCR=local

sudo -u eje-staging npm run library:ocr -- --report
sudo -u eje-staging npm run library:ocr -- --max 5
```

`deploy/eje-staging.service` is a separate unit, user, port, database and
storage directory from the live service, so a recognition run cannot compete
with production for anything but the shared PostgreSQL server and the CPU.

**`npm run preflight` now warns when `EJE_OCR=local` is set on a deployment that
declares itself `production`**, naming BD-21 and the measured per-page cost —
because the owner asked for the demonstration first, and a production
deployment quietly running it would be recognition nobody approved on the
machine that also serves the tablets.

**NOTHING WAS INSTALLED ON THE PRODUCTION VPS and OCR WAS NOT ENABLED THERE as
part of this work.** The packages above were installed in the development
container to take these measurements. The commands are written down so EJE can
run them when they choose; this session has no access to the VPS.
