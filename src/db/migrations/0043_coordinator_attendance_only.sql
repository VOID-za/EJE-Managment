-- A Coordinator's month is attendance only (TS-ROLE-1 — the tester,
-- 1 November 2026: "Coordinators do not work overtime. Coordinators do not
-- need to complete timesheets … Coordinators must still complete their own
-- attendance forms").
--
-- FORWARD-ONLY, ADDITIVE, AND NOTHING EXISTING IS REWRITTEN. Three rules are
-- RELAXED, only as far as that needs; no row is updated or deleted:
--
--   monthly_submissions.timesheet_period_id — may now be NULL: a month sent as
--     attendance alone. Every existing row keeps its timesheet.
--   guard_monthly_submission() — a NULL timesheet is allowed for a user whose
--     role is 'coordinator' when the row is written, and for nobody else; a
--     submission that names a timesheet is held to exactly the old rule (the
--     same person's period, sent, covering exactly the month). Submissions
--     stay write-once.
--   finance_packages_has_attachments — at least ONE attachment (was two): a
--     package holding only a Coordinator's month carries one PDF.
--
-- The release before this one (b946fd3), if it is ever rolled back to, reads
-- a NULL timesheet as "no period" and writes only rows with one.
ALTER TABLE "monthly_submissions" ALTER COLUMN "timesheet_period_id" DROP NOT NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_monthly_submission"() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'the monthly submission % was sent to the office and cannot be changed', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- Attendance only: a Coordinator's month, and nobody else's.
  IF NEW."timesheet_period_id" IS NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM "users" AS person WHERE person."id" = NEW."user_id" AND person."role" = 'coordinator'
    ) THEN
      RAISE EXCEPTION 'a monthly submission without a timesheet is a Coordinator''s only (%)', NEW."month"
        USING ERRCODE = 'check_violation';
    END IF;
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
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "finance_packages" DROP CONSTRAINT "finance_packages_has_attachments";
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint
ALTER TABLE "finance_packages" ADD CONSTRAINT "finance_packages_has_attachments" CHECK ("attachment_count" >= 1 AND "total_bytes" > 0);
