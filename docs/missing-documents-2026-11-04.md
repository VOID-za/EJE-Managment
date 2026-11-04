# The 17 storage keys with no file — investigated 4 November 2026

Every backup since the oldest one kept (27 October 2026) records the same 17
storage keys as "already missing when taken" (`unresolved-references.json`);
no backup ever lost one. Each was investigated read-only: its database record,
its job, customer or library entry, its recorded size and checksum, a search of
the whole server (`find / -xdev -name …`), the storage directories, and every
one of the 30 retained backups' manifests.

**Finding: none of the 17 ever had a stored file in this deployment.** All are
demonstration records — on DEMO customers, the demonstration Technical Library
and demonstration machines — created as metadata without bytes, either by the
seed (which cannot ship binary content) or with the demonstration data loaded
before the live database's first audit event (26 October 2026). There is no
original to recover, nothing has been lost, and **no record was changed or
deleted**. Nothing was regenerated.

| # | Table | Storage key | Record | Evidence | Status | Impact |
|---|---|---|---|---|---|---|
| 1 | final_documents | `jobcards/final/EJE-2015.pdf` | EJE-2015, breakdown, closed — ACME Engineering Solutions (DEMO) | size 0, no checksum, 23 Sep 2026; seeded (`src/db/seed/jobs.ts`: "a seed cannot ship binary content, so a seeded job card is rendered on first download") | Never stored — by design | Opening it renders the PDF from the job's stored record and caches it marked **backfilled** (never presented as an issued original) |
| 2 | final_documents | `jobcards/final/EJE-2016.pdf` | EJE-2016, service, closed — Johannesburg Industrial Automation (DEMO) | as 1 | Never stored — by design | as 1 |
| 3 | final_documents | `jobcards/final/EJE-2017.pdf` | EJE-2017, installation, closed — ACME Engineering Solutions (DEMO) | as 1 | Never stored — by design | as 1 |
| 4 | final_documents | `jobcards/final/EJE-2019.pdf` | EJE-2019, breakdown, closed — Johannesburg Industrial Automation (DEMO) | as 1 | Never stored — by design | as 1 |
| 5 | final_documents | `partsnotes/final/EJE-2020.pdf` | EJE-2020, parts, closed — ACME Engineering Solutions (DEMO) | as 1 | Never stored — by design | as 1 |
| 6 | final_documents | `partsnotes/final/EJE-2021.pdf` | EJE-2021, parts, closed — Southern Industrial Components (DEMO) | as 1 | Never stored — by design | as 1 |
| 7 | job_media | `uploads/1330d3b2-1c32-4366-8cbe-39840e925ca5` | EJE-2013 (completion) — Advanced Machine Systems (DEMO); customer-facing photo `EJE-2013-2026-09-25133925.jpg`, "uploaded" 25 Sep 2026 by John Master | 2 140 000 bytes (the same invented size as #8), no checksum, no audit event (the audit trail starts 26 Oct) — demonstration metadata | Never stored | The photo shows as unavailable on that demonstration job |
| 8 | job_media | `uploads/a83c0cf3-761c-4491-ba7c-deeb25cddf73` | EJE-2031 (invoiced) — Johannesburg Industrial Automation (DEMO); customer-facing photo `EJE-2031-2026-10-20081404.jpg`, "uploaded" 20 Oct 2026 by Mike Technician | as 7 | Never stored | as 7 |
| 9 | library_document_versions | `library/cnc-safety-procedure-demo-rev3.pdf` | CNC Safety Procedure (DEMO), Rev 3 | seeded (`src/db/seed/collaboration.ts`: "there is no file"); recorded size a round 4 324 000, no checksum | Never stored | Opening the file in the Library reports it unavailable |
| 10 | library_document_versions | `library/machine-installation-procedure-demo-rev2.pdf` | Machine Installation Procedure (DEMO), Rev 2 | as 9 | Never stored | as 9 |
| 11 | library_document_versions | `library/preventative-maintenance-checklist-demo-rev5.pdf` | Preventative Maintenance Checklist (DEMO), Rev 5 | as 9 | Never stored | as 9 |
| 12 | library_document_versions | `library/electrical-safety-procedure-demo-rev4.pdf` | Electrical Safety Procedure (DEMO), Rev 4 | as 9 | Never stored | as 9 |
| 13 | library_document_versions | `library/emergency-stop-testing-procedure-demo-rev1.pdf` | Emergency Stop Testing Procedure (DEMO), Rev 1 | as 9 | Never stored | as 9 |
| 14 | library_document_versions | `library/cnc-safety-procedure-demo-rev2.pdf` | CNC Safety Procedure (DEMO), Rev 2 (archived) | as 9 | Never stored | none (archived version) |
| 15 | library_document_versions | `library/technician-training-guide-demo-draft1.pdf` | Technician Training Guide (DEMO), Draft 1 | as 9 | Never stored | as 9 |
| 16 | machine_photos | `machines/mazak-qt250-front.jpg` | machine MZ-QT250-40218 — ACME Engineering Solutions (DEMO) | seeded (`src/db/seed/register.ts`: "Metadata and no photograph"), provenance `simulated` | Never stored | The machine shows no photo |
| 17 | machine_photos | `machines/fanuc-robodrill-cabinet.jpg` | machine FN-D21-55204 — Johannesburg Industrial Automation (DEMO) | as 16 | Never stored | as 16 |

**Who must supply a replacement:** nobody — these belong to demonstration
customers. If any of these demonstration records is ever kept into a real
deployment, the owner decides whether to upload real documents for the library
entries; the job photos and machine photos have no real originals anywhere.

**Note.** Records 1–6 carry `provenance = 'genuine'` in the database although
they were seeded; the seed of that time did not mark them. Left unchanged
(data is not rewritten); recorded here.
