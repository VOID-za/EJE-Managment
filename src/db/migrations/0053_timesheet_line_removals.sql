-- 0053 — a removed timesheet line stays removed (PAYROLL-ONE-1 follow-up), 5 November 2026.
--
-- ADDITIVE. One new table; no existing row is updated or deleted, and the
-- release before this one (v1.5.0, cf6fe86) runs unchanged against it — it
-- never reads the table.
--
-- Why: a line's saves and its removal travel separately (a save still on its
-- way when the line is removed; a page left with both in the air; another
-- device still showing the line). Without a record of the removal, a save that
-- arrives after it would write the line back — a confirmed removal silently
-- reversed. The removal now leaves its line id here, and a later save of that
-- id is refused, explicitly (`timesheet_line_removed`).
--
-- Write-once: a removal is never edited or deleted.
CREATE TABLE IF NOT EXISTS "timesheet_line_removals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"removed_by" uuid NOT NULL REFERENCES "users"("id"),
	"removed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_timesheet_line_removal"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'the removal of timesheet line % is part of the record and is kept as it is', OLD."id"
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "timesheet_line_removals_guard" ON "timesheet_line_removals";--> statement-breakpoint
CREATE TRIGGER "timesheet_line_removals_guard" BEFORE UPDATE OR DELETE ON "timesheet_line_removals"
  FOR EACH ROW EXECUTE FUNCTION "guard_timesheet_line_removal"();
