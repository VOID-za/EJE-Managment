-- The standby calendar (STANDBY-1…8, 2 November 2026).
--
-- FORWARD-ONLY AND ADDITIVE. Four new tables and three new notification types;
-- nothing existing is touched, read differently or rewritten:
--
--   standby_eligibility   — who may stand in which place (main, helper,
--     apprentice). Kept by the office: every field worker is a `technician`
--     account, so the role cannot say who is an apprentice.
--   standby_weeks         — one row per week, identified by its Monday; draft
--     (the office's working copy) or published (the calendar everyone works
--     to). Publishing is one-way.
--   standby_assignments   — the four places of each week. An empty place is a
--     row with a NULL user; nobody holds two places in one week.
--   standby_swap_requests — a request to exchange ONE place between two people
--     in two weeks, and the office's decision on it.
--
-- WHAT THE DATABASE ITSELF REFUSES, whatever the application does:
--   - deleting any of these rows (history is kept; changes are audited);
--   - a week that does not start on a Monday, a week moved, or a published week
--     turned back into a draft;
--   - a place given to somebody who is not an active technician eligible for
--     it; one person in two places of the same week;
--   - a swap request whose two people do not hold the two places it names when
--     it is made; a place offered in two pending requests on the same side;
--   - a request decided twice, changed after it was decided or cancelled, or
--     decided by the person who made it.
--
-- `IF NOT EXISTS` / `CREATE OR REPLACE` throughout, so a re-run after a partial
-- apply is harmless. As in 0032, 0038 and 0039, the new enum values are not
-- USED in this migration. The release before this one (5d726d3) reads none of
-- these tables and is unaffected if it is ever rolled back to.
ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'standby_swap_requested';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'standby_swap_decided';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'standby_assignment_changed';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "standby_eligibility" (
	"user_id" uuid PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"may_main" boolean DEFAULT false NOT NULL,
	"may_helper" boolean DEFAULT false NOT NULL,
	"may_apprentice" boolean DEFAULT false NOT NULL,
	"updated_by" uuid REFERENCES "users"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "standby_eligibility_apprentice_apart" CHECK (NOT ("may_apprentice" AND ("may_main" OR "may_helper")))
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "standby_weeks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"week_start" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_by" uuid REFERENCES "users"("id"),
	"published_at" timestamp with time zone,
	"created_by" uuid REFERENCES "users"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "standby_weeks_starts_monday" CHECK (extract(isodow from "week_start") = 1),
	CONSTRAINT "standby_weeks_status_known" CHECK ("status" IN ('draft', 'published')),
	CONSTRAINT "standby_weeks_publication_whole" CHECK ("status" = 'draft' OR ("published_by" IS NOT NULL AND "published_at" IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "standby_weeks_week_start_key" ON "standby_weeks" USING btree ("week_start");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "standby_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"week_id" uuid NOT NULL REFERENCES "standby_weeks"("id") ON DELETE restrict,
	"position" text NOT NULL,
	"user_id" uuid REFERENCES "users"("id") ON DELETE restrict,
	"assigned_by" uuid REFERENCES "users"("id"),
	"assigned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "standby_assignments_position_known" CHECK ("position" IN ('main', 'helper', 'apprentice_1', 'apprentice_2'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "standby_assignments_week_position_key" ON "standby_assignments" USING btree ("week_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "standby_assignments_week_user_key" ON "standby_assignments" USING btree ("week_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "standby_assignments_user_idx" ON "standby_assignments" USING btree ("user_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "standby_swap_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"requester_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"requester_week_id" uuid NOT NULL REFERENCES "standby_weeks"("id") ON DELETE restrict,
	"requester_position" text NOT NULL,
	"counterpart_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"counterpart_week_id" uuid NOT NULL REFERENCES "standby_weeks"("id") ON DELETE restrict,
	"counterpart_position" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"decided_by" uuid REFERENCES "users"("id"),
	"decided_at" timestamp with time zone,
	"decision_note" text DEFAULT '' NOT NULL,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "standby_swap_requests_kind_known" CHECK ("kind" IN ('main', 'apprentice')),
	CONSTRAINT "standby_swap_requests_status_known" CHECK ("status" IN ('pending', 'approved', 'rejected', 'cancelled')),
	CONSTRAINT "standby_swap_requests_places_match_kind" CHECK (
		("kind" = 'main' AND "requester_position" = 'main' AND "counterpart_position" = 'main')
		OR ("kind" = 'apprentice' AND "requester_position" IN ('apprentice_1', 'apprentice_2') AND "counterpart_position" IN ('apprentice_1', 'apprentice_2'))
	),
	CONSTRAINT "standby_swap_requests_two_people" CHECK ("requester_id" <> "counterpart_id"),
	CONSTRAINT "standby_swap_requests_two_weeks" CHECK ("requester_week_id" <> "counterpart_week_id"),
	CONSTRAINT "standby_swap_requests_reason_bounded" CHECK (char_length("reason") <= 1000),
	CONSTRAINT "standby_swap_requests_note_bounded" CHECK (char_length("decision_note") <= 2000),
	CONSTRAINT "standby_swap_requests_outcome_whole" CHECK (
		("status" = 'pending' AND "decided_by" IS NULL AND "decided_at" IS NULL AND "cancelled_at" IS NULL)
		OR ("status" IN ('approved', 'rejected') AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL AND "cancelled_at" IS NULL)
		OR ("status" = 'cancelled' AND "decided_by" IS NULL AND "cancelled_at" IS NOT NULL)
	),
	CONSTRAINT "standby_swap_requests_decided_by_another" CHECK ("decided_by" IS NULL OR "decided_by" <> "requester_id")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "standby_swap_requests_requester_slot_pending_key" ON "standby_swap_requests" USING btree ("requester_week_id","requester_position") WHERE "status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "standby_swap_requests_counterpart_slot_pending_key" ON "standby_swap_requests" USING btree ("counterpart_week_id","counterpart_position") WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "standby_swap_requests_requester_idx" ON "standby_swap_requests" USING btree ("requester_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "standby_swap_requests_counterpart_idx" ON "standby_swap_requests" USING btree ("counterpart_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "standby_swap_requests_status_idx" ON "standby_swap_requests" USING btree ("status");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_standby_kept"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are part of the standby record and cannot be deleted', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "standby_eligibility_kept" ON "standby_eligibility";--> statement-breakpoint
CREATE TRIGGER "standby_eligibility_kept" BEFORE DELETE ON "standby_eligibility"
  FOR EACH ROW EXECUTE FUNCTION "guard_standby_kept"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_standby_week"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'the standby week of % is part of the record and cannot be deleted', OLD."week_start"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."week_start" IS DISTINCT FROM OLD."week_start" THEN
    RAISE EXCEPTION 'a standby week cannot be moved (%)', OLD."week_start" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'published' AND (
    NEW."status" <> 'published'
    OR NEW."published_by" IS DISTINCT FROM OLD."published_by"
    OR NEW."published_at" IS DISTINCT FROM OLD."published_at"
  ) THEN
    RAISE EXCEPTION 'the standby week of % is published and stays published', OLD."week_start"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "standby_weeks_guard" ON "standby_weeks";--> statement-breakpoint
CREATE TRIGGER "standby_weeks_guard" BEFORE UPDATE OR DELETE ON "standby_weeks"
  FOR EACH ROW EXECUTE FUNCTION "guard_standby_week"();--> statement-breakpoint
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
        AND person."role" = 'technician'
        AND CASE
          WHEN NEW."position" = 'main' THEN eligible."may_main"
          WHEN NEW."position" = 'helper' THEN eligible."may_helper"
          ELSE eligible."may_apprentice"
        END
    ) THEN
      RAISE EXCEPTION 'only an active technician eligible for the % place can stand in it', NEW."position"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "standby_assignments_guard" ON "standby_assignments";--> statement-breakpoint
CREATE TRIGGER "standby_assignments_guard" BEFORE INSERT OR UPDATE OR DELETE ON "standby_assignments"
  FOR EACH ROW EXECUTE FUNCTION "guard_standby_assignment"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_standby_swap_request"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a standby swap request is part of the record and cannot be deleted (%)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'pending' THEN
      RAISE EXCEPTION 'a standby swap request starts pending (%)', NEW."id" USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "standby_assignments" AS mine
      WHERE mine."week_id" = NEW."requester_week_id" AND mine."position" = NEW."requester_position"
        AND mine."user_id" = NEW."requester_id"
    ) OR NOT EXISTS (
      SELECT 1 FROM "standby_assignments" AS theirs
      WHERE theirs."week_id" = NEW."counterpart_week_id" AND theirs."position" = NEW."counterpart_position"
        AND theirs."user_id" = NEW."counterpart_id"
    ) THEN
      RAISE EXCEPTION 'a standby swap names two places the two people actually hold (%)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: the one change allowed is the outcome, once, from pending.
  IF OLD."status" <> 'pending' THEN
    RAISE EXCEPTION 'standby swap request % was already % and cannot be changed', OLD."id", OLD."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" NOT IN ('approved', 'rejected', 'cancelled')
    OR NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."requester_id" IS DISTINCT FROM OLD."requester_id"
    OR NEW."requester_week_id" IS DISTINCT FROM OLD."requester_week_id"
    OR NEW."requester_position" IS DISTINCT FROM OLD."requester_position"
    OR NEW."counterpart_id" IS DISTINCT FROM OLD."counterpart_id"
    OR NEW."counterpart_week_id" IS DISTINCT FROM OLD."counterpart_week_id"
    OR NEW."counterpart_position" IS DISTINCT FROM OLD."counterpart_position"
    OR NEW."reason" IS DISTINCT FROM OLD."reason"
    OR NEW."requested_at" IS DISTINCT FROM OLD."requested_at" THEN
    RAISE EXCEPTION 'only the outcome of standby swap request % can be recorded', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "standby_swap_requests_guard" ON "standby_swap_requests";--> statement-breakpoint
CREATE TRIGGER "standby_swap_requests_guard" BEFORE INSERT OR UPDATE OR DELETE ON "standby_swap_requests"
  FOR EACH ROW EXECUTE FUNCTION "guard_standby_swap_request"();
