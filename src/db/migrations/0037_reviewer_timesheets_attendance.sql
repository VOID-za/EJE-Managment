-- The real-world reviewer's timesheet and attendance changes (28 October 2026).
-- NOT APPLIED TO PRODUCTION by this change; it ships with the next approved
-- release like every other migration.
--
-- FORWARD-ONLY AND ADDITIVE. New nullable or defaulted columns and one new
-- table; no existing row is rewritten and nothing is backfilled:
--
--   attendance.absence_reason (ATT-01) — NULL on every existing row. An absent
--     day recorded before the reason existed keeps none; nothing invents one.
--   timesheet_entries.workshop (TS-06) — false on every existing line.
--   timesheet_entries.callout_amount_cents, callout_shared (TS-08) — 0 / false.
--     The old whole-number `callouts` count stays exactly as it was, shown as
--     historical; it is never converted into an amount.
--   timesheet_entries.internal_km, customer_km (TS-09) — 0. No existing value
--     is reinterpreted as either kind of kilometre.
--   `normal_hours` (NT, TS-07) is KEPT: new lines carry 0, old lines keep the
--     value they were given.
--   timesheet_months (TS-02/03/10) — one row per technician per month: the one
--     comment for the whole timesheet, and the submission to the office with
--     the snapshot of what was sent. Empty until somebody writes.
--
-- `IF NOT EXISTS` throughout, so a re-run after a partial apply is harmless.
ALTER TABLE "attendance" ADD COLUMN IF NOT EXISTS "absence_reason" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "attendance" ADD CONSTRAINT "attendance_absence_reason_known" CHECK (
    "absence_reason" IS NULL
    OR ("status" = 'absent' AND "absence_reason" IN ('leave', 'sick_leave', 'family_responsibility', 'iod'))
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD COLUMN IF NOT EXISTS "workshop" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD COLUMN IF NOT EXISTS "callout_amount_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD COLUMN IF NOT EXISTS "callout_shared" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD COLUMN IF NOT EXISTS "internal_km" numeric(7, 1) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD COLUMN IF NOT EXISTS "customer_km" numeric(7, 1) DEFAULT '0' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_reviewer_bounded" CHECK (
    "callout_amount_cents" BETWEEN 0 AND 100000000
    AND "internal_km" BETWEEN 0 AND 10000
    AND "customer_km" BETWEEN 0 AND 10000
    AND NOT ("workshop" AND "customer_id" IS NOT NULL)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "timesheet_months" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"month" text NOT NULL,
	"comment" text DEFAULT '' NOT NULL,
	"updated_by" uuid NOT NULL REFERENCES "users"("id"),
	"commented_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_by" uuid REFERENCES "users"("id"),
	"snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "timesheet_months_month_format" CHECK ("month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "timesheet_months_comment_bounded" CHECK (char_length("comment") <= 2000),
	CONSTRAINT "timesheet_months_submission_whole" CHECK (
		("submitted_at" IS NULL AND "submitted_by" IS NULL AND "snapshot" IS NULL)
		OR ("submitted_at" IS NOT NULL AND "submitted_by" IS NOT NULL AND "snapshot" IS NOT NULL)
	)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "timesheet_months_user_month_key" ON "timesheet_months" USING btree ("user_id","month");--> statement-breakpoint
-- A SUBMITTED MONTH IS WRITE-ONCE. The application refuses every change; this
-- refuses it again at the database, so no path — a script, a future bug — can
-- rewrite what was sent to the office or un-send it.
CREATE OR REPLACE FUNCTION "refuse_submitted_timesheet_rewrite"() RETURNS trigger AS $$
BEGIN
  IF OLD."submitted_at" IS NOT NULL THEN
    RAISE EXCEPTION 'timesheet % for % was sent to the office and cannot be changed', OLD."month", OLD."user_id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "timesheet_months_write_once" ON "timesheet_months";--> statement-breakpoint
CREATE TRIGGER "timesheet_months_write_once" BEFORE UPDATE OR DELETE ON "timesheet_months"
  FOR EACH ROW EXECUTE FUNCTION "refuse_submitted_timesheet_rewrite"();
