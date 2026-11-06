-- 0054 — each form completed on its own, then both submitted to the office together (FORM-LIFECYCLE-1), 6 November 2026.
--
-- The owner's workflow (6 November 2026): Timesheets and Attendance are each
-- COMPLETED on their own page (Completed → name the form → OK). Completing
-- finalises and locks the form and moves it to My Monthly Forms, where it
-- waits; Submit to Office then sends both together as one submission.
--
-- ADDITIVE. One new table; no existing row is updated or deleted. Every
-- timesheet period, snapshot, correction, payroll and monthly submission,
-- Finance package and attendance day stays exactly as stored. The release
-- before this one (v1.6.0, 42e6bd4) runs unchanged against it: it never reads
-- the table.
--
-- payroll_form_completions — one completed form: whose, which (timesheet or
-- attendance), its From and To, the name it was given, its frozen content and
-- the PDF stored at that moment, who completed it and when, and — once both
-- went to the office — the payroll submission it went in. Write-once: the only
-- change ever allowed is setting submission_id, once. At most one form of each
-- kind waits per person (the partial unique key), so a repeated or raced
-- completion is never a second form.
CREATE TABLE IF NOT EXISTS "payroll_form_completions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"kind" text NOT NULL,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"file_name" text NOT NULL,
	"content" jsonb NOT NULL,
	"document" jsonb NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"completed_by" uuid NOT NULL REFERENCES "users"("id"),
	"submission_id" uuid REFERENCES "payroll_submissions"("id") ON DELETE restrict,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_form_completions_kind_known" CHECK ("kind" IN ('timesheet', 'attendance')),
	CONSTRAINT "payroll_form_completions_range_ordered" CHECK ("period_from" <= "period_to"),
	CONSTRAINT "payroll_form_completions_range_bounded" CHECK ("period_to" - "period_from" < 366),
	CONSTRAINT "payroll_form_completions_file_name_bounded" CHECK (char_length("file_name") BETWEEN 5 AND 120)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payroll_form_completions_user_idx" ON "payroll_form_completions" USING btree ("user_id", "completed_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payroll_form_completions_awaiting_key"
  ON "payroll_form_completions" USING btree ("user_id", "kind") WHERE "submission_id" IS NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_payroll_form_completion"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'the completed form % is part of the record and cannot be deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- A completed form is final: only the submission it went in is recorded, once.
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
    OR NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."period_from" IS DISTINCT FROM OLD."period_from"
    OR NEW."period_to" IS DISTINCT FROM OLD."period_to"
    OR NEW."file_name" IS DISTINCT FROM OLD."file_name"
    OR NEW."content" IS DISTINCT FROM OLD."content"
    OR NEW."document" IS DISTINCT FROM OLD."document"
    OR NEW."completed_at" IS DISTINCT FROM OLD."completed_at"
    OR NEW."completed_by" IS DISTINCT FROM OLD."completed_by"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'the completed form % is kept exactly as it was completed', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."submission_id" IS NOT NULL AND NEW."submission_id" IS DISTINCT FROM OLD."submission_id" THEN
    RAISE EXCEPTION 'the completed form % was already submitted to the office', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "payroll_form_completions_guard" ON "payroll_form_completions";--> statement-breakpoint
CREATE TRIGGER "payroll_form_completions_guard" BEFORE UPDATE OR DELETE ON "payroll_form_completions"
  FOR EACH ROW EXECUTE FUNCTION "guard_payroll_form_completion"();
