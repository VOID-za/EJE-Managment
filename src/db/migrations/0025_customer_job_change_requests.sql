-- A CUSTOMER'S REQUEST TO CHANGE SOMETHING ON A JOB. CUST-CR, the job half.
--
-- WHAT WAS BUILT BEFORE, AND WHAT WAS NOT. `customer_change_requests` carries a
-- report from somebody at EJE who may READ a register record but not edit it —
-- a technician standing at a machine whose serial number is wrong. Issue #27
-- asks for something else as well: a CUSTOMER's request to change something on
-- a JOB. That half was left unbuilt because three questions were unanswered,
-- and this migration answers them in the schema the way the register half
-- answered its own.
--
-- WHO RAISES ONE. The customer — and a customer has no account in this system.
-- There is no customer portal and no customer role, so the request arrives by
-- telephone and somebody at EJE writes it down. `raised_by` is therefore the
-- EJE person who TOOK the call, and `requested_by_contact_id` is the customer
-- contact who MADE it. Nullable, because the office does not always know which
-- of four contacts telephoned, and a required field people fill in with "the
-- customer" is worse than an empty one.
--
-- WHAT IT MAY CHANGE. Nothing, by itself — exactly as the register half
-- changes nothing. There is no proposed-value column and no apply path: the
-- request carries the customer's words and the office's decision. A job in
-- progress is unaffected except that whoever is working it can SEE that the
-- customer has asked for something, which is the whole point.
--
-- AND AFTER SIGNATURE. CR-01's finality is untouched, and BD-02 already
-- answered what happens: a signed job card stays immutable and a Master raises
-- a CORRECTION with its own addendum. So a request against a signed job is
-- still recorded — a customer querying an issued job card is exactly when one
-- is raised — and the office's resolution note is where "we raised correction
-- 2" is written. Nothing here edits a signed job, because nothing can.
--
-- TWO CHECKS, BOTH EQUIVALENCES, so each refuses both halves of its mistake: a
-- `job` request with no job (a request about nothing), a register report
-- carrying a job id (a customer's request filed under a heading about the
-- register), and a customer contact recorded against a report no customer made.
--
-- `restrict` on both new keys, like every other reference in this table: a job
-- with a customer's request against it cannot be deleted out from under the
-- record of them asking.
ALTER TABLE "customer_change_requests" ADD COLUMN IF NOT EXISTS "job_id" uuid;--> statement-breakpoint
ALTER TABLE "customer_change_requests" ADD COLUMN IF NOT EXISTS "requested_by_contact_id" uuid;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "customer_change_requests" ADD CONSTRAINT "customer_change_requests_job_id_jobs_id_fk"
		FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "customer_change_requests" ADD CONSTRAINT "customer_change_requests_requested_by_contact_id_contacts_id_fk"
		FOREIGN KEY ("requested_by_contact_id") REFERENCES "public"."contacts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_change_requests_job_idx" ON "customer_change_requests" USING btree ("job_id","raised_at");--> statement-breakpoint
-- A CHECK IS REPLACED BY DROPPING IT FIRST, AND THE DROP IS WHERE THE QUIET GOES.
--
-- `ADD CONSTRAINT` inside `EXCEPTION WHEN duplicate_object THEN NULL` is the
-- right idiom for a constraint that is NEW — it is how every foreign key above
-- is added, and a second run is a no-op. It is the WRONG idiom for a constraint
-- this migration REDEFINES: swallowing the duplicate leaves the OLD definition
-- in place and reports success, which is how `pricing_snapshot_lines_amounts_
-- non_negative` kept refusing the discount line it was rewritten to allow.
--
-- So the drop is unconditional and the ADD is unconditional, and the NOTICE
-- that `DROP CONSTRAINT IF EXISTS` prints on a fresh database — which reads
-- like an error in a deployment log — is swallowed as `undefined_object`
-- instead. Re-runnable, silent, and it installs the definition written here.
DO $$ BEGIN
	ALTER TABLE "customer_change_requests" DROP CONSTRAINT "customer_change_requests_job_matches_subject";
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint
ALTER TABLE "customer_change_requests" ADD CONSTRAINT "customer_change_requests_job_matches_subject" CHECK (
	("subject" = 'job') = ("job_id" IS NOT NULL)
);--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "customer_change_requests" DROP CONSTRAINT "customer_change_requests_contact_is_for_a_job";
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint
ALTER TABLE "customer_change_requests" ADD CONSTRAINT "customer_change_requests_contact_is_for_a_job" CHECK (
	"requested_by_contact_id" IS NULL OR "subject" = 'job'
);
