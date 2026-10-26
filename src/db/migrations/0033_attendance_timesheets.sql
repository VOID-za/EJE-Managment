-- The attendance register and the timesheet's daily comments. ATTEND-1,
-- TIMESHEET-1 (26 October 2026).
--
-- FORWARD-ONLY AND ADDITIVE. Two NEW tables; no existing table, column or row
-- is touched. Nothing is backfilled: nobody's attendance or day was recorded
-- before these existed, and inventing either would be fiction. Job labour —
-- where the timesheet's hours come from — is read, never copied or rewritten.
--
-- ONE ROW PER PERSON PER DAY in each table, by unique index, so a second
-- record for the same day cannot exist however many writers race. The
-- application corrects a day by UPDATING its row and keeps the earlier value on
-- the audit trail.
--
-- `IF NOT EXISTS` throughout, so a re-run after a partial apply is harmless.
CREATE TABLE IF NOT EXISTS "attendance" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"work_date" date NOT NULL,
	"status" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"recorded_by" uuid NOT NULL REFERENCES "users"("id"),
	"recorded_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "attendance_status_known" CHECK ("status" in ('present', 'absent')),
	CONSTRAINT "attendance_note_bounded" CHECK (char_length("note") <= 500)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "attendance_user_date_key" ON "attendance" USING btree ("user_id","work_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attendance_date_idx" ON "attendance" USING btree ("work_date");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "timesheet_comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"work_date" date NOT NULL,
	"comment" text NOT NULL,
	"updated_by" uuid NOT NULL REFERENCES "users"("id"),
	"commented_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "timesheet_comments_not_blank" CHECK ("comment" ~ '[^[:space:]]' and char_length("comment") <= 1000)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "timesheet_comments_user_date_key" ON "timesheet_comments" USING btree ("user_id","work_date");
