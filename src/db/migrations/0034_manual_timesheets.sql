-- A technician's own timesheet lines. TIMESHEET-2 (27 October 2026): the
-- owner's instruction that timesheets are COMPLETELY MANUAL — customer, normal
-- time, overtime, double time and call-outs typed by the technician, never
-- derived from job cards, labour or call-out flags.
--
-- FORWARD-ONLY AND ADDITIVE. One NEW table; no existing table, column or row is
-- touched and nothing is backfilled. The daily comments (`timesheet_comments`,
-- 0033) are kept exactly as they are. The previous timesheet screen computed
-- its hours on the fly from job labour and stored none, so there is no derived
-- history to convert — and inventing manual entries from it would be the very
-- derivation the owner has ruled out.
--
-- Several lines may share a day (two customers in one day), so there is no
-- unique key on (user, day); a day with no line is unrecorded.
--
-- `IF NOT EXISTS` throughout, so a re-run after a partial apply is harmless.
CREATE TABLE IF NOT EXISTS "timesheet_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"work_date" date NOT NULL,
	"customer_id" uuid REFERENCES "customers"("id") ON DELETE restrict,
	"customer_name" text DEFAULT '' NOT NULL,
	"normal_hours" numeric(5, 2) DEFAULT '0' NOT NULL,
	"overtime_hours" numeric(5, 2) DEFAULT '0' NOT NULL,
	"double_hours" numeric(5, 2) DEFAULT '0' NOT NULL,
	"callouts" integer DEFAULT 0 NOT NULL,
	"updated_by" uuid NOT NULL REFERENCES "users"("id"),
	"recorded_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "timesheet_entries_hours_bounded" CHECK ("normal_hours" between 0 and 24 and "overtime_hours" between 0 and 24 and "double_hours" between 0 and 24),
	CONSTRAINT "timesheet_entries_callouts_bounded" CHECK ("callouts" between 0 and 10),
	CONSTRAINT "timesheet_entries_customer_bounded" CHECK (char_length("customer_name") <= 200)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "timesheet_entries_user_date_idx" ON "timesheet_entries" USING btree ("user_id","work_date");
