-- Captures a tablet held that the server refused, handed to the office. BD-15.
--
-- EJE answered OFF-QUEUE-DEC-1: a capture the server permanently refuses is
-- RETAINED and REFERRED TO THE OFFICE for a decision. Before this it lived on
-- one tablet with a refusal message on it, and whether anybody ever acted on it
-- depended on the technician remembering to mention it.
--
-- Three constraints carry reasoning rather than just shape:
--
--  * job_id ... ON DELETE RESTRICT. A referral records that somebody tried to
--    put work on this job and could not. Deleting the job to make that record
--    disappear must not be possible.
--  * UNIQUE (technician_id, idempotency_key). Referring is idempotent: a flush
--    that runs twice, or a reload mid-request, must not put two copies of one
--    problem on the office's screen. The key is the one the capture was first
--    ATTEMPTED under, minted on the tablet before the first send — so applying
--    the capture later is the same write the tablet was trying to make, and
--    cannot become a second one.
--  * state and resolution are TEXT, following machine_approvals.decision: a
--    third outcome is a business decision and should not need a migration.
--
-- Additive. No existing table is altered and no existing row is touched.

CREATE TABLE "capture_referrals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"technician_id" uuid,
	"action" text NOT NULL,
	"payload" jsonb NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"idempotency_key" text NOT NULL,
	"refusal_code" text DEFAULT '' NOT NULL,
	"refusal_message" text DEFAULT '' NOT NULL,
	"referred_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"resolution_note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "capture_referrals" ADD CONSTRAINT "capture_referrals_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_referrals" ADD CONSTRAINT "capture_referrals_technician_id_users_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_referrals" ADD CONSTRAINT "capture_referrals_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "capture_referrals_capture_key" ON "capture_referrals" USING btree ("technician_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "capture_referrals_state_idx" ON "capture_referrals" USING btree ("state","referred_at");--> statement-breakpoint
CREATE INDEX "capture_referrals_job_idx" ON "capture_referrals" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "capture_referrals_technician_idx" ON "capture_referrals" USING btree ("technician_id","referred_at");