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
--> statement-breakpoint
-- STANDBY-DAY-1: day swaps. The weekly schedule is untouched; an approved day
-- swap writes a day's override, and only that day's place changes.
CREATE TABLE IF NOT EXISTS "standby_day_swaps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"requester_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"pairs" jsonb NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'awaiting_recipient' NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"recipient_decided_at" timestamp with time zone,
	"recipient_note" text DEFAULT '' NOT NULL,
	"office_decided_by" uuid,
	"office_decided_at" timestamp with time zone,
	"office_note" text DEFAULT '' NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "standby_day_swaps_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "standby_day_swaps_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "standby_day_swaps_office_decided_by_users_id_fk" FOREIGN KEY ("office_decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "standby_day_swaps_kind_known" CHECK ("kind" IN ('main', 'apprentice')),
	CONSTRAINT "standby_day_swaps_status_known" CHECK ("status" IN ('awaiting_recipient', 'awaiting_office', 'approved', 'denied', 'rejected', 'withdrawn')),
	CONSTRAINT "standby_day_swaps_two_people" CHECK ("requester_id" <> "recipient_id"),
	CONSTRAINT "standby_day_swaps_has_pairs" CHECK (jsonb_typeof("pairs") = 'array' AND jsonb_array_length("pairs") BETWEEN 1 AND 14),
	CONSTRAINT "standby_day_swaps_office_is_another" CHECK ("office_decided_by" IS NULL OR ("office_decided_by" <> "requester_id" AND "office_decided_by" <> "recipient_id"))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "standby_day_swaps_requester_idx" ON "standby_day_swaps" ("requester_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "standby_day_swaps_recipient_idx" ON "standby_day_swaps" ("recipient_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "standby_day_swaps_status_idx" ON "standby_day_swaps" ("status");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "standby_day_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" date NOT NULL,
	"position" text NOT NULL,
	"user_id" uuid NOT NULL,
	"swap_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "standby_day_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "standby_day_overrides_swap_id_standby_day_swaps_id_fk" FOREIGN KEY ("swap_id") REFERENCES "public"."standby_day_swaps"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "standby_day_overrides_position_known" CHECK ("position" IN ('main', 'helper', 'apprentice_1', 'apprentice_2'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "standby_day_overrides_date_position_key" ON "standby_day_overrides" ("date", "position");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "standby_day_overrides_user_idx" ON "standby_day_overrides" ("user_id");--> statement-breakpoint
-- A day swap is history: never deleted; who, what and which days are fixed when
-- it is written; it moves only forward through its two stages.
CREATE OR REPLACE FUNCTION "guard_standby_day_swap"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a standby day swap is part of the record and cannot be deleted (%)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'awaiting_recipient' OR NEW."recipient_decided_at" IS NOT NULL OR NEW."office_decided_by" IS NOT NULL
       OR NEW."office_decided_at" IS NOT NULL OR NEW."withdrawn_at" IS NOT NULL THEN
      RAISE EXCEPTION 'a standby day swap starts by waiting for the person asked' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."requester_id" IS DISTINCT FROM OLD."requester_id"
     OR NEW."recipient_id" IS DISTINCT FROM OLD."recipient_id" OR NEW."pairs" IS DISTINCT FROM OLD."pairs"
     OR NEW."reason" IS DISTINCT FROM OLD."reason" OR NEW."requested_at" IS DISTINCT FROM OLD."requested_at"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'who asked whom for which days is fixed when a standby day swap is written (%)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (
    (OLD."status" = 'awaiting_recipient' AND NEW."status" IN ('awaiting_office', 'denied', 'withdrawn'))
    OR (OLD."status" = 'awaiting_office' AND NEW."status" IN ('approved', 'rejected'))
  ) THEN
    RAISE EXCEPTION 'a standby day swap cannot go from % to %', OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" IN ('approved', 'rejected') AND (NEW."office_decided_by" IS NULL OR NEW."office_decided_at" IS NULL) THEN
    RAISE EXCEPTION 'the Office decision on a standby day swap names who decided and when' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "standby_day_swaps_guard" ON "standby_day_swaps";--> statement-breakpoint
CREATE TRIGGER "standby_day_swaps_guard" BEFORE INSERT OR UPDATE OR DELETE ON "standby_day_swaps"
  FOR EACH ROW EXECUTE FUNCTION "guard_standby_day_swap"();--> statement-breakpoint
-- A day's override: never deleted or moved to another day or place; written
-- only while its day swap awaits the Office's approval (the approval writes the
-- days, then records itself approved, in one transaction); held only by an
-- active technician or apprentice eligible for the place; and only on a day of
-- a PUBLISHED week.
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
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "standby_day_overrides_guard" ON "standby_day_overrides";--> statement-breakpoint
CREATE TRIGGER "standby_day_overrides_guard" BEFORE INSERT OR UPDATE OR DELETE ON "standby_day_overrides"
  FOR EACH ROW EXECUTE FUNCTION "guard_standby_day_override"();
