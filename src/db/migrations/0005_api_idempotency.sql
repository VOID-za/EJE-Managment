-- Replayed requests.
--
-- A tablet on a bad signal retries. Without a record of what a request already
-- did, the retry accepts the job twice, or captures a second signature and
-- freezes a second price. `api_idempotency` is that record: the first request
-- to present a key does the work and stores its answer; later requests with the
-- same key are handed that answer back.
--
-- Additive only. Nothing in 0000-0004 is touched.

CREATE TABLE "api_idempotency" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_body" jsonb,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_idempotency" ADD CONSTRAINT "api_idempotency_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_idempotency_scope_key" ON "api_idempotency" USING btree ("user_id","operation","idempotency_key");--> statement-breakpoint
CREATE INDEX "api_idempotency_created_at_idx" ON "api_idempotency" USING btree ("created_at");
