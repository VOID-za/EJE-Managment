-- The owner's decisions of 28 October 2026 on the reviewer's feedback.
-- NOT APPLIED TO PRODUCTION by this change; it ships with 0037 in the next
-- approved release.
--
-- FORWARD-ONLY AND ADDITIVE. Nothing is dropped and no existing row is
-- reinterpreted:
--
--   timesheet_periods — a technician's timesheet for a CHOSEN period (From and
--     To dates), replacing the calendar month 0037 introduced. Any row 0037's
--     `timesheet_months` holds is COPIED across as the period that month
--     covered (first to last day), with its comment, submission and snapshot
--     exactly as they were; `timesheet_months` itself is kept, unwritten from
--     now on. 0037 has never been released, so in practice it is empty.
--     Two SENT periods of one technician may not overlap — no day's work can
--     be sent twice — and a sent period is write-once.
--   notification_type gains 'timesheet_submitted' (TS-02: the office is told).
--   delivery_note_documents — the courier's Delivery Note as ISSUED beside the
--     priced job card (PARTS-03/04): one per job, write-once, recording the job
--     card it accompanies and the one courier signature both documents carry.
--
-- `IF NOT EXISTS` / `CREATE OR REPLACE` throughout, so a re-run after a partial
-- apply is harmless. As in 0032, the new enum value is not USED here.
ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'timesheet_submitted';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "timesheet_periods" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"comment" text DEFAULT '' NOT NULL,
	"updated_by" uuid NOT NULL REFERENCES "users"("id"),
	"commented_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_by" uuid REFERENCES "users"("id"),
	"snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "timesheet_periods_range_valid" CHECK ("period_from" <= "period_to" AND "period_to" - "period_from" < 92),
	CONSTRAINT "timesheet_periods_comment_bounded" CHECK (char_length("comment") <= 2000),
	CONSTRAINT "timesheet_periods_submission_whole" CHECK (
		("submitted_at" IS NULL AND "submitted_by" IS NULL AND "snapshot" IS NULL)
		OR ("submitted_at" IS NOT NULL AND "submitted_by" IS NOT NULL AND "snapshot" IS NOT NULL)
	)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "timesheet_periods_user_range_key" ON "timesheet_periods" USING btree ("user_id","period_from","period_to");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "timesheet_periods_user_idx" ON "timesheet_periods" USING btree ("user_id","period_from");--> statement-breakpoint
-- A SENT PERIOD IS WRITE-ONCE, and two sent periods never overlap. The
-- application refuses both; this refuses them again at the database. The
-- per-technician advisory lock serialises two sends racing for overlapping
-- ranges, so the overlap check cannot be beaten by timing.
CREATE OR REPLACE FUNCTION "guard_timesheet_period"() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD."submitted_at" IS NOT NULL THEN
    RAISE EXCEPTION 'timesheet % to % for % was sent to the office and cannot be changed',
      OLD."period_from", OLD."period_to", OLD."user_id" USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW."submitted_at" IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('timesheet_periods:' || NEW."user_id"::text));
    IF EXISTS (
      SELECT 1 FROM "timesheet_periods" AS sent
      WHERE sent."user_id" = NEW."user_id"
        AND sent."id" <> NEW."id"
        AND sent."submitted_at" IS NOT NULL
        AND sent."period_from" <= NEW."period_to"
        AND sent."period_to" >= NEW."period_from"
    ) THEN
      RAISE EXCEPTION 'timesheet % to % for % overlaps a period already sent to the office',
        NEW."period_from", NEW."period_to", NEW."user_id" USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "timesheet_periods_guard" ON "timesheet_periods";--> statement-breakpoint
CREATE TRIGGER "timesheet_periods_guard" BEFORE INSERT OR UPDATE OR DELETE ON "timesheet_periods"
  FOR EACH ROW EXECUTE FUNCTION "guard_timesheet_period"();--> statement-breakpoint
-- The months 0037 may hold, carried across as the periods they covered.
INSERT INTO "timesheet_periods" (
	"id", "user_id", "period_from", "period_to", "comment", "updated_by", "commented_at",
	"submitted_at", "submitted_by", "snapshot", "created_at", "updated_at", "version"
)
SELECT
	m."id", m."user_id",
	to_date(m."month" || '-01', 'YYYY-MM-DD'),
	(to_date(m."month" || '-01', 'YYYY-MM-DD') + interval '1 month' - interval '1 day')::date,
	m."comment", m."updated_by", m."commented_at",
	m."submitted_at", m."submitted_by",
	CASE WHEN m."snapshot" IS NULL THEN NULL ELSE m."snapshot"
		|| jsonb_build_object(
			'from', m."month" || '-01',
			'to', to_char((to_date(m."month" || '-01', 'YYYY-MM-DD') + interval '1 month' - interval '1 day')::date, 'YYYY-MM-DD')
		) END,
	m."created_at", m."updated_at", m."version"
FROM "timesheet_months" AS m
ON CONFLICT DO NOTHING;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "delivery_note_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL REFERENCES "jobs"("id") ON DELETE restrict,
	"file_name" text NOT NULL,
	"storage_key" text NOT NULL,
	"page_count" integer NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"checksum_sha256" text,
	"generated_at" timestamp with time zone NOT NULL,
	"generated_by" uuid REFERENCES "users"("id"),
	"job_card_document_key" text NOT NULL,
	"signed_by_name" text,
	"signed_at" timestamp with time zone,
	"signature_sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_note_documents_signature_whole" CHECK (
		("signed_at" IS NULL AND "signed_by_name" IS NULL AND "signature_sha256" IS NULL)
		OR ("signed_at" IS NOT NULL AND "signed_by_name" IS NOT NULL AND "signature_sha256" IS NOT NULL)
	)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "delivery_note_documents_job_key" ON "delivery_note_documents" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "delivery_note_documents_storage_key_key" ON "delivery_note_documents" USING btree ("storage_key");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "refuse_delivery_note_rewrite"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'an issued delivery note is write-once (%)', OLD."id" USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "delivery_note_documents_write_once" ON "delivery_note_documents";--> statement-breakpoint
CREATE TRIGGER "delivery_note_documents_write_once" BEFORE UPDATE OR DELETE ON "delivery_note_documents"
  FOR EACH ROW EXECUTE FUNCTION "refuse_delivery_note_rewrite"();
