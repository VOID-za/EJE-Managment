-- A CORRECTION TO AN ISSUED JOB CARD. BD-02, IMMUT-9, AUD-3.
--
-- THE GAP THIS CLOSES was an acceptance blocker: a signed job card with a
-- genuine error had no remedy at any layer. The application refuses every
-- edit, this database refuses every UPDATE, and the office was left holding a
-- document that says the wrong thing with no way to say so. "Immutable" was
-- implemented; "and here is what you do instead" was not.
--
-- A CORRECTION IS A NEW RECORD, NEVER AN EDIT — the shape
-- `refuse_mutation()`'s own message asks for: "correct it by adding a new
-- record". Nothing here touches `final_documents`, `job_signatures` or
-- `pricing_snapshots`. The original job card, its signature, its issue date,
-- its prices and its bytes are exactly as they were.
--
-- `corrects_document_key` is a foreign key to `final_documents.storage_key` —
-- unique, and write-once like the rest of that row. The KEY rather than the row
-- id because a storage key names an exact set of BYTES, which is what the
-- customer holds. RESTRICT in both directions: neither the job nor the document
-- it corrects can be removed from under it.

CREATE TABLE "job_corrections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"corrects_document_key" text NOT NULL,
	"reason" text NOT NULL,
	"narrative" text NOT NULL,
	"areas" text[] NOT NULL,
	"raised_by" uuid,
	"raised_at" timestamp with time zone NOT NULL,
	"acknowledgement" text DEFAULT 'not_required' NOT NULL,
	"acknowledged_by" text,
	"acknowledgement_method" text,
	"acknowledgement_recorded_by" uuid,
	"acknowledgement_recorded_at" timestamp with time zone,
	"acknowledgement_note" text DEFAULT '' NOT NULL,
	"document_file_name" text NOT NULL,
	"document_storage_key" text NOT NULL,
	"document_size_bytes" bigint NOT NULL,
	"document_checksum_sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_corrections_sequence_positive" CHECK ("job_corrections"."sequence" >= 1),
	CONSTRAINT "job_corrections_reason_present" CHECK (length(btrim("job_corrections"."reason")) > 0),
	CONSTRAINT "job_corrections_narrative_present" CHECK (length(btrim("job_corrections"."narrative")) > 0),
	-- `cardinality`, NOT `array_length(areas, 1)`. On an EMPTY array
	-- `array_length` returns NULL, `NULL >= 1` is NULL, and a CHECK treats NULL
	-- as satisfied — so the first version of this constraint accepted exactly
	-- the row it was written to refuse. The db test caught it; `cardinality`
	-- returns 0.
	CONSTRAINT "job_corrections_areas_present" CHECK (cardinality("job_corrections"."areas") >= 1),
	CONSTRAINT "job_corrections_size_positive" CHECK ("job_corrections"."document_size_bytes" > 0),
	CONSTRAINT "job_corrections_acknowledgement_known" CHECK ("job_corrections"."acknowledgement" in ('not_required', 'required', 'recorded')),
	CONSTRAINT "job_corrections_acknowledgement_consistent" CHECK (("job_corrections"."acknowledgement" = 'recorded') = ("job_corrections"."acknowledged_by" is not null and "job_corrections"."acknowledgement_recorded_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "job_corrections" ADD CONSTRAINT "job_corrections_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_corrections" ADD CONSTRAINT "job_corrections_corrects_document_key_final_documents_storage_key_fk" FOREIGN KEY ("corrects_document_key") REFERENCES "public"."final_documents"("storage_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_corrections" ADD CONSTRAINT "job_corrections_raised_by_users_id_fk" FOREIGN KEY ("raised_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_corrections" ADD CONSTRAINT "job_corrections_acknowledgement_recorded_by_users_id_fk" FOREIGN KEY ("acknowledgement_recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_corrections_job_sequence_key" ON "job_corrections" USING btree ("job_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "job_corrections_storage_key_key" ON "job_corrections" USING btree ("document_storage_key");--> statement-breakpoint
CREATE INDEX "job_corrections_job_idx" ON "job_corrections" USING btree ("job_id","raised_at");--> statement-breakpoint

-- APPEND-ONLY, WITH ONE THING THAT MAY BE FILLED IN LATER.
--
-- The same shape `signature_refusals_guard` uses, for the same reason: what
-- was RAISED is a historical fact, and what the customer then said is a later
-- one. So the reason, the narrative, the affected areas, the author, the
-- timestamp, the document it corrects and the addendum's own bytes are frozen
-- at insert — and the acknowledgement may go from null to a value exactly
-- once.
--
-- WHY NOT A SECOND TABLE FOR THE ACKNOWLEDGEMENT. It would be the more
-- orthodox shape and it would also let a correction have two of them, which is
-- a question nobody has asked and an answer nobody wants printed on a
-- customer's addendum. One correction, one acknowledgement, enforced here.
CREATE OR REPLACE FUNCTION job_corrections_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A correction to an issued job card is a historical record and cannot be deleted.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.job_id                 IS DISTINCT FROM OLD.job_id
     OR NEW.sequence            IS DISTINCT FROM OLD.sequence
     OR NEW.corrects_document_key IS DISTINCT FROM OLD.corrects_document_key
     OR NEW.reason              IS DISTINCT FROM OLD.reason
     OR NEW.narrative           IS DISTINCT FROM OLD.narrative
     OR NEW.areas               IS DISTINCT FROM OLD.areas
     OR NEW.raised_by           IS DISTINCT FROM OLD.raised_by
     OR NEW.raised_at           IS DISTINCT FROM OLD.raised_at
     OR NEW.document_file_name  IS DISTINCT FROM OLD.document_file_name
     OR NEW.document_storage_key IS DISTINCT FROM OLD.document_storage_key
     OR NEW.document_size_bytes IS DISTINCT FROM OLD.document_size_bytes
     OR NEW.document_checksum_sha256 IS DISTINCT FROM OLD.document_checksum_sha256 THEN
    RAISE EXCEPTION
      'What a correction says cannot be rewritten. Raise another correction instead.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The acknowledgement is recorded once. `not_required` may become
  -- `required`, and `required` may become `recorded`; nothing goes back.
  IF OLD.acknowledgement = 'recorded'
     AND (NEW.acknowledgement            IS DISTINCT FROM OLD.acknowledgement
          OR NEW.acknowledged_by         IS DISTINCT FROM OLD.acknowledged_by
          OR NEW.acknowledgement_method  IS DISTINCT FROM OLD.acknowledgement_method
          OR NEW.acknowledgement_recorded_by IS DISTINCT FROM OLD.acknowledgement_recorded_by
          OR NEW.acknowledgement_recorded_at IS DISTINCT FROM OLD.acknowledgement_recorded_at
          OR NEW.acknowledgement_note    IS DISTINCT FROM OLD.acknowledgement_note) THEN
    RAISE EXCEPTION
      'This correction has already been acknowledged; that record cannot be rewritten.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.acknowledgement = 'not_required' AND OLD.acknowledgement = 'required' THEN
    RAISE EXCEPTION
      'A correction that required the customer''s acknowledgement cannot stop requiring it.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER job_corrections_guard
  BEFORE UPDATE OR DELETE ON job_corrections
  FOR EACH ROW EXECUTE FUNCTION job_corrections_guard();
