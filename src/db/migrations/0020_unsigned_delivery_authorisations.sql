-- A MASTER AUTHORISING THE SENDING OF A JOB CARD THE CUSTOMER DID NOT SIGN.
-- BD-06, DELIV-7, AUD-4.
--
-- WHAT WAS TRUE BEFORE THIS, and it was an acceptance blocker: closing a job
-- without a signature sent the customer NOTHING. The document was rendered,
-- stored and downloadable, and the send was left as an open business decision.
-- That is the right default — a customer who declined to sign must not be
-- e-mailed a copy automatically — and it left EJE with no way to send one at
-- all.
--
-- THE OWNER'S RULE, implemented here: no automatic delivery merely because the
-- job closed without a signature; a MASTER must explicitly authorise any
-- exceptional delivery; and the authorising user, time, reason, document
-- version, destination and outcome are all recorded.
--
-- APPEND-ONLY, one row per job. A retry of a failed send does not need a
-- second authorisation — what happened to each attempt is on `job.delivery`
-- and in the audit trail, where every other delivery attempt is recorded.
--
-- `document_key` is a foreign key to `final_documents.storage_key`, so an
-- authorisation names the exact bytes it covers and cannot be read as
-- authorising some later document.

CREATE TABLE "unsigned_delivery_authorisations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"document_key" text NOT NULL,
	"recipient" text NOT NULL,
	"reason" text NOT NULL,
	"authorised_by" uuid,
	"authorised_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unsigned_delivery_authorisations_reason_present" CHECK (length(btrim("unsigned_delivery_authorisations"."reason")) > 0),
	CONSTRAINT "unsigned_delivery_authorisations_recipient_present" CHECK (length(btrim("unsigned_delivery_authorisations"."recipient")) > 0)
);
--> statement-breakpoint
ALTER TABLE "unsigned_delivery_authorisations" ADD CONSTRAINT "unsigned_delivery_authorisations_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unsigned_delivery_authorisations" ADD CONSTRAINT "unsigned_delivery_authorisations_document_key_final_documents_storage_key_fk" FOREIGN KEY ("document_key") REFERENCES "public"."final_documents"("storage_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "unsigned_delivery_authorisations_job_key" ON "unsigned_delivery_authorisations" USING btree ("job_id");--> statement-breakpoint

-- APPEND-ONLY. A decision somebody took is not edited afterwards; if the
-- decision changes, that is a new fact and belongs on the audit trail.
CREATE TRIGGER unsigned_delivery_authorisations_append_only
  BEFORE UPDATE OR DELETE ON unsigned_delivery_authorisations
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
