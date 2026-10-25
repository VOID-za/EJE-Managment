-- The office lifecycle after submission. Issue #73, Batch 1.
--
--   technician submits the signed job card -> office_handling
--   the office marks it handled            -> awaiting_po
--   the office records the invoice number  -> invoiced
--
-- Email delivery of the customer's copy is tracked on its own (`delivery_*`
-- columns) and no longer moves the status: a confirmed delivery used to close
-- the job, and now changes nothing but the delivery record.
--
-- FORWARD-ONLY AND ADDITIVE. Three enum values appended, five nullable columns,
-- four checks and one trigger. NO ROW IS REWRITTEN:
--   - a historical `closed` job stays `closed` — it was never invoiced through
--     this system, and calling it `invoiced` would be invention;
--   - a `awaiting_delivery` job (submitted before this lifecycle) is left as it
--     is; the application treats that status as waiting on the office and lets
--     the office handle it straight to `awaiting_po`.
--
-- THE CHECKS COMPARE `status::text`, not the new enum literals. drizzle runs
-- every pending migration in ONE transaction, and PostgreSQL refuses to use an
-- enum value inside the transaction that added it ("unsafe use of new value").
-- A text comparison does not use the value, so it is safe here.
ALTER TYPE "public"."job_status" ADD VALUE IF NOT EXISTS 'office_handling';--> statement-breakpoint
ALTER TYPE "public"."job_status" ADD VALUE IF NOT EXISTS 'awaiting_po';--> statement-breakpoint
ALTER TYPE "public"."job_status" ADD VALUE IF NOT EXISTS 'invoiced';--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "office_handled_by" uuid REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "office_handled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "invoice_number" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "invoiced_by" uuid REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "invoiced_at" timestamp with time zone;--> statement-breakpoint
-- New constraints, so the duplicate-safe form is right: no earlier migration
-- defines these names.
DO $$ BEGIN
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_office_handling_is_whole_or_absent"
    CHECK (("office_handled_by" IS NULL) = ("office_handled_at" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_invoice_is_whole_or_absent"
    CHECK (("invoice_number" IS NULL) = ("invoiced_at" IS NULL)
       AND ("invoice_number" IS NULL) = ("invoiced_by" IS NULL)
       AND ("invoice_number" IS NULL OR "invoice_number" ~ '[^[:space:]]'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_awaiting_po_was_handled"
    CHECK ("status"::text NOT IN ('awaiting_po', 'invoiced') OR "office_handled_at" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_invoiced_has_invoice_number"
    CHECK ("status"::text <> 'invoiced' OR "invoice_number" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
-- A RECORDED INVOICE NUMBER IS NEVER REWRITTEN. The application refuses it;
-- this is the second line, as 0002 and 0007 are for the signed record. Setting
-- it for the first time (NULL -> a number) is the one change allowed.
CREATE OR REPLACE FUNCTION refuse_invoice_number_rewrite()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.invoice_number IS NOT NULL
     AND NEW.invoice_number IS DISTINCT FROM OLD.invoice_number THEN
    RAISE EXCEPTION
      'job % already records invoice %; an invoice number is never rewritten.',
      OLD.job_number, OLD.invoice_number
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS jobs_invoice_number_frozen ON jobs;--> statement-breakpoint
CREATE TRIGGER jobs_invoice_number_frozen
  BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION refuse_invoice_number_rewrite();
