-- 0052 — payroll forms submitted together for a From–To period (PAYROLL-ONE-1), 5 November 2026.
--
-- The owner's decisions (5 November 2026): My Monthly Forms is the ONE place a
-- person submits; the timesheet and the attendance go TOGETHER for exactly the
-- same From and To; the Finance month is the month of To; a partial overlap is
-- refused; a complete replacement is explicit and keeps the original; a person
-- who keeps no timesheet submits attendance alone; incomplete timesheet lines
-- are kept as drafts and block the submission; the working PDFs keep the name
-- the person gives them, and a submitted document keeps the name it went with.
--
-- ADDITIVE AND HISTORY-PRESERVING. No row is updated or deleted by this file.
-- Every existing timesheet period, snapshot, correction, monthly submission,
-- Finance package and attendance day stays exactly as stored.
--
--   1. timesheet_periods — one CURRENT row per person and dates (was: one row
--      for ever), so replacing a submission with the very same dates keeps the
--      original row, marked replaced.
--   2. guard_timesheet_period() — a SENT period is final: its snapshot,
--      comment and submission stamp never change; it is only marked replaced,
--      once. (RESUBMIT-1's in-place rewrite has had no caller since TS-PAPER.)
--   3. monthly_submissions — the calendar-month attendance submissions made
--      before this release are history: never rewritten again (RESUBMIT-1's
--      in-place replacement ends), only marked replaced, once, by a payroll
--      submission covering all of the month. Three nullable columns.
--   4. payroll_submissions — the new submission (the "replaced by" links are
--      checked at commit, so a replacement and what it replaces are written
--      in one transaction in either order): person, From, To, Finance
--      month, whether a timesheet was required, the timesheet period it
--      submitted, the attendance frozen as it stood, the file names it went
--      with and the stored PDFs. Write-once; one current per person for any day.
--   5. payroll_document_names — the name a person gave a WORKING PDF.
--   6. timesheet_line_drafts — a timesheet line typed but not yet complete.
--
-- ROLLBACK. The release before this one (v1.4.0) runs against it, with one
-- limitation recorded in docs/deploy-next-release.md: its own "Submit
-- timesheet" asks for the old full unique key in ON CONFLICT, which (1)
-- replaces, so that button fails without writing anything. Everything it reads
-- is unchanged.

-- 1. One current row per person and dates.
CREATE UNIQUE INDEX IF NOT EXISTS "timesheet_periods_user_range_current_key"
  ON "timesheet_periods" USING btree ("user_id", "period_from", "period_to") WHERE "superseded_at" IS NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "timesheet_periods_user_range_key";--> statement-breakpoint

-- 2. A sent period is final.
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
  -- One CURRENT submission per person for any day (replaced ones do not count).
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

-- 4 (first, so 3 can name it). The payroll submission.
CREATE TABLE IF NOT EXISTS "payroll_submissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"finance_month" text NOT NULL,
	"timesheet_required" boolean NOT NULL,
	"timesheet_period_id" uuid REFERENCES "timesheet_periods"("id") ON DELETE restrict,
	"attendance_snapshot" jsonb NOT NULL,
	"timesheet_file_name" text NOT NULL,
	"attendance_file_name" text NOT NULL,
	"documents" jsonb NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"submitted_by" uuid NOT NULL REFERENCES "users"("id"),
	"superseded_at" timestamp with time zone,
	"superseded_by" uuid REFERENCES "users"("id"),
	"superseded_by_submission" uuid REFERENCES "payroll_submissions"("id") DEFERRABLE INITIALLY DEFERRED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_submissions_range_ordered" CHECK ("period_from" <= "period_to"),
	CONSTRAINT "payroll_submissions_range_bounded" CHECK ("period_to" - "period_from" < 366),
	CONSTRAINT "payroll_submissions_finance_month_of_to" CHECK ("finance_month" = to_char("period_to", 'YYYY-MM')),
	CONSTRAINT "payroll_submissions_timesheet_whole" CHECK ("timesheet_required" = ("timesheet_period_id" IS NOT NULL)),
	CONSTRAINT "payroll_submissions_file_names_bounded" CHECK (
		char_length("attendance_file_name") BETWEEN 5 AND 120
		AND (char_length("timesheet_file_name") BETWEEN 5 AND 120 OR (NOT "timesheet_required" AND "timesheet_file_name" = ''))
	),
	CONSTRAINT "payroll_submissions_superseded_whole" CHECK (
		("superseded_at" IS NULL AND "superseded_by" IS NULL AND "superseded_by_submission" IS NULL)
		OR ("superseded_at" IS NOT NULL AND "superseded_by" IS NOT NULL AND "superseded_by_submission" IS NOT NULL)
	)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payroll_submissions_user_idx" ON "payroll_submissions" USING btree ("user_id", "period_from");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payroll_submissions_finance_month_idx" ON "payroll_submissions" USING btree ("finance_month");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payroll_submissions_timesheet_key" ON "payroll_submissions" USING btree ("timesheet_period_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payroll_submissions_current_range_key"
  ON "payroll_submissions" USING btree ("user_id", "period_from", "period_to") WHERE "superseded_at" IS NULL;--> statement-breakpoint

-- 3. The monthly submissions made before this release: history, replaced only by a covering payroll submission.
ALTER TABLE "monthly_submissions" ADD COLUMN IF NOT EXISTS "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "monthly_submissions" ADD COLUMN IF NOT EXISTS "superseded_by" uuid;--> statement-breakpoint
ALTER TABLE "monthly_submissions" ADD COLUMN IF NOT EXISTS "superseded_by_submission" uuid;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "monthly_submissions" ADD CONSTRAINT "monthly_submissions_superseded_by_users_id_fk"
    FOREIGN KEY ("superseded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "monthly_submissions" ADD CONSTRAINT "monthly_submissions_superseded_by_submission_fk"
    FOREIGN KEY ("superseded_by_submission") REFERENCES "public"."payroll_submissions"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_monthly_submission"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'the monthly submission % is part of the record and cannot be deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- PAYROLL-ONE-1: what was submitted is never rewritten; it is only marked replaced, once.
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
      OR NEW."month" IS DISTINCT FROM OLD."month"
      OR NEW."timesheet_period_id" IS DISTINCT FROM OLD."timesheet_period_id"
      OR NEW."attendance_snapshot" IS DISTINCT FROM OLD."attendance_snapshot"
      OR NEW."submitted_at" IS DISTINCT FROM OLD."submitted_at"
      OR NEW."submitted_by" IS DISTINCT FROM OLD."submitted_by"
      OR OLD."superseded_at" IS NOT NULL THEN
      RAISE EXCEPTION 'the monthly submission % is kept exactly as submitted', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."superseded_at" IS NULL OR NEW."superseded_by" IS NULL OR NEW."superseded_by_submission" IS NULL THEN
      RAISE EXCEPTION 'the monthly submission % is replaced by a payroll submission, named, by somebody, at a time', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."superseded_at" IS NOT NULL OR NEW."superseded_by" IS NOT NULL OR NEW."superseded_by_submission" IS NOT NULL THEN
    RAISE EXCEPTION 'a monthly submission starts current' USING ERRCODE = 'check_violation';
  END IF;
  -- No attendance day is submitted twice: a month may not overlap a current payroll submission.
  IF EXISTS (
    SELECT 1 FROM "payroll_submissions" AS sent
    WHERE sent."user_id" = NEW."user_id"
      AND sent."superseded_at" IS NULL
      AND sent."period_from" <= (to_date(NEW."month" || '-01', 'YYYY-MM-DD') + interval '1 month' - interval '1 day')::date
      AND sent."period_to" >= to_date(NEW."month" || '-01', 'YYYY-MM-DD')
  ) THEN
    RAISE EXCEPTION 'the month % shares days with a payroll submission already made', NEW."month"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."timesheet_period_id" IS NULL THEN
    RETURN NEW;
  END IF;
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
  -- One CURRENT submission per person for any day, across both kinds of submission.
  PERFORM pg_advisory_xact_lock(hashtext('payroll_submissions:' || NEW."user_id"::text));
  IF EXISTS (
    SELECT 1 FROM "payroll_submissions" AS sent
    WHERE sent."user_id" = NEW."user_id"
      AND sent."id" <> NEW."id"
      AND sent."superseded_at" IS NULL
      AND sent."period_from" <= NEW."period_to"
      AND sent."period_to" >= NEW."period_from"
  ) THEN
    RAISE EXCEPTION 'payroll submission % to % for % overlaps one already made', NEW."period_from", NEW."period_to", NEW."user_id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "monthly_submissions" AS month
    WHERE month."user_id" = NEW."user_id"
      AND month."superseded_at" IS NULL
      AND to_date(month."month" || '-01', 'YYYY-MM-DD') <= NEW."period_to"
      AND (to_date(month."month" || '-01', 'YYYY-MM-DD') + interval '1 month' - interval '1 day')::date >= NEW."period_from"
  ) THEN
    RAISE EXCEPTION 'payroll submission % to % for % overlaps a monthly submission already made', NEW."period_from", NEW."period_to", NEW."user_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "payroll_submissions_guard" ON "payroll_submissions";--> statement-breakpoint
CREATE TRIGGER "payroll_submissions_guard" BEFORE INSERT OR UPDATE OR DELETE ON "payroll_submissions"
  FOR EACH ROW EXECUTE FUNCTION "guard_payroll_submission"();--> statement-breakpoint

-- 5. The name a person gave a working PDF. Metadata only: never a storage path.
CREATE TABLE IF NOT EXISTS "payroll_document_names" (
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"kind" text NOT NULL,
	"file_name" text NOT NULL,
	"updated_by" uuid NOT NULL REFERENCES "users"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "payroll_document_names_pk" PRIMARY KEY ("user_id", "kind"),
	CONSTRAINT "payroll_document_names_kind_known" CHECK ("kind" IN ('timesheet', 'attendance')),
	CONSTRAINT "payroll_document_names_safe" CHECK (
		char_length("file_name") BETWEEN 5 AND 120
		AND "file_name" ~* '\.pdf$'
		AND "file_name" !~ '[/\\:*?"<>|[:cntrl:]]'
		AND left("file_name", 1) <> '.'
		AND position('..' in "file_name") = 0
	)
);--> statement-breakpoint

-- 6. A timesheet line typed but not complete yet: kept, shown, and blocking the submission.
CREATE TABLE IF NOT EXISTS "timesheet_line_drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"work_date" date,
	"typed" jsonb NOT NULL,
	"updated_by" uuid NOT NULL REFERENCES "users"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "timesheet_line_drafts_typed_bounded" CHECK (octet_length("typed"::text) <= 4000)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "timesheet_line_drafts_user_idx" ON "timesheet_line_drafts" USING btree ("user_id", "work_date");
