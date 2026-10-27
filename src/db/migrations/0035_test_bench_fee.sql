-- The test bench fee. BENCH-1, the owner's instruction of 27 October 2026.
--
-- A configurable fixed fee (like the call-out fee), set by a Master or a
-- Coordinator, ticked per job, charged once, and frozen into the job's pricing
-- snapshot at signature like every other rate.
--
-- FORWARD-ONLY AND ADDITIVE. Three columns, each NOT NULL with a default, so
-- every existing row reads exactly as it did:
--   - system_settings.test_bench_fee_cents defaults to 0 — no fee until the office
--     sets one;
--   - jobs.test_bench_applied defaults to false — no existing job carried the
--     fee, so none is repriced;
--   - pricing_snapshots.test_bench_fee_cents defaults to 0 — a snapshot taken
--     before the fee existed froze no such rate, and its stored totals are
--     untouched.
-- NO ROW IS REWRITTEN and no signed total changes.
--
-- The signed-job guard (0007) is replaced to freeze the new flag alongside the
-- call-out flag: once a customer has signed, whether the fee applies is final.
-- The function body is otherwise identical.
ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "test_bench_fee_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "test_bench_applied" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pricing_snapshots" ADD COLUMN IF NOT EXISTS "test_bench_fee_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "system_settings" DROP CONSTRAINT IF EXISTS "system_settings_test_bench_fee_non_negative";--> statement-breakpoint
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_test_bench_fee_non_negative" CHECK ("test_bench_fee_cents" >= 0);--> statement-breakpoint
CREATE OR REPLACE FUNCTION refuse_signed_jobcard_rewrite()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM job_signatures WHERE job_id = OLD.id) THEN
    RETURN NEW;
  END IF;

  IF NEW.report_fault_findings IS DISTINCT FROM OLD.report_fault_findings
     OR NEW.report_diagnosis      IS DISTINCT FROM OLD.report_diagnosis
     OR NEW.report_work_performed IS DISTINCT FROM OLD.report_work_performed
     OR NEW.callout_applied       IS DISTINCT FROM OLD.callout_applied
     OR NEW.test_bench_applied    IS DISTINCT FROM OLD.test_bench_applied
     OR NEW.order_number          IS DISTINCT FROM OLD.order_number
     OR NEW.reference_number      IS DISTINCT FROM OLD.reference_number
     OR NEW.fault_description     IS DISTINCT FROM OLD.fault_description
  THEN
    RAISE EXCEPTION
      'job % has been signed by the customer; the job card text and charges are final.',
      OLD.job_number
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
