-- 0050 — timesheets as a digital piece of paper (TS-PAPER), 4 November 2026.
-- ADDITIVE: no row is rewritten or deleted, no column dropped. One check is
-- relaxed, one table added, one trigger function relaxed. The release before
-- this one runs unchanged against it (it keeps its own 92-day rule in code).
--
-- 1. A pay period ends on the real payday, however long that makes it (the
--    December holidays, the finance administrator's leave): the 92-day limit
--    goes; From on or before To stays.
ALTER TABLE "timesheet_periods" DROP CONSTRAINT IF EXISTS "timesheet_periods_range_valid";--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "timesheet_periods" ADD CONSTRAINT "timesheet_periods_range_ordered"
    CHECK ("period_from" <= "period_to");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
-- 2. The comment on the sheet a person is filling in now, before they know
--    the dates it will be submitted for. One row per person; submitting copies
--    it into the snapshot and clears it.
CREATE TABLE IF NOT EXISTS "timesheet_working_comments" (
	"user_id" uuid PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"comment" text DEFAULT '' NOT NULL,
	"updated_by" uuid NOT NULL REFERENCES "users"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "timesheet_working_comments_bounded" CHECK (char_length("comment") <= 2000)
);--> statement-breakpoint
-- 3. The monthly submission is the ATTENDANCE; timesheets are submitted by
--    payday from the Timesheets page. A month may now be submitted without a
--    timesheet by anybody (was: Coordinators only). A submission that names a
--    timesheet is held to exactly the old rule, and every existing row keeps
--    the timesheet it has.
CREATE OR REPLACE FUNCTION "guard_monthly_submission"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'the monthly submission % is the current submission and cannot be deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- RESUBMIT-1: a submission is REPLACED in place — what was submitted and
    -- when — and is never moved to another person, month or timesheet.
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
      OR NEW."month" IS DISTINCT FROM OLD."month"
      OR NEW."timesheet_period_id" IS DISTINCT FROM OLD."timesheet_period_id" THEN
      RAISE EXCEPTION 'the monthly submission % can be replaced, never moved to another person, month or timesheet', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- Attendance only (TS-PAPER): anybody's month.
  IF NEW."timesheet_period_id" IS NULL THEN
    RETURN NEW;
  END IF;
  -- The timesheet half must be the same technician's period, SENT, covering exactly the month.
  IF NOT EXISTS (
    SELECT 1 FROM "timesheet_periods" AS sent
    WHERE sent."id" = NEW."timesheet_period_id"
      AND sent."user_id" = NEW."user_id"
      AND sent."submitted_at" IS NOT NULL
      AND sent."period_from" = to_date(NEW."month" || '-01', 'YYYY-MM-DD')
      AND sent."period_to" = (to_date(NEW."month" || '-01', 'YYYY-MM-DD') + interval '1 month' - interval '1 day')::date
  ) THEN
    RAISE EXCEPTION 'a monthly submission needs the same technician''s sent timesheet for exactly %', NEW."month"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
