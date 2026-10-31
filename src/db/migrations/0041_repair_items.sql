-- Test & Repair: any number of parts booked in, each with its own quantity
-- (TR-PARTS-1, the tester, 31 October 2026).
--
-- FORWARD-ONLY AND ADDITIVE. One defaulted column; nothing existing is
-- rewritten and nothing is backfilled:
--
--   jobs.more_repair_items — the parts booked in AFTER the first, as a JSON
--     array of { partNumber, description, quantity }. The first part stays in
--     repair_part_number / repair_description / repair_quantity, exactly where
--     every job has always kept it, so every existing job reads the same and
--     the release before this one, if it is ever rolled back to, still reads
--     the first part as it did. An existing job gets '[]': it has one part (or
--     none), which is what it had.
--
-- The column only ever holds an array; the application checks each part (its
-- lengths and a positive whole quantity) before it is written, and reads it
-- defensively. Adding a defaulted column touches no signed job card: the
-- signed-job guards (0007, 0032) watch other columns and are not fired by it.
--
-- `IF NOT EXISTS` / duplicate_object guards throughout, so a re-run is harmless.
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "more_repair_items" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_more_repair_items_array" CHECK (
    jsonb_typeof("more_repair_items") = 'array' AND jsonb_array_length("more_repair_items") <= 199
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
