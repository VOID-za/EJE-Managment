-- Demonstration data says so, and the library has the categories EJE asked for.
-- October mandate sections 1 and 3.
--
-- WHAT WAS WRONG. Nine seeded library documents, three seeded machine
-- photographs and six seeded job cards were presented exactly as real EJE
-- records — including file sizes the seed invented for bytes that do not exist
-- ("18.4 MB, 214 pages" for a manual nobody had uploaded). Nothing in the
-- database said which records were fixtures, so nothing on a screen could.
--
-- PROVENANCE IS RECORDED, NEVER INFERRED. Not from a file name, not from a
-- customer's name, not from whether bytes happen to be missing: a genuine
-- document whose file is lost is an incident, and a fixture with no file is
-- housekeeping. The two must not be told apart by the same test.
--
-- THE DEFAULT IS `genuine`, in that direction deliberately. Every row that
-- exists was written by the application or by the seed; the seed now says
-- `simulated` for its own rows and nothing else may. A default of `simulated`
-- would label real customer documents as fixtures, which is the one mistake
-- here that could lose a real record.
--
-- ADDITIVE AND REVERSIBLE BY NEGLECT: four nullable-by-default columns, four
-- CHECK constraints, and five new enum values. No row is rewritten, nothing is
-- dropped, and code that predates this runs against the new schema unchanged.

ALTER TYPE "public"."technical_document_type" ADD VALUE 'checklist';--> statement-breakpoint
ALTER TYPE "public"."technical_document_type" ADD VALUE 'training';--> statement-breakpoint
ALTER TYPE "public"."technical_document_type" ADD VALUE 'internal_procedure';--> statement-breakpoint
ALTER TYPE "public"."technical_document_type" ADD VALUE 'form';--> statement-breakpoint
ALTER TYPE "public"."technical_document_type" ADD VALUE 'certificate';--> statement-breakpoint
ALTER TABLE "machine_photos" ADD COLUMN "provenance" text DEFAULT 'genuine' NOT NULL;--> statement-breakpoint
ALTER TABLE "final_documents" ADD COLUMN "provenance" text DEFAULT 'genuine' NOT NULL;--> statement-breakpoint
ALTER TABLE "library_document_versions" ADD COLUMN "provenance" text DEFAULT 'genuine' NOT NULL;--> statement-breakpoint
ALTER TABLE "library_documents" ADD COLUMN "provenance" text DEFAULT 'genuine' NOT NULL;--> statement-breakpoint
ALTER TABLE "machine_photos" ADD CONSTRAINT "machine_photos_provenance_known" CHECK ("machine_photos"."provenance" in ('genuine', 'simulated'));--> statement-breakpoint
ALTER TABLE "final_documents" ADD CONSTRAINT "final_documents_provenance_known" CHECK ("final_documents"."provenance" in ('genuine', 'simulated'));--> statement-breakpoint
ALTER TABLE "library_document_versions" ADD CONSTRAINT "library_document_versions_provenance_known" CHECK ("library_document_versions"."provenance" in ('genuine', 'simulated'));--> statement-breakpoint
ALTER TABLE "library_documents" ADD CONSTRAINT "library_documents_provenance_known" CHECK ("library_documents"."provenance" in ('genuine', 'simulated'));