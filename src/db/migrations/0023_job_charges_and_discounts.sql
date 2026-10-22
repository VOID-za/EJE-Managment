-- ADDITIONAL CHARGES AND DISCOUNTS. COST-5.
--
-- WHAT A JOB COULD NOT SAY UNTIL NOW. Three kinds of money could go on a job:
-- labour at a rate, travel at a rate per kilometre, and parts at a price per
-- unit. Anything else had nowhere to go — consumables, a workshop bench fee, a
-- sub-contractor's invoice passed through, the courier charge on a part that
-- had to be flown in. The office's answer was to write it into a part line
-- with a made-up part number, which is how a parts search starts returning
-- things that are not parts.
--
-- And nothing could take money OFF. A discount agreed with a customer on the
-- telephone was applied on the invoice, outside this system, so the job card
-- the customer signed and the invoice they paid disagreed.
--
-- TWO SHAPES, BECAUSE THEY ARE TWO DIFFERENT THINGS.
--
--   * A CHARGE is a line: there can be many, each with its own description, and
--     each prints as its own row. Hence its own table.
--   * A DISCOUNT is a decision about the WHOLE JOB: there is at most one, it
--     carries the reason and the person who authorised it, and it is applied to
--     the subtotal BEFORE VAT — because VAT is charged on what the customer
--     actually pays. Hence four columns on `jobs`.
--
-- THE DISCOUNT COLUMNS ARE ALL-OR-NOTHING, written as an equivalence so the
-- CHECK refuses both halves of the mistake: an amount nobody authorised, and an
-- authorisation with no amount. NULL is treated as satisfied by a CHECK, which
-- is the trap that made two earlier constraints in this schema accept the row
-- they were written to refuse, so every arm here is written to be NULL-proof.
--
-- AND "NOT BLANK" IS `~ '[^[:space:]]'`, NOT `btrim(...) <> ''`. `btrim` with
-- no second argument trims SPACES ONLY, so a reason of a single TAB passes the
-- second form — which the database test caught on the charge description. The
-- regex asks the question that was meant: is there one character here that is
-- not whitespace. Other constraints in this schema still use the weaker form;
-- they are noted rather than changed in this migration, because each one is a
-- separate question about existing rows.
--
-- ADDITIVE. One new table and four nullable columns; no rewrite, no backfill,
-- and the previous release runs unchanged against this schema — it simply does
-- not read them.
CREATE TABLE IF NOT EXISTS "job_additional_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"description" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"captured_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "job_additional_charges_has_description" CHECK ("description" ~ '[^[:space:]]'),
	CONSTRAINT "job_additional_charges_amount_positive" CHECK ("amount_cents" > 0)
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "job_additional_charges" ADD CONSTRAINT "job_additional_charges_job_id_jobs_id_fk"
		FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "job_additional_charges" ADD CONSTRAINT "job_additional_charges_captured_by_users_id_fk"
		FOREIGN KEY ("captured_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_additional_charges_job_idx" ON "job_additional_charges" USING btree ("job_id");--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "discount_cents" bigint;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "discount_reason" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "discount_authorised_by" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "discount_authorised_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "jobs" ADD CONSTRAINT "jobs_discount_authorised_by_users_id_fk"
		FOREIGN KEY ("discount_authorised_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
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
	ALTER TABLE "jobs" DROP CONSTRAINT "jobs_discount_is_whole_or_absent";
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_discount_is_whole_or_absent" CHECK (
	("discount_cents" IS NOT NULL) = ("discount_authorised_by" IS NOT NULL)
	AND ("discount_cents" IS NOT NULL) = ("discount_authorised_at" IS NOT NULL)
	AND ("discount_cents" IS NULL OR "discount_reason" ~ '[^[:space:]]')
	AND ("discount_cents" IS NOT NULL OR "discount_reason" !~ '[^[:space:]]')
);--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "jobs" DROP CONSTRAINT "jobs_discount_is_positive";
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_discount_is_positive" CHECK (
	"discount_cents" IS NULL OR "discount_cents" > 0
);
--> statement-breakpoint
-- THE PRICED SNAPSHOT HAS TO BE ABLE TO SAY WHAT WAS TAKEN OFF.
--
-- `pricing_snapshots` is the write-once record of what the customer actually
-- signed for, and it could record only a subtotal. A job card with a discount
-- on it needs both figures — the office is asked "what was it before you came
-- down" and the answer must be IN the record rather than reconstructed by
-- adding the lines back up.
--
-- Both columns nullable and all-or-nothing: a snapshot taken before this
-- migration has no discount to record and no gross figure distinct from its
-- subtotal, and a zero would claim a measurement nobody took.
ALTER TABLE "pricing_snapshots" ADD COLUMN IF NOT EXISTS "gross_subtotal_cents" bigint;--> statement-breakpoint
ALTER TABLE "pricing_snapshots" ADD COLUMN IF NOT EXISTS "discount_cents" bigint;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "pricing_snapshots" DROP CONSTRAINT "pricing_snapshots_discount_within_gross";
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint
ALTER TABLE "pricing_snapshots" ADD CONSTRAINT "pricing_snapshots_discount_within_gross" CHECK (
	("gross_subtotal_cents" IS NOT NULL) = ("discount_cents" IS NOT NULL)
	AND ("discount_cents" IS NULL OR "discount_cents" >= 0)
	AND ("gross_subtotal_cents" IS NULL OR "gross_subtotal_cents" >= "discount_cents")
);--> statement-breakpoint
-- AND THE LINE CHECK BECOMES STRICTER, NOT LOOSER.
--
-- It read "every amount is non-negative", right while every line was work. A
-- discount line is money off and its total is negative, so the rule is now per
-- kind. This REFUSES two rows the old one accepted: a discount recorded as a
-- positive amount, which anything summing the lines would have ADDED, and a
-- discount of zero.
DO $$ BEGIN
	ALTER TABLE "pricing_snapshot_lines" DROP CONSTRAINT "pricing_snapshot_lines_amounts_non_negative";
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint
ALTER TABLE "pricing_snapshot_lines" ADD CONSTRAINT "pricing_snapshot_lines_amounts_non_negative" CHECK (
	CASE WHEN "line_kind" = 'discount'
		THEN "unit_price_cents" < 0 AND "line_total_cents" < 0
		ELSE "unit_price_cents" >= 0 AND "line_total_cents" >= 0
	END
);
