-- Monthly payroll forms and the Finance package (29 October 2026).
--
-- FORWARD-ONLY AND ADDITIVE. Two nullable/defaulted columns, two new tables;
-- nothing existing is rewritten:
--
--   users.document_name — the technician's name as it appears on their monthly
--     PDFs and in their file names ("JC", "RUAN"). Set by the office. NULL
--     means "not set": the first name, upper-case, is used.
--   system_settings.finance_email — the ONE Finance recipient the monthly
--     package is sent to. Empty means not configured: nothing can be sent.
--   monthly_submissions — a technician's month sent to the office: the
--     timesheet period covering exactly that calendar month, and the month's
--     attendance frozen as it stood. One per technician per month; write-once.
--   finance_packages — one month's payroll package for Finance: who prepared
--     it, the recipient, and a MANIFEST of every attachment (technician,
--     document, file name, storage key, SHA-256, size, page count, version).
--     Its attachments are stored write-once beside it, so what was sent can be
--     established exactly, whatever is corrected later. Sent at most once:
--     the manifest and recipient never change after it is prepared, a sent
--     package never changes at all, and only one package per month may be
--     open (prepared, sending or failed) at a time.
--
-- `IF NOT EXISTS` / `CREATE OR REPLACE` throughout, so a re-run is harmless.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "document_name" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "users" ADD CONSTRAINT "users_document_name_bounded" CHECK (
    "document_name" IS NULL OR char_length("document_name") BETWEEN 1 AND 30
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "finance_email" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "monthly_submissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"month" text NOT NULL,
	"timesheet_period_id" uuid NOT NULL REFERENCES "timesheet_periods"("id") ON DELETE restrict,
	"attendance_snapshot" jsonb NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"submitted_by" uuid NOT NULL REFERENCES "users"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monthly_submissions_month_format" CHECK ("month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "monthly_submissions_user_month_key" ON "monthly_submissions" USING btree ("user_id","month");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "monthly_submissions_period_key" ON "monthly_submissions" USING btree ("timesheet_period_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_monthly_submission"() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'the monthly submission % was sent to the office and cannot be changed', OLD."id"
      USING ERRCODE = 'check_violation';
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
DROP TRIGGER IF EXISTS "monthly_submissions_guard" ON "monthly_submissions";--> statement-breakpoint
CREATE TRIGGER "monthly_submissions_guard" BEFORE INSERT OR UPDATE OR DELETE ON "monthly_submissions"
  FOR EACH ROW EXECUTE FUNCTION "guard_monthly_submission"();--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "finance_packages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"month" text NOT NULL,
	"status" text DEFAULT 'prepared' NOT NULL,
	"recipient" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"attachment_count" integer NOT NULL,
	"total_bytes" integer NOT NULL,
	"prepared_by" uuid NOT NULL REFERENCES "users"("id"),
	"prepared_at" timestamp with time zone NOT NULL,
	"sent_by" uuid REFERENCES "users"("id"),
	"send_started_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"provider_message_id" text,
	"provider_state" text,
	"failure_reason" text DEFAULT '' NOT NULL,
	"failure_kind" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "finance_packages_month_format" CHECK ("month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "finance_packages_status_known" CHECK ("status" IN ('prepared', 'sending', 'sent', 'failed', 'discarded')),
	CONSTRAINT "finance_packages_has_attachments" CHECK ("attachment_count" >= 2 AND "total_bytes" > 0),
	CONSTRAINT "finance_packages_sent_whole" CHECK (
		("status" = 'sent') = ("sent_at" IS NOT NULL AND "sent_by" IS NOT NULL AND "provider_message_id" IS NOT NULL)
	)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "finance_packages_one_open_per_month" ON "finance_packages" USING btree ("month") WHERE "status" IN ('prepared', 'sending', 'failed');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finance_packages_month_idx" ON "finance_packages" USING btree ("month");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_finance_package"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a Finance package is part of the record and cannot be deleted (%)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'prepared' THEN
      RAISE EXCEPTION 'a Finance package starts prepared (%)', NEW."id" USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" IN ('sent', 'discarded') THEN
    RAISE EXCEPTION 'Finance package % is % and cannot be changed', OLD."id", OLD."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."manifest" IS DISTINCT FROM OLD."manifest"
    OR NEW."recipient" IS DISTINCT FROM OLD."recipient"
    OR NEW."month" IS DISTINCT FROM OLD."month"
    OR NEW."attachment_count" IS DISTINCT FROM OLD."attachment_count"
    OR NEW."total_bytes" IS DISTINCT FROM OLD."total_bytes"
    OR NEW."prepared_by" IS DISTINCT FROM OLD."prepared_by"
    OR NEW."prepared_at" IS DISTINCT FROM OLD."prepared_at" THEN
    RAISE EXCEPTION 'what Finance package % holds cannot be changed once prepared', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- The allowed moves: prepared/failed -> sending -> sent/failed; prepared/failed -> discarded.
  IF NOT (
    (OLD."status" IN ('prepared', 'failed') AND NEW."status" IN ('sending', 'discarded'))
    OR (OLD."status" = 'sending' AND NEW."status" IN ('sent', 'failed'))
  ) THEN
    RAISE EXCEPTION 'Finance package % cannot go from % to %', OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "finance_packages_guard" ON "finance_packages";--> statement-breakpoint
CREATE TRIGGER "finance_packages_guard" BEFORE INSERT OR UPDATE OR DELETE ON "finance_packages"
  FOR EACH ROW EXECUTE FUNCTION "guard_finance_package"();
