-- Email templates and the customer email outbox, WhatsApp delivery status, and
-- automatic site pins (INT-EMAIL-1..4, INT-WA-1..3, INT-MAP-1..3 — the owner,
-- 1 November 2026: "FULL WHATSAPP, GOOGLE MAPS & EMAIL INTEGRATION").
--
-- FORWARD-ONLY AND ADDITIVE. New tables, and new columns that all carry a
-- default; no existing column is changed, dropped or rewritten, and the only
-- backfill marks the location a site ALREADY has (entered by hand by the
-- office) as the office's own, verified pin — so automatic geocoding can never
-- replace it. The release before this one (c68b3c3), if it is ever rolled back
-- to, ignores every table and column added here.
--
--   email_templates / email_template_versions — the office's templates, by
--     event and job type, with every version kept. A version is never edited:
--     an edit is a new version. At most ONE default per event and job type,
--     and a default is always active (index + check), so which template a
--     signed job card uses is never ambiguous.
--   email_messages — every customer email the system composes: the exact
--     recipient, subject, body, attachment and template version, frozen when
--     it is queued. At most one queued/sending/sent message per job, event and
--     attached document (the duplicate guard). A sent message can never be
--     changed or deleted; no message's content can be changed after it is
--     written (a corrected address is a NEW message).
--   outbox_messages (+ columns) — what Meta's webhooks later said about a
--     WhatsApp message: delivered, read, failed.
--   whatsapp_webhook_events — one row per webhook status received, keyed so a
--     repeated delivery from Meta is recognised and ignored.
--   sites (+ columns) — the automatic pin: the address that was geocoded,
--     what the provider returned, how sure it was, and whether the office has
--     verified the pin.
--   geocode_cache — provider answers by normalised address, so the same
--     address is never paid for twice within the cache period.
--   integration_usage — requests per service per day, for the daily cap.
--   integration_state — a fingerprint of each integration's configuration, so
--     a change of configuration is recorded on the audit trail.
--
-- `IF NOT EXISTS` / duplicate_object guards throughout, so a re-run is harmless.

CREATE TABLE IF NOT EXISTS "email_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"job_type" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"system_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid REFERENCES "users"("id") ON DELETE RESTRICT,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid REFERENCES "users"("id") ON DELETE RESTRICT,
	CONSTRAINT "email_templates_event_known" CHECK ("event" IN ('signed_job_card')),
	CONSTRAINT "email_templates_job_type_known" CHECK ("job_type" IN ('breakdown', 'installation', 'service', 'test_and_repair', 'parts')),
	CONSTRAINT "email_templates_default_is_active" CHECK (NOT "is_default" OR "active"),
	CONSTRAINT "email_templates_name_present" CHECK (length(btrim("name")) > 0 AND length("name") <= 120),
	CONSTRAINT "email_templates_version_positive" CHECK ("current_version" >= 1)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "email_templates_one_default" ON "email_templates" ("event", "job_type") WHERE "is_default";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "email_templates_system_key" ON "email_templates" ("system_key") WHERE "system_key" IS NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "email_template_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"template_id" uuid NOT NULL REFERENCES "email_templates"("id") ON DELETE RESTRICT,
	"version" integer NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"change_note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid REFERENCES "users"("id") ON DELETE RESTRICT,
	CONSTRAINT "email_template_versions_sizes" CHECK (length("subject") <= 300 AND length("body") <= 20000),
	CONSTRAINT "email_template_versions_unique" UNIQUE ("template_id", "version")
);--> statement-breakpoint

CREATE OR REPLACE FUNCTION "email_template_versions_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'An email template version is never changed or deleted; save a new version instead.'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "email_template_versions_no_change" ON "email_template_versions";--> statement-breakpoint
CREATE TRIGGER "email_template_versions_no_change" BEFORE UPDATE OR DELETE ON "email_template_versions"
  FOR EACH ROW EXECUTE FUNCTION "email_template_versions_immutable"();--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "email_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"event" text NOT NULL,
	"job_id" uuid REFERENCES "jobs"("id") ON DELETE RESTRICT,
	"template_id" uuid REFERENCES "email_templates"("id") ON DELETE RESTRICT,
	"template_version_id" uuid REFERENCES "email_template_versions"("id") ON DELETE RESTRICT,
	"template_name" text DEFAULT '' NOT NULL,
	"template_version" integer,
	"sender" text DEFAULT '' NOT NULL,
	"recipient" text DEFAULT '' NOT NULL,
	"cc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"attachment_storage_key" text,
	"attachment_file_name" text,
	"attachment_sha256" text,
	"state" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"provider_request_id" text,
	"failure_kind" text,
	"failure_reason" text DEFAULT '' NOT NULL,
	"retry_of" uuid REFERENCES "email_messages"("id") ON DELETE RESTRICT,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" uuid REFERENCES "users"("id") ON DELETE RESTRICT,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "email_messages_idempotency_key_unique" UNIQUE ("idempotency_key"),
	CONSTRAINT "email_messages_state_known" CHECK ("state" IN ('queued', 'sending', 'sent', 'failed', 'attention')),
	CONSTRAINT "email_messages_attempts_bounded" CHECK ("attempts" >= 0 AND "attempts" <= 100),
	CONSTRAINT "email_messages_cc_array" CHECK (jsonb_typeof("cc") = 'array'),
	CONSTRAINT "email_messages_sent_has_time" CHECK ("state" <> 'sent' OR "sent_at" IS NOT NULL),
	CONSTRAINT "email_messages_sendable_has_recipient" CHECK ("state" NOT IN ('queued', 'sending', 'sent') OR length("recipient") > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "email_messages_one_live_per_document" ON "email_messages" ("job_id", "event", "attachment_storage_key")
  WHERE "state" IN ('queued', 'sending', 'sent');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_messages_due_idx" ON "email_messages" ("next_attempt_at") WHERE "state" IN ('queued', 'sending');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_messages_job_idx" ON "email_messages" ("job_id", "created_at");--> statement-breakpoint

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
     OR NEW."retry_of" IS DISTINCT FROM OLD."retry_of"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR NEW."created_by" IS DISTINCT FROM OLD."created_by" THEN
    RAISE EXCEPTION 'What an email says, and to whom, is fixed when it is written. A corrected email is a new record.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "email_messages_history" ON "email_messages";--> statement-breakpoint
CREATE TRIGGER "email_messages_history" BEFORE UPDATE OR DELETE ON "email_messages"
  FOR EACH ROW EXECUTE FUNCTION "email_messages_guard"();--> statement-breakpoint

ALTER TABLE "outbox_messages" ADD COLUMN IF NOT EXISTS "purpose" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD COLUMN IF NOT EXISTS "delivery_status" text;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD COLUMN IF NOT EXISTS "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD COLUMN IF NOT EXISTS "read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD COLUMN IF NOT EXISTS "provider_error" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD COLUMN IF NOT EXISTS "retry_of" uuid;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_delivery_status_known" CHECK (
    "delivery_status" IS NULL OR "delivery_status" IN ('sent', 'delivered', 'read', 'failed')
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbox_messages_provider_idx" ON "outbox_messages" ("provider_message_id") WHERE "provider_message_id" IS NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "whatsapp_webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_message_id" text NOT NULL,
	"status" text NOT NULL,
	"error_code" text DEFAULT '' NOT NULL,
	"error_title" text DEFAULT '' NOT NULL,
	"occurred_at" timestamp with time zone,
	"received_at" timestamp with time zone NOT NULL,
	"matched" boolean DEFAULT false NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "whatsapp_webhook_events_message_idx" ON "whatsapp_webhook_events" ("provider_message_id");--> statement-breakpoint

ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "location_status" text DEFAULT 'not_requested' NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "location_source" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "location_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "location_verified_by" uuid REFERENCES "users"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "geocode_query" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "geocoded_address" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "geocode_place_id" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "geocode_precision" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "geocode_provider" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "geocoded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "geocode_error" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "geocode_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "geocode_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "suggested_latitude" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "suggested_longitude" numeric(9, 6);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sites" ADD CONSTRAINT "sites_location_status_known" CHECK ("location_status" IN (
    'not_requested', 'pending', 'resolved', 'ambiguous', 'not_found', 'failed', 'not_configured', 'verified', 'stale'
  ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sites" ADD CONSTRAINT "sites_location_source_known" CHECK ("location_source" IS NULL OR "location_source" IN ('manual', 'geocoded'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sites" ADD CONSTRAINT "sites_coordinates_in_range" CHECK (
    ("latitude" IS NULL OR "latitude" BETWEEN -90 AND 90) AND ("longitude" IS NULL OR "longitude" BETWEEN -180 AND 180)
    AND ("suggested_latitude" IS NULL OR "suggested_latitude" BETWEEN -90 AND 90)
    AND ("suggested_longitude" IS NULL OR "suggested_longitude" BETWEEN -180 AND 180)
  ) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sites_geocode_due_idx" ON "sites" ("geocode_next_attempt_at") WHERE "location_status" = 'pending';--> statement-breakpoint
-- The pins the office already entered by hand are theirs: verified, manual.
UPDATE "sites" SET "location_status" = 'verified', "location_source" = 'manual'
 WHERE "latitude" IS NOT NULL AND "longitude" IS NOT NULL AND "location_source" IS NULL AND "location_status" = 'not_requested';--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "geocode_cache" (
	"query_key" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"outcome" text NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "integration_usage" (
	"day" date NOT NULL,
	"service" text NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "integration_usage_pk" PRIMARY KEY ("day", "service")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "integration_state" (
	"service" text PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
