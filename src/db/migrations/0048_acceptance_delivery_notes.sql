-- 0048 — physical acceptance, workflow improvements and the Delivery Note,
-- 3 November 2026. ADDITIVE: no existing row is rewritten, no column dropped,
-- no historical record touched. Functions are redefined in place
-- (CREATE OR REPLACE); no constraint an earlier migration added is re-added.
--
-- DELIVERY-NOTE-1: the Delivery Note job type. Its delivery date, and the
-- comment on each of its part lines. Both are new and empty everywhere else.
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "delivery_date" date;--> statement-breakpoint
ALTER TABLE "job_parts" ADD COLUMN IF NOT EXISTS "comment" text DEFAULT '' NOT NULL;--> statement-breakpoint
-- The reference row the jobs' foreign key points at. Nothing existing changes.
INSERT INTO "job_types" ("code", "label", "description", "checklist_required", "photos_required", "schedules_date_range",
  "captures_labour_and_travel", "visits_site", "order_number_expectation", "captures_delivery_note", "collected_on_completion",
  "default_priority", "accent", "position")
VALUES ('delivery_note', 'Delivery Note', 'Proof of delivery: the parts handed to a customer or a courier, signed for. No pricing.',
  false, false, false, false, false, 'optional', false, true, 'normal', 'green', 5)
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint
-- A Delivery Note is never priced and never invoiced. The application refuses
-- every price; the database refuses them again, so no path can add one.
CREATE OR REPLACE FUNCTION "guard_delivery_note_job"() RETURNS trigger AS $$
BEGIN
  IF NEW."job_type_code" = 'delivery_note' THEN
    IF NEW."status"::text IN ('office_handling', 'awaiting_delivery', 'awaiting_po', 'awaiting_invoice_no', 'invoiced') THEN
      RAISE EXCEPTION 'a Delivery Note never enters the invoicing workflow (%)', NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."callout_applied" OR NEW."test_bench_applied" THEN
      RAISE EXCEPTION 'a Delivery Note carries no call-out or bench fee' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "jobs_delivery_note_guard" ON "jobs";--> statement-breakpoint
CREATE TRIGGER "jobs_delivery_note_guard" BEFORE INSERT OR UPDATE ON "jobs"
  FOR EACH ROW EXECUTE FUNCTION "guard_delivery_note_job"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_delivery_note_line"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "jobs" AS job WHERE job."id" = NEW."job_id" AND job."job_type_code" = 'delivery_note') THEN
    IF TG_TABLE_NAME = 'job_parts' THEN
      IF NEW."unit_price_cents" <> 0 THEN
        RAISE EXCEPTION 'a Delivery Note part line carries no price' USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      RAISE EXCEPTION 'a Delivery Note carries no % line', TG_TABLE_NAME USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "job_parts_delivery_note_guard" ON "job_parts";--> statement-breakpoint
CREATE TRIGGER "job_parts_delivery_note_guard" BEFORE INSERT OR UPDATE ON "job_parts"
  FOR EACH ROW EXECUTE FUNCTION "guard_delivery_note_line"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "job_labour_delivery_note_guard" ON "job_labour";--> statement-breakpoint
CREATE TRIGGER "job_labour_delivery_note_guard" BEFORE INSERT OR UPDATE ON "job_labour"
  FOR EACH ROW EXECUTE FUNCTION "guard_delivery_note_line"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "job_travel_delivery_note_guard" ON "job_travel";--> statement-breakpoint
CREATE TRIGGER "job_travel_delivery_note_guard" BEFORE INSERT OR UPDATE ON "job_travel"
  FOR EACH ROW EXECUTE FUNCTION "guard_delivery_note_line"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "job_additional_charges_delivery_note_guard" ON "job_additional_charges";--> statement-breakpoint
CREATE TRIGGER "job_additional_charges_delivery_note_guard" BEFORE INSERT OR UPDATE ON "job_additional_charges"
  FOR EACH ROW EXECUTE FUNCTION "guard_delivery_note_line"();--> statement-breakpoint
-- TS-OVERLAP-1: a later submission sharing a day replaces an earlier one. The
-- earlier one is marked superseded — kept, never deleted, never shown — so a
-- person has at most ONE current submission for any day.
ALTER TABLE "timesheet_periods" ADD COLUMN IF NOT EXISTS "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "timesheet_periods" ADD COLUMN IF NOT EXISTS "superseded_by" uuid;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "timesheet_periods" ADD CONSTRAINT "timesheet_periods_superseded_by_users_id_fk"
    FOREIGN KEY ("superseded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_timesheet_period"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD."submitted_at" IS NOT NULL THEN
    RAISE EXCEPTION 'timesheet % to % for % was sent to the office and cannot be deleted',
      OLD."period_from", OLD."period_to", OLD."user_id" USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  -- RESUBMIT-1: a sent period may be saved and sent again — its comment,
  -- snapshot and submission stamp replaced — but never moved, given to another
  -- person, or turned back into a draft.
  IF TG_OP = 'UPDATE' AND OLD."submitted_at" IS NOT NULL AND (
    NEW."user_id" IS DISTINCT FROM OLD."user_id"
    OR NEW."period_from" IS DISTINCT FROM OLD."period_from"
    OR NEW."period_to" IS DISTINCT FROM OLD."period_to"
    OR NEW."submitted_at" IS NULL
  ) THEN
    RAISE EXCEPTION 'timesheet % to % for % was sent to the office: it can be sent again, never moved or unsent',
      OLD."period_from", OLD."period_to", OLD."user_id" USING ERRCODE = 'check_violation';
  END IF;
  -- TS-OVERLAP-1: only a sent period is superseded, and it is current again only by being SENT again.
  IF NEW."superseded_at" IS NOT NULL AND NEW."submitted_at" IS NULL THEN
    RAISE EXCEPTION 'only a sent timesheet is replaced by a later one' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."superseded_at" IS NOT NULL AND NEW."superseded_at" IS NULL
     AND NEW."submitted_at" IS NOT DISTINCT FROM OLD."submitted_at" THEN
    RAISE EXCEPTION 'a replaced timesheet is current again only when it is sent again' USING ERRCODE = 'check_violation';
  END IF;
  -- One CURRENT submission per person for any day (superseded ones do not count).
  IF NEW."submitted_at" IS NOT NULL AND NEW."superseded_at" IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('timesheet_periods:' || NEW."user_id"::text));
    IF EXISTS (
      SELECT 1 FROM "timesheet_periods" AS sent
      WHERE sent."user_id" = NEW."user_id"
        AND sent."id" <> NEW."id"
        AND sent."submitted_at" IS NOT NULL
        AND sent."superseded_at" IS NULL
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
-- STANDBY-ELIG-2 (the owner, 3 November 2026): a Senior Tech may stand in the
-- MAIN and HELPER places, once the Office makes them eligible. Apprentice
-- places stay a technician's or an apprentice's. The role is compared as text.
CREATE OR REPLACE FUNCTION "guard_standby_assignment"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a standby place is part of the record and cannot be deleted (%)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."week_id" IS DISTINCT FROM OLD."week_id" OR NEW."position" IS DISTINCT FROM OLD."position") THEN
    RAISE EXCEPTION 'a standby place cannot be moved to another week or place (%)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."user_id" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."user_id" IS DISTINCT FROM OLD."user_id") THEN
    IF NOT EXISTS (
      SELECT 1
      FROM "users" AS person
      JOIN "standby_eligibility" AS eligible ON eligible."user_id" = person."id"
      WHERE person."id" = NEW."user_id"
        AND person."active"
        AND (person."role"::text IN ('technician', 'apprentice')
             OR (person."role"::text = 'master' AND NEW."position" IN ('main', 'helper')))
        AND CASE
          WHEN NEW."position" = 'main' THEN eligible."may_main"
          WHEN NEW."position" = 'helper' THEN eligible."may_helper"
          ELSE eligible."may_apprentice"
        END
    ) THEN
      RAISE EXCEPTION 'only an active technician, apprentice or Senior Tech eligible for the % place can stand in it', NEW."position"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_standby_day_override"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a standby day is part of the record and cannot be deleted (%)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."date" IS DISTINCT FROM OLD."date" OR NEW."position" IS DISTINCT FROM OLD."position") THEN
    RAISE EXCEPTION 'a standby day cannot be moved to another day or place (%)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "standby_day_swaps" AS swap
    WHERE swap."id" = NEW."swap_id" AND swap."status" = 'awaiting_office'
  ) THEN
    RAISE EXCEPTION 'a standby day changes only when the Office approves a day swap' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "standby_weeks" AS week
    WHERE week."week_start" = NEW."date" - (extract(isodow FROM NEW."date")::int - 1) AND week."status" = 'published'
  ) THEN
    RAISE EXCEPTION 'a standby day can change only in a published week (%)', NEW."date" USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM "users" AS person
    JOIN "standby_eligibility" AS eligible ON eligible."user_id" = person."id"
    WHERE person."id" = NEW."user_id"
      AND person."active"
      AND (person."role"::text IN ('technician', 'apprentice')
           OR (person."role"::text = 'master' AND NEW."position" IN ('main', 'helper')))
      AND CASE
        WHEN NEW."position" = 'main' THEN eligible."may_main"
        WHEN NEW."position" = 'helper' THEN eligible."may_helper"
        ELSE eligible."may_apprentice"
      END
  ) THEN
    RAISE EXCEPTION 'only an active technician, apprentice or Senior Tech eligible for the % place can stand in it', NEW."position"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
