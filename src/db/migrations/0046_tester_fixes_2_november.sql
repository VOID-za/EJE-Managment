-- The tester's critical fixes of 2 November 2026.
--
-- ADDITIVE, AND NOTHING EXISTING IS REWRITTEN: no row is updated or deleted by
-- this migration. Four things change, each as far as the requirement needs:
--
--   1. INVOICING (INV-FLOW-1). A new job status `awaiting_invoice_no` between
--      `awaiting_po` and `invoiced`, and the customer's PO number on the job
--      (`po_number`, `po_recorded_by`, `po_recorded_at`) — its own columns, not
--      `order_number`, which is part of what the customer signed and stays
--      frozen at signature (0007). The PO is whole or absent, required for
--      Awaiting Invoice No, and never rewritten once recorded (like the
--      invoice number, 0032). Jobs already Awaiting PO stay there: each needs
--      its PO number before its invoice number. Jobs already Invoiced are left
--      exactly as they are, with no PO recorded.
--
--   2. RESUBMISSION (RESUBMIT-1, replacing ATT-LOCK-1 and TS-02's write-once
--      rule). A monthly submission may be REPLACED in place — its attendance
--      snapshot and submission stamp; never its person, month or timesheet
--      period — and is still never deleted. A sent timesheet period may be
--      SENT AGAIN — its snapshot, comment and submission stamp; never its
--      dates or person — is still never deleted, and still never overlaps
--      another sent period. A timesheet correction may be deleted only inside
--      a resubmission of its period (`eje.replacing_submission`), which
--      supersedes it; nothing else may delete one.
--
--   3. ACTIVITY RETENTION (RETAIN-2). The audit trail stays append-only —
--      no event is ever UPDATED — but an event OLDER THAN 7 DAYS may be
--      deleted inside the retention purge (`eje.retention`), and nowhere else.
--      Other append-only tables keep `refuse_mutation()` unchanged.
--
--   4. Notifications need no change: nothing references them, and the purge
--      (RETAIN-1) deletes notification rows only.
--
-- `IF NOT EXISTS`, `CREATE OR REPLACE` and duplicate-tolerant blocks
-- throughout, so a re-run after a partial apply is harmless. The new enum value
-- is not USED in this migration (compared as text), as in 0032.
ALTER TYPE "public"."job_status" ADD VALUE IF NOT EXISTS 'awaiting_invoice_no' AFTER 'awaiting_po';--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "po_number" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "po_recorded_by" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "po_recorded_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_po_recorded_by_users_id_fk"
    FOREIGN KEY ("po_recorded_by") REFERENCES "users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_po_is_whole_or_absent"
    CHECK (("po_number" IS NULL) = ("po_recorded_at" IS NULL)
       AND ("po_number" IS NULL) = ("po_recorded_by" IS NULL)
       AND ("po_number" IS NULL OR "po_number" ~ '[^[:space:]]'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_awaiting_invoice_no_has_po"
    CHECK ("status"::text <> 'awaiting_invoice_no' OR "po_number" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
-- Awaiting Invoice No, like Awaiting PO and Invoiced, has been handled by the office.
ALTER TABLE "jobs" DROP CONSTRAINT IF EXISTS "jobs_awaiting_po_was_handled";--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_awaiting_po_was_handled"
  CHECK ("status"::text NOT IN ('awaiting_po', 'awaiting_invoice_no', 'invoiced') OR "office_handled_at" IS NOT NULL);--> statement-breakpoint
CREATE OR REPLACE FUNCTION refuse_po_number_rewrite()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.po_number IS NOT NULL
     AND (NEW.po_number IS DISTINCT FROM OLD.po_number
       OR NEW.po_recorded_by IS DISTINCT FROM OLD.po_recorded_by
       OR NEW.po_recorded_at IS DISTINCT FROM OLD.po_recorded_at) THEN
    RAISE EXCEPTION
      'job % already records PO %; a PO number is never rewritten.',
      OLD.job_number, OLD.po_number
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS jobs_po_number_frozen ON jobs;--> statement-breakpoint
CREATE TRIGGER jobs_po_number_frozen
  BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION refuse_po_number_rewrite();--> statement-breakpoint
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
CREATE OR REPLACE FUNCTION "guard_timesheet_correction"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- RESUBMIT-1: a period sent again supersedes its corrections; only that removes one.
    IF current_setting('eje.replacing_submission', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'a timesheet correction is part of the record and cannot be deleted (%)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'pending' THEN
      RAISE EXCEPTION 'a timesheet correction starts pending (%)', NEW."id" USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "timesheet_periods" AS sent
      WHERE sent."id" = NEW."period_id" AND sent."user_id" = NEW."user_id" AND sent."submitted_at" IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'only a timesheet sent to the office, by its own technician, can be corrected (%)', NEW."period_id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: the one change allowed is the decision, once, from pending.
  IF OLD."status" <> 'pending' THEN
    RAISE EXCEPTION 'timesheet correction % was already decided and cannot be changed', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" NOT IN ('accepted', 'rejected')
    OR NEW."period_id" IS DISTINCT FROM OLD."period_id"
    OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
    OR NEW."sequence" IS DISTINCT FROM OLD."sequence"
    OR NEW."reason" IS DISTINCT FROM OLD."reason"
    OR NEW."before_snapshot" IS DISTINCT FROM OLD."before_snapshot"
    OR NEW."after_snapshot" IS DISTINCT FROM OLD."after_snapshot"
    OR NEW."requested_by" IS DISTINCT FROM OLD."requested_by"
    OR NEW."requested_at" IS DISTINCT FROM OLD."requested_at" THEN
    RAISE EXCEPTION 'only the decision on timesheet correction % can be recorded', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_audit_event"() RETURNS trigger AS $$
BEGIN
  -- RETAIN-2: an event is never changed; it may be deleted only by the
  -- retention purge, and only once it is older than 7 days.
  IF TG_OP = 'DELETE'
    AND current_setting('eje.retention', true) = 'on'
    AND OLD."occurred_at" < now() - interval '7 days' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_events is append-only: an event is never changed, and is removed only by the 7-day retention purge'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;--> statement-breakpoint
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION "guard_audit_event"();
