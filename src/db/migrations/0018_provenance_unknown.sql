-- A THIRD, HONEST ANSWER ABOUT WHERE A RECORD CAME FROM. October mandate §1.3.
--
-- `provenance` arrived in 0015 with a default of 'genuine'. Every row written
-- before that took the default, so its origin was never RECORDED — it was
-- assumed, and the assumption is right most of the time and is still an
-- assumption. §1.3 says an uncertain record must not silently be treated as
-- proven either way, so there is now a value that says exactly that.
--
-- WHY 'unknown' RATHER THAN 'simulated'. Marking an unrecorded row simulated
-- would print SIMULATED — NOT A GENUINE EJE DOCUMENT across a real customer's
-- paperwork. That is not the safe direction; it is a different false statement
-- and a worse one, because somebody would discard the record.
--
-- THE DEFAULT CHANGES TOO, to 'unknown'. An INSERT that forgets the column now
-- lands on "nobody said" instead of on "this is EJE's". That exact omission
-- has already happened twice in this repository — `JobRepository.save` and the
-- machine-photograph insert both dropped the field, and the column's 'genuine'
-- default turned six demonstration job cards into what the reconcile reported
-- as LOST CUSTOMER DOCUMENTS. A default that says nothing cannot do that.
-- Every application insert states the value explicitly; a test asserts it.

ALTER TABLE "library_documents" DROP CONSTRAINT "library_documents_provenance_known";--> statement-breakpoint
ALTER TABLE "library_documents" ADD CONSTRAINT "library_documents_provenance_known" CHECK ("library_documents"."provenance" in ('genuine', 'simulated', 'unknown'));--> statement-breakpoint
ALTER TABLE "library_documents" ALTER COLUMN "provenance" SET DEFAULT 'unknown';--> statement-breakpoint

ALTER TABLE "library_document_versions" DROP CONSTRAINT "library_document_versions_provenance_known";--> statement-breakpoint
ALTER TABLE "library_document_versions" ADD CONSTRAINT "library_document_versions_provenance_known" CHECK ("library_document_versions"."provenance" in ('genuine', 'simulated', 'unknown'));--> statement-breakpoint
ALTER TABLE "library_document_versions" ALTER COLUMN "provenance" SET DEFAULT 'unknown';--> statement-breakpoint

ALTER TABLE "machine_photos" DROP CONSTRAINT "machine_photos_provenance_known";--> statement-breakpoint
ALTER TABLE "machine_photos" ADD CONSTRAINT "machine_photos_provenance_known" CHECK ("machine_photos"."provenance" in ('genuine', 'simulated', 'unknown'));--> statement-breakpoint
ALTER TABLE "machine_photos" ALTER COLUMN "provenance" SET DEFAULT 'unknown';--> statement-breakpoint

ALTER TABLE "customer_documents" DROP CONSTRAINT "customer_documents_provenance_known";--> statement-breakpoint
ALTER TABLE "customer_documents" ADD CONSTRAINT "customer_documents_provenance_known" CHECK ("customer_documents"."provenance" in ('genuine', 'simulated', 'unknown'));--> statement-breakpoint
ALTER TABLE "customer_documents" ALTER COLUMN "provenance" SET DEFAULT 'unknown';--> statement-breakpoint

ALTER TABLE "machine_documents" DROP CONSTRAINT "machine_documents_provenance_known";--> statement-breakpoint
ALTER TABLE "machine_documents" ADD CONSTRAINT "machine_documents_provenance_known" CHECK ("machine_documents"."provenance" in ('genuine', 'simulated', 'unknown'));--> statement-breakpoint
ALTER TABLE "machine_documents" ALTER COLUMN "provenance" SET DEFAULT 'unknown';--> statement-breakpoint

-- `final_documents` gets the VALUE but keeps its default, and no row of it is
-- rewritten below. Two reasons, and both are deliberate:
--
--   1. It is WRITE-ONCE. `refuse_mutation()` refuses UPDATE on it, and that
--      refusal is one of the protections CR-01 rests on. Suspending it to
--      improve a label would be exactly the exception that makes immutability
--      mean nothing — the next person to want one will cite this migration.
--   2. A job card's origin can be established without touching the row. The
--      trigger's own message says how — "correct it by adding a new record" —
--      and that is exactly what `provenance_recording` below is: one row
--      saying when this database began recording provenance. The reconcile
--      reads it, treats any final document older than that as UNRECORDED
--      whatever the column says, and falls back to the shipped demonstration
--      dataset.
--
-- Without that row this migration would have CREATED the failure it exists to
-- prevent: 0015's backfill writes 'genuine' over six demonstration job cards
-- on the live database, and `documents:reconcile` would then report all six as
-- LOST CUSTOMER DOCUMENTS and exit non-zero on the first run after deployment.
ALTER TABLE "final_documents" DROP CONSTRAINT "final_documents_provenance_known";--> statement-breakpoint
ALTER TABLE "final_documents" ADD CONSTRAINT "final_documents_provenance_known" CHECK ("final_documents"."provenance" in ('genuine', 'simulated', 'unknown'));--> statement-breakpoint
-- Its DEFAULT changes with the others. A default is a property of the table,
-- not of a row, so `refuse_mutation()` has nothing to say about it and no
-- existing job card is touched: only an INSERT that omits the column is
-- affected, and the issue path has stated it since `49e79b4`.
ALTER TABLE "final_documents" ALTER COLUMN "provenance" SET DEFAULT 'unknown';--> statement-breakpoint

-- WHEN THIS DATABASE STARTED RECORDING PROVENANCE, written down rather than
-- inferred.
--
-- THE FIRST ATTEMPT AT THIS READ DRIZZLE'S LEDGER, and it was wrong in the one
-- case that matters. `drizzle.__drizzle_migrations.created_at` is the journal's
-- authored `when`, not the moment the migration ran here — so on the live
-- database, which is still serving a release from before this column existed,
-- every job card issued between 0015 being written and 0015 being APPLIED
-- would have looked "recent" and escaped the relabelling while carrying a
-- provenance nobody recorded.
--
-- So the moment is recorded as a fact. Everything created before it was
-- backfilled by 0015's default; everything after it was written by code that
-- states the value.
CREATE TABLE "provenance_recording" (
	"id" text PRIMARY KEY NOT NULL,
	"recorded_from" timestamp with time zone NOT NULL,
	"note" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
INSERT INTO "provenance_recording" ("id", "recorded_from", "note")
VALUES (
  'cutoff',
  now(),
  'Rows created before this moment took the provenance column''s original ''genuine'' default and were never recorded as anything. See migration 0018 and docs/demonstration-data.md.'
);
--> statement-breakpoint

-- ROWS WHOSE PROVENANCE WAS NEVER RECORDED BECOME 'unknown'.
--
-- The cutoff is the row above, so this and the reconcile agree by construction
-- rather than by both being written carefully.
--
-- WHY OVER-MARKING IS THE ACCEPTED ERROR HERE. A row written between 0015 and
-- this migration by code that DID state `genuine` is indistinguishable from a
-- backfilled one, and is relabelled with the rest. That is the safe direction:
-- "nobody wrote this down" is recoverable by somebody looking, while a
-- defaulted guess left claiming `genuine` is the false statement §1.3 exists
-- to stop. It also costs nothing today — no EJE deployment has run 0015, so
-- there are no such rows to over-mark.
DO $$
DECLARE
  cutoff timestamptz;
BEGIN
  SELECT recorded_from INTO cutoff FROM provenance_recording WHERE id = 'cutoff';

  UPDATE library_documents SET provenance = 'unknown'
   WHERE created_at < cutoff AND provenance = 'genuine';
  UPDATE library_document_versions SET provenance = 'unknown'
   WHERE created_at < cutoff AND provenance = 'genuine';
  UPDATE machine_photos SET provenance = 'unknown'
   WHERE created_at < cutoff AND provenance = 'genuine';
  /*
   * `customer_documents` and `machine_documents` postdate 0015 entirely, so
   * these two can never match. They are here so the list is every table
   * carrying the column, and a reader does not have to work out which two were
   * left out and why.
   */
  UPDATE customer_documents SET provenance = 'unknown'
   WHERE created_at < cutoff AND provenance = 'genuine';
  UPDATE machine_documents SET provenance = 'unknown'
   WHERE created_at < cutoff AND provenance = 'genuine';
END $$;
