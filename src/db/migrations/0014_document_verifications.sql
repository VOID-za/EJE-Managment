-- An observation about an issued document's bytes. APPEND-ONLY. BACKUP-1.
--
-- `final_documents.size_bytes` and `.checksum_sha256` were columns nothing ever
-- wrote: every row on the live server read 0 with no checksum, while the
-- schema's comment claimed the checksum was verified on every read. New rows
-- record both at issue. The old ones CANNOT be corrected in place, because
-- `final_documents` is write-once and `0002_immutability.sql` refuses UPDATE on
-- it — on purpose, since a job card the customer holds must stay the job card
-- the customer holds. That trigger's own message says what to do instead:
-- "correct it by adding a new record". This is that record.
--
-- Written by `npm run documents:reconcile`, which measures the file under each
-- key and records what it found — including that it found nothing. Nothing
-- reads these rows to decide what to serve; the file itself is what is served.
--
-- The rows are evidence, so the same guard applies to them as to everything
-- else of that kind here: inserted and read, never updated or deleted.

CREATE TABLE "final_document_verifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"final_document_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"verdict" text NOT NULL,
	"size_bytes" bigint,
	"checksum_sha256" text,
	"renderer_version" integer,
	"detail" text DEFAULT '' NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "final_document_verifications" ADD CONSTRAINT "final_document_verifications_final_document_id_final_documents_id_fk" FOREIGN KEY ("final_document_id") REFERENCES "public"."final_documents"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE TRIGGER final_document_verifications_append_only
  BEFORE UPDATE OR DELETE ON final_document_verifications
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
