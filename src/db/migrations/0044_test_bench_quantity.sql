-- A quantity on the test bench fee (BENCH-QTY-1 — the tester, 1 November 2026:
-- "Add a quantity field for the Test bench fee. Default quantity: 1").
--
-- FORWARD-ONLY AND ADDITIVE. One column, NOT NULL with a default of 1, so every
-- existing row reads exactly as it did: a job that carried the fee carried it
-- ONCE, and quantity × rate = 1 × rate is the amount it was always charged.
-- NO ROW IS REWRITTEN, no snapshot is touched, and no signed total changes.
--
--   jobs.test_bench_quantity — how many times the test bench fee applies,
--     1 to 99 (a check). Counts only while test_bench_applied is true.
--
-- The signed-job guard (0007, replaced by 0035) is replaced once more to freeze
-- the quantity beside the flag: once a customer has signed, how many bench fees
-- the job carries is final. The function body is otherwise identical to 0035's.
--
-- The release before this one (7c0ca94), if it is ever rolled back to, never
-- reads or writes the new column; its default keeps that code's inserts valid.
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "test_bench_quantity" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT IF EXISTS "jobs_test_bench_quantity_range";--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_test_bench_quantity_range" CHECK ("test_bench_quantity" BETWEEN 1 AND 99);--> statement-breakpoint
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
     OR NEW.test_bench_quantity   IS DISTINCT FROM OLD.test_bench_quantity
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
