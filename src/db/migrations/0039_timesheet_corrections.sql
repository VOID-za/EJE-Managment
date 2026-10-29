-- The correction of a timesheet already sent to the office (29 October 2026).
-- Ships with 0037 and 0038 in the same release.
--
-- FORWARD-ONLY AND ADDITIVE. One new table, two new notification types;
-- nothing existing is touched:
--
--   timesheet_corrections — a correction of ONE sent period, requested by the
--     technician whose timesheet it is, with a reason, and decided once by the
--     office (a Master or a Coordinator who did not request it): accepted or
--     rejected. It records the complete version it corrects (`before_snapshot`
--     — the original submission, or the correction last accepted) and the
--     complete corrected version (`after_snapshot`). The sent period and its
--     snapshot are NEVER changed: the original submission stays exactly as it
--     was sent, and the version in force is the one last accepted.
--
-- WHAT THE DATABASE ITSELF REFUSES, whatever the application does:
--   - a correction of a period that has not been sent, or of somebody else's;
--   - a second correction PENDING for the same period (a retry cannot open two);
--   - a decision taken twice, or reversed; a correction deleted; any change to
--     what was requested (reason, versions, requester, time);
--   - a decision by the person who requested it; a rejection without a note.
-- A correction covers exactly its period's days — it has no dates of its own —
-- so it cannot create a period, or overlap one.
--
-- `IF NOT EXISTS` / `CREATE OR REPLACE` throughout, so a re-run after a partial
-- apply is harmless. As in 0032 and 0038, the new enum values are not USED here.
ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'timesheet_correction_requested';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'timesheet_correction_decided';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "timesheet_corrections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"period_id" uuid NOT NULL REFERENCES "timesheet_periods"("id") ON DELETE restrict,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"sequence" integer NOT NULL,
	"reason" text NOT NULL,
	"before_snapshot" jsonb NOT NULL,
	"after_snapshot" jsonb NOT NULL,
	"requested_by" uuid NOT NULL REFERENCES "users"("id"),
	"requested_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid REFERENCES "users"("id"),
	"decided_at" timestamp with time zone,
	"decision_note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "timesheet_corrections_sequence_positive" CHECK ("sequence" >= 1),
	CONSTRAINT "timesheet_corrections_status_known" CHECK ("status" IN ('pending', 'accepted', 'rejected')),
	CONSTRAINT "timesheet_corrections_reason_given" CHECK (char_length(btrim("reason")) BETWEEN 1 AND 2000),
	CONSTRAINT "timesheet_corrections_note_bounded" CHECK (char_length("decision_note") <= 2000),
	CONSTRAINT "timesheet_corrections_decision_whole" CHECK (
		("status" = 'pending' AND "decided_by" IS NULL AND "decided_at" IS NULL)
		OR ("status" <> 'pending' AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL)
	),
	CONSTRAINT "timesheet_corrections_decided_by_another" CHECK ("decided_by" IS NULL OR "decided_by" <> "requested_by"),
	CONSTRAINT "timesheet_corrections_rejection_explained" CHECK ("status" <> 'rejected' OR char_length(btrim("decision_note")) > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "timesheet_corrections_period_sequence_key" ON "timesheet_corrections" USING btree ("period_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "timesheet_corrections_one_pending_key" ON "timesheet_corrections" USING btree ("period_id") WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "timesheet_corrections_user_idx" ON "timesheet_corrections" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "timesheet_corrections_status_idx" ON "timesheet_corrections" USING btree ("status");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_timesheet_correction"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a timesheet correction is part of the record and cannot be deleted (%)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'pending' THEN
      RAISE EXCEPTION 'a timesheet correction starts pending (%)', NEW."id" USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "timesheet_periods" AS sent
      WHERE sent."id" = NEW."period_id" AND sent."user_id" = NEW."user_id" AND sent."submitted_at" IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'only a timesheet sent to the office, by its own technician, can be corrected (%)', NEW."period_id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: the one change allowed is the decision, once, from pending.
  IF OLD."status" <> 'pending' THEN
    RAISE EXCEPTION 'timesheet correction % was already decided and cannot be changed', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" NOT IN ('accepted', 'rejected')
    OR NEW."period_id" IS DISTINCT FROM OLD."period_id"
    OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
    OR NEW."sequence" IS DISTINCT FROM OLD."sequence"
    OR NEW."reason" IS DISTINCT FROM OLD."reason"
    OR NEW."before_snapshot" IS DISTINCT FROM OLD."before_snapshot"
    OR NEW."after_snapshot" IS DISTINCT FROM OLD."after_snapshot"
    OR NEW."requested_by" IS DISTINCT FROM OLD."requested_by"
    OR NEW."requested_at" IS DISTINCT FROM OLD."requested_at" THEN
    RAISE EXCEPTION 'only the decision on timesheet correction % can be recorded', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "timesheet_corrections_guard" ON "timesheet_corrections";--> statement-breakpoint
CREATE TRIGGER "timesheet_corrections_guard" BEFORE INSERT OR UPDATE OR DELETE ON "timesheet_corrections"
  FOR EACH ROW EXECUTE FUNCTION "guard_timesheet_correction"();
