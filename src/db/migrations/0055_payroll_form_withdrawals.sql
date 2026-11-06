-- 0055 — a completed form withdrawn before Submit to Office, and corrected as a separate draft (FORM-WITHDRAW-1), 6 November 2026.
--
-- The owner's rule (6 November 2026): a COMPLETED form can be withdrawn while
-- it waits on My Monthly Forms; once it is submitted to the office, never.
-- The completed form stays in the record exactly as it was completed — its
-- content and its PDF are never changed — and the correction is a separate
-- draft that must be completed again before it can be submitted.
--
-- ADDITIVE. Two columns on payroll_form_completions (empty on every existing
-- row), one new table, and the one-form-awaiting key rebuilt so that a
-- withdrawn form no longer counts as awaiting. No existing row is updated or
-- deleted: every completion, payroll and monthly submission, timesheet period,
-- correction, Finance package and attendance day stays exactly as stored.
--
-- payroll_form_completions.withdrawn_at / withdrawn_by — set once, together,
-- and only while the form has not been submitted; a withdrawn form can never
-- be submitted (the guard below). corrects_id — on a completed CORRECTION, the
-- withdrawn form it corrects; set when it is completed, never changed, at most
-- one completed correction per withdrawn form.
--
-- payroll_form_correction_drafts — the editable draft a withdrawal opens:
-- whose, which form, its From and To (the withdrawn form's), the withdrawn
-- form it corrects (one draft per withdrawn form), and — once completed again
-- — the completed correction. Write-once apart from that one link. At most one
-- draft of each kind is open per person.
ALTER TABLE "payroll_form_completions" ADD COLUMN IF NOT EXISTS "withdrawn_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payroll_form_completions" ADD COLUMN IF NOT EXISTS "withdrawn_by" uuid REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "payroll_form_completions" ADD COLUMN IF NOT EXISTS "corrects_id" uuid REFERENCES "payroll_form_completions"("id") ON DELETE restrict;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payroll_form_completions" ADD CONSTRAINT "payroll_form_completions_withdrawn_together"
    CHECK (("withdrawn_at" IS NULL) = ("withdrawn_by" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payroll_form_completions" ADD CONSTRAINT "payroll_form_completions_withdrawn_or_submitted"
    CHECK ("withdrawn_at" IS NULL OR "submission_id" IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payroll_form_completions_corrects_key"
  ON "payroll_form_completions" USING btree ("corrects_id") WHERE "corrects_id" IS NOT NULL;--> statement-breakpoint
-- At most one form of each kind awaits per person — a withdrawn one no longer awaits.
DROP INDEX IF EXISTS "payroll_form_completions_awaiting_key";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payroll_form_completions_awaiting_key"
  ON "payroll_form_completions" USING btree ("user_id", "kind") WHERE "submission_id" IS NULL AND "withdrawn_at" IS NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_payroll_form_completion"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'the completed form % is part of the record and cannot be deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- A completed correction corrects a WITHDRAWN form of the same person, kind and dates.
    IF NEW."corrects_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "payroll_form_completions" o
      WHERE o."id" = NEW."corrects_id" AND o."withdrawn_at" IS NOT NULL AND o."user_id" = NEW."user_id"
        AND o."kind" = NEW."kind" AND o."period_from" = NEW."period_from" AND o."period_to" = NEW."period_to"
    ) THEN
      RAISE EXCEPTION 'a correction corrects a withdrawn form of the same person, form and dates'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."withdrawn_at" IS NOT NULL OR NEW."submission_id" IS NOT NULL THEN
      RAISE EXCEPTION 'a form is completed awaiting submission'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- A completed form is final: only the submission it went in, or its withdrawal, is recorded — once.
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
    OR NEW."corrects_id" IS DISTINCT FROM OLD."corrects_id"
  THEN
    RAISE EXCEPTION 'the completed form % is kept exactly as it was completed', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."submission_id" IS NOT NULL AND NEW."submission_id" IS DISTINCT FROM OLD."submission_id" THEN
    RAISE EXCEPTION 'the completed form % was already submitted to the office', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."withdrawn_at" IS NOT NULL AND (NEW."withdrawn_at" IS DISTINCT FROM OLD."withdrawn_at" OR NEW."withdrawn_by" IS DISTINCT FROM OLD."withdrawn_by") THEN
    RAISE EXCEPTION 'the completed form % was already withdrawn', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."withdrawn_at" IS NOT NULL AND NEW."submission_id" IS NOT NULL THEN
    RAISE EXCEPTION 'the completed form % was withdrawn, so it is never submitted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."submission_id" IS NOT NULL AND NEW."withdrawn_at" IS NOT NULL THEN
    RAISE EXCEPTION 'the completed form % was submitted to the office, so it cannot be withdrawn', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "payroll_form_completions_guard" ON "payroll_form_completions";--> statement-breakpoint
CREATE TRIGGER "payroll_form_completions_guard" BEFORE INSERT OR UPDATE OR DELETE ON "payroll_form_completions"
  FOR EACH ROW EXECUTE FUNCTION "guard_payroll_form_completion"();--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_form_correction_drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"kind" text NOT NULL,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"withdrawn_id" uuid NOT NULL REFERENCES "payroll_form_completions"("id") ON DELETE restrict,
	"completed_id" uuid REFERENCES "payroll_form_completions"("id") ON DELETE restrict,
	"opened_at" timestamp with time zone NOT NULL,
	"opened_by" uuid NOT NULL REFERENCES "users"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_form_correction_drafts_kind_known" CHECK ("kind" IN ('timesheet', 'attendance')),
	CONSTRAINT "payroll_form_correction_drafts_range_ordered" CHECK ("period_from" <= "period_to")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payroll_form_correction_drafts_withdrawn_key" ON "payroll_form_correction_drafts" USING btree ("withdrawn_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payroll_form_correction_drafts_completed_key" ON "payroll_form_correction_drafts" USING btree ("completed_id") WHERE "completed_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payroll_form_correction_drafts_open_key"
  ON "payroll_form_correction_drafts" USING btree ("user_id", "kind") WHERE "completed_id" IS NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_payroll_form_correction_draft"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'the correction draft % is part of the record and cannot be deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- A draft corrects a withdrawn form of the same person, kind and dates.
    IF NOT EXISTS (
      SELECT 1 FROM "payroll_form_completions" o
      WHERE o."id" = NEW."withdrawn_id" AND o."withdrawn_at" IS NOT NULL AND o."user_id" = NEW."user_id"
        AND o."kind" = NEW."kind" AND o."period_from" = NEW."period_from" AND o."period_to" = NEW."period_to"
    ) OR NEW."completed_id" IS NOT NULL THEN
      RAISE EXCEPTION 'a correction draft opens on a withdrawn form of the same person, form and dates'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
    OR NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."period_from" IS DISTINCT FROM OLD."period_from"
    OR NEW."period_to" IS DISTINCT FROM OLD."period_to"
    OR NEW."withdrawn_id" IS DISTINCT FROM OLD."withdrawn_id"
    OR NEW."opened_at" IS DISTINCT FROM OLD."opened_at"
    OR NEW."opened_by" IS DISTINCT FROM OLD."opened_by"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR (OLD."completed_id" IS NOT NULL AND NEW."completed_id" IS DISTINCT FROM OLD."completed_id")
  THEN
    RAISE EXCEPTION 'the correction draft % is kept as it was opened; only its completion is recorded, once', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- Completed by the correction of this very withdrawn form.
  IF NEW."completed_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "payroll_form_completions" c WHERE c."id" = NEW."completed_id" AND c."corrects_id" = NEW."withdrawn_id"
  ) THEN
    RAISE EXCEPTION 'the correction draft % is completed by the correction of its own withdrawn form', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "payroll_form_correction_drafts_guard" ON "payroll_form_correction_drafts";--> statement-breakpoint
CREATE TRIGGER "payroll_form_correction_drafts_guard" BEFORE INSERT OR UPDATE OR DELETE ON "payroll_form_correction_drafts"
  FOR EACH ROW EXECUTE FUNCTION "guard_payroll_form_correction_draft"();
