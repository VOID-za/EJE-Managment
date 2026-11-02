-- 0047 — the next critical batch, 2 November 2026. ADDITIVE: no existing row is
-- rewritten, no column dropped, no historical record touched.
--
-- ROLE-APP-1: the `apprentice` role — a Technician in every permission, so the
-- office can tell apprentices apart and place them in apprentice standby
-- positions. The visible renames (Master → Senior Tech, Coordinator → Office)
-- are labels only: the stored values, and every audit record carrying them,
-- are unchanged.
ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS 'apprentice';--> statement-breakpoint
-- A standby place may be held by an active Technician OR Apprentice eligible
-- for it (the role is compared as text, so the new value is not used before
-- this migration commits).
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
        AND person."role"::text IN ('technician', 'apprentice')
        AND CASE
          WHEN NEW."position" = 'main' THEN eligible."may_main"
          WHEN NEW."position" = 'helper' THEN eligible."may_helper"
          ELSE eligible."may_apprentice"
        END
    ) THEN
      RAISE EXCEPTION 'only an active technician or apprentice eligible for the % place can stand in it', NEW."position"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- STANDBY-DAY-1: the two-stage day swap's notifications (Standby subtab).
ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'standby_day_swap_requested';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'standby_day_swap_answered';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'standby_day_swap_for_office';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'standby_day_swap_decided';
--> statement-breakpoint
-- JOB-ATT-3: a job's document may be chosen to travel IN the customer's signed
-- job card email. Existing documents are not chosen (false) — nothing changes
-- for an email already written.
ALTER TABLE "job_media" ADD COLUMN IF NOT EXISTS "email_to_customer" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN IF NOT EXISTS "extra_attachments" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- What an email carries is fixed when it is written: the extra documents too.
CREATE OR REPLACE FUNCTION "email_messages_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An email record is history and is never deleted.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."state" = 'sent' THEN
    RAISE EXCEPTION 'A sent email is never changed.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
     OR NEW."event" IS DISTINCT FROM OLD."event"
     OR NEW."job_id" IS DISTINCT FROM OLD."job_id"
     OR NEW."template_id" IS DISTINCT FROM OLD."template_id"
     OR NEW."template_version_id" IS DISTINCT FROM OLD."template_version_id"
     OR NEW."template_name" IS DISTINCT FROM OLD."template_name"
     OR NEW."template_version" IS DISTINCT FROM OLD."template_version"
     OR NEW."sender" IS DISTINCT FROM OLD."sender"
     OR NEW."recipient" IS DISTINCT FROM OLD."recipient"
     OR NEW."cc" IS DISTINCT FROM OLD."cc"
     OR NEW."subject" IS DISTINCT FROM OLD."subject"
     OR NEW."body" IS DISTINCT FROM OLD."body"
     OR NEW."attachment_storage_key" IS DISTINCT FROM OLD."attachment_storage_key"
     OR NEW."attachment_file_name" IS DISTINCT FROM OLD."attachment_file_name"
     OR NEW."attachment_sha256" IS DISTINCT FROM OLD."attachment_sha256"
     OR NEW."extra_attachments" IS DISTINCT FROM OLD."extra_attachments"
     OR NEW."retry_of" IS DISTINCT FROM OLD."retry_of"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR NEW."created_by" IS DISTINCT FROM OLD."created_by" THEN
    RAISE EXCEPTION 'What an email says, and to whom, is fixed when it is written. A corrected email is a new record.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- CUST-RATES-1: the rate option chosen by the office for each customer. EVERY
-- EXISTING CUSTOMER IS ON DEFAULT RATES: nothing in the register says any of them
-- had rates of its own, so none is assumed to. Their job cards price exactly as
-- before; a signed job card keeps its pricing snapshot whatever changes later.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "rate_mode" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "customers" ADD CONSTRAINT "customers_rate_mode_known" CHECK ("rate_mode" IN ('default', 'custom'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_rates" (
	"customer_id" uuid PRIMARY KEY NOT NULL,
	"labour_normal_cents" bigint NOT NULL,
	"labour_overtime_cents" bigint NOT NULL,
	"labour_double_cents" bigint NOT NULL,
	"callout_rate_cents" bigint NOT NULL,
	"test_bench_fee_cents" bigint NOT NULL,
	"kilometre_rate_cents" bigint NOT NULL,
	"vat_percent_basis_points" integer NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "customer_rates_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "customer_rates_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "customer_rates_non_negative" CHECK ("labour_normal_cents" >= 0 AND "labour_overtime_cents" >= 0 AND "labour_double_cents" >= 0 AND "callout_rate_cents" >= 0 AND "test_bench_fee_cents" >= 0 AND "kilometre_rate_cents" >= 0 AND "vat_percent_basis_points" BETWEEN 0 AND 10000)
);
