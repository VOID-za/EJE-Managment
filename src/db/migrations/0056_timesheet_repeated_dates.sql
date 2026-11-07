-- 0056 — repeated dates in timesheets; every submitted LINE recorded once (REPEAT-DATES-1), 7 November 2026.
--
-- The owner's rule (7 November 2026): the same calendar date may legitimately
-- appear in more than one submitted timesheet. A date is never refused, locked
-- or replaced because an earlier submission had it. What is paid once is the
-- WORK LINE: each line of a submitted timesheet belongs to that submission for
-- good, and no line is ever in two submissions.
--
-- Until now one CURRENT submission per person for any day was enforced here
-- (guard_timesheet_period, guard_payroll_submission and the two current-range
-- unique keys): the calendar date was, in effect, the payroll identity. This
-- file moves that identity to the line.
--
-- ADDITIVE AND HISTORY-PRESERVING. No existing row is updated or deleted:
-- every timesheet period and its snapshot, correction, payroll and monthly
-- submission, completion, Finance package and attendance day stays exactly as
-- stored, and so do their write-once guards.
--
--   1. timesheet_submitted_lines — NEW. One row per submitted line (keyed by
--      the line's id): whose, its work date, the sent timesheet period that
--      carried it, when. Filled from every sent snapshot already stored (each
--      line once — a line in a replaced submission and in its replacement is
--      recorded on the current one), then by the trigger below as each new
--      timesheet is sent. Append-only.
--   2. record_timesheet_submitted_lines() — when a timesheet period is SENT,
--      its snapshot's lines are recorded; a line already recorded refuses the
--      whole submission ("timesheet line … is already in a submitted
--      timesheet"), so no line is paid twice whatever its date.
--   3. guard_timesheet_period() — unchanged, except that two sent periods of
--      one person may now share days.
--   4. guard_payroll_submission() — unchanged, except that two submissions of
--      one person may now share days (with a payroll or a monthly submission).
--   5. The one-current-row-per-dates keys: timesheet_periods keeps one UNSENT
--      row per person and dates (the row submitting fills in); payroll
--      submissions get a plain index. Several submissions may have exactly the
--      same From and To.
--
-- ROLLBACK. v1.7.1 runs against this file with one limitation, recorded in
-- docs/payroll-forms.md: its Submit to Office names the old current-range keys
-- in ON CONFLICT, so it fails with nothing written until the release is rolled
-- forward. Everything it reads is unchanged.

-- 1. The line ledger.
CREATE TABLE IF NOT EXISTS "timesheet_submitted_lines" (
	"entry_id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"work_date" date NOT NULL,
	"period_id" uuid NOT NULL REFERENCES "timesheet_periods"("id") ON DELETE restrict,
	"submitted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timesheet_submitted_lines_entry_bounded" CHECK (char_length("entry_id") BETWEEN 1 AND 100)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "timesheet_submitted_lines_user_date_idx" ON "timesheet_submitted_lines" USING btree ("user_id", "work_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "timesheet_submitted_lines_period_idx" ON "timesheet_submitted_lines" USING btree ("period_id");--> statement-breakpoint
INSERT INTO "timesheet_submitted_lines" ("entry_id", "user_id", "work_date", "period_id", "submitted_at")
SELECT DISTINCT ON (line->>'id') line->>'id', sent."user_id", (line->>'date')::date, sent."id", sent."submitted_at"
FROM "timesheet_periods" AS sent
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sent."snapshot"->'entries', '[]'::jsonb)) AS line
WHERE sent."submitted_at" IS NOT NULL AND jsonb_typeof(line) = 'object' AND line ? 'id' AND line ? 'date'
ORDER BY line->>'id', (sent."superseded_at" IS NOT NULL), sent."submitted_at" DESC
ON CONFLICT DO NOTHING;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_timesheet_submitted_line"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'submitted timesheet line % is part of the record and is never changed or deleted', OLD."entry_id"
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "timesheet_submitted_lines_guard" ON "timesheet_submitted_lines";--> statement-breakpoint
CREATE TRIGGER "timesheet_submitted_lines_guard" BEFORE UPDATE OR DELETE ON "timesheet_submitted_lines"
  FOR EACH ROW EXECUTE FUNCTION "guard_timesheet_submitted_line"();--> statement-breakpoint

-- 2. Each line of a timesheet, recorded as it is sent — once, ever.
CREATE OR REPLACE FUNCTION "record_timesheet_submitted_lines"() RETURNS trigger AS $$
DECLARE
  twice text;
BEGIN
  IF NEW."submitted_at" IS NULL OR (TG_OP = 'UPDATE' AND OLD."submitted_at" IS NOT NULL) THEN
    RETURN NULL;
  END IF;
  -- Two submissions racing for one person are made one after the other; the second then sees the first's lines.
  PERFORM pg_advisory_xact_lock(hashtext('timesheet_submitted_lines:' || NEW."user_id"::text));
  SELECT line->>'id' INTO twice
  FROM jsonb_array_elements(COALESCE(NEW."snapshot"->'entries', '[]'::jsonb)) AS line
  JOIN "timesheet_submitted_lines" AS held ON held."entry_id" = line->>'id'
  LIMIT 1;
  IF twice IS NOT NULL THEN
    RAISE EXCEPTION 'timesheet line % is already in a submitted timesheet', twice USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO "timesheet_submitted_lines" ("entry_id", "user_id", "work_date", "period_id", "submitted_at")
  SELECT line->>'id', NEW."user_id", (line->>'date')::date, NEW."id", NEW."submitted_at"
  FROM jsonb_array_elements(COALESCE(NEW."snapshot"->'entries', '[]'::jsonb)) AS line;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "timesheet_periods_record_lines" ON "timesheet_periods";--> statement-breakpoint
CREATE TRIGGER "timesheet_periods_record_lines" AFTER INSERT OR UPDATE ON "timesheet_periods"
  FOR EACH ROW EXECUTE FUNCTION "record_timesheet_submitted_lines"();--> statement-breakpoint

-- 3. A sent period is final — and may share days with another.
CREATE OR REPLACE FUNCTION "guard_timesheet_period"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD."submitted_at" IS NOT NULL THEN
    RAISE EXCEPTION 'timesheet % to % for % was sent to the office and cannot be deleted',
      OLD."period_from", OLD."period_to", OLD."user_id" USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  -- PAYROLL-ONE-1: what was sent is never rewritten. It may only be marked replaced, once.
  IF TG_OP = 'UPDATE' AND OLD."submitted_at" IS NOT NULL AND (
    NEW."user_id" IS DISTINCT FROM OLD."user_id"
    OR NEW."period_from" IS DISTINCT FROM OLD."period_from"
    OR NEW."period_to" IS DISTINCT FROM OLD."period_to"
    OR NEW."submitted_at" IS DISTINCT FROM OLD."submitted_at"
    OR NEW."submitted_by" IS DISTINCT FROM OLD."submitted_by"
    OR NEW."snapshot" IS DISTINCT FROM OLD."snapshot"
    OR NEW."comment" IS DISTINCT FROM OLD."comment"
  ) THEN
    RAISE EXCEPTION 'timesheet % to % for % was sent to the office and is kept exactly as sent',
      OLD."period_from", OLD."period_to", OLD."user_id" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."superseded_at" IS NOT NULL AND NEW."submitted_at" IS NULL THEN
    RAISE EXCEPTION 'only a sent timesheet is replaced by a later one' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."superseded_at" IS NOT NULL AND (
    NEW."superseded_at" IS DISTINCT FROM OLD."superseded_at" OR NEW."superseded_by" IS DISTINCT FROM OLD."superseded_by"
  ) THEN
    RAISE EXCEPTION 'a replaced timesheet stays replaced' USING ERRCODE = 'check_violation';
  END IF;
  -- REPEAT-DATES-1: two sent periods may share days; each LINE is sent once (timesheet_submitted_lines).
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- 4. A payroll submission is write-once — and may share days with another.
CREATE OR REPLACE FUNCTION "guard_payroll_submission"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payroll submission % is part of the record and cannot be deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
      OR NEW."period_from" IS DISTINCT FROM OLD."period_from"
      OR NEW."period_to" IS DISTINCT FROM OLD."period_to"
      OR NEW."finance_month" IS DISTINCT FROM OLD."finance_month"
      OR NEW."timesheet_required" IS DISTINCT FROM OLD."timesheet_required"
      OR NEW."timesheet_period_id" IS DISTINCT FROM OLD."timesheet_period_id"
      OR NEW."attendance_snapshot" IS DISTINCT FROM OLD."attendance_snapshot"
      OR NEW."timesheet_file_name" IS DISTINCT FROM OLD."timesheet_file_name"
      OR NEW."attendance_file_name" IS DISTINCT FROM OLD."attendance_file_name"
      OR NEW."documents" IS DISTINCT FROM OLD."documents"
      OR NEW."submitted_at" IS DISTINCT FROM OLD."submitted_at"
      OR NEW."submitted_by" IS DISTINCT FROM OLD."submitted_by"
      OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
      OR OLD."superseded_at" IS NOT NULL THEN
      RAISE EXCEPTION 'payroll submission % is kept exactly as submitted', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."superseded_by_submission" = NEW."id" THEN
      RAISE EXCEPTION 'a payroll submission cannot replace itself' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."superseded_at" IS NOT NULL THEN
    RAISE EXCEPTION 'a payroll submission starts current' USING ERRCODE = 'check_violation';
  END IF;
  -- The timesheet half: the same person's period, SENT, current, for exactly these dates.
  IF NEW."timesheet_period_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "timesheet_periods" AS sent
    WHERE sent."id" = NEW."timesheet_period_id"
      AND sent."user_id" = NEW."user_id"
      AND sent."submitted_at" IS NOT NULL
      AND sent."superseded_at" IS NULL
      AND sent."period_from" = NEW."period_from"
      AND sent."period_to" = NEW."period_to"
  ) THEN
    RAISE EXCEPTION 'a payroll submission needs the same person''s current sent timesheet for exactly % to %', NEW."period_from", NEW."period_to"
      USING ERRCODE = 'check_violation';
  END IF;
  -- REPEAT-DATES-1: submissions may share days; their timesheet lines are each submitted once (timesheet_submitted_lines).
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- 5. Several submissions may have the very same dates.
CREATE UNIQUE INDEX IF NOT EXISTS "timesheet_periods_user_range_unsent_key"
  ON "timesheet_periods" USING btree ("user_id", "period_from", "period_to") WHERE "superseded_at" IS NULL AND "submitted_at" IS NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "timesheet_periods_user_range_current_key";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payroll_submissions_user_range_idx" ON "payroll_submissions" USING btree ("user_id", "period_from", "period_to");--> statement-breakpoint
DROP INDEX IF EXISTS "payroll_submissions_current_range_key";
