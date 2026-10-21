# Demonstration data: exactly what is simulated, and how you can tell

The classification record the October mandate §1.3 asks for. It says which
records on a demonstration deployment are fixtures, how the application says
so, which of them have no file behind them at all, and what is uncertain.

**The rule, in one line:** provenance is **recorded on the row**, never inferred
from a name, a file name, a customer or a missing file. A document called
`demo.pdf` may be a real document somebody named badly; a manual called
*Leadwell V-40 Rev 4* is a fixture.

---

## 1. What EJE have authorised to remain as demonstration records

Expressly permitted by the owner, and **not labelled** as simulated because
they are the test environment itself rather than records anybody could file:

| What | Count on a seeded deployment |
|---|---|
| Demo user switching | enabled (`/api/health` reports `"demoSwitcher": true`) |
| Demonstration users | 5 accounts |
| Demonstration customers | 5 |
| Demonstration jobs and their workflows | 26 |

The customers are fictional and their e-mail addresses end in `-demo.local` or
`-demo.co.za`, so nothing in the demonstration can reach a real mailbox even if
a transport were configured.

## 2. What is labelled SIMULATED

Every one of these carries `provenance = 'simulated'` in the database, is
labelled on screen, and — where it produces a file — says so **inside the
file**:

| Record | Count | Has stored bytes? | Where the label appears |
|---|---|---|---|
| Library documents | 7 (PostgreSQL seed); 9 (demonstration store) | **No — metadata only** | list row badge, detail metadata line, preview panel, and no download is offered |
| Library revisions | one per document | **No** | as above |
| Machine photographs | 2 (PostgreSQL); 3 (demonstration store) | **No** | tile badge and a `SIMULATED` placeholder instead of a frame |
| Issued job cards | 6 | rendered on first download | **every page of the PDF**, plus the screen |
| Job photographs (demonstration store only) | 7 | No | the job's own panels |

Customer documents (§4) are seeded **not at all**, deliberately: a seeded one
would be a fourth kind of fixture with no bytes behind it, and §1 is about
having fewer of those. The feature is demonstrated by uploading a real file
during a session.

### The exact wording

```
SIMULATED — DEMONSTRATION DATA — NOT A GENUINE EJE DOCUMENT   (screens)
SIMULATED - DEMONSTRATION DATA - NOT A GENUINE EJE DOCUMENT   (PDF pages)
SIMULATED                                                     (list rows, chips)
```

The PDF variant uses hyphens because the renderer's fonts carry no em dash, and
a missing glyph in the one line that must be readable is worse than a less
pretty dash. `src/domain/types/provenance.ts` holds all three, so no component
invents its own.

## 3. Metadata-only records: what the application does NOT do

A library document with no bytes behind it:

- reports `storedFile: false` and `fileSizeBytes: 0` through the API;
- shows **no page count and no file size** — it says *No stored file*;
- offers **no download button and no preview frame**;
- answers **404** on `/api/library/:id/file`, with the reason;
- generates **nothing** to stand in for the document.

**What those zeroes replaced.** Until 20 October 2026 the seed asserted sizes
and page counts for files that do not exist — `18_442_000` bytes and `214`
pages for a Leadwell manual nobody has ever uploaded, `1_842_000` for machine
photographs, `4_180_000 + pages × 12_000` in the PostgreSQL seed, and a flat
`2_400_000` for every metadata-only document somebody added through the office
screen. The library printed those numbers beside a download button. A size is
now measured off a real file or it is zero.

## 4. The six job cards reported missing, verified

`EJE-2015, EJE-2016, EJE-2017, EJE-2019, EJE-2020, EJE-2021` had no files in
`/var/lib/eje/storage`. **Verified against the seed, the database and the
storage directory** rather than taken from the earlier report:

- all six are in `seedJobs`, the shipped demonstration dataset;
- all six now carry `provenance = 'simulated'` on their `final_documents` row
  (`npm run documents:reconcile` reads the column and names them);
- their PDFs are rendered on first download, as a seed cannot ship one, and
  when rendered each page carries the stamp;
- **no original bytes were recovered, because none ever existed**, and nothing
  was manufactured to fill the gap.

If any of these had turned out to be genuine it would have been a data-recovery
incident; the reconcile tool reports a genuine document with missing bytes as
`absent_genuine`, exits non-zero, and says to restore it from a backup rather
than re-render it.

## 5. Uncertainty, recorded rather than resolved — now a VALUE, not a footnote

**Updated 21 October 2026.** Everything in the table below was true and was
only written down *here*. `provenance` now has a third value, `unknown`, and
the application says it on screen rather than leaving it in a document:

- migration **0018** relabelled every row written before provenance existed in
  the five tables that permit an UPDATE — `library_documents`,
  `library_document_versions`, `machine_photos`, and (vacuously)
  `customer_documents` and `machine_documents`;
- the column's **default changed from `genuine` to `unknown`**, so an insert
  that forgets the field now lands on "nobody said" instead of on a claim. That
  exact omission has happened twice in this repository, and
  `provenance-writes.db.test.ts` now asserts that each upload path puts
  `genuine` in the column itself;
- `final_documents` **is not rewritten**, because it is write-once and that
  refusal is one of the protections CR-01 rests on. Instead 0018 writes one row
  — `provenance_recording` — saying when this database began recording, and
  `documents:reconcile` treats any job card older than that as unrecorded
  whatever its column says. The trigger's own message says to correct such a
  row "by adding a new record", and that is what this is;
- an unreadable value reads as `unknown` rather than as `simulated`. Printing
  SIMULATED across a real customer's job card is not the safe direction — it is
  a different false statement, and a worse one, because somebody would discard
  the record.

**What `unknown` does NOT do:** it does not stamp a PDF. Only a record
*recorded* as simulated is stamped. The screen, the API and the reconcile say
it instead.

**A would-be production incident this prevented.** Without
`provenance_recording`, applying 0015 to the live database would have
backfilled `genuine` onto the six demonstration job cards, and the first
`documents:reconcile` after deployment would have reported all six as **LOST
CUSTOMER DOCUMENTS** and exited non-zero. Proved by building a database shaped
like the live one — pre-provenance rows, drizzle ledger at 0014 — migrating it,
and running the reconcile: the demonstration job card classifies as
`absent_demonstration`, a genuine one with missing bytes still fails the run,
and the summary names the tables whose provenance was never recorded.

### The original uncertainty table, kept for the record

| What | Status |
|---|---|
| Rows written **before** `provenance` existed | They read `genuine` by default. On a live deployment that default is correct — the application wrote them — but it is a default, not a measurement. `documents:reconcile` falls back to the demonstration dataset for job cards, and there is no equivalent fallback for library documents or machine photographs. **If EJE's live database holds library records of uncertain origin, they will read as genuine until somebody looks at them.** |
| The demonstration store's own snapshot | Upgraded in place (v17 → v18). It classifies by whether bytes exist, which is a sound reading of a snapshot and the only evidence a snapshot carries. Stated in the migration itself. |
| `machine_photos` on the live server | Two rows, seeded, now labelled. Nothing else has ever written to that table on the live deployment. |

## 6. How to check a deployment yourself

```bash
# Every document record, classified, read-only:
npm run documents:reconcile

# What the database itself says, by table:
psql "$DATABASE_URL" -At -c "
  select 'library',  count(*), count(*) filter (where provenance='simulated') from library_documents
  union all select 'machine_photos', count(*), count(*) filter (where provenance='simulated') from machine_photos
  union all select 'final_documents', count(*), count(*) filter (where provenance='simulated') from final_documents
  union all select 'customer_documents', count(*), count(*) filter (where provenance='simulated') from customer_documents"
```

A row reading `simulated` is a fixture. A row reading `genuine` whose file is
missing is an incident, and the reconcile tool fails on it.

## 7. Before genuine customer data is introduced

Two things that are safe now and must be decided before real customers are on
the system:

1. **Demo user switching** (`EJE_DEMO_SWITCHER`) signs in as the five published
   accounts, verifying the published password against the stored hash. It is
   armed only when the variable **names the configured database**, so the same
   line on a differently-named database turns nothing on. **Since 21 October it
   is also refused outright wherever `EJE_DEPLOYMENT=production`**, in the
   runtime rather than in a check — so a production deployment cannot arm it
   even with the line present. It should still be absent from that file; see
   `docs/demonstration-isolation.md` and `docs/security.md`.
2. **The demonstration dataset itself** belongs in a separate database — the
   design, the enforcement and the exact VPS steps are
   `docs/demonstration-isolation.md`. A `simulated` label is an honest answer
   to "is this real", not a substitute for keeping the two apart, and the
   repository now enforces the boundary rather than only documenting it.
   **The database work still needs somebody with root on the VPS.**
