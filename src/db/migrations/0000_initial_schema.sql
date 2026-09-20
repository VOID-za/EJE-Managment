-- Extensions this schema depends on.
--
-- `citext` gives case-insensitive text, used for email addresses so that
-- Sipho@eje and sipho@eje are the same person rather than two accounts.
-- `pgcrypto` supplies gen_random_uuid() for any row inserted outside the
-- application; ids normally come from the application so a client can
-- reference a record it has not sent yet.
CREATE EXTENSION IF NOT EXISTS "citext";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "pgcrypto";--> statement-breakpoint
CREATE TYPE "public"."attachment_kind" AS ENUM('photo', 'video', 'document');--> statement-breakpoint
CREATE TYPE "public"."availability_status" AS ENUM('active', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."availability_type" AS ENUM('appointment', 'sick_leave', 'annual_leave', 'personal_leave', 'training', 'other');--> statement-breakpoint
CREATE TYPE "public"."cancellation_reason" AS ENUM('customer_resolved', 'customer_cancelled', 'duplicate', 'no_longer_required', 'customer_unavailable', 'other');--> statement-breakpoint
CREATE TYPE "public"."checklist_response_type" AS ENUM('pass_fail_na', 'measurement', 'text', 'yes_no');--> statement-breakpoint
CREATE TYPE "public"."checklist_version_status" AS ENUM('draft', 'current', 'archived');--> statement-breakpoint
CREATE TYPE "public"."delivery_state" AS ENUM('not_started', 'sending', 'pending_delivery', 'delivered', 'failed');--> statement-breakpoint
CREATE TYPE "public"."job_participation_role" AS ENUM('primary_technician', 'additional_technician');--> statement-breakpoint
CREATE TYPE "public"."job_priority" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('draft', 'open', 'in_progress', 'awaiting_spares', 'completion', 'customer_signature', 'review', 'awaiting_delivery', 'submitted', 'closed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."labour_rate_type" AS ENUM('normal', 'overtime', 'double');--> statement-breakpoint
CREATE TYPE "public"."library_document_status" AS ENUM('current', 'archived', 'pending_approval');--> statement-breakpoint
CREATE TYPE "public"."machine_approval" AS ENUM('approved', 'pending_approval');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('in_app', 'whatsapp', 'email');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('job_assigned', 'job_transferred', 'customer_change_request', 'machine_approval_request', 'document_approval_request', 'job_submitted', 'signature_refused', 'chat_message');--> statement-breakpoint
CREATE TYPE "public"."order_number_expectation" AS ENUM('required', 'expected', 'optional');--> statement-breakpoint
CREATE TYPE "public"."outbox_channel" AS ENUM('email', 'whatsapp');--> statement-breakpoint
CREATE TYPE "public"."pass_fail_na" AS ENUM('pass', 'fail', 'na');--> statement-breakpoint
CREATE TYPE "public"."pricing_snapshot_reason" AS ENUM('customer_signature', 'signature_refused', 'submission');--> statement-breakpoint
CREATE TYPE "public"."refusal_resolution" AS ENUM('resubmitted', 'issued_unsigned');--> statement-breakpoint
CREATE TYPE "public"."technical_document_type" AS ENUM('machine_manual', 'electrical_diagram', 'service_manual', 'safety_procedure', 'work_procedure', 'datasheet');--> statement-breakpoint
CREATE TYPE "public"."transfer_reason" AS ENUM('unable_to_attend', 'sick_or_unavailable', 'vehicle_problem', 'scheduling_conflict', 'requires_another_technician', 'customer_requested', 'other');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('master', 'coordinator', 'technician');--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone,
	"ip" "inet",
	"user_agent" text,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"initials" text NOT NULL,
	"email" "citext" NOT NULL,
	"mobile" text DEFAULT '' NOT NULL,
	"role" "user_role" NOT NULL,
	"job_title" text DEFAULT '' NOT NULL,
	"password_hash" text,
	"password_set_at" timestamp with time zone,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"disabled_at" timestamp with time zone,
	"disabled_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_types" (
	"code" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"checklist_required" boolean NOT NULL,
	"photos_required" boolean NOT NULL,
	"schedules_date_range" boolean NOT NULL,
	"captures_labour_and_travel" boolean NOT NULL,
	"visits_site" boolean NOT NULL,
	"order_number_expectation" "order_number_expectation" NOT NULL,
	"captures_delivery_note" boolean NOT NULL,
	"collected_on_completion" boolean NOT NULL,
	"default_priority" "job_priority" NOT NULL,
	"accent" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machine_types" (
	"code" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"position" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"company_name" text NOT NULL,
	"company_registration" text DEFAULT '' NOT NULL,
	"company_vat_number" text DEFAULT '' NOT NULL,
	"company_phone" text DEFAULT '' NOT NULL,
	"company_email" text DEFAULT '' NOT NULL,
	"company_address" text DEFAULT '' NOT NULL,
	"labour_normal_cents" bigint NOT NULL,
	"labour_overtime_cents" bigint NOT NULL,
	"labour_double_cents" bigint NOT NULL,
	"callout_rate_cents" bigint NOT NULL,
	"kilometre_rate_cents" bigint NOT NULL,
	"vat_percent_basis_points" integer NOT NULL,
	"job_number_prefix" text DEFAULT 'EJE-' NOT NULL,
	"quiet_hours_start" text DEFAULT '18:00' NOT NULL,
	"quiet_hours_end" text DEFAULT '07:00' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "system_settings_single_row" CHECK ("system_settings"."id" = 1),
	CONSTRAINT "system_settings_rates_non_negative" CHECK (
      "system_settings"."labour_normal_cents" >= 0
      and "system_settings"."labour_overtime_cents" >= 0
      and "system_settings"."labour_double_cents" >= 0
      and "system_settings"."callout_rate_cents" >= 0
      and "system_settings"."kilometre_rate_cents" >= 0
      and "system_settings"."vat_percent_basis_points" >= 0
    )
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"site_id" uuid,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"position" text DEFAULT '' NOT NULL,
	"email" "citext" DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"email_bounced_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"body" text NOT NULL,
	"author_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"account_number" text NOT NULL,
	"registration_number" text DEFAULT '' NOT NULL,
	"vat_number" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"office_line1" text DEFAULT '' NOT NULL,
	"office_line2" text DEFAULT '' NOT NULL,
	"office_city" text DEFAULT '' NOT NULL,
	"office_province" text DEFAULT '' NOT NULL,
	"office_postal_code" text DEFAULT '' NOT NULL,
	"industry" text DEFAULT '' NOT NULL,
	"payment_terms" text DEFAULT '' NOT NULL,
	"customer_since" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address_line1" text DEFAULT '' NOT NULL,
	"address_line2" text DEFAULT '' NOT NULL,
	"city" text DEFAULT '' NOT NULL,
	"province" text DEFAULT '' NOT NULL,
	"postal_code" text DEFAULT '' NOT NULL,
	"access_notes" text DEFAULT '' NOT NULL,
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machine_approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"machine_id" uuid NOT NULL,
	"requested_by" uuid,
	"requested_at" timestamp with time zone NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision" text,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"manufacturer" text NOT NULL,
	"model" text NOT NULL,
	"serial_number" text NOT NULL,
	"machine_number" text DEFAULT '' NOT NULL,
	"machine_type_code" text NOT NULL,
	"year" integer NOT NULL,
	"installation_date" date,
	"control_system" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"approval" "machine_approval" DEFAULT 'pending_approval' NOT NULL,
	"created_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "machines_year_plausible" CHECK ("machines"."year" between 1900 and 2200)
);
--> statement-breakpoint
CREATE TABLE "job_labour" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"technician_id" uuid,
	"captured_by" uuid,
	"work_date" date NOT NULL,
	"rate_type" "labour_rate_type" NOT NULL,
	"hours" numeric(6, 2) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "job_labour_hours_positive" CHECK ("job_labour"."hours" > 0)
);
--> statement-breakpoint
CREATE TABLE "job_media" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"kind" "attachment_kind" NOT NULL,
	"file_name" text NOT NULL,
	"caption" text DEFAULT '' NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text DEFAULT '' NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"checksum_sha256" text,
	"uploaded_at" timestamp with time zone NOT NULL,
	"uploaded_by" uuid,
	"removed_at" timestamp with time zone,
	"removed_by" uuid
);
--> statement-breakpoint
CREATE TABLE "job_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"body" text NOT NULL,
	"author_id" uuid,
	"internal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_participants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "job_participation_role" NOT NULL,
	"since" timestamp with time zone NOT NULL,
	"until" timestamp with time zone,
	"ended_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_parts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"part_number" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_cents" bigint NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"captured_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "job_parts_quantity_positive" CHECK ("job_parts"."quantity" > 0),
	CONSTRAINT "job_parts_unit_price_non_negative" CHECK ("job_parts"."unit_price_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "job_technicians" (
	"job_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"added_by" uuid
);
--> statement-breakpoint
CREATE TABLE "job_transfers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"from_user_id" uuid,
	"to_user_id" uuid,
	"reason" "transfer_reason" NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"transferred_by" uuid NOT NULL,
	"transferred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_transfers_other_needs_description" CHECK ("job_transfers"."reason" <> 'other' or btrim("job_transfers"."description") <> '')
);
--> statement-breakpoint
CREATE TABLE "job_travel" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"technician_id" uuid,
	"captured_by" uuid,
	"travel_date" date NOT NULL,
	"kilometres" numeric(8, 1) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "job_travel_kilometres_positive" CHECK ("job_travel"."kilometres" > 0)
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_number" text NOT NULL,
	"job_number_seq" integer NOT NULL,
	"customer_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"machine_id" uuid,
	"job_type_code" text NOT NULL,
	"priority" "job_priority" NOT NULL,
	"status" "job_status" NOT NULL,
	"scheduled_date" date,
	"scheduled_end_date" date,
	"order_number" text DEFAULT '' NOT NULL,
	"order_number_waived_by" uuid,
	"order_number_waived_at" timestamp with time zone,
	"order_number_waiver_note" text DEFAULT '' NOT NULL,
	"reference_number" text DEFAULT '' NOT NULL,
	"fault_description" text DEFAULT '' NOT NULL,
	"primary_technician_id" uuid,
	"callout_applied" boolean DEFAULT false NOT NULL,
	"courier_collection" boolean DEFAULT false NOT NULL,
	"waybill_number" text DEFAULT '' NOT NULL,
	"delivery_note" text DEFAULT '' NOT NULL,
	"awaiting_spares_reason" text DEFAULT '' NOT NULL,
	"report_fault_findings" text DEFAULT '' NOT NULL,
	"report_diagnosis" text DEFAULT '' NOT NULL,
	"report_work_performed" text DEFAULT '' NOT NULL,
	"report_recommendations" text DEFAULT '' NOT NULL,
	"report_general_notes" text DEFAULT '' NOT NULL,
	"cancellation_reason" "cancellation_reason",
	"cancellation_description" text DEFAULT '' NOT NULL,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"accepted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "jobs_schedule_end_needs_start" CHECK ("jobs"."scheduled_end_date" is null or "jobs"."scheduled_date" is not null),
	CONSTRAINT "jobs_schedule_end_not_before_start" CHECK ("jobs"."scheduled_end_date" is null or "jobs"."scheduled_end_date" >= "jobs"."scheduled_date"),
	CONSTRAINT "jobs_courier_needs_waybill" CHECK (not "jobs"."courier_collection" or btrim("jobs"."waybill_number") <> ''),
	CONSTRAINT "jobs_cancelled_has_reason" CHECK ("jobs"."status" <> 'cancelled' or "jobs"."cancellation_reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "job_signatures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"customer_name" text NOT NULL,
	"customer_surname" text NOT NULL,
	"stroke_data" text NOT NULL,
	"declaration" text NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"captured_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_signatures_name_present" CHECK (btrim("job_signatures"."customer_name") <> ''),
	CONSTRAINT "job_signatures_surname_present" CHECK (btrim("job_signatures"."customer_surname") <> ''),
	CONSTRAINT "job_signatures_stroke_present" CHECK (btrim("job_signatures"."stroke_data") <> '')
);
--> statement-breakpoint
CREATE TABLE "signature_refusals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"reason" text NOT NULL,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolution" "refusal_resolution",
	"resolution_note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signature_refusals_reason_present" CHECK (btrim("signature_refusals"."reason") <> ''),
	CONSTRAINT "signature_refusals_attempt_positive" CHECK ("signature_refusals"."attempt" >= 1),
	CONSTRAINT "signature_refusals_resolution_complete" CHECK (("signature_refusals"."resolved_at" is null and "signature_refusals"."resolution" is null and "signature_refusals"."resolved_by" is null)
          or ("signature_refusals"."resolved_at" is not null and "signature_refusals"."resolution" is not null and "signature_refusals"."resolved_by" is not null))
);
--> statement-breakpoint
CREATE TABLE "pricing_snapshot_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"line_kind" text NOT NULL,
	"source_line_id" uuid,
	"position" integer NOT NULL,
	"description" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"quantity" numeric(12, 2) NOT NULL,
	"unit_label" text DEFAULT '' NOT NULL,
	"unit_price_cents" bigint NOT NULL,
	"line_total_cents" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_snapshot_lines_amounts_non_negative" CHECK ("pricing_snapshot_lines"."unit_price_cents" >= 0 and "pricing_snapshot_lines"."line_total_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pricing_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"signature_id" uuid,
	"refusal_id" uuid,
	"labour_normal_cents" bigint NOT NULL,
	"labour_overtime_cents" bigint NOT NULL,
	"labour_double_cents" bigint NOT NULL,
	"callout_rate_cents" bigint NOT NULL,
	"kilometre_rate_cents" bigint NOT NULL,
	"vat_percent_basis_points" integer NOT NULL,
	"subtotal_cents" bigint NOT NULL,
	"vat_cents" bigint NOT NULL,
	"total_cents" bigint NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"reason" "pricing_snapshot_reason" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_snapshots_amounts_non_negative" CHECK ("pricing_snapshots"."subtotal_cents" >= 0 and "pricing_snapshots"."vat_cents" >= 0 and "pricing_snapshots"."total_cents" >= 0),
	CONSTRAINT "pricing_snapshots_attempt_positive" CHECK ("pricing_snapshots"."attempt" >= 1)
);
--> statement-breakpoint
CREATE TABLE "checklist_answer_photos" (
	"id" uuid PRIMARY KEY NOT NULL,
	"answer_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"file_name" text NOT NULL,
	"caption" text DEFAULT '' NOT NULL,
	"content_type" text DEFAULT '' NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"uploaded_at" timestamp with time zone NOT NULL,
	"uploaded_by" uuid
);
--> statement-breakpoint
CREATE TABLE "checklist_answers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"instance_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"choice" "pass_fail_na",
	"yes_no" boolean,
	"measurement" numeric(14, 4),
	"text_answer" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"answered_at" timestamp with time zone,
	"answered_by" uuid,
	CONSTRAINT "checklist_answers_fail_needs_note" CHECK ("checklist_answers"."choice" is distinct from 'fail' or btrim("checklist_answers"."notes") <> '')
);
--> statement-breakpoint
CREATE TABLE "checklist_instances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"started_at" timestamp with time zone,
	"started_by" uuid,
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checklist_questions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"section_id" uuid NOT NULL,
	"text" text NOT NULL,
	"help_text" text DEFAULT '' NOT NULL,
	"response_type" "checklist_response_type" NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"photo_required" boolean DEFAULT false NOT NULL,
	"unit" text,
	"expected_min" numeric(14, 4),
	"expected_max" numeric(14, 4),
	"position" integer NOT NULL,
	CONSTRAINT "checklist_questions_range_ordered" CHECK ("checklist_questions"."expected_min" is null or "checklist_questions"."expected_max" is null or "checklist_questions"."expected_max" >= "checklist_questions"."expected_min"),
	CONSTRAINT "checklist_questions_range_only_for_measurement" CHECK ("checklist_questions"."response_type" = 'measurement'
          or ("checklist_questions"."expected_min" is null and "checklist_questions"."expected_max" is null))
);
--> statement-breakpoint
CREATE TABLE "checklist_sections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checklist_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"checklist_id" uuid NOT NULL,
	"version" text NOT NULL,
	"status" "checklist_version_status" DEFAULT 'draft' NOT NULL,
	"source_document" text DEFAULT '' NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checklists" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"job_type_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"final_document_id" uuid,
	"channel" "outbox_channel" NOT NULL,
	"recipient" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"state" "delivery_state" NOT NULL,
	"provider_message_id" text,
	"attempted_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"failure_reason" text DEFAULT '' NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_attempts_attempt_positive" CHECK ("delivery_attempts"."attempt_number" >= 1),
	CONSTRAINT "delivery_attempts_delivered_is_confirmed" CHECK ("delivery_attempts"."state" <> 'delivered' or "delivery_attempts"."confirmed_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "final_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text DEFAULT 'application/pdf' NOT NULL,
	"page_count" integer NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"checksum_sha256" text,
	"renderer_version" integer NOT NULL,
	"backfilled" boolean DEFAULT false NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"generated_by" uuid,
	"issued_to" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "final_documents_page_count_positive" CHECK ("final_documents"."page_count" >= 1)
);
--> statement-breakpoint
CREATE TABLE "message_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"channel" "outbox_channel" NOT NULL,
	"job_id" uuid,
	"recipients" text[] NOT NULL,
	"cc_recipients" text[] DEFAULT '{}'::text[] NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"template_name" text,
	"template_parameters" text[],
	"attachment_storage_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"state" "delivery_state" DEFAULT 'not_started' NOT NULL,
	"provider_message_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "availability" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "availability_type" NOT NULL,
	"status" "availability_status" DEFAULT 'active' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"all_day" boolean DEFAULT true NOT NULL,
	"start_time" time,
	"end_time" time,
	"description" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "availability_range_ordered" CHECK ("availability"."end_date" >= "availability"."start_date"),
	CONSTRAINT "availability_timed_needs_times" CHECK ("availability"."all_day" or ("availability"."start_time" is not null and "availability"."end_time" is not null)),
	CONSTRAINT "availability_cancelled_has_stamp" CHECK ("availability"."status" <> 'cancelled' or "availability"."cancelled_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "chat_conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid,
	"job_number" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_message_reads" (
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"read_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"body" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"availability_record_id" uuid,
	"actioned_by" uuid,
	"actioned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_participants" (
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"recipient_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"job_id" uuid,
	"link" text,
	"channels" "notification_channel"[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"handled_at" timestamp with time zone,
	"handled_by" uuid
);
--> statement-breakpoint
CREATE TABLE "library_document_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"version" text NOT NULL,
	"file_name" text NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text DEFAULT '' NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"page_count" integer,
	"checksum_sha256" text,
	"uploaded_at" timestamp with time zone NOT NULL,
	"uploaded_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"rejected_by" uuid,
	"rejected_at" timestamp with time zone,
	"rejection_reason" text DEFAULT '' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_document_versions_one_outcome" CHECK ("library_document_versions"."approved_at" is null or "library_document_versions"."rejected_at" is null),
	CONSTRAINT "library_document_versions_rejection_has_reason" CHECK ("library_document_versions"."rejected_at" is null or btrim("library_document_versions"."rejection_reason") <> '')
);
--> statement-breakpoint
CREATE TABLE "library_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"document_type" "technical_document_type" NOT NULL,
	"manufacturer" text DEFAULT '' NOT NULL,
	"machine_model" text DEFAULT '' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "library_document_status" DEFAULT 'pending_approval' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"archived_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "library_favourites" (
	"user_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "library_views" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"viewed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"actor_id" uuid,
	"actor_role" "user_role",
	"actor_name" text DEFAULT '' NOT NULL,
	"type" text NOT NULL,
	"summary" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"job_id" uuid,
	"job_number" text,
	"entity_type" text,
	"entity_id" uuid,
	"metadata" jsonb,
	"request_id" uuid,
	"session_id" uuid,
	"ip" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events_archive" (
	"id" uuid PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"actor_id" uuid,
	"actor_role" "user_role",
	"actor_name" text DEFAULT '' NOT NULL,
	"type" text NOT NULL,
	"summary" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"job_id" uuid,
	"job_number" text,
	"entity_type" text,
	"entity_id" uuid,
	"metadata" jsonb,
	"request_id" uuid,
	"session_id" uuid,
	"ip" "inet",
	"created_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_disabled_by_users_id_fk" FOREIGN KEY ("disabled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_approvals" ADD CONSTRAINT "machine_approvals_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_approvals" ADD CONSTRAINT "machine_approvals_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_approvals" ADD CONSTRAINT "machine_approvals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_machine_type_code_machine_types_code_fk" FOREIGN KEY ("machine_type_code") REFERENCES "public"."machine_types"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_labour" ADD CONSTRAINT "job_labour_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_labour" ADD CONSTRAINT "job_labour_technician_id_users_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_labour" ADD CONSTRAINT "job_labour_captured_by_users_id_fk" FOREIGN KEY ("captured_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_media" ADD CONSTRAINT "job_media_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_media" ADD CONSTRAINT "job_media_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_media" ADD CONSTRAINT "job_media_removed_by_users_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_notes" ADD CONSTRAINT "job_notes_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_notes" ADD CONSTRAINT "job_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_participants" ADD CONSTRAINT "job_participants_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_participants" ADD CONSTRAINT "job_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_parts" ADD CONSTRAINT "job_parts_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_parts" ADD CONSTRAINT "job_parts_captured_by_users_id_fk" FOREIGN KEY ("captured_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_technicians" ADD CONSTRAINT "job_technicians_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_technicians" ADD CONSTRAINT "job_technicians_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_technicians" ADD CONSTRAINT "job_technicians_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_transfers" ADD CONSTRAINT "job_transfers_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_transfers" ADD CONSTRAINT "job_transfers_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_transfers" ADD CONSTRAINT "job_transfers_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_transfers" ADD CONSTRAINT "job_transfers_transferred_by_users_id_fk" FOREIGN KEY ("transferred_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_travel" ADD CONSTRAINT "job_travel_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_travel" ADD CONSTRAINT "job_travel_technician_id_users_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_travel" ADD CONSTRAINT "job_travel_captured_by_users_id_fk" FOREIGN KEY ("captured_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_job_type_code_job_types_code_fk" FOREIGN KEY ("job_type_code") REFERENCES "public"."job_types"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_order_number_waived_by_users_id_fk" FOREIGN KEY ("order_number_waived_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_primary_technician_id_users_id_fk" FOREIGN KEY ("primary_technician_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_signatures" ADD CONSTRAINT "job_signatures_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_signatures" ADD CONSTRAINT "job_signatures_captured_by_users_id_fk" FOREIGN KEY ("captured_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_refusals" ADD CONSTRAINT "signature_refusals_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_refusals" ADD CONSTRAINT "signature_refusals_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_refusals" ADD CONSTRAINT "signature_refusals_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_snapshot_lines" ADD CONSTRAINT "pricing_snapshot_lines_snapshot_id_pricing_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."pricing_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_snapshots" ADD CONSTRAINT "pricing_snapshots_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_snapshots" ADD CONSTRAINT "pricing_snapshots_signature_id_job_signatures_id_fk" FOREIGN KEY ("signature_id") REFERENCES "public"."job_signatures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_snapshots" ADD CONSTRAINT "pricing_snapshots_refusal_id_signature_refusals_id_fk" FOREIGN KEY ("refusal_id") REFERENCES "public"."signature_refusals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_answer_photos" ADD CONSTRAINT "checklist_answer_photos_answer_id_checklist_answers_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."checklist_answers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_answer_photos" ADD CONSTRAINT "checklist_answer_photos_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_answers" ADD CONSTRAINT "checklist_answers_instance_id_checklist_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."checklist_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_answers" ADD CONSTRAINT "checklist_answers_question_id_checklist_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."checklist_questions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_answers" ADD CONSTRAINT "checklist_answers_answered_by_users_id_fk" FOREIGN KEY ("answered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_instances" ADD CONSTRAINT "checklist_instances_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_instances" ADD CONSTRAINT "checklist_instances_version_id_checklist_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."checklist_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_instances" ADD CONSTRAINT "checklist_instances_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_instances" ADD CONSTRAINT "checklist_instances_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_questions" ADD CONSTRAINT "checklist_questions_section_id_checklist_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."checklist_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_sections" ADD CONSTRAINT "checklist_sections_version_id_checklist_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."checklist_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_versions" ADD CONSTRAINT "checklist_versions_checklist_id_checklists_id_fk" FOREIGN KEY ("checklist_id") REFERENCES "public"."checklists"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_versions" ADD CONSTRAINT "checklist_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklists" ADD CONSTRAINT "checklists_job_type_code_job_types_code_fk" FOREIGN KEY ("job_type_code") REFERENCES "public"."job_types"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_final_document_id_final_documents_id_fk" FOREIGN KEY ("final_document_id") REFERENCES "public"."final_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "final_documents" ADD CONSTRAINT "final_documents_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "final_documents" ADD CONSTRAINT "final_documents_generated_by_users_id_fk" FOREIGN KEY ("generated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_outbox" ADD CONSTRAINT "message_outbox_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_outbox" ADD CONSTRAINT "message_outbox_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability" ADD CONSTRAINT "availability_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability" ADD CONSTRAINT "availability_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability" ADD CONSTRAINT "availability_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message_reads" ADD CONSTRAINT "chat_message_reads_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message_reads" ADD CONSTRAINT "chat_message_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_conversation_id_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_availability_record_id_availability_id_fk" FOREIGN KEY ("availability_record_id") REFERENCES "public"."availability"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_actioned_by_users_id_fk" FOREIGN KEY ("actioned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_participants" ADD CONSTRAINT "chat_participants_conversation_id_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_participants" ADD CONSTRAINT "chat_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_handled_by_users_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_document_versions" ADD CONSTRAINT "library_document_versions_document_id_library_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."library_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_document_versions" ADD CONSTRAINT "library_document_versions_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_document_versions" ADD CONSTRAINT "library_document_versions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_document_versions" ADD CONSTRAINT "library_document_versions_rejected_by_users_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_documents" ADD CONSTRAINT "library_documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_favourites" ADD CONSTRAINT "library_favourites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_favourites" ADD CONSTRAINT "library_favourites_document_id_library_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."library_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_views" ADD CONSTRAINT "library_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_views" ADD CONSTRAINT "library_views_document_id_library_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."library_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_active_idx" ON "sessions" USING btree ("user_id") WHERE "sessions"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_role_active_idx" ON "users" USING btree ("role") WHERE "users"."active";--> statement-breakpoint
CREATE INDEX "contacts_customer_idx" ON "contacts" USING btree ("customer_id") WHERE "contacts"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "contacts_email_idx" ON "contacts" USING btree ("email") WHERE "contacts"."email" <> '';--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_one_primary_per_customer" ON "contacts" USING btree ("customer_id") WHERE "contacts"."is_primary" and "contacts"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "customer_notes_customer_idx" ON "customer_notes" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_account_number_key" ON "customers" USING btree ("account_number");--> statement-breakpoint
CREATE INDEX "customers_name_idx" ON "customers" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "customers_registration_number_idx" ON "customers" USING btree ("registration_number") WHERE "customers"."registration_number" <> '';--> statement-breakpoint
CREATE INDEX "sites_customer_idx" ON "sites" USING btree ("customer_id") WHERE "sites"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "sites_name_idx" ON "sites" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "machine_approvals_machine_idx" ON "machine_approvals" USING btree ("machine_id","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "machines_customer_serial_key" ON "machines" USING btree ("customer_id",lower("serial_number")) WHERE "machines"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "machines_serial_idx" ON "machines" USING btree (lower("serial_number"));--> statement-breakpoint
CREATE INDEX "machines_machine_number_idx" ON "machines" USING btree (lower("machine_number")) WHERE "machines"."machine_number" <> '';--> statement-breakpoint
CREATE INDEX "machines_site_idx" ON "machines" USING btree ("site_id") WHERE "machines"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "machines_customer_idx" ON "machines" USING btree ("customer_id") WHERE "machines"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "job_labour_job_idx" ON "job_labour" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "job_media_job_idx" ON "job_media" USING btree ("job_id") WHERE "job_media"."removed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "job_media_storage_key_key" ON "job_media" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "job_notes_job_idx" ON "job_notes" USING btree ("job_id","created_at");--> statement-breakpoint
CREATE INDEX "job_participants_user_idx" ON "job_participants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "job_participants_job_idx" ON "job_participants" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_participants_one_open" ON "job_participants" USING btree ("job_id","user_id","role") WHERE "job_participants"."until" is null;--> statement-breakpoint
CREATE INDEX "job_parts_job_idx" ON "job_parts" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "job_parts_part_number_idx" ON "job_parts" USING btree (lower("part_number"));--> statement-breakpoint
CREATE UNIQUE INDEX "job_technicians_pkey" ON "job_technicians" USING btree ("job_id","user_id");--> statement-breakpoint
CREATE INDEX "job_technicians_user_idx" ON "job_technicians" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "job_transfers_job_idx" ON "job_transfers" USING btree ("job_id","transferred_at");--> statement-breakpoint
CREATE INDEX "job_travel_job_idx" ON "job_travel" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_job_number_key" ON "jobs" USING btree ("job_number");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_job_number_seq_key" ON "jobs" USING btree ("job_number_seq");--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "jobs_primary_technician_idx" ON "jobs" USING btree ("primary_technician_id","status");--> statement-breakpoint
CREATE INDEX "jobs_customer_idx" ON "jobs" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "jobs_site_idx" ON "jobs" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "jobs_machine_idx" ON "jobs" USING btree ("machine_id");--> statement-breakpoint
CREATE INDEX "jobs_job_type_idx" ON "jobs" USING btree ("job_type_code");--> statement-breakpoint
CREATE INDEX "jobs_created_at_idx" ON "jobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "jobs_updated_at_idx" ON "jobs" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "jobs_scheduled_idx" ON "jobs" USING btree ("scheduled_date","scheduled_end_date") WHERE "jobs"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "jobs_closed_at_idx" ON "jobs" USING btree ("closed_at") WHERE "jobs"."status" = 'closed';--> statement-breakpoint
CREATE INDEX "jobs_open_pool_idx" ON "jobs" USING btree ("created_at") WHERE "jobs"."status" = 'open' and "jobs"."primary_technician_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "job_signatures_job_key" ON "job_signatures" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "signature_refusals_job_attempt_key" ON "signature_refusals" USING btree ("job_id","attempt");--> statement-breakpoint
CREATE INDEX "signature_refusals_job_idx" ON "signature_refusals" USING btree ("job_id","attempt");--> statement-breakpoint
CREATE INDEX "signature_refusals_outstanding_idx" ON "signature_refusals" USING btree ("recorded_at") WHERE "signature_refusals"."resolved_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "pricing_snapshot_lines_position_key" ON "pricing_snapshot_lines" USING btree ("snapshot_id","position");--> statement-breakpoint
CREATE INDEX "pricing_snapshot_lines_snapshot_idx" ON "pricing_snapshot_lines" USING btree ("snapshot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pricing_snapshots_job_attempt_key" ON "pricing_snapshots" USING btree ("job_id","attempt");--> statement-breakpoint
CREATE INDEX "pricing_snapshots_job_idx" ON "pricing_snapshots" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "checklist_answer_photos_answer_idx" ON "checklist_answer_photos" USING btree ("answer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "checklist_answer_photos_storage_key_key" ON "checklist_answer_photos" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "checklist_answers_question_key" ON "checklist_answers" USING btree ("instance_id","question_id");--> statement-breakpoint
CREATE INDEX "checklist_answers_instance_idx" ON "checklist_answers" USING btree ("instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "checklist_instances_job_key" ON "checklist_instances" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "checklist_instances_version_idx" ON "checklist_instances" USING btree ("version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "checklist_questions_position_key" ON "checklist_questions" USING btree ("section_id","position");--> statement-breakpoint
CREATE INDEX "checklist_questions_section_idx" ON "checklist_questions" USING btree ("section_id");--> statement-breakpoint
CREATE UNIQUE INDEX "checklist_sections_position_key" ON "checklist_sections" USING btree ("version_id","position");--> statement-breakpoint
CREATE INDEX "checklist_sections_version_idx" ON "checklist_sections" USING btree ("version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "checklist_versions_checklist_version_key" ON "checklist_versions" USING btree ("checklist_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "checklist_versions_one_current" ON "checklist_versions" USING btree ("checklist_id") WHERE "checklist_versions"."status" = 'current';--> statement-breakpoint
CREATE INDEX "checklist_versions_checklist_idx" ON "checklist_versions" USING btree ("checklist_id");--> statement-breakpoint
CREATE INDEX "checklists_job_type_idx" ON "checklists" USING btree ("job_type_code");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_attempts_job_attempt_key" ON "delivery_attempts" USING btree ("job_id","channel","attempt_number");--> statement-breakpoint
CREATE INDEX "delivery_attempts_job_idx" ON "delivery_attempts" USING btree ("job_id","attempt_number");--> statement-breakpoint
CREATE INDEX "delivery_attempts_provider_idx" ON "delivery_attempts" USING btree ("provider_message_id") WHERE "delivery_attempts"."provider_message_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "final_documents_job_key" ON "final_documents" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "final_documents_storage_key_key" ON "final_documents" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "message_outbox_idempotency_key" ON "message_outbox" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "message_outbox_due_idx" ON "message_outbox" USING btree ("next_attempt_at") WHERE "message_outbox"."state" in ('not_started', 'sending', 'pending_delivery');--> statement-breakpoint
CREATE INDEX "message_outbox_job_idx" ON "message_outbox" USING btree ("job_id") WHERE "message_outbox"."job_id" is not null;--> statement-breakpoint
CREATE INDEX "availability_user_window_idx" ON "availability" USING btree ("user_id","start_date","end_date") WHERE "availability"."status" = 'active';--> statement-breakpoint
CREATE INDEX "availability_window_idx" ON "availability" USING btree ("start_date","end_date");--> statement-breakpoint
CREATE INDEX "chat_conversations_recent_idx" ON "chat_conversations" USING btree ("last_message_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_message_reads_pkey" ON "chat_message_reads" USING btree ("message_id","user_id");--> statement-breakpoint
CREATE INDEX "chat_message_reads_user_idx" ON "chat_message_reads" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "chat_messages_conversation_idx" ON "chat_messages" USING btree ("conversation_id","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_participants_pkey" ON "chat_participants" USING btree ("conversation_id","user_id");--> statement-breakpoint
CREATE INDEX "chat_participants_user_idx" ON "chat_participants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notifications_recipient_idx" ON "notifications" USING btree ("recipient_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("recipient_id") WHERE "notifications"."read_at" is null;--> statement-breakpoint
CREATE INDEX "notifications_job_idx" ON "notifications" USING btree ("job_id") WHERE "notifications"."job_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "library_document_versions_version_key" ON "library_document_versions" USING btree ("document_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "library_document_versions_storage_key_key" ON "library_document_versions" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "library_document_versions_document_idx" ON "library_document_versions" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "library_document_versions_one_current" ON "library_document_versions" USING btree ("document_id") WHERE "library_document_versions"."approved_at" is not null and "library_document_versions"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "library_documents_name_idx" ON "library_documents" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "library_documents_model_idx" ON "library_documents" USING btree (lower("machine_model"));--> statement-breakpoint
CREATE INDEX "library_documents_status_idx" ON "library_documents" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "library_favourites_pkey" ON "library_favourites" USING btree ("user_id","document_id");--> statement-breakpoint
CREATE INDEX "library_views_user_idx" ON "library_views" USING btree ("user_id","viewed_at");--> statement-breakpoint
CREATE INDEX "audit_events_occurred_at_idx" ON "audit_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_job_idx" ON "audit_events" USING btree ("job_id","occurred_at") WHERE "audit_events"."job_id" is not null;--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_type_idx" ON "audit_events" USING btree ("type","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id") WHERE "audit_events"."entity_id" is not null;--> statement-breakpoint
CREATE INDEX "audit_events_archive_occurred_at_idx" ON "audit_events_archive" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_archive_job_idx" ON "audit_events_archive" USING btree ("job_id") WHERE "audit_events_archive"."job_id" is not null;