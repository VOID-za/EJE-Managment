CREATE TABLE "outbox_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"template" text NOT NULL,
	"recipient" text NOT NULL,
	"parameters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"preview" text DEFAULT '' NOT NULL,
	"job_id" uuid,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"provider_message_id" text,
	"failure_reason" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_attempt_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "outbox_messages_pending_idx" ON "outbox_messages" USING btree ("created_at") WHERE "outbox_messages"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "outbox_messages_job_idx" ON "outbox_messages" USING btree ("job_id");